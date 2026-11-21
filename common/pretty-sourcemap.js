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
import { SOURCE_MAP } from '../risk/files/readability.js'
import { besideFile, mapNamed } from '../risk/files/source-map-link.js'
import { blocksHold } from './line-diff.js'
import { sourcemapListing } from './sourcemap-listing.js'
import { unlistSourcemap } from './sourcemap-unlist.js'

export { unlistSourcemap }

// Whether a path is a source map's, which the viewer lists rather than
// formats, where its text is one (risk/files/source-map-link.js isSourceMap).
export const sourcemapPrinted = path => SOURCE_MAP.test(path)

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

const joined = lines => (lines.length === 0 ? '' : `${lines.join('\n')}\n`)

// Whether a diff drawn of two maps' listings shows every change between the
// maps: null where it does, else why not. `a` and `b` are the lines drawn of
// the old side and the new, `blocks` the changes drawn between them (each
// `a[a0..a1)` replaced by `b[b0..b1)`); `before` and `after` each side's map,
// `{ text, listing }`, its listing as listSourcemap made it (which reads back
// to the text), both '' where that side has none. The old side drawn must be
// the old map's listing; the changes drawn must take it to the new side drawn
// (line-diff.js blocksHold); that must be the new map's listing; and the new
// map is rebuilt of it, by JSON.stringify, to its very text.
export function sourcemapDiffRebuilds({ a, b, blocks }, before, after) {
  const drawn = joined(b)
  if (joined(a) !== before.listing) return "the old side drawn isn't the old map's listing."
  if (!blocksHold(before.listing, drawn, blocks)) return "the changes drawn don't take the old map's listing to the new side drawn."
  if (drawn !== after.listing) return "the new side drawn isn't the new map's listing."
  if (after.text === '') return null
  try {
    return JSON.stringify(unlistSourcemap(drawn)) === after.text ? null : 'the new side drawn reads back to another map than the new one.'
  } catch (err) {
    return err.message
  }
}
