// Minified files pretty-printed in the Code tab while its toggle is on
// (state.bundleSourcePretty): a managed bundle's or an npm version's file,
// asked of the server by its path and its text's hash, which formats it once
// and keeps the copy (server-managed/pretty-print.ts). The viewer keeps the
// last few copies it read, for the session; a copy's line numbers are its
// own, so the file's line links and marks stay with the file as published.
import { html } from 'lit'
import { computeFileHash } from '@preventive/report'
import { state } from '#client/index.js'
import { MAX_PRETTY_BYTES, prettyExtension } from '../../common/pretty-print.js'
import { utf8ByteLength } from '../../common/utf8.js'
import { fetchPrettyBundleFile, fetchPrettyNpmFile } from './client-managed.js'
import { npmFileReadability } from './file-readability.js'

// The pretty-print toggles' icon, for the Code tab's bar and Compare's.
export const PRETTY_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 2.5c-1.4 0-2 .6-2 2v1.6c0 .9-.5 1.6-1.5 1.9 1 .3 1.5 1 1.5 1.9v1.6c0 1.4.6 2 2 2M10.5 2.5c1.4 0 2 .6 2 2v1.6c0 .9.5 1.6 1.5 1.9-1 .3-1.5 1-1.5 1.9v1.6c0 1.4-.6 2-2 2"/></svg>`

// What a pretty-print toggle says of the copy it shows.
export const prettyTooltip = copy => copy?.status === 'loading' ? 'Pretty-printing…'
  : copy?.status === 'error' ? `Couldn't pretty-print: ${copy.message}` : 'Pretty-print'

// Copies kept, the one read last last; each can run to megabytes.
const KEPT_COPIES = 8

// Copies by integrity and path: `{ status: 'loading' }`, `{ status: 'ready',
// text }`, or `{ status: 'error', message, retry }`, `retry` where asking
// again may succeed.
const copies = new Map()
// What a copy asked for calls once it comes: the view that last asked.
const notifiers = new Map()
const copyKey = (details, path) => `${details.integrity}\0${path}`

// Whether each file of a bundle or npm version can be formatted, by its
// details: in a language the server formats, no larger than it formats, and
// minified (npmFileReadability).
const formattable = new WeakMap()

// Whether the open file can be pretty-printed: a formattable file of a
// managed bundle or an npm version.
export function prettyPrintable(details, entry, path, content) {
  if (!(entry?.managedId || entry?.npm) || typeof content !== 'string') return false
  let files = formattable.get(details)
  if (!files) formattable.set(details, files = new Map())
  if (!files.has(path)) {
    files.set(path, prettyExtension(path) !== null && utf8ByteLength(content) <= MAX_PRETTY_BYTES && npmFileReadability(path, content).category === 'minified')
  }
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
    const text = entry.npm
      ? await fetchPrettyNpmFile(entry.npm.name, entry.npm.version, path, hash)
      : await fetchPrettyBundleFile(entry.managedId, path, hash)
    next = { status: 'ready', text }
  } catch (err) {
    // A session that changed asks again under the new one, on its render.
    if (err?.name === 'AbortError') { if (copies.get(key) === copy) copies.delete(key); return }
    next = { status: 'error', message: err?.message ?? String(err), retry: !(err?.status >= 400 && err.status < 500 && err.status !== 429) }
  }
  if (copies.get(key) !== copy) return
  copies.set(key, next)
  const notify = notifiers.get(key)
  notifiers.delete(key)
  notify?.()
}

// A printable file's pretty-printed copy while the toggle is on, asked for
// the first time it is wanted, `notify` called once it comes; null while it
// is off.
export function prettyCopy(details, entry, path, content, notify) {
  if (!state.bundleSourcePretty) return null
  const key = copyKey(details, path)
  const asked = copies.get(key)
  const copy = asked ?? { status: 'loading' }
  keep(key, copy)
  if (copy.status === 'loading') notifiers.set(key, notify)
  if (!asked) load(key, copy, entry, path, content, details.fileHashes?.get(path))
  return copy
}

// Turned back on, the toggle asks again for copies that failed for a reason
// that may have passed.
export function togglePrettySource() {
  state.bundleSourcePretty = !state.bundleSourcePretty
  if (!state.bundleSourcePretty) return
  for (const [key, copy] of copies) if (copy.status === 'error' && copy.retry) copies.delete(key)
}
