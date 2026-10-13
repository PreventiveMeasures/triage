// Compare's diff of a JavaScript file minified on both sides with renamed
// names hidden: worked out by the server from the two files pretty-printed,
// the old one given the new one's names (server-managed/rename-diff.ts),
// asked for by both files' paths and their texts' hashes, as their copies are
// (pretty-source.js). The server checks its own diff (@preventive/compare's
// renamedDiff); the viewer takes it as it is, once it names the two files
// asked about and, as the copies it was worked out from, the two the view
// draws, and keeps the last few it read, for the session.
import { computeFileHash } from '@preventive/report'
import { fetchBundleRenameDiff, fetchNpmRenameDiff } from './client-managed.js'

// Diffs kept, the one read last last; a view asks again on every paint for
// those it shows.
const KEPT_DIFFS = 16
// Diffs asked of the server at once: as many as it works out at once
// (server-managed/rename-diff.ts). The rest wait their turn, in the order
// asked, as a view asks for all it shows (Compare's Diff view, every file
// minified on both sides); one the server kept comes back at once.
const MAX_FETCHES = 2
// A failure that may pass (the server busy, a timeout) is asked again on a
// paint this long after it came, twice as long each time it fails again.
const RETRY_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

// Diffs by both sides' integrity and path and the whitespace setting:
// `{ status: 'loading' }`, `{ status: 'ready', before, blocks, reason, reads,
// marks, copies }` (the old side as diffed, the change blocks, why its names
// are its own where they could not be given safely, the properties through
// which either side reads names, the blocks of the diff of the files as they
// are that differ in renamed names alone, and the hashes of the copies it was
// worked out from), or `{ status: 'error', message, retry }`,
// `retry` where asking again may succeed (the server busy, a timeout), then
// `until` when, `tries` the failures so far.
const diffs = new Map()
// What a diff asked for calls once it comes: the view that last asked.
const notifiers = new Map()

// What an answer not shaped as the server answers, for other files than those
// asked about, or of other copies than those drawn, is told as.
const MISMATCH = "The server's diff doesn't match this file as shown."

// Whether the server can diff a comparison's files: both a managed bundle's,
// or both a version's of one npm package.
export const renameDiffable = (base, other) => !!(base?.managedId && other?.managedId)
  || (!!base?.npm && !!other?.npm && base.npm.name === other.npm.name)

let fetches = 0
const turns = []

async function inTurn(work) {
  if (fetches < MAX_FETCHES) fetches++
  else await new Promise(resolve => { turns.push(resolve) })
  try { return await work() }
  finally {
    const next = turns.shift()
    if (next) next()
    else fetches--
  }
}

// Diffs asked for in the task now running and in the last one that asked, as
// a view painting asks for all it shows: kept past KEPT_DIFFS, as are those
// still coming, so a view showing more than that never drops one it shows and
// asks for it again.
let asking = false, wanted = new Set(), wantedBefore = new Set()

function want(key) {
  if (!asking) {
    asking = true
    wantedBefore = wanted
    wanted = new Set()
    setTimeout(() => { asking = false })
  }
  wanted.add(key)
}

async function load(key, asked, base, basePath, before, other, path, after, ignoreWhitespace) {
  let next
  try {
    const [hash, otherHash] = await Promise.all([[base, basePath, before], [other, path, after]]
      .map(([details, file, text]) => details.fileHashes?.get(file) ?? computeFileHash(text)))
    const params = { path: basePath, hash, otherPath: path, otherHash, ignoreWhitespace }
    const answer = await inTurn(() => base.npm
      ? fetchNpmRenameDiff(base.npm.name, base.npm.version, other.npm.version, params)
      : fetchBundleRenameDiff(base.managedId, other.managedId, params))
    const { before: renamed, blocks, reason, reads, marks, prettyHash, otherPrettyHash } = answer
    next = answer.hash === hash && answer.otherHash === otherHash && typeof renamed === 'string' && Array.isArray(blocks)
      && (reason == null || typeof reason === 'string') && Array.isArray(reads) && reads.every(read => typeof read === 'string') && Array.isArray(marks)
      && typeof prettyHash === 'string' && typeof otherPrettyHash === 'string'
      ? { status: 'ready', before: renamed, blocks, reason: reason ?? null, reads, marks, copies: [prettyHash, otherPrettyHash] }
      : { status: 'error', message: MISMATCH, retry: true }
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
  const notify = notifiers.get(key)
  if (next.status === 'error' && next.retry) {
    const wait = Math.min(RETRY_MS * 2 ** (asked.tries ?? 0), RETRY_MAX_MS)
    Object.assign(next, { until: Date.now() + wait, tries: (asked.tries ?? 0) + 1 })
    // Painted again then, to ask again.
    if (notify) setTimeout(notify, wait)?.unref?.()
  }
  diffs.set(key, next)
  notifiers.delete(key)
  evict()
  notify?.()
}

// Past KEPT_DIFFS, the least recent no view waits for: as one is asked for,
// and as one comes that may be wanted no longer.
function evict() {
  for (const [old, kept] of diffs) {
    if (diffs.size <= KEPT_DIFFS) break
    if (wanted.has(old) || wantedBefore.has(old) || kept.status === 'loading') continue
    diffs.delete(old)
    notifiers.delete(old)
  }
}

// A file's diff with renamed names hidden, `basePath` and `before` its base
// side's path and text, `path` and `after` the other's, asked for the first
// time it is wanted, `notify` called once it comes; taken only where the
// copies it was worked out from are those the view draws, as `drawn` names
// them (their hashes), its blocks else of other lines: told as an error then,
// asked for again with the rest.
export function renameDiff(base, basePath, before, other, path, after, ignoreWhitespace, notify, drawn) {
  const key = `${base.integrity}\0${basePath}\0${other.integrity}\0${path}\0${ignoreWhitespace}`
  const asked = diffs.get(key)
  // One that failed for a reason that may have passed, asked again once due.
  const due = asked?.status === 'error' && asked.until !== undefined && Date.now() >= asked.until
  let diff = asked && !due ? asked : { status: 'loading', tries: asked?.tries }
  if (diff.status === 'ready' && !(diff.copies[0] === drawn?.[0] && diff.copies[1] === drawn?.[1])) diff = { status: 'error', message: MISMATCH, retry: true }
  diffs.delete(key)
  diffs.set(key, diff)
  want(key)
  if (diff.status === 'loading') notifiers.set(key, notify)
  if (!asked || due) load(key, diff, base, basePath, before, other, path, after, ignoreWhitespace)
  evict()
  return diff
}

// Turned back on, "Hide renamed names" asks again for diffs that failed for a
// reason that may have passed.
export function retryRenameDiffs() {
  for (const [key, diff] of diffs) if (diff.status === 'error' && diff.retry) diffs.delete(key)
}
