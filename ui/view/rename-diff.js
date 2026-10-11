// Compare's diff of a JavaScript file minified on both sides with renamed
// names hidden: worked out by the server from the two files pretty-printed,
// the old one given the new one's names (server-managed/rename-diff.ts),
// asked for by both files' paths and their texts' hashes, as their copies are
// (pretty-source.js). The viewer keeps the last few it read, for the session.
import { computeFileHash } from '@preventive/report'
import { fetchBundleRenameDiff, fetchNpmRenameDiff } from './client-managed.js'

// Diffs kept, the one read last last; a view asks again on every paint for
// those it shows.
const KEPT_DIFFS = 16

// Diffs by both sides' integrity and path and the whitespace setting:
// `{ status: 'loading' }`, `{ status: 'ready', before, blocks, reason }` (the
// old side as diffed, the change blocks, and why its names are its own where
// they could not be given safely), or `{ status: 'error', message, retry }`,
// `retry` where asking again may succeed (the server busy, a timeout).
const diffs = new Map()
// What a diff asked for calls once it comes: the view that last asked.
const notifiers = new Map()

// Whether the server can diff a comparison's files: both a managed bundle's,
// or both a version's of one npm package.
export const renameDiffable = (base, other) => !!(base?.managedId && other?.managedId)
  || (!!base?.npm && !!other?.npm && base.npm.name === other.npm.name)

async function load(key, asked, base, basePath, before, other, path, after, ignoreWhitespace) {
  let next
  try {
    const [hash, otherHash] = await Promise.all([[base, basePath, before], [other, path, after]]
      .map(([details, file, text]) => details.fileHashes?.get(file) ?? computeFileHash(text)))
    const params = { path: basePath, hash, otherPath: path, otherHash, ignoreWhitespace }
    const { before: renamed, blocks, reason } = base.npm
      ? await fetchNpmRenameDiff(base.npm.name, base.npm.version, other.npm.version, params)
      : await fetchBundleRenameDiff(base.managedId, other.managedId, params)
    next = { status: 'ready', before: renamed, blocks, reason }
  } catch (err) {
    // A session that changed asks again under the new one, on its render.
    if (err?.name === 'AbortError') {
      if (diffs.get(key) === asked) {
        diffs.delete(key)
        notifiers.delete(key)
      }
      return
    }
    next = { status: 'error', message: err?.message ?? String(err), retry: !(err?.status >= 400 && err.status < 500 && err.status !== 429) }
  }
  if (diffs.get(key) !== asked) return
  diffs.set(key, next)
  const notify = notifiers.get(key)
  notifiers.delete(key)
  notify?.()
}

// A file's diff with renamed names hidden, `basePath` and `before` its base
// side's path and text, `path` and `after` the other's, asked for the first
// time it is wanted, `notify` called once it comes.
export function renameDiff(base, basePath, before, other, path, after, ignoreWhitespace, notify) {
  const key = `${base.integrity}\0${basePath}\0${other.integrity}\0${path}\0${ignoreWhitespace}`
  const asked = diffs.get(key)
  const diff = asked ?? { status: 'loading' }
  diffs.delete(key)
  diffs.set(key, diff)
  if (diff.status === 'loading') notifiers.set(key, notify)
  if (!asked) load(key, diff, base, basePath, before, other, path, after, ignoreWhitespace)
  for (const [old, kept] of diffs) {
    if (diffs.size <= KEPT_DIFFS) break
    if (kept.status === 'loading' || old === key) continue
    diffs.delete(old)
    notifiers.delete(old)
  }
  return diff
}

// Turned back on, "Hide renamed names" asks again for diffs that failed for a
// reason that may have passed.
export function retryRenameDiffs() {
  for (const [key, diff] of diffs) if (diff.status === 'error' && diff.retry) diffs.delete(key)
}
