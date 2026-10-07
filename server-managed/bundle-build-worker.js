import { parentPort, workerData } from 'node:worker_threads'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { buildGitHubBundle, setCacheDir } from '@exodus/stasis/vfs-bundle'
import { brotliOptions } from '@exodus/stasis-core/brotli'
import { HttpError, createClient } from '@preventive/upstream/github.js'
import { githubBundleFilename } from './bundle-build.ts'
import { bundleBuildDiagnostic } from './bundle-build-diagnostics.js'

const regularFile = entry => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)

async function projectDirectory(input, github, client) {
  // Input validation permits either JS/TS entries or Solidity entries, never a mix.
  const manifests = input.entries[0].endsWith('.sol') ? ['foundry.toml', 'soldeer.toml', 'soldeer.lock'] : ['package.json']
  if (!input.directory) return ''
  for (let directory = input.directory; ; directory = posix.dirname(directory).replace(/^\.$/u, '')) {
    const entries = await client.listRepoDir({ repo: github, sha: input.commit, directory: directory || undefined })
    if (entries.some(entry => manifests.includes(entry.path) && regularFile(entry))) return directory
    if (!directory) return input.directory
  }
}

// The name Stasis read from the package.json in the project directory we
// provide, where its module holds bundled files. JS builds only: a Solidity
// build records `solidity-bundle` for a package.json without name and version.
async function packageName(input, github, project, bundle, client) {
  if (!project || input.entries[0].endsWith('.sol')) return null
  const entries = await client.listRepoDir({ repo: github, sha: input.commit, directory: project })
  if (!entries.some(entry => entry.path === 'package.json' && regularFile(entry))) return null
  const name = bundle.modules.get(posix.relative(bundle.repo?.directory ?? '', project) || '.')?.name
  return typeof name === 'string' ? name : null
}

export async function buildStasisBundle({ input, github, token, maxBytes, scopes, cacheDir = null }, client = createClient({ token }), progress = () => {}) {
  const allowed = path => scopes.some(scope => !scope || path === scope || path.startsWith(scope + '/'))
  // Reuse these immutable listings when Stasis discovers the lockfile root.
  const listings = new Map()
  const buildClient = { ...client, listRepoDir(options) {
    const key = JSON.stringify([options.repo, options.sha, options.directory ?? ''])
    if (!listings.has(key)) listings.set(key, client.listRepoDir(options))
    return listings.get(key)
  } }
  // Upstream's disk cache keeps the npm tarballs and version documents, and
  // the repo's tree, in `cacheDir`; without one (Vercel), nothing is kept on
  // disk. This fresh worker inherits no application credentials.
  setCacheDir(cacheDir ?? false)
  progress('build')
  const project = await projectDirectory(input, github, buildClient)
  if (!allowed(project)) throw new Error('build-scope')
  const { bundle } = await buildGitHubBundle({
    github, sha: input.commit, directory: project || undefined,
    entries: input.entries.map(entry => posix.relative(project || '.', entry)),
    ...input.options, client: buildClient, ...(cacheDir === null && { cache: false }),
  })
  const directory = bundle.repo?.directory ?? ''
  progress('scope')
  // Imports outside the selected package may widen the root. Never publish it under a
  // narrower team grant: the storage location must cover the actual bundle.
  if (!allowed(directory)) throw new Error('build-scope')
  progress('serialize')
  const serialized = bundle.serialize()
  if (Buffer.byteLength(serialized) > 200 * 1024 * 1024) throw new Error('too-large')
  progress('compress')
  const bytes = brotliCompressSync(serialized, brotliOptions())
  if (bytes.length > maxBytes) throw new Error('too-large')
  const name = await packageName(input, github, project, bundle, buildClient)
  return { bytes, directory, filename: githubBundleFilename(github, project, input.commit, name) }
}

if (parentPort && workerData?.type === 'managed-bundle-build') {
  // Send diagnostics to the request's parent thread, which writes them before
  // returning the HTTP response. Worker stdout can be lost on termination.
  const send = message => {
    // Node worker messages have no browser target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    parentPort.postMessage(message)
  }
  try {
    send(await buildStasisBundle(workerData, undefined, stage => send({ type: 'progress', stage })))
  } catch (error) {
    const diagnostic = bundleBuildDiagnostic(error, workerData.token)
    // Do not return upstream bodies or paths outside the caller's grants.
    const code = ['build-scope', 'too-large'].includes(diagnostic.message) ? diagnostic.message
      : error instanceof HttpError ? (error.status === 429 ? 'github-rate-limited' : 'github-build-failed')
        : /no packageManager given|lockfile installs/u.test(diagnostic.message) ? 'build-lockfile'
          : 'build-failed'
    send({ error: code, status: code === 'too-large' ? 413 : code === 'build-scope' ? 403 : 422, diagnostic })
  }
}
