import { parentPort, workerData } from 'node:worker_threads'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { buildGitHubBundle } from '@exodus/stasis/vfs-bundle'
import { brotliOptions } from '@exodus/stasis-core/brotli'
import { HttpError, createClient } from '@preventive/upstream/github.js'
import { githubBundleFilename } from './bundle-build.ts'

export async function buildStasisBundle({ input, github, token, maxBytes, scopes }, client = createClient({ token })) {
  const allowed = path => scopes.some(scope => !scope || path === scope || path.startsWith(scope + '/'))
  // Stasis/upstream cache writes are disabled by default; this fresh worker
  // never enables a cache directory or inherits application credentials.
  const { bundle } = await buildGitHubBundle({
    github, sha: input.commit, directory: input.directory || undefined,
    entries: input.entries.map(entry => posix.relative(input.directory || '.', entry)),
    ...input.options, client,
  })
  const directory = bundle.repo?.directory ?? ''
  // A workspace lockfile may widen the build root. Never publish it under a
  // narrower team grant: the storage location must cover the actual bundle.
  if (!allowed(directory)) throw new Error('build-scope')
  const serialized = bundle.serialize()
  if (Buffer.byteLength(serialized) > 200 * 1024 * 1024) throw new Error('too-large')
  const bytes = brotliCompressSync(serialized, brotliOptions())
  if (bytes.length > maxBytes) throw new Error('too-large')
  return { bytes, directory, filename: githubBundleFilename(github, input.directory, input.commit) }
}

if (parentPort && workerData?.type === 'managed-bundle-build') {
  try {
    // Node worker messages have no browser target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    parentPort.postMessage(await buildStasisBundle(workerData))
  } catch (error) {
    // Do not return upstream bodies or paths outside the caller's grants.
    const code = ['build-scope', 'too-large'].includes(error.message) ? error.message
      : error instanceof HttpError ? (error.status === 429 ? 'github-rate-limited' : 'github-build-failed')
        : /no packageManager given|lockfile installs/u.test(error.message) ? 'build-lockfile'
          : 'build-failed'
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    parentPort.postMessage({ error: code, status: code === 'too-large' ? 413 : code === 'build-scope' ? 403 : 422 })
  }
}
