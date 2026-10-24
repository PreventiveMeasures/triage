import { parentPort, workerData } from 'node:worker_threads'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { buildGitHubBundle, setCacheDir } from '@exodus/stasis/vfs-bundle'
import { brotliOptions } from '@exodus/stasis-core/brotli'
import { HttpError, createClient } from '@preventive/upstream/github.js'
import { githubBundleFilename } from './bundle-build.ts'
import { bundleBuildDiagnostic } from './bundle-build-diagnostics.js'
import { MAX_STASIS_CONFIG_BYTES, STASIS_CONFIG, parseStasisConfig } from './stasis-config.ts'

const regularFile = entry => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)
const parentOf = path => posix.dirname(path).replace(/^\.$/u, '')

// The `entries` of the stasis.config.json in `directory` (parseStasisConfig's),
// null where it has none. One Stasis would refuse to read is config-invalid.
async function directoryConfig(input, github, directory, client) {
  const listing = await client.listRepoDir({ repo: github, sha: input.commit, directory: directory || undefined })
  if (!listing.some(entry => entry.path === STASIS_CONFIG && regularFile(entry))) return null
  const path = posix.join(directory, STASIS_CONFIG)
  const text = await client.getRepoFile({ repo: github, path, ref: input.commit })
  try {
    if (Buffer.byteLength(text) > MAX_STASIS_CONFIG_BYTES) throw new Error(`${path} is larger than ${MAX_STASIS_CONFIG_BYTES} bytes`)
    return parseStasisConfig(text, directory)
  } catch (error) {
    throw new Error('config-invalid', { cause: error })
  }
}

// The stasis.config.json listing the selected entries, as `{ directory,
// config }`: for each entry, the nearest one at or above it whose `entries`
// names it. null where none lists any. Entries it lists are built with their
// options there alone, as `stasis bundle` builds them: with others, or with
// another file's, they are config-mixed.
async function listingConfig(input, github, client) {
  const configs = new Map()
  const configAt = directory => {
    if (!configs.has(directory)) configs.set(directory, directoryConfig(input, github, directory, client))
    return configs.get(directory)
  }
  const found = await Promise.all(input.entries.map(async entry => {
    for (let directory = parentOf(entry); ; directory = parentOf(directory)) {
      const config = await configAt(directory)
      if (config?.has(posix.relative(`/${directory}`, `/${entry}`))) return { entry, directory, config }
      if (!directory) return { entry, directory: null }
    }
  }))
  const listed = found.find(at => at.directory !== null)
  if (!listed) return null
  const other = found.find(at => at.directory !== listed.directory)
  if (other) {
    const where = at => at.directory === null ? 'none' : posix.join(at.directory, STASIS_CONFIG)
    throw new Error('config-mixed', { cause: new Error(`${listed.entry} is listed in ${where(listed)}, ${other.entry} in ${where(other)}`) })
  }
  return { directory: listed.directory, config: listed.config }
}

// The builds of the entries `listed` (listingConfig's) lists, as `stasis
// bundle` makes them: the ones with the same options together. An entry
// setting an option that runs code is config-runs-code: nothing consents.
function configBuilds(input, { directory, config }) {
  const builds = new Map()
  for (const entry of input.entries) {
    const path = posix.relative(`/${directory}`, `/${entry}`)
    const { runs, options } = config.get(path)
    if (runs !== null) throw new Error('config-runs-code', { cause: new Error(`${posix.join(directory, STASIS_CONFIG)} sets ${runs} for ${path}`) })
    const id = JSON.stringify(options)
    if (builds.has(id)) builds.get(id).entries.push(path)
    else builds.set(id, { entries: [path], options })
  }
  return [...builds.values()]
}

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

