// Minified files pretty-printed in the Code tab while its toggle is on
// (state.bundleSourcePretty), formatted by the server once and kept there
// (server-managed/pretty-print.ts), each taken where the server names the
// file it formatted as the one shown: a managed bundle's asked for a file at
// a time, by its path and its text's hash; an npm version's all in one
// request, the first time one is wanted. Compare has every file that changed
// between its two bundles or versions, both sides', in one request too, on or
// off. The viewer keeps the last few bundle copies it read, and the last few
// versions' and comparisons', for the session; a copy's line numbers are its
// own, so the file's line links and marks stay with the file as published.
// JSON is formatted here instead, in any bundle, and a source map listed
// (VIEWER_KINDS), a comparison's two listings drawn only where their diff
// reads back to the new map (comparedListingRefusal).
import { html } from 'lit'
import { computeFileHash } from '@preventive/report'
import { state } from '#client/index.js'
import { bundleFilesAsMap } from '../../common/bundle-sources.js'
import { jsonPrinted, prettyJsonText } from '../../common/pretty-json.js'
import { needsPrettyPrint, prettyExtension, printableSize } from '../../common/pretty-print.js'
import { listSourcemap, sourcemapDiffRebuilds, sourcemapPrinted } from '../../common/pretty-sourcemap.js'
import { isSourceMap } from '../../risk/files/source-map-link.js'
import { fetchPrettyBundleChanges, fetchPrettyBundleFile, fetchPrettyNpmChanges, fetchPrettyNpmFile, fetchPrettyNpmFiles } from './client-managed.js'
import { npmFileReadabilityRead } from './file-readability.js'
import { renameDiffable } from './rename-diff.js'
import { aborted, evict, failureOf, limiter, retrier, retryable, teller, touch } from './server-asks.js'
import { weakNotify } from './weak-notify.js'

// The pretty-print toggles' icon, for the Code tab's bar and Compare's.
export const PRETTY_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 2.5c-1.4 0-2 .6-2 2v1.6c0 .9-.5 1.6-1.5 1.9 1 .3 1.5 1 1.5 1.9v1.6c0 1.4.6 2 2 2M10.5 2.5c1.4 0 2 .6 2 2v1.6c0 .9.5 1.6 1.5 1.9-1 .3-1.5 1-1.5 1.9v1.6c0 1.4-.6 2-2 2"/></svg>`

// What a pretty-print toggle says of the copy it shows: one file's, or for a
// view showing more (Compare's Diff view), a failure telling how many of
// them failed (`failed` of `of`).
export const prettyTooltip = (copy, json = false) => copy?.status === 'loading' ? 'Pretty-printing…'
  : copy?.status === 'error' ? `Couldn't pretty-print${copy.of > 1 ? ` ${copy.failed} of ${copy.of} files` : ''}: ${copy.message}`
  : json && state.bundleSourcePretty ? JSON_LAYOUTS[state.bundleSourcePretty].tooltip : 'Pretty-print'

// JSON's layouts while the toggle is on: the width prettyJSON folds to, and
// what its tooltip tells of it.
const JSON_LAYOUTS = {
  indented: { width: 0, tooltip: 'Pretty-printed, each value on a line of its own. Press to fold what fits on one.' },
  folded: { width: 120, tooltip: 'Pretty-printed, what fits on a line folded onto it. Press to show as published.' },
}

// Whether a toggle shows JSON's third state, folded.
export const prettyFolded = json => json && state.bundleSourcePretty === 'folded'

// Bundle copies kept, the one read last last; each can run to megabytes.
const KEPT_COPIES = 8
// npm versions whose copies are kept, the one read last last: Compare shows two.
const KEPT_VERSIONS = 4
// Comparisons whose copies are kept, the one read last last, each holding
// both sides' of every file that changed between them.
const KEPT_COMPARISONS = 2
// Copies coming close together are told to the view that asked at once.
const tell = teller(30)
// Bundle copies are asked of the server as many at once as it formats
// (server-managed/pretty-print.ts), the rest waiting their turn, as a view
// asks for all it shows (Compare's Diff view, both sides of every changed
// file); one the server kept comes back at once.
const inTurn = limiter(2)

// What a copy the server names as another file's, or as none, is told as.
const MISMATCH = "The server's copy is of another file than the one open."
// What an npm version's file the server didn't pretty-print is told as.
const UNLISTED = "The server didn't pretty-print this file."

// A failure that may pass, of a file's copy or a comparison's, asked again
// a while after (server-asks.js retrier).
const retried = retrier()

// A copy the server sent: ready where it is of the file shown (`own`), else
// told apart from it, or failed as the server told (`message`, `status`).
const received = async (own, text, message, status) => own ? { status: 'ready', text, hash: await computeFileHash(text) }
  : typeof text === 'string' ? { status: 'error', message: MISMATCH, retry: true }
  : { status: 'error', message, retry: retryable(status) }

