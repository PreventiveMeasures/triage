// One comparison model for Compare and Review (common/bundle-comparison.js
// prepareComparison): two managed bundles', or a package version's against
// another or none, as the server pairs their files
// (server-managed/comparison.ts), the viewer pairing none of them; two
// bundles opened here, which no server holds, as this viewer pairs them, in a
// chunk loaded only for those (bundle-comparison-local.js). Kept for the last
// few comparisons, for the session; a failure that may pass is asked again a
// while after, its view painted again then.
import { fetchBundleComparison, fetchNpmComparison } from './client-managed.js'

// Comparisons kept, the one read last last; each holds every file each side differs in.
const KEPT_COMPARISONS = 4
const RETRY_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

const retryable = status => !(status >= 400 && status < 500 && status !== 429)

// Review's side for a package's first version, with no files (npm-review.js EMPTY_REVIEW_BASE).
const empty = details => details?.integrity === '(empty)'

// Comparisons by both sides and scope, the server's by both sides' integrity,
// those worked out here by both details read, as nothing else names their
// content: `state` as a view reads it,
// `{ status: 'loading' }`, `{ status: 'ready', diff }` or `{ status: 'error',
// message }`; `notify`, the view that last asked, and `waiting`, those that
// wait for it whole (bundleComparisonDiff), told once it comes; `retryAt`
// where it failed for a reason that may pass; `failures` in a row before it.
const comparisons = new Map()

// Past KEPT_COMPARISONS, the least recent no longer coming.
function evict() {
  for (const [key, comparison] of comparisons) {
    if (comparisons.size <= KEPT_COMPARISONS) break
    if (comparison.state.status !== 'loading') comparisons.delete(key)
  }
}

// Its view and those waiting for it, told.
function tell(comparison) {
  comparison.notify?.()
  for (const waiter of comparison.waiting.splice(0)) waiter()
}

// The pairing of bundles opened here, once its chunk is loaded: worked out at once then.
let local = null

// Whether the server pairs a comparison: of two managed bundles, or of a
// package version against another, of the same package or not, or against none.
const served = (base, other) => !!(base.managedId && other.managedId) || !!(other.npm && (base.npm || empty(base)))

// The comparison as it is had: asked of the server where it pairs it, else
// worked out here, its chunk loaded first.
function pair(base, other, scope) {
  if (base.managedId && other.managedId) return fetchBundleComparison(base.managedId, other.managedId, { scope })
  if (served(base, other)) {
    return fetchNpmComparison(other.npm.name, other.npm.version, base.npm?.version ?? '(empty)', { otherName: base.npm?.name ?? other.npm.name })
  }
  return import('./bundle-comparison-local.js').then(module => {
    local = module
    return module.prepareComparison(base, other, scope)
  })
}

async function load(key, comparison, base, other, scope) {
  let state
  try { state = { status: 'ready', diff: await pair(base, other, scope) } }
  catch (err) {
    // A session that changed asks again under the new one, as its view, told, asks.
    if (err?.name === 'AbortError') {
      if (comparisons.get(key) === comparison) comparisons.delete(key)
      tell(comparison)
      return
    }
    state = { status: 'error', message: err?.message ?? String(err) }
    if (retryable(err?.status)) {
      const wait = Math.min(RETRY_MS * 2 ** comparison.failures, RETRY_MAX_MS)
      Object.assign(comparison, { retryAt: Date.now() + wait, failures: comparison.failures + 1 })
      setTimeout(() => { comparison.notify?.() }, wait)?.unref?.()
    }
  }
  if (state.status === 'ready') comparison.failures = 0
  comparison.state = state
  tell(comparison)
  evict()
}

// A number for each details read, as comparisons worked out here are kept by.
const read = new WeakMap()
let reads = 0
const readOf = details => {
  if (!read.has(details)) read.set(details, ++reads)
  return read.get(details)
}

// The comparison of `base` with `other`, within a reason `scope` where given,
// asked for where none is kept, or one that failed for a reason that may pass
// is due again; the one read last.
function comparisonOf(base, other, scope) {
  const key = served(base, other) ? `${base.integrity}\0${other.integrity}\0${scope ?? ''}` : `${readOf(base)}\0${readOf(other)}\0${scope ?? ''}\0here`
  let comparison = comparisons.get(key)
  comparisons.delete(key)
  if (!comparison || (comparison.retryAt !== undefined && Date.now() >= comparison.retryAt)) {
    comparison = { state: { status: 'loading' }, notify: comparison?.notify ?? null, waiting: [], failures: comparison?.failures ?? 0 }
    if (local && !served(base, other)) comparison.state = { status: 'ready', diff: local.prepareComparison(base, other, scope ?? '') }
    else load(key, comparison, base, other, scope ?? '')
  }
  comparisons.set(key, comparison)
  evict()
  return comparison
}

// The comparison of `base` with `other`, within a reason `scope` (a Stasis
// bundle's `reason:<tree>`) where given, as a view reads it: loading, ready
// with its `diff`, or failed with a `message`; `notify` called once it comes.
export function bundleComparison(base, other, scope, notify) {
  const comparison = comparisonOf(base, other, scope)
  comparison.notify = notify
  return comparison.state
}

// The same, as its `diff` once it comes, for a view that opens on it whole:
// rejected where it fails.
export function bundleComparisonDiff(base, other, scope = null) {
  return new Promise((resolve, reject) => {
    const settle = () => {
      const comparison = comparisonOf(base, other, scope), { state } = comparison
      if (state.status === 'loading') comparison.waiting.push(settle)
      else if (state.status === 'ready') resolve(state.diff)
      else reject(new Error(state.message))
    }
    settle()
  })
}