// Prisma Client is what `prisma generate` writes, not what the repo holds: for
// a JS project whose package.json depends on a @prisma/ package, Stasis
// generates it before the scan (generate: ['prisma']).
async function prismaGenerate(input, github, project, client) {
  if (input.entries[0].endsWith('.sol')) return []
  const listing = await client.listRepoDir({ repo: github, sha: input.commit, directory: project || undefined })
  if (!listing.some(entry => entry.path === 'package.json' && regularFile(entry))) return []
  const text = await client.getRepoFile({ repo: github, path: posix.join(project, 'package.json'), ref: input.commit })
  let manifest
  try { manifest = JSON.parse(text) } catch { return [] }
  const named = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap(field => manifest?.[field] !== null && typeof manifest?.[field] === 'object' ? Object.keys(manifest[field]) : [])
  return named.some(name => name.startsWith('@prisma/')) ? ['prisma'] : []
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
  // disk. This fresh worker inherits no application credentials but NPM_TOKEN.
  setCacheDir(cacheDir ?? false)
  progress('build')
  // Entries stasis.config.json lists are built from its directory with their
  // options there, taking no conditions; others, from their project with the
  // conditions chosen.
  const listed = await listingConfig(input, github, buildClient)
  if (listed && input.conditions !== null) throw new Error('config-conditions')
  if (!listed && input.conditions === null && !input.entries[0].endsWith('.sol')) throw new Error('bad-conditions')
  const project = listed ? listed.directory : await projectDirectory(input, github, buildClient)
  if (!allowed(project)) throw new Error('build-scope')
  const builds = listed ? configBuilds(input, listed) : [{ entries: input.entries.map(entry => posix.relative(project || '.', entry)), options: {} }]
  const generate = await prismaGenerate(input, github, project, buildClient)
  let bundle
  for (const build of builds) {
    // One at a time, as `stasis bundle` builds them, into one bundle.
    const built = (await buildGitHubBundle({
      github, sha: input.commit, directory: project || undefined, entries: build.entries,
      ...input.options, ...build.options, client: buildClient, ...(cacheDir === null && { cache: false }), ...(generate.length > 0 && { generate }),
    })).bundle
    // Merged, the bundles' repo would drop a directory they don't agree on.
    if (bundle && (bundle.repo?.directory ?? '') !== (built.repo?.directory ?? '')) {
      throw new Error(`${builds[0].entries[0]} and ${build.entries[0]} can't be bundled together: their bundles' paths are relative to different directories`)
    }
    bundle = bundle ? bundle.merge(built) : built
  }
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

// The code a failed build answers with. Never upstream bodies or paths outside
// the caller's grants: those stay in the diagnostic. A missing or ambiguous
// lockfile, or the named one missing, is the lockfile's.
export function buildErrorCode(error, message) {
  if (['build-scope', 'too-large', 'bad-conditions', 'config-invalid', 'config-mixed', 'config-conditions', 'config-runs-code'].includes(message)) return message
  if (error instanceof HttpError) return error.status === 429 ? 'github-rate-limited' : 'github-build-failed'
  return /no packageManager given|lockfile installs|no (?:pnpm-lock\.yaml|yarn\.lock|package-lock\.json|soldeer\.lock) found in /u.test(message) ? 'build-lockfile' : 'build-failed'
}

if (parentPort && workerData?.type === 'managed-bundle-build') {
  // Send diagnostics to the request's parent thread, which writes them before
  // returning the HTTP response. Worker stdout can be lost on termination.
  const send = (message, transfer = []) => {
    // Node worker messages have no browser target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    parentPort.postMessage(message, transfer)
  }
  try {
    const built = await buildStasisBundle(workerData, undefined, stage => send({ type: 'progress', stage }))
    // The bytes handed over rather than copied, where they alone fill their
    // buffer (a small one may share Node's pool, which can't be moved).
    const { bytes } = built
    send(built, bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? [bytes.buffer] : [])
  } catch (error) {
    const diagnostic = bundleBuildDiagnostic(error, workerData.token)
    const code = buildErrorCode(error, diagnostic.message)
    send({ error: code, status: code === 'too-large' ? 413 : code === 'build-scope' ? 403 : code === 'bad-conditions' ? 400 : 422, diagnostic })
  }
}
