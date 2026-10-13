// Minified files pretty-printed in the Code tab while its toggle is on
// (state.bundleSourcePretty), formatted by the server once and kept there
// (server-managed/pretty-print.ts), each taken where the server names the
// file it formatted as the one shown: a managed bundle's asked for a file at
// a time, by its path and its text's hash; an npm version's all in one
// request, the first time one is wanted. The viewer keeps the last few
// bundle copies it read, and the last few versions', for the session; a
// copy's line numbers are its own, so the file's line links and marks stay
// with the file as published.
import { html } from 'lit'
import { computeFileHash } from '@preventive/report'
import { state } from '#client/index.js'
import { bundleFilesAsMap } from '../../common/bundle-sources.js'
import { needsPrettyPrint } from '../../common/pretty-print.js'
import { fetchPrettyBundleFile, fetchPrettyNpmFiles } from './client-managed.js'
import { npmFileReadabilityRead } from './file-readability.js'

// The pretty-print toggles' icon, for the Code tab's bar and Compare's.
export const PRETTY_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 2.5c-1.4 0-2 .6-2 2v1.6c0 .9-.5 1.6-1.5 1.9 1 .3 1.5 1 1.5 1.9v1.6c0 1.4.6 2 2 2M10.5 2.5c1.4 0 2 .6 2 2v1.6c0 .9.5 1.6 1.5 1.9-1 .3-1.5 1-1.5 1.9v1.6c0 1.4-.6 2-2 2"/></svg>`

// What a pretty-print toggle says of the copy it shows: one file's, or for a
// view showing more (Compare's Diff view), a failure telling how many of
// them failed (`failed` of `of`).
export const prettyTooltip = copy => copy?.status === 'loading' ? 'Pretty-printing…'
  : copy?.status === 'error' ? `Couldn't pretty-print${copy.of > 1 ? ` ${copy.failed} of ${copy.of} files` : ''}: ${copy.message}` : 'Pretty-print'

// Bundle copies kept, the one read last last; each can run to megabytes.
const KEPT_COPIES = 8
// npm versions whose copies are kept, the one read last last: Compare shows two.
const KEPT_VERSIONS = 4
// Bundle copies asked of the server at once: as many as it formats at once
// (server-managed/pretty-print.ts). The rest wait their turn, in the order
// asked, as a view asks for all it shows (Compare's Diff view, both sides of
// every changed file); one the server kept comes back at once.
const MAX_FETCHES = 2

// What a copy the server names as another file's, or as none, is told as.
const MISMATCH = "The server's copy is of another file than the one open."
// What an npm version's file the server didn't pretty-print is told as.
const UNLISTED = "The server didn't pretty-print this file."

// Whether asking again for a copy that failed with `status` may succeed.
const retryable = status => !(status >= 400 && status < 500 && status !== 429)

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

// Whether each file of a bundle or npm version can be formatted, by its
// details (needsPrettyPrint, as the server tells an npm version's).
const formattable = new WeakMap()

// Whether the open file can be pretty-printed: a formattable file of a
// managed bundle or an npm version.
export function prettyPrintable(details, entry, path, content) {
  if (!(entry?.managedId || entry?.npm) || typeof content !== 'string') return false
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
  evict()
}

// Past KEPT_COPIES, the least recent no view waits for: as one is asked for,
// and as one comes that may be wanted no longer.
function evict() {
  for (const [old, kept] of copies) {
    if (copies.size <= KEPT_COPIES) break
    if (wanted.has(old) || wantedBefore.has(old) || kept.status === 'loading') continue
    copies.delete(old)
    notifiers.delete(old)
  }
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

async function load(key, copy, entry, path, content, known) {
  let next
  try {
    const hash = known ?? await computeFileHash(content)
    const { text, source } = await inTurn(() => fetchPrettyBundleFile(entry.managedId, path, hash))
    next = source === hash && typeof text === 'string' ? { status: 'ready', text, hash: await computeFileHash(text) } : { status: 'error', message: MISMATCH, retry: true }
  } catch (err) {
    // A session that changed asks again under the new one, on its render.
    if (err?.name === 'AbortError') {
      if (copies.get(key) === copy) {
        copies.delete(key)
        notifiers.delete(key)
      }
      return
    }
    next = { status: 'error', message: err?.message ?? String(err), retry: retryable(err?.status) }
  }
  if (copies.get(key) !== copy) return
  copies.set(key, next)
  settled++
  const notify = notifiers.get(key)
  notifiers.delete(key)
  notify?.()
  evict()
}

// Past KEPT_VERSIONS, the least recent whose request ended.
function evictVersions() {
  for (const [key, version] of versions) {
    if (versions.size <= KEPT_VERSIONS) break
    if (version.rest) versions.delete(key)
  }
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
      const copy = own ? { status: 'ready', text, hash: await computeFileHash(text) }
        : typeof text === 'string' ? { status: 'error', message: MISMATCH, retry: true }
        : { status: 'error', message, retry: retryable(status) }
      version.copies.set(path, copy)
      settled++
      notifyOf(version, path)
    })
    rest = { status: 'error', message: UNLISTED, retry: false }
  } catch (err) {
    // A session that changed asks again under the new one, on its render.
    if (err?.name === 'AbortError') {
      if (versions.get(key) === version) versions.delete(key)
      return
    }
    rest = { status: 'error', message: err?.message ?? String(err), retry: retryable(err?.status) }
  }
  version.rest = rest
  settled++
  for (const path of [...version.notifiers.keys()]) notifyOf(version, path)
  evictVersions()
}

// An npm version's file's copy, the version's asked for the first time one
// is wanted. A text other than the version's file, as Compare shows one
// side's for both where an importer was captured on one, has none.
function versionCopy(details, entry, path, content, notify) {
  const key = details.integrity
  let version = versions.get(key)
  versions.delete(key)
  if (!version) {
    version = { copies: new Map(), notifiers: new Map(), rest: null }
    loadVersion(key, version, details, entry)
  }
  versions.set(key, version)
  evictVersions()
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
  if (entry.npm) return versionCopy(details, entry, path, content, notify)
  const key = copyKey(details, path)
  const asked = copies.get(key)
  const copy = asked ?? { status: 'loading' }
  keep(key, copy)
  if (copy.status === 'loading') notifiers.set(key, notify)
  if (!asked) load(key, copy, entry, path, content, details.fileHashes?.get(path))
  return copy
}

// The copy kept for a file, as prettyCopy has it, without asking for one:
// null where none is kept, or while the toggle is off.
export function keptPrettyCopy(details, path) {
  if (!state.bundleSourcePretty) return null
  const version = versions.get(details.integrity)
  return (version ? version.copies.get(path) ?? version.rest : copies.get(copyKey(details, path))) ?? null
}

// Turned back on, the toggle asks again for copies that failed for a reason
// that may have passed: an npm version's all again, once its request ended.
export function togglePrettySource() {
  state.bundleSourcePretty = !state.bundleSourcePretty
  if (!state.bundleSourcePretty) return
  const failed = copy => copy.status === 'error' && copy.retry
  for (const [key, copy] of copies) if (failed(copy)) copies.delete(key)
  for (const [key, version] of versions) if (version.rest && (failed(version.rest) || [...version.copies.values()].some(failed))) versions.delete(key)
}