// Copies by integrity and path: `{ status: 'loading' }`, `{ status: 'ready',
// text, hash }` (`hash` the copy's own, which a diff of it names:
// rename-diff.js), or `{ status: 'error', message, retry }`, `retry` where
// asking again may succeed.
const copies = new Map()
// Copies come or failed so far, for a view to tell its own work stale by.
let settled = 0
export const prettySettled = () => settled
// What a copy asked for calls once it comes: the view that last asked.
const notifiers = new Map()
const copyKey = (details, path) => `${details.integrity}\0${path}`
// npm versions' copies, by integrity: `copies` by path as above, those that
// came, and `notifiers` by path as above; once its request ended, `rest`,
// the copy each file it brought none of has (an error).
const versions = new Map()
// Compare's copies, by both sides' integrity: the files that changed between
// them, both sides' pretty-printed, in one request the first time one is
// asked for, the toggle on or not (Compare tells from them where printing
// changes a diff): `copies` by side and path as above, those that came;
// `notify`, the view that last asked for one; `ended` once its request ended,
// and `rest`, the copy every file has where it failed, asked for again a while
// after where that may succeed. A file it brought none of, or couldn't make
// as the server was busy, is asked for alone (fileCopy).
const comparisons = new Map()

// The files formatted here, by kind, each by what its path names: JSON, in
// the toggle's layout (`layouts`), and source maps, listed (pretty-sourcemap.js);
// and what makes a file of the kind printable, past being no larger than formatted.
const parses = text => {
  try { JSON.parse(text); return true } catch { return false }
}
const VIEWER_KINDS = [
  { printed: jsonPrinted, printable: parses, layouts: true, copy: (_details, _path, content, layout) => prettyJsonText(content, { width: JSON_LAYOUTS[layout].width }) },
  { printed: sourcemapPrinted, printable: isSourceMap, layouts: false, copy: (_details, _path, content) => listSourcemap(content) },
]
const viewerKind = path => VIEWER_KINDS.find(kind => kind.printed(path)) ?? null

// Files formatted here by details and path: the text each was read from,
// whether it can be formatted, and its copy in the layout last asked for.
const viewerFiles = new WeakMap()

function viewerFile(details, kind, path, content) {
  let files = viewerFiles.get(details)
  if (!files) viewerFiles.set(details, files = new Map())
  let file = files.get(path)
  if (file?.content !== content) files.set(path, file = { content, printable: printableSize(content) && kind.printable(content), layout: null, copy: null })
  return file
}

// A file's copy, in the layout the toggle is in where its kind has layouts,
// made here as it is first asked for in it: ready, or an error where it would
// read otherwise than the file; null where it can't be.
function viewerCopy(details, kind, path, content) {
  const file = viewerFile(details, kind, path, content), layout = kind.layouts ? state.bundleSourcePretty : 'listed'
  if (!file.printable) return null
  if (file.layout !== layout) {
    file.layout = layout
    try {
      file.copy = { status: 'ready', text: kind.copy(details, path, content, layout) }
    } catch (err) {
      file.copy = { status: 'error', message: err?.message ?? String(err), retry: false }
    }
  }
  return file.copy
}

// Whether each file of a bundle or npm version can be formatted, by its
// details (needsPrettyPrint, as the server tells an npm version's).
const formattable = new WeakMap()

// Whether the open file can be pretty-printed: JSON or a source map, in any
// bundle, or a formattable file of a managed bundle or an npm version.
export function prettyPrintable(details, entry, path, content) {
  if (typeof content !== 'string') return false
  const kind = viewerKind(path)
  if (kind) return viewerFile(details, kind, path, content).printable
  if (!(entry?.managedId || entry?.npm)) return false
  let files = formattable.get(details)
  if (!files) formattable.set(details, files = new Map())
  if (!files.has(path)) files.set(path, needsPrettyPrint(path, content, () => npmFileReadabilityRead(details, path, content)))
  return files.get(path)
}

// Copies asked for in the task now running and in the last one that asked,
// as a view painting asks for all it shows (Compare's Diff view, both sides
// of every changed file): kept past KEPT_COPIES, as are those still coming,
// so a view showing more than that never drops one it shows or waits for and
// asks for it again.
let asking = false, wanted = new Set(), wantedBefore = new Set()

function keep(key, copy) {
  copies.delete(key)
  copies.set(key, copy)
  if (!asking) {
    asking = true
    wantedBefore = wanted
    wanted = new Set()
    setTimeout(() => { asking = false })
  }
  wanted.add(key)
  evictCopies()
}

