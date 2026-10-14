// Compare's diff of a JavaScript file minified on both sides with renamed
// names hidden: worked out by the server from the two files pretty-printed,
// the old one given the new one's names (server-managed/rename-diff.ts),
// whitespace changes shown and hidden both. Every pair a comparison's view
// diffs so comes in one request, the first time one is wanted, a line each as
// the server works it out; a pair it brought none of, or the file a view
// shows first while they come, is asked for alone, by both files' paths and
// their texts' hashes, as their copies are (pretty-source.js). The server
// checks its own diff (@preventive/compare's renamedDiffs); the viewer takes
// it as it is, once it names the two files asked about and, as the copies it
// was worked out from, the two the view draws. A comparison's diffs are kept
// together, for either whitespace setting, the last few comparisons' for the
// session: turning a setting on or off asks for none again.
import { computeFileHash } from '@preventive/report'
import { bundleFilesAsMap } from './bundle-sources.js'
import { fetchBundleRenameDiff, fetchBundleRenameDiffs, fetchNpmRenameDiff, fetchNpmRenameDiffs } from './client-managed.js'

// Comparisons whose diffs are kept, the one read last last, each holding
// every pair of its files diffed so far.
const KEPT_COMPARISONS = 2
// Diffs asked for alone at once: as many as the server works out at once
// (server-managed/rename-diff.ts), the rest waiting their turn, in the order
// asked; one the server kept comes back at once.
const MAX_FETCHES = 2
// A failure that may pass (the server busy, a timeout) is asked again on a
// paint this long after it came, twice as long each time it fails again.
const RETRY_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000
// How long diffs that come close together wait for each other, to be told
// to the view that asked at once.
const TELL_MS = 30

// What an answer not shaped as the server answers, for other files than those
// asked about, or of other copies than those drawn, is told as.
const MISMATCH = "The server's diff doesn't match this file as shown."

// Whether the server can diff a comparison's files: both a managed bundle's,
// or both a version's of one npm package.
export const renameDiffable = (base, other) => !!(base?.managedId && other?.managedId)
  || (!!base?.npm && !!other?.npm && base.npm.name === other.npm.name)

// Whether asking again for a diff that failed with `status` may succeed.
const retryable = status => !(status >= 400 && status < 500 && status !== 429)

// Comparisons by both sides' integrity: `diffs` by both files' paths, each
// `{ status: 'loading' }`, `{ status: 'ready', before, reason, reads, copies,
// settings }` (the old side as diffed, why its names are its own where they
// could not be given safely, the properties through which either side reads
// names, the hashes of the copies it was worked out from, and with whitespace
// changes shown and hidden, `{ status: 'ready', before, blocks, marks,
// reason, reads }` as a view reads it: the change blocks, and the blocks of
// the diff of the files as they are that differ in renamed names alone), or
// `{ status: 'error', message, retry }`, `retry` where asking again may
// succeed, then `until` when; `tries` the failures before, for how long
// until then. `notify`, the view that last asked; `ended` once its request
// ended, and `rest`, the failure every pair it brought none of has where it
// failed, asked for again a while after where that may succeed.
const comparisons = new Map()

// An answer as the server shapes it, as a diff kept: null for one shaped
// otherwise, or naming other files than `hash` and `otherHash`.
function readAnswer(answer, hash, otherHash) {
  const { before, reason, reads, prettyHash, otherPrettyHash, ignoringWhitespace } = answer ?? {}
  const sets = [answer, ignoringWhitespace].map(set => (Array.isArray(set?.blocks) && Array.isArray(set.marks) ? { blocks: set.blocks, marks: set.marks } : null))
  if (!(answer?.hash === hash && answer.otherHash === otherHash && typeof before === 'string' && (reason == null || typeof reason === 'string')
    && Array.isArray(reads) && reads.every(read => typeof read === 'string') && sets.every(Boolean)
    && typeof prettyHash === 'string' && typeof otherPrettyHash === 'string')) return null
  const settings = sets.map(set => ({ status: 'ready', before, ...set, reason: reason ?? null, reads }))
  return { status: 'ready', before, reason: reason ?? null, reads, copies: [prettyHash, otherPrettyHash], settings }
}

