// How a built file names its source map, and what a source map is: read
// alike where a version's map is told rebuilt with its file (npm/compare.js
// rebuiltWithMap) and where a map's listing is of the file beside it that
// names it (common/pretty-sourcemap.js).

// A `sourceMappingURL` comment and no more, on a file's last line.
const SOURCE_MAP_FILE = /^\s*(?:\/\/[#@] sourceMappingURL=(\S+)|\/\*[#@] sourceMappingURL=(\S+?)\s*\*\/)\s*$/u
// A map name a build writes (`a.js.map`, `../maps/a.map`): segments of
// letters, digits and `._~@+-`, as a browser reads them alike. One at a URL,
// from a site's root, or with an escape or a backslash names none.
const MAP_NAME = /^(?:[\w.~@+-]+\/)*[\w.~@+-]+\.map$/u

// The map a file's text names on its last line by a plain path from the
// file's own (MAP_NAME), or null: none named, or one named otherwise (a data:
// URL, a site's).
export function mapNamed(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trimEnd()
  const directive = SOURCE_MAP_FILE.exec(trimmed.slice(trimmed.lastIndexOf('\n') + 1))
  const name = directive?.[1] ?? directive?.[2]
  return name && MAP_NAME.test(name) ? name : null
}

// The path `name` names from beside `file`, or null for one above the root.
export function besideFile(file, name) {
  const parts = file.split('/').slice(0, -1)
  for (const part of name.split('/')) {
    if (part === '..' && parts.length === 0) return null
    if (part === '..') parts.pop()
    else if (part !== '.') parts.push(part)
  }
  return parts.join('/')
}

// Whether a text is a source map: JSON with `mappings`, or each of an
// indexed map's `sections` with its own.
export function isSourceMap(text) {
  try {
    const json = JSON.parse(text)
    return typeof json?.mappings === 'string'
      || (Array.isArray(json?.sections) && json.sections.length > 0 && json.sections.every(section => typeof section?.map?.mappings === 'string'))
  } catch { return false }
}
