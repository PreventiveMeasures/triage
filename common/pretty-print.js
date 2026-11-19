// Minified files pretty-printed by the server (server-managed/pretty-print.ts)
// for the viewer (ui/view/pretty-source.js).
import { npmFileReadability } from '../risk/files/readability.js'
import { utf8ByteLength } from './utf8.js'

// The extensions formatted, each parsed as the language it names; JSON the
// viewer formats itself (pretty-json.js).
const PRETTY_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'css'])

// The largest file formatted, in UTF-8 bytes: formatting holds a syntax tree
// a hundred times the file's size.
export const MAX_PRETTY_BYTES = 4 * 1024 * 1024

// Whether a text is no larger than formatted (MAX_PRETTY_BYTES): its UTF-8
// counted only where its length leaves it in doubt, each of its UTF-16 units
// one to three bytes.
export const printableSize = text => text.length * 3 <= MAX_PRETTY_BYTES || (text.length <= MAX_PRETTY_BYTES && utf8ByteLength(text) <= MAX_PRETTY_BYTES)

// The extension a path is formatted as, or null for one that isn't.
export function prettyExtension(path) {
  const extension = /\.([a-z]+)$/iu.exec(path)?.[1]?.toLowerCase()
  return PRETTY_EXTENSIONS.has(extension) ? extension : null
}

// Whether a file's text is pretty-printed: in a language formatted, no larger
// than formatted, and minified, as risk reads it, `read` reading that where
// the reader keeps it.
export function needsPrettyPrint(path, text, read = () => npmFileReadability(path, text)) {
  return prettyExtension(path) !== null && printableSize(text) && read().category === 'minified'
}