const fileHash = (details, path, text) => details.fileHashes?.get(path) ?? computeFileHash(text)

// Views to tell of diffs come, each once, a little after the first of them.
const told = new Set()
function tell(notify) {
  if (!notify) return
  if (told.size === 0) {
    setTimeout(() => {
      const views = [...told]
      told.clear()
      for (const view of views) view()
    }, TELL_MS)
  }
  told.add(notify)
}

// A failure that may pass, given when it is asked again (`until`), counting
// `tries`, the view that last asked painted again then.
function due(comparison, failure, tries = 0) {
  const wait = Math.min(RETRY_MS * 2 ** tries, RETRY_MAX_MS)
  Object.assign(failure, { until: Date.now() + wait, tries: tries + 1 })
  setTimeout(() => { comparison.notify?.() }, wait)?.unref?.()
  return failure
}

// Past KEPT_COMPARISONS, the least recent whose request ended.
function evict() {
  for (const [key, comparison] of comparisons) {
    if (comparisons.size <= KEPT_COMPARISONS) break
    if (comparison.ended) comparisons.delete(key)
  }
}

// Every pair a comparison's view diffs with renamed names hidden, in one
// request: each kept as it comes, where it names its two sides' files as they
// are and the pair has none yet but one asked for alone meanwhile (a failure
// keeps its own wait), unless asked for again while it was read, which leaves
// the pair to that newer ask; and one the server couldn't diff now, as it was
// busy, left to be asked for alone once this ends; where the request failed,
// what every pair it brought none of has, the comparison asked for again a
// while after where that may succeed.
async function loadComparison(key, comparison, base, other, scope) {
  let rest = null
  try {
    const line = async ({ path, otherPath, hash, otherHash, status, message, ...answer }) => {
      if (typeof path !== 'string' || typeof otherPath !== 'string') return
      const pair = `${path}\0${otherPath}`
      // The pair as it was when this came: none yet, or one asked for alone, on its way.
      const found = comparison.diffs.get(pair)
      if ((found?.status ?? 'loading') !== 'loading') return
      const [olds, news] = [bundleFilesAsMap(base).get(path), bundleFilesAsMap(other).get(otherPath)]
      const diff = message === undefined
        ? typeof olds === 'string' && typeof news === 'string' && readAnswer({ ...answer, hash, otherHash }, await fileHash(base, path, olds), await fileHash(other, otherPath, news))
        : !retryable(status) && { status: 'error', message, retry: false }
      // Asked for again while this was read, the pair is the newer ask's to answer.
      if (!diff || comparison.diffs.get(pair) !== found) return
      // In place of one asked for alone again, its failures before carried on.
      diff.tries = comparison.diffs.get(pair)?.tries
      comparison.diffs.set(pair, diff)
      tell(comparison.notify)
    }
    await (base.npm ? fetchNpmRenameDiffs(base.npm.name, base.npm.version, other.npm.version, line)
      : fetchBundleRenameDiffs(base.managedId, other.managedId, line, { scope }))
  } catch (err) {
    // A session that changed asks again under the new one, on its render.
    if (err?.name === 'AbortError') {
      if (comparisons.get(key) === comparison) comparisons.delete(key)
      return
    }
    rest = { status: 'error', message: err?.message ?? String(err), retry: retryable(err?.status) }
  }
  Object.assign(comparison, { ended: true, rest })
  if (rest?.retry) due(comparison, rest, comparison.tries)
  tell(comparison.notify)
  evict()
}

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

