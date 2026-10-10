// Pretty-printed copies of minified files: the viewer asks for one by its
// bundle or npm version, its path and its content's hash, and the server
// (server-managed/pretty-print.ts) formats it with oxfmt and keeps it.

// The extensions formatted, each parsed as the language it names.
const PRETTY_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'css', 'json'])

// The largest file formatted, in UTF-8 bytes: formatting holds a syntax tree
// a hundred times the file's size.
export const MAX_PRETTY_BYTES = 4 * 1024 * 1024

// The hash a file is asked for by, as bundle metadata names files'
// (computeFileHash in @preventive/report: the sha512 of its UTF-8 text).
export const PRETTY_FILE_HASH = /^sha512-[\d+/A-Za-z]{86}==$/u

// The extension a path is formatted as, or null for one that isn't.
export function prettyExtension(path) {
  const extension = /\.([a-z]+)$/iu.exec(path)?.[1]?.toLowerCase()
  return extension !== undefined && PRETTY_EXTENSIONS.has(extension) ? extension : null
}
