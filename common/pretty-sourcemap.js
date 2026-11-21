// A source map listed for the pretty-print toggle (ui/view/pretty-source.js):
// its values alone, laid out a value to a row (sourcemap-listing.js), so that
// a diff of two maps' listings reads as the changes between them. A listing
// reads back (sourcemap-unlist.js) to the very text it lists, and Compare
// draws a diff of two only where what it draws, the old map's listing and the
// changes it shows, reads back to the new map (sourcemapDiffRebuilds). A map
// that can't be listed, or a diff of two that doesn't read back, is shown as
// published.
import { UNSEEN } from '../risk/files/characters.js'
import { SOURCE_MAP } from '../risk/files/readability.js'
import { blocksHold } from './line-diff.js'
import { sourcemapListing } from './sourcemap-listing.js'
import { unlistSourcemap } from './sourcemap-unlist.js'

export { unlistSourcemap }

// Whether a path is a source map's, which the viewer lists rather than
// formats, where its text is one (risk/files/source-map-link.js isSourceMap).
export const sourcemapPrinted = path => SOURCE_MAP.test(path)

// What JSON.parse reads past after a value: a line end, mostly.
const BLANKS = /^[\t\n\r ]*$/u

// A source map's text listed. Throws, saying why, for a text that isn't a
// JSON object written as JSON.stringify writes it, but for blanks after it
// (spaced, keys repeated, a number or an escape spelled otherwise: a listing
// wouldn't read back to it), an index map, or a listing too long. Asserted of
// every listing before it is shown, as no map should fail them: that it reads
// back to the very text it lists, and that no row of it holds a character
// that shows as another or none.
export function listSourcemap(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error("Its text isn't JSON.")
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error("Its JSON isn't an object.")
  const json = JSON.stringify(value), trailing = text.slice(json.length)
  if (!text.startsWith(json) || !BLANKS.test(trailing)) throw new Error("Its text isn't written as JSON.stringify writes its JSON, so its listing wouldn't read back to it.")
  if (Object.hasOwn(value, 'sections')) throw new Error("It is an index map, whose sections aren't listed.")
  const listing = sourcemapListing(value, trailing)
  if (unlistSourcemap(listing) !== text) throw new Error("Its listing doesn't read back to its text.")
  if (UNSEEN.test(listing)) throw new Error('Its listing would show a character as another or none.')
  return listing
}

const joined = lines => (lines.length === 0 ? '' : `${lines.join('\n')}\n`)

// Whether a diff drawn of two maps' listings shows every change between the
// maps: null where it does, else why not. `a` and `b` are the lines drawn of
// the old side and the new, `blocks` the changes drawn between them (each
// `a[a0..a1)` replaced by `b[b0..b1)`); `before` and `after` each side's map,
// `{ text, listing }`, its listing as listSourcemap made it (which reads back
// to the text), both '' where that side has none. The old side drawn must be
// the old map's listing; the changes drawn must take it to the new side drawn
// (line-diff.js blocksHold); that must be the new map's listing; and it must
// read back to the new map's very text.
export function sourcemapDiffRebuilds({ a, b, blocks }, before, after) {
  const drawn = joined(b)
  if (joined(a) !== before.listing) return "the old side drawn isn't the old map's listing."
  if (!blocksHold(before.listing, drawn, blocks)) return "the changes drawn don't take the old map's listing to the new side drawn."
  if (drawn !== after.listing) return "the new side drawn isn't the new map's listing."
  if (after.text === '') return null
  try {
    return unlistSourcemap(drawn) === after.text ? null : 'the new side drawn reads back to another map than the new one.'
  } catch (err) {
    return err.message
  }
}