// Past KEPT_COPIES, the least recent no view waits for: as one is asked for,
// and as one comes that may be wanted no longer.
function evictCopies() {
  for (const [old, kept] of copies) {
    if (copies.size <= KEPT_COPIES) break
    if (wanted.has(old) || wantedBefore.has(old) || kept.status === 'loading') continue
    copies.delete(old)
    notifiers.delete(old)
  }
}

async function load(key, copy, entry, path, content, known) {
  let next
  try {
    const hash = known ?? await computeFileHash(content)
    const { text, source } = await inTurn(() => (entry.npm ? fetchPrettyNpmFile(entry.npm.name, entry.npm.version, path, hash) : fetchPrettyBundleFile(entry.managedId, path, hash)))
    next = source === hash && typeof text === 'string' ? { status: 'ready', text, hash: await computeFileHash(text) } : { status: 'error', message: MISMATCH, retry: true }
  } catch (err) {
    if (aborted(err)) {
      if (copies.get(key) === copy) {
        copies.delete(key)
        notifiers.delete(key)
      }
      return
    }
    next = failureOf(err)
  }
  if (copies.get(key) !== copy) return
  copies.set(key, next)
  settled++
  const notify = notifiers.get(key)
  // One to be asked for again keeps the view that last asked, to be told then.
  const retry = next.status === 'error' && next.retry
  if (!retry) notifiers.delete(key)
  retried(`file ${key}`, retry, () => copies.get(key) === next && copies.delete(key), () => notifiers.get(key))
  notify?.()
  evictCopies()
}

function notifyOf(version, path) {
  const notify = version.notifiers.get(path)
  version.notifiers.delete(path)
  notify?.()
}

// Every file of an npm version that needs pretty-printing, in one request:
// each copy as it comes, checked as a bundle's is, against the version's own
// file; then, once the request ended, what the files it brought none of have.
async function loadVersion(key, version, details, { npm }) {
  const files = bundleFilesAsMap(details)
  let rest
  try {
    await fetchPrettyNpmFiles(npm.name, npm.version, async ({ path, source, text, status, message }) => {
      const file = files.get(path)
      const own = typeof text === 'string' && typeof file === 'string' && source === await computeFileHash(file)
      version.copies.set(path, await received(own, text, message, status))
      settled++
      notifyOf(version, path)
    })
    rest = { status: 'error', message: UNLISTED, retry: false }
  } catch (err) {
    if (aborted(err)) {
      if (versions.get(key) === version) versions.delete(key)
      return
    }
    rest = failureOf(err)
  }
  version.rest = rest
  settled++
  for (const path of [...version.notifiers.keys()]) notifyOf(version, path)
  evict(versions, KEPT_VERSIONS, ended => ended.rest)
}

// An npm version's file's copy, the version's asked for the first time one
// is wanted. A text other than the version's file, as Compare shows one
// side's for both where an importer was captured on one, has none.
function versionCopy(details, entry, path, content, notify) {
  const key = details.integrity
  const version = touch(versions, key, KEPT_VERSIONS, ended => ended.rest, () => {
    const made = { copies: new Map(), notifiers: new Map(), rest: null }
    loadVersion(key, made, details, entry)
    return made
  })
  if (content !== bundleFilesAsMap(details).get(path)) return { status: 'error', message: MISMATCH, retry: false }
  const copy = version.copies.get(path) ?? version.rest
  if (copy) return copy
  version.notifiers.set(path, notify)
  return { status: 'loading' }
}

// A printable file's pretty-printed copy while the toggle is on, asked for
// the first time it is wanted, `notify` called once it comes; null while it
// is off.
export function prettyCopy(details, entry, path, content, notify) {
  if (!state.bundleSourcePretty) return null
  const kind = viewerKind(path)
  if (kind) return viewerCopy(details, kind, path, content)
  if (entry.npm) return versionCopy(details, entry, path, content, notify)
  return fileCopy(details, path, content, notify, entry)
}

// A file's copy asked for alone, as a bundle's is, by its path and hash: a
// managed bundle's or, where Compare's request for the files that changed
// brought none of it, an npm version's (`entry` as details have it).
function fileCopy(details, path, content, notify, entry = details) {
  const key = copyKey(details, path)
  const asked = copies.get(key)
  const copy = asked ?? { status: 'loading' }
  keep(key, copy)
  if (copy.status === 'loading' || copy.retry) notifiers.set(key, notify)
  if (!asked) load(key, copy, entry, path, content, details.fileHashes?.get(path))
  return copy
}

