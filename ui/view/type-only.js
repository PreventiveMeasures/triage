// Which of a comparison's files changed in types alone, as the server proves
// them (server-managed/type-only.ts: @preventive/compare's compareTrees
// stamps `typeOnly`, which needs Node and so can't be proven here): asked for
// once per comparison of two managed bundles or two versions of a package,
// the first time one of its TypeScript files is drawn, whether or not those
// changes are hidden, as Compare offers to hide them only where there are
// any; each taken where it names the files the view shows, by their hashes.
// Kept for the last few comparisons, for the session.
import { computeFileHash } from '@preventive/report'
import { prettyExtension } from '../../common/pretty-print.js'
import { bundleFilesAsMap } from './bundle-sources.js'
import { fetchBundleTypeOnly, fetchNpmTypeOnly } from './client-managed.js'
import { renameDiffable } from './rename-diff.js'

// Comparisons whose proofs are kept, the one read last last.
const KEPT_COMPARISONS = 2
// A failure that may pass is asked again this long after it came, twice as
// long each time it fails again, its view painted again then.
const RETRY_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000
// TypeScript files, as the server reads them by extension: none other is proven.
const TYPESCRIPT = new Set(['ts', 'mts', 'cts'])

const retryable = status => !(status >= 400 && status < 500 && status !== 429)
// A pair by both files' paths, a side not there empty.
const pairOf = (path, otherPath) => `${path ?? ''}\0${otherPath ?? ''}`

// Comparisons by both sides' integrity: `files`, the pairs proven, as pairOf
// names them; `notify`, the view that last asked; `ended` once its request
// ended. Failures in a row, by comparison.
const comparisons = new Map()
const failures = new Map()

// Past KEPT_COMPARISONS, the least recent whose request ended.
function evict() {
  for (const [key, comparison] of comparisons) {
    if (comparisons.size <= KEPT_COMPARISONS) break
    if (comparison.ended) comparisons.delete(key)
  }
}

// Whether a side is as a line names it: its file of that hash, or none there.
async function named(details, path, hash) {
  if (path === null) return hash === null
  const text = typeof path === 'string' ? bundleFilesAsMap(details).get(path) : undefined
  return typeof text === 'string' && hash === await (details.fileHashes?.get(path) ?? computeFileHash(text))
}

// A comparison's proofs, each kept where it names both its sides' files as
// they are, all taken at once as its request ends; where it failed for a
// reason that may pass, asked for again a while after.
async function load(key, comparison, base, other, scope) {
  let failed = false
  const files = new Set()
  try {
    const line = async ({ path, hash, otherPath, otherHash }) => {
      if (path === undefined || otherPath === undefined || (path ?? otherPath) === null) return
      if (await named(base, path, hash) && await named(other, otherPath, otherHash)) files.add(pairOf(path, otherPath))
    }
    await (base.npm ? fetchNpmTypeOnly(base.npm.name, base.npm.version, other.npm.version, line) : fetchBundleTypeOnly(base.managedId, other.managedId, line, { scope }))
  } catch (err) {
    // A session that changed asks again under the new one, on its render.
    if (err?.name === 'AbortError') {
      if (comparisons.get(key) === comparison) comparisons.delete(key)
      return
    }
    failed = retryable(err?.status)
  }
  Object.assign(comparison, { files, ended: true })
  if (failed) {
    const tries = failures.get(key) ?? 0
    failures.set(key, tries + 1)
    setTimeout(() => {
      if (comparisons.get(key) !== comparison) return
      comparisons.delete(key)
      comparison.notify?.()
    }, Math.min(RETRY_MS * 2 ** tries, RETRY_MAX_MS))?.unref?.()
  } else failures.delete(key)
  comparison.notify?.()
  evict()
}

// Whether a file of a comparison, `entry` as Compare lists it and `contents`
// its two sides' texts, changed in types alone, as the server proved: false
// till that came, and for a file other than TypeScript on either side there,
// or a text other than its side's file. `notify` called once it came. A
// comparison within a reason `scope` (bundle-comparison.js) has those of the
// files it compares within it, apart from the whole bundles'.
export function typeOnly(base, other, path, { kind, basePath = path }, { before, after }, notify, scope = '') {
  if (kind === 'repointed' || !renameDiffable(base, other)) return false
  const sides = [kind === 'added' ? null : basePath, kind === 'removed' ? null : path]
  if (!sides.every(file => file === null || TYPESCRIPT.has(prettyExtension(file)))) return false
  if ((sides[0] !== null && before !== bundleFilesAsMap(base).get(basePath)) || (sides[1] !== null && after !== bundleFilesAsMap(other).get(path))) return false
  const key = `${base.integrity}\0${other.integrity}\0${scope}`
  let comparison = comparisons.get(key)
  comparisons.delete(key)
  if (!comparison) {
    comparison = { files: new Set(), notify: null, ended: false }
    load(key, comparison, base, other, scope)
  }
  comparisons.set(key, comparison)
  evict()
  comparison.notify = notify
  return comparison.files.has(pairOf(...sides))
}
