// Minified files pretty-printed by the server (server-managed/pretty-print.ts)
// for the viewer (ui/view/pretty-source.js).
import { npmFileReadability } from '../risk/files/readability.js'
import { utf8ByteLength } from './utf8.js'

// The extensions formatted, each parsed as the language it names.
const PRETTY_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'css', 'json'])

// The largest file formatted, in UTF-8 bytes: formatting holds a syntax tree
// a hundred times the file's size.
export const MAX_PRETTY_BYTES = 4 * 1024 * 1024

// The extension a path is formatted as, or null for one that isn't.
export function prettyExtension(path) {
  const extension = /\.([a-z]+)$/iu.exec(path)?.[1]?.toLowerCase()
  return PRETTY_EXTENSIONS.has(extension) ? extension : null
}

// Whether a file's text is pretty-printed: in a language formatted, no larger
// than formatted, and minified, as risk reads it, `read` reading that where
// the reader keeps it.
export function needsPrettyPrint(path, text, read = () => npmFileReadability(path, text)) {
  return prettyExtension(path) !== null && utf8ByteLength(text) <= MAX_PRETTY_BYTES && read().category === 'minified'
}