// One pair asked for alone, kept with its comparison's.
async function load(comparison, pair, asked, base, basePath, before, other, path, after) {
  let next
  try {
    const [hash, otherHash] = await Promise.all([fileHash(base, basePath, before), fileHash(other, path, after)])
    const params = { path: basePath, hash, otherPath: path, otherHash }
    const answer = await inTurn(() => (base.npm
      ? fetchNpmRenameDiff(base.npm.name, base.npm.version, other.npm.version, params)
      : fetchBundleRenameDiff(base.managedId, other.managedId, params)))
    next = readAnswer(answer, hash, otherHash) ?? { status: 'error', message: MISMATCH, retry: true }
    next.tries = asked.tries
  } catch (err) {
    // A session that changed asks again under the new one, on its render.
    if (err?.name === 'AbortError') {
      if (comparison.diffs.get(pair) === asked) comparison.diffs.delete(pair)
      return
    }
    next = { status: 'error', message: err?.message ?? String(err), retry: retryable(err?.status) }
  }
  if (comparison.diffs.get(pair) !== asked) return
  if (next.status === 'error' && next.retry) due(comparison, next, asked.tries)
  comparison.diffs.set(pair, next)
  tell(comparison.notify)
}

// A file's diff with renamed names hidden, whitespace changes shown or hidden
// as `ignoreWhitespace` asks, `basePath` and `before` its base side's path and
// text, `path` and `after` the other's: its comparison's asked for the first
// time one of them is wanted, and the file alone where its comparison's came
// without it, or while they come where the view shows it first (`alone`),
// `notify` called once it comes. Taken only where the copies it was worked
// out from are those the view draws, as `drawn` names them (their hashes),
// its blocks else of other lines: told as an error then, asked for again
// alone a while after. A text other than its side's file, as Compare shows
// one side's for both where an importer was captured on one, has none. A
// comparison within a reason `scope` (bundle-comparison.js) has its pairs
// found within it, apart from the whole bundles'.
export function renameDiff(base, basePath, before, other, path, after, ignoreWhitespace, notify, drawn, alone = false, scope = '') {
  const key = `${base.integrity}\0${other.integrity}\0${scope}`
  let comparison = comparisons.get(key)
  comparisons.delete(key)
  // One whose request failed for a reason that may have passed asked for
  // again once due, the pairs it brought kept.
  if (!comparison || (comparison.rest?.until !== undefined && Date.now() >= comparison.rest.until)) {
    comparison = { diffs: comparison?.diffs ?? new Map(), notify: null, ended: false, rest: null, tries: comparison?.rest?.tries }
    loadComparison(key, comparison, base, other, scope)
  }
  comparisons.set(key, comparison)
  evict()
  comparison.notify = notify
  if (before !== bundleFilesAsMap(base).get(basePath) || after !== bundleFilesAsMap(other).get(path)) return { status: 'error', message: MISMATCH, retry: false }
  const pair = `${basePath}\0${path}`
  let diff = comparison.diffs.get(pair)
  if (!diff && !comparison.ended && !alone) return { status: 'loading' }
  if (!diff && comparison.rest) return comparison.rest
  // Worked out from the copies drawn, it is taken, the failures before it
  // forgotten, so one after starts its wait anew; from others (printed again
  // since, as a formatter changed), asked for again alone, as a failure that
  // may pass is, its wait growing while the server answers so.
  if (diff?.status === 'ready') {
    if (diff.copies[0] === drawn?.[0] && diff.copies[1] === drawn?.[1]) {
      diff.tries = 0
      return diff.settings[Number(ignoreWhitespace)]
    }
    diff = due(comparison, { status: 'error', message: MISMATCH, retry: true }, diff.tries)
    comparison.diffs.set(pair, diff)
  }
  // One that failed for a reason that may have passed, asked again once due.
  if (diff && !(diff.status === 'error' && diff.until !== undefined && Date.now() >= diff.until)) return diff
  const asked = { status: 'loading', tries: diff?.tries }
  comparison.diffs.set(pair, asked)
  load(comparison, pair, asked, base, basePath, before, other, path, after)
  return asked
}

// Turned back on, "Hide renamed names" asks again for diffs that failed for a
// reason that may have passed: a comparison's all again, where its request
// failed so.
export function retryRenameDiffs() {
  for (const [key, comparison] of comparisons) {
    if (comparison.rest?.retry) comparisons.delete(key)
    else for (const [pair, diff] of comparison.diffs) if (diff.status === 'error' && diff.retry) comparison.diffs.delete(pair)
  }
}
