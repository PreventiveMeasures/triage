// Minified files pretty-printed in the Code tab while its toggle is on
// (state.bundleSourcePretty): a managed bundle's or an npm version's file,
// asked of the server by its path and its text's hash, which formats it once
// and keeps the copy (server-managed/pretty-print.ts). The viewer keeps the
// last few copies it read, for the session; a copy's line numbers are its
// own, so the file's line links and marks stay with the file as published.
import { computeFileHash } from '@preventive/report'
import { state } from '#client/index.js'
import { MAX_PRETTY_BYTES, prettyExtension } from '../../common/pretty-print.js'
import { utf8ByteLength } from '../../common/utf8.js'
import { fetchPrettyBundleFile, fetchPrettyNpmFile } from './client-managed.js'
import { npmFileReadability, npmFilesRead } from './npm-overview.js'
import { render } from './render.js'

// Copies kept, the one read last last; each can run to megabytes.
const KEPT_COPIES = 8

// Copies by integrity and path: `{ status: 'loading' }`, `{ status: 'ready',
// text }`, or `{ status: 'error', message, retry }`, `retry` where asking
// again may succeed.
const copies = new Map()
const copyKey = (details, path) => `${details.integrity}\0${path}`

// Whether each of a bundle's files is minified, as the npm Overview tells
// (npmFileReadability), by its details; an npm version's are read there.
const minifiedFiles = new WeakMap()
function minified(details, path, content) {
  if (details.npm) return npmFilesRead(details).byPath.get(path)?.category === 'minified'
  let files = minifiedFiles.get(details)
  if (!files) minifiedFiles.set(details, files = new Map())
  if (!files.has(path)) files.set(path, npmFileReadability(path, content).category === 'minified')
  return files.get(path)
}

// Whether the open file can be pretty-printed: a minified file of a managed
// bundle or an npm version, in a language the server formats, and no larger
// than it formats.
export function prettyPrintable(details, entry, path, content) {
  return Boolean(entry?.managedId || entry?.npm) && typeof content === 'string' && prettyExtension(path) !== null
    && content.length <= MAX_PRETTY_BYTES && utf8ByteLength(content) <= MAX_PRETTY_BYTES && minified(details, path, content)
}

function keep(key, copy) {
  copies.delete(key)
  copies.set(key, copy)
  for (const old of copies.keys()) {
    if (copies.size <= KEPT_COPIES) break
    copies.delete(old)
  }
}

async function load(key, copy, details, entry, path, content) {
  let next
  try {
    const hash = details.fileHashes?.get(path) ?? await computeFileHash(content)
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
  if (state.bundleSourceFile === path) render()
}

// The open file's pretty-printed copy while the toggle is on, asked for
// the first time it is wanted; null while it is off, or for a file that
// can't be pretty-printed.
export function prettyCopy(details, entry, path, content) {
  if (!state.bundleSourcePretty || !prettyPrintable(details, entry, path, content)) return null
  const key = copyKey(details, path)
  const asked = copies.get(key)
  const copy = asked ?? { status: 'loading' }
  keep(key, copy)
  if (!asked) load(key, copy, details, entry, path, content)
  return copy
}

// Turned back on, the toggle asks again for copies that failed for a reason
// that may have passed.
export function togglePrettySource() {
  state.bundleSourcePretty = !state.bundleSourcePretty
  if (!state.bundleSourcePretty) return
  for (const [key, copy] of copies) if (copy.status === 'error' && copy.retry) copies.delete(key)
}
