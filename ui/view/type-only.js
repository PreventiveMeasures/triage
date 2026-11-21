// Which of a comparison's files changed in types alone, as the server proves
// (server-managed/type-only.ts: @preventive/compare's compareTrees stamps
// `typeOnly`, which needs Node), and which but for what runs, with the lines
// holding it: asked for once per comparison of two managed bundles or two
// versions of a package, the first time one of its TypeScript files is
// drawn, hidden or not, as Compare offers to hide them only where there are
// any; each taken where it names the files shown, by their hashes. The last
// few comparisons' are kept.
import { computeFileHash } from '@preventive/report'
import { prettyExtension } from '../../common/pretty-print.js'
import { bundleFilesAsMap } from '../../common/bundle-sources.js'
import { fetchBundleTypeOnly, fetchNpmTypeOnly } from './client-managed.js'
import { renameDiffable } from './rename-diff.js'
import { aborted, evict, retrier, retryable, touch } from './server-asks.js'
import { weakNotify } from './weak-notify.js'

// Comparisons whose proofs are kept, the one read last last.
const KEPT_COMPARISONS = 2
// TypeScript files, as the server reads them by extension: none other is proven.
const TYPESCRIPT = new Set(['ts', 'mts', 'cts'])

// A failure that may pass: not a refusal, nor a server whose Node proves
// nothing (501 proof-unsupported, server-managed/type-only.ts), as it won't.
const provingMayPass = status => status !== 501 && retryable(status)
// Review's base where it has none (npm-review.js EMPTY_REVIEW_BASE): a version
// is proven against no files, each of its own added, as against an empty one.
const emptyBase = details => details?.integrity === '(empty)'
// Whether the server proves a comparison's files: two managed bundles', or
// two versions' of one npm package (renameDiffable), or a version's alone.
const provable = (base, other) => renameDiffable(base, other) || (emptyBase(base) && !!other?.npm)
// A pair by both files' paths, a side not there empty.
const pairOf = (path, otherPath) => `${path ?? ''}\0${otherPath ?? ''}`

// Comparisons by both sides' integrity: `files`, the pairs proven, as pairOf
// names them, each `true` or the lines holding what runs; `notify`, the view
// that last asked; `ended` once its request ended. A failure that may pass is
// asked again a while after (server-asks.js retrier), its view painted then.
const comparisons = new Map()
const retried = retrier()

// Whether a side is as a line names it: its file of that hash, or none there.
async function named(details, path, hash) {
  if (path === null) return hash === null
  const text = typeof path === 'string' ? bundleFilesAsMap(details).get(path) : undefined
  return typeof text === 'string' && hash === await (details.fileHashes?.get(path) ?? computeFileHash(text))
}

// Lines `[from, to)` as the server tells them, in order, apart, a side not
// there none: else none are taken.
const ranges = (told, there) => Array.isArray(told) && (there || told.length === 0)
  && told.every((range, i) => Array.isArray(range) && range.length === 2 && range.every(Number.isSafeInteger) && range[0] >= (i > 0 ? told[i - 1][1] : 0) && range[0] < range[1])

// A comparison's proofs, each kept where it names both its sides' files as
// they are, all taken at once as its request ends: `true` for a change in
// types alone, else its sides' lines that hold what runs (`runs`, `otherRuns`),
// none taken that don't read as lines of those sides. Where it failed for a
// reason that may pass, asked for again a while after.
async function load(key, comparison, base, other, scope) {
  let failed = false
  const files = new Map()
  try {
    const line = async ({ path, hash, otherPath, otherHash, runs, otherRuns }) => {
      if (path === undefined || otherPath === undefined || (path ?? otherPath) === null) return
      const lines = runs === undefined && otherRuns === undefined ? true : ranges(runs, path !== null) && ranges(otherRuns, otherPath !== null) && { runs, otherRuns }
      if (lines && await named(base, path, hash) && await named(other, otherPath, otherHash)) files.set(pairOf(path, otherPath), lines)
    }
    await (base.npm ? fetchNpmTypeOnly(base.npm.name, base.npm.version, other.npm.version, line)
      : emptyBase(base) ? fetchNpmTypeOnly(other.npm.name, other.npm.version, '(empty)', line)
      : fetchBundleTypeOnly(base.managedId, other.managedId, line, { scope }))
  } catch (err) {
    if (aborted(err)) {
      if (comparisons.get(key) === comparison) comparisons.delete(key)
      return
    }
    failed = provingMayPass(err?.status)
  }
  Object.assign(comparison, { files, ended: true })
  retried(key, failed, () => comparisons.get(key) === comparison && comparisons.delete(key), () => comparison.notify)
  comparison.notify?.()
  evict(comparisons, KEPT_COMPARISONS, ended => ended.ended)
}

// What the server proved of a file of a comparison, `entry` as Compare lists
// it and `contents` its two sides' texts: `true` where it changed in types
// alone; where it changed in types alone but for what runs, the lines holding
// that on each side, `{ runs, otherRuns }`, each `[from, to)` of its side's
// lines counted from zero, none for a side not there, the same object while
// the proof is kept; else nothing (undefined), as till that came, and for a
// file other than TypeScript on either side there, or a text other than its
// side's file. `notify` called once it came. A comparison within a reason
// `scope` (bundle-comparison.js) has those of the files it compares within
// it, apart from the whole bundles'.
export function typeProof(base, other, path, { kind, basePath = path }, { before, after }, notify, scope = '') {
  if (kind === 'repointed' || !provable(base, other)) return undefined
  const sides = [kind === 'added' ? null : basePath, kind === 'removed' ? null : path]
  if (!sides.every(file => file === null || TYPESCRIPT.has(prettyExtension(file)))) return undefined
  if ((sides[0] !== null && before !== bundleFilesAsMap(base).get(basePath)) || (sides[1] !== null && after !== bundleFilesAsMap(other).get(path))) return undefined
  const key = `${base.integrity}\0${other.integrity}\0${scope}`
  const comparison = touch(comparisons, key, KEPT_COMPARISONS, ended => ended.ended, () => {
    const made = { files: new Map(), notify: null, ended: false }
    load(key, made, base, other, scope)
    return made
  })
  comparison.notify = weakNotify(notify)
  return comparison.files.get(pairOf(...sides))
}
