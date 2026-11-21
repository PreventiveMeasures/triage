// A source map listed for the pretty-print toggle (ui/view/pretty-source.js):
// each of its keys in order, a value to a line, its lists an item to a line,
// the texts of its sources line by line and its mappings decoded
// (sourcemap-listing.js), so that a diff of two maps' listings reads as the
// changes between them. A listing reads back (sourcemap-unlist.js) to the
// very map it lists, and is made only of a map written as JSON.stringify
// writes its JSON; and Compare draws a diff of two only where what it draws,
// the old map's listing and the changes it shows, reads back to the new map
// (sourcemapDiffRebuilds). A map that can't be listed, or a diff of two that
// doesn't read back, is shown as published.
import { besideFile, mapNamed } from '../risk/files/source-map-link.js'
import { sourcemapListing } from './sourcemap-listing.js'
import { unlistSourcemap } from './sourcemap-unlist.js'

export { unlistSourcemap }

// Whether a path is a source map's, which the viewer lists rather than
// formats, where its text is one (risk/files/source-map-link.js isSourceMap).
export const sourcemapPrinted = path => /\.map$/iu.test(path)

// The file a map is of, beside it, `{ path, text }`, or null: the file its
// `file` names, else at its own path without `.map`, among `files` (path →
// text), held to the map's path being what that file's sourceMappingURL names
// (risk/files/source-map-link.js mapNamed), so that a listing glosses a map
// with the file it is of, or with none.
export function sourcemapGenerated(value, path, files) {
  if (!files || typeof path !== 'string' || path === '') return null
  const named = typeof value?.file === 'string' && value.file !== '' ? besideFile(path, value.file) : null
  const bare = sourcemapPrinted(path) ? path.slice(0, -4) : null
  for (const candidate of new Set([named, bare])) {
    if (!candidate) continue
    const text = files.get(candidate)
    if (typeof text !== 'string') continue
    const name = mapNamed(text)
    if (name !== null && besideFile(candidate, name) === path) return { path: candidate, text }
  }
  return null
}

// A source map's text listed, `{ text, generated }`, glossed with the
// generated file beside it among `files` (sourcemapGenerated), `path` the
// map's own. Throws, saying why, for a text that isn't a JSON object written
// as JSON.stringify writes it (spaced, keys repeated, a number or an escape
// spelled otherwise: a listing wouldn't read back to it), an index map, or a
// listing too long; and where its listing doesn't read back to its text,
// which no map should come to.
export function listSourcemap(text, path = '', files = null) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error("Its text isn't JSON.")
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error("Its JSON isn't an object.")
  if (JSON.stringify(value) !== text) throw new Error("Its text isn't written as JSON.stringify writes its JSON, so its listing wouldn't read back to it.")
  if (Object.hasOwn(value, 'sections')) throw new Error("It is an index map, whose sections aren't listed.")
  const generated = sourcemapGenerated(value, path, files)
  const listing = sourcemapListing(value, generated)
  if (JSON.stringify(unlistSourcemap(listing)) !== text) throw new Error("Its listing doesn't read back to its text.")
  return { text: listing, generated }
}

// The lines a diff's change blocks make of its old side's (`a`): each block's
// lines of the new side's (`b`) as drawn, in place of the old lines it
// removes, the lines between taken from the old side; null where the blocks
// don't fit the lines (out of order, past either side, or not as many lines
// between them on each side).
function rebuilt(a, b, blocks) {
  if (!Array.isArray(blocks)) return null
  const lines = []
  let i = 0, j = 0
  for (const block of blocks) {
    const { a0, a1, b0, b1 } = block ?? {}
    if (![a0, a1, b0, b1].every(Number.isInteger) || a0 < i || a1 < a0 || b0 < j || b1 < b0 || a1 > a.length || b1 > b.length || a0 - i !== b0 - j) return null
    while (i < a0) lines.push(a[i++])
    for (let k = b0; k < b1; k++) lines.push(b[k])
    i = a1
    j = b1
  }
  if (a.length - i !== b.length - j) return null
  while (i < a.length) lines.push(a[i++])
  return lines
}
const joined = lines => (lines.length === 0 ? '' : `${lines.join('\n')}\n`)

// Whether a diff drawn of two maps' listings shows every change between the
// maps: null where it does, else why not. `a` and `b` are the lines drawn of
// the old side and the new, `blocks` the changes drawn between them (each
// `a[a0..a1)` replaced by `b[b0..b1)`); `before` and `after` each side's map,
// `{ text, path, files }` as listSourcemap lists it, `text` '' where that
// side has none. The old side drawn must be the old map's listing, reading
// back to it; the new side drawn what the changes make of the old, and the
// new map's listing; and what they make must read back, by JSON.stringify,
// to the new map's very text.
export function sourcemapDiffRebuilds({ a, b, blocks }, before, after) {
  try {
    const old = before.text === '' ? '' : listSourcemap(before.text, before.path, before.files).text
    if (joined(a) !== old) return "the old side drawn isn't the old map's listing."
    if (old !== '' && JSON.stringify(unlistSourcemap(old)) !== before.text) return "the old map's listing doesn't read back to it."
    const lines = rebuilt(a, b, blocks)
    if (lines === null) return "the changes drawn don't fit the listings drawn."
    const made = joined(lines)
    if (made !== joined(b)) return "the new side drawn isn't what the changes drawn make of the old."
    if (after.text === '') return made === '' ? null : 'the changes drawn leave a listing of a map removed.'
    if (JSON.stringify(unlistSourcemap(made)) !== after.text) return 'what the changes drawn make of the old listing reads back to another map than the new one.'
    if (listSourcemap(after.text, after.path, after.files).text !== made) return "what the changes drawn make of the old listing isn't the new map's listing."
    return null
  } catch (err) {
    return err?.message ?? String(err)
  }
}
