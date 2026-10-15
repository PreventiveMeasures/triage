// How a file's text reads, for a reviewer: its category (binary, a source
// map, code with unexpectedly long lines or an inline map, minified, else
// ASCII or UTF-8), its control and invisible characters, its longest lines,
// an obfuscator's fingerprint, a large code file, and a file become
// unreadable between two versions.
import { CONTROLS, npmTextEncoding } from './characters.js'
import { MINIFIED_AVERAGE, minifiable, minifiedAverage } from './script.js'

// Lines longer than anyone writes by hand.
export const NPM_LONG_LINE = 1000
// Prose, which wraps where it is read: its long lines are paragraphs. By its
// extension (text, Markdown and MDX, and the markup GitHub renders a README
// from: `README.org`, `README.rdoc`), or its name alone (`LICENSE-MIT`,
// `CHANGES`; a dot in it only a version's, `LICENSE-LGPL2.1`,
// `CHANGES.2.0`; a prose extension after it is one), not code named alike
// (`lib/history.js`, `dist/notice.min.js`), which can be minified as any.
export const NPM_PROSE = /(?:\.(?:md|markdown|mdown|mkdn|mdx|txt|rst|adoc|asciidoc|asc|textile|rdoc|org|creole|mediawiki|wiki|pod)|(?:^|\/)(?:licen[cs]e|copying|notice|authors|contributors|readme|changelog|changes|history)(?:-[^/.]*)?(?:\.\d[^/.]*)*)$/iu
const SOURCE_MAP_COMMENT = /^\s*(?:\/\/|\/\*)[#@] sourceMappingURL=/u
// A line that is all one, the map in it as a data: URL, base64 or
// percent-encoded: not code that writes one.
const INLINE_SOURCE_MAP = /^\s*(?:\/\/|\/\*)[#@] sourceMappingURL=data:[^\s,]*,[\w+/=%.~-]*\s*(?:\*\/)?\s*$/u
export const SOURCE_MAP = /\.map$/iu
const MINIFIED_NAME = /\.min\.[^/.]+$/iu
// What javascript-obfuscator writes, and next to nothing else: its names,
// `_0x` and four to six hex digits, OBFUSCATED_NAMES of them or more, or the
// loop it turns its array of strings with, `while(!![])`, spaced or not.
const OBFUSCATED_NAME = /(?<![\p{ID_Continue}$])_0x[0-9a-f]{4,6}(?![\p{ID_Continue}$])/gu
export const OBFUSCATED_NAMES = 20
const OBFUSCATED_LOOP = /while\s*\(\s*!!\[\]\s*\)/u
// Names counted before a fingerprint's count stops, reading as that many or
// more: each is kept to tell it from the others, and a file can hold millions.
export const OBFUSCATED_COUNTED = 1000
// A text's obfuscator fingerprint, `{ names, loop }`: how many such names it
// has, up to OBFUSCATED_COUNTED, and whether it has the loop; null where it
// has neither enough names nor the loop.
export function npmObfuscation(text) {
  const names = new Set()
  for (const [name] of text.matchAll(OBFUSCATED_NAME)) {
    names.add(name)
    if (names.size === OBFUSCATED_COUNTED) break
  }
  const loop = OBFUSCATED_LOOP.test(text)
  return names.size >= OBFUSCATED_NAMES || loop ? { names: names.size, loop } : null
}

// A code file this large is mostly a bundle, worth a look where a version
// adds it: JavaScript or TypeScript, not a declaration file, which holds no
// code that runs, or any file node runs as a script (`script`, npm/files.js
// npmLoadedScripts).
export const NPM_LARGE_CODE = 256 * 1024
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/iu
const DECLARATION = /\.d\.[cm]?ts$/iu
export const npmLargeCode = (path, bytes, script = false) => typeof bytes === 'number' && bytes >= NPM_LARGE_CODE && (script || (CODE.test(path) && !DECLARATION.test(path)))

// A code file that isn't text (npmFileReadability's `binary`: not UTF-8, or
// holding a NUL), by its path and how it reads, a declaration file too, or
// any file node runs as a script (`script`, npm/files.js npmLoadedScripts):
// no one can read it in review, yet what reads it by its byte order mark can
// run it, or type with it, as UTF-16 (a browser's classic script, Windows
// Script Host, TypeScript), and node runs it decoded as UTF-8 whatever it
// holds past its code (`//` and a byte no UTF-8 has).
export const npmBinaryCode = (path, readability, script = false) => readability?.category === 'binary' && (script || CODE.test(path))

// A file with a line over UNREADABLE_LINE characters, by how it reads
// (`now`, npmFileReadability's), `path` its path: an inline source map's line
// counts for none, and prose and source maps, whose long lines the Long lines
// tag passes over, never are, but where node runs it as a script (`script`),
// nor is a file that isn't text. Then one that had no line over SHORT_LINES
// characters (`was`) and now has one over UNREADABLE_LINE, by how it reads on
// each side.
const SHORT_LINES = 200
const UNREADABLE_LINE = 2000
export const npmUnreadable = (path, now, script = false) => Boolean(now) && now.category !== 'binary' && (script || (!NPM_PROSE.test(path) && !SOURCE_MAP.test(path)))
  && now.longest > UNREADABLE_LINE
export const npmBecameUnreadable = (path, was, now, script = false) => Boolean(was) && was.category !== 'binary' && was.longest <= SHORT_LINES && npmUnreadable(path, now, script)

// How a file reads, as its `category`, the first that holds (READABILITY):
// binary (no text), map (a source map), long (code with some lines
// longer than anyone writes), inline-map (code with its source map in it, minified or
// not), minified (code mostly on long lines, or named .min., or minified
// into shorter lines: see MINIFIED_AVERAGE), else utf8 or ascii; and
// whatever it is, the control, bidirectional or invisible characters a text
// holds (`controls`), found in one pass, which count as a label of their own
// beside it each, control and invisible (npmReadabilityLabels). Prose is
// readable whatever its lines' lengths, and an inline source map's line
// counts for none, nor for how much of the code is on long lines. With
// npmTextEncoding's `kind` and `controls`, its `longest` line's length and
// `longLines`, its code's lines' `average` length where it is minified into
// short ones (strings and comments aside, see MINIFIED_AVERAGE; 0 otherwise),
// how long its inline map is (`inlineMap`, 0 for none), and its obfuscator
// fingerprint (`obfuscation`, npmObfuscation's; null for none, and for prose
// or a source map). One node runs as a script whatever its name (`script`,
// script.js npmIsScript) is read as code: no prose nor source map.
export function npmFileReadability(path, text, script = false) {
  const encoding = npmTextEncoding(text)
  if (encoding.kind === 'binary') return { ...encoding, category: 'binary', longest: 0, longLines: 0, average: 0, inlineMap: 0, obfuscation: null }
  let inlineMap = 0, longChars = 0, longLines = 0, longest = 0
  for (let at = 0; at <= text.length;) {
    const next = text.indexOf('\n', at)
    const end = next === -1 ? text.length : next
    const length = end - at - (text[end - 1] === '\r' ? 1 : 0)
    if (SOURCE_MAP_COMMENT.test(text.slice(at, at + 64)) && INLINE_SOURCE_MAP.test(text.slice(at, end))) inlineMap += length
    else {
      if (length > NPM_LONG_LINE) {
        longLines++
        longChars += length
      }
      longest = Math.max(longest, length)
    }
    at = end + 1
  }
  // A source map holds the names and sources of the code it maps, and prose
  // its examples: neither runs.
  const map = !script && SOURCE_MAP.test(path), prose = !script && NPM_PROSE.test(path)
  const obfuscation = prose || map ? null : npmObfuscation(text)
  const read = { ...encoding, longest, longLines, average: 0, inlineMap, obfuscation }
  if (map) return { ...read, category: 'map' }
  if (prose) return { ...read, category: inlineMap > 0 ? 'inline-map' : encoding.kind }
  if (longLines === 0) {
    // None of its lines longer than MINIFIED_AVERAGE, none of its code's can
    // average more: told without reading its code.
    const language = minifiable(path, script)
    const average = language !== null && longest > MINIFIED_AVERAGE ? minifiedAverage(text, language) : 0
    return { ...read, average, category: inlineMap > 0 ? 'inline-map' : average > 0 ? 'minified' : encoding.kind }
  }
  if (longChars / (text.length - inlineMap) < .5 && !MINIFIED_NAME.test(path)) return { ...read, category: 'long' }
  return { ...read, category: inlineMap > 0 ? 'inline-map' : 'minified' }
}

// The category a file's tag shows: for one with long lines, how its text is
// encoded.
export const npmTaggedCategory = readability => readability.category === 'long' ? readability.kind : readability.category

// What a file is labelled, in its tags and in the Overview's warning and
// chips, each finding it: its control characters, its invisible ones
// (characterLabels) and its long lines, where it holds them, beside its category (how its text is encoded, for one whose long
// lines are unexpected), but for ASCII or UTF-8, which a file that can't be
// read as it is counts under as none of them. A minified file's long lines
// are labelled too, as its inline map's are; prose's and a source map's
// never are.
export function npmReadabilityLabels(readability) {
  const flags = [...characterLabels(readability.controls),
    ...readability.longLines > 0 && ['long', 'minified', 'inline-map'].includes(readability.category) ? ['long'] : []]
  const category = npmTaggedCategory(readability)
  return READABILITY.get(category).mark || flags.length === 0 ? [...flags, category] : flags
}

// How a label is marked on a file: long lines as a warning where it is
// otherwise readable, as they are unexpected there, and as a notice in
// minified code, as minified code is; any other as its category is.
export const npmLabelMark = (readability, label) => label === 'long' && readability.category !== 'long' ? 'notice' : READABILITY.get(label).mark

// Each category: its name, its tag in a list of files or a file's head (and,
// `short`, in a file tree, where that is too long), and how it is marked,
// `warn` for what to look into, `notice` for what can be hard to review by
// reading it either way.
export const READABILITY = new Map([
  ['binary', { name: 'Binary', tag: 'Binary', mark: 'warn' }],
  ['controls', { name: 'Control chars', tag: 'Controls', mark: 'warn' }],
  ['invisible', { name: 'Invisible chars', tag: 'Invisible', mark: 'warn' }],
  ['long', { name: 'Long lines', tag: 'Long lines', mark: 'warn' }],
  ['minified', { name: 'Minified', tag: 'Minified', short: 'Min', mark: 'notice' }],
  ['map', { name: 'Source maps', tag: 'Map', mark: 'notice' }],
  ['inline-map', { name: 'Inline source maps', tag: 'Inline map', mark: 'notice' }],
  ['utf8', { name: 'UTF-8', tag: 'UTF-8', mark: null }],
  ['ascii', { name: 'ASCII', tag: 'ASCII', mark: null }],
])

// The characters a text holds of a label's kind, `controls` (C0, DEL, C1
// and bidirectional controls) or `invisible`, `[point, times]`, the most
// found first: those npmTextEncoding found in one pass, told apart by code
// point. The labels a text's characters take, of those two.
const CONTROL = new RegExp(CONTROLS.source, 'u')
export const charactersOf = (controls, label) => [...controls ?? []]
  .filter(([point]) => CONTROL.test(String.fromCodePoint(point)) === (label === 'controls')).toSorted((a, b) => b[1] - a[1] || a[0] - b[0])
const characterLabels = controls => controls ? ['controls', 'invisible'].filter(label => charactersOf(controls, label).length > 0) : []