// The files that changed between a comparison's two sides, both sides', in
// one request: each copy as it comes, checked as a bundle's is, against its
// side's own file; where the request failed, what every file it brought none
// of has.
async function loadComparison(key, comparison, base, other) {
  const sides = { base, other }
  let rest = null
  try {
    const line = async ({ side, path, source, text, status, message }) => {
      // One the server couldn't make now, as it was busy, asked for alone once this ends.
      if (typeof text !== 'string' && retryable(status)) return
      const details = Object.hasOwn(sides, side) ? sides[side] : null
      const file = details && bundleFilesAsMap(details).get(path)
      const own = typeof text === 'string' && typeof file === 'string' && source === (details.fileHashes?.get(path) ?? await computeFileHash(file))
      comparison.copies.set(`${side}\0${path}`, await received(own, text, message, status))
      settled++
      tell(comparison.notify)
    }
    await (base.npm ? fetchPrettyNpmChanges(base.npm.name, base.npm.version, other.npm.version, line)
      : fetchPrettyBundleChanges(base.managedId, other.managedId, line))
  } catch (err) {
    if (aborted(err)) {
      if (comparisons.get(key) === comparison) comparisons.delete(key)
      return
    }
    rest = failureOf(err)
  }
  Object.assign(comparison, { ended: true, rest })
  settled++
  retried(`comparison ${key}`, rest?.retry, () => comparisons.get(key) === comparison && comparisons.delete(key), () => comparison.notify)
  tell(comparison.notify)
  evict(comparisons, KEPT_COMPARISONS, ended => ended.ended)
}

// Whether one side's file of a comparison can be pretty-printed (comparedCopy):
// JSON and source maps in any comparison, other code the server formats
// between two managed bundles or two versions of a package.
export function comparedPrintable(base, other, side, path, content) {
  const kind = viewerKind(path)
  return kind ? viewerFile(side === 'base' ? base : other, kind, path, content).printable
    : renameDiffable(base, other) && prettyExtension(path) !== null && printableSize(content)
}

// One side's file of a comparison of two managed bundles, or two versions of
// a package (rename-diff.js renameDiffable), pretty-printed: `side` `base` or
// `other`, `notify` called once it comes; the comparison's files asked for
// the first time one is, whether or not the toggle is on, and one it brought
// none of asked for alone once it ended. A text other than the side's file
// has none. JSON, of any comparison, is formatted here, once the toggle is on,
// and a source map listed.
export function comparedCopy(base, other, side, path, content, notify) {
  const details = side === 'base' ? base : other
  const kind = viewerKind(path)
  if (kind) return state.bundleSourcePretty ? viewerCopy(details, kind, path, content) : { status: 'off' }
  const key = `${base.integrity}\0${other.integrity}`
  const comparison = touch(comparisons, key, KEPT_COMPARISONS, ended => ended.ended, () => {
    const made = { copies: new Map(), notify: null, ended: false, rest: null }
    loadComparison(key, made, base, other)
    return made
  })
  if (content !== bundleFilesAsMap(details).get(path)) return { status: 'error', message: MISMATCH, retry: false }
  comparison.notify = weakNotify(notify)
  return comparison.copies.get(`${side}\0${path}`) ?? comparison.rest ?? (comparison.ended ? fileCopy(details, path, content, notify) : { status: 'loading' })
}

// Why a diff drawn of a comparison's source map, as the two sides' listings,
// doesn't show every change between them (pretty-sourcemap.js
// sourcemapDiffRebuilds), or null where it does: `basePath` and `path` the
// map's on each side, `before` and `after` their texts ('' for a side with
// none), `drawn` the diff's lines (`a`, `b`) and `blocks`; each side held to
// the listing its copy has.
export function comparedListingRefusal(base, other, basePath, path, { before, after }, drawn) {
  const side = (details, file, text) => {
    const copy = text === '' ? { status: 'ready', text: '' } : viewerCopy(details, viewerKind(file), file, text)
    return { text, listing: copy?.status === 'ready' ? copy.text : null }
  }
  return sourcemapDiffRebuilds(drawn, side(base, basePath, before), side(other, path, after))
}

// The toggle pressed: on, then off, or on a JSON file's (`json`) on indented,
// then folded, then off. Turned back on, it asks again for copies that failed
// for a reason that may have passed: an npm version's, or a comparison's, all
// again, once its request ended.
export function togglePrettySource(json = false) {
  state.bundleSourcePretty = state.bundleSourcePretty ? json && state.bundleSourcePretty === 'indented' && 'folded' : 'indented'
  if (state.bundleSourcePretty !== 'indented') return
  const failed = copy => copy.status === 'error' && copy.retry
  for (const [key, copy] of copies) if (failed(copy)) copies.delete(key)
  for (const [key, version] of versions) if (version.rest && (failed(version.rest) || [...version.copies.values()].some(failed))) versions.delete(key)
  for (const [key, comparison] of comparisons) if (comparison.ended && (comparison.rest ? failed(comparison.rest) : [...comparison.copies.values()].some(failed))) comparisons.delete(key)
}
