// How a file's text reads, as risk tells it (risk/files/readability.js), for
// a reviewer: the npm Overview's tags and warnings (npm-overview.js),
// Compare's tags in a file's head (bundle-compare-code.js) and its chips on
// what a version changes (npm-overview.js npmCompareBadges), and which files
// the Code tab offers pretty-printed (pretty-source.js).
import { html, nothing } from 'lit'
import { formatBytes } from '../scan/metrics.js'
import { bundleFilesAsMap } from '../../common/bundle-sources.js'
import { npmVersionFileRisk } from '../../risk/npm/compare.js'
import { NPM_LONG_LINE, OBFUSCATED_COUNTED, OBFUSCATED_NAMES, READABILITY, charactersOf, npmFileReadability, npmLabelMark, npmLargeCode, npmReadabilityLabels, npmTaggedCategory } from '../../risk/files/readability.js'

export { NPM_LARGE_CODE, NPM_LONG_LINE, NPM_PROSE, READABILITY, npmBecameUnreadable, npmFileReadability, npmLabelMark, npmLargeCode, npmObfuscation, npmReadabilityLabels, npmTaggedCategory } from '../../risk/files/readability.js'
export { JS_STRING_OR_COMMENT } from '../../risk/files/script.js'
export { npmTextEncoding } from '../../risk/files/characters.js'

// What a fingerprint holds, as a tooltip says it.
export const npmObfuscationFound = ({ names, loop }) => [names >= OBFUSCATED_NAMES
  && `${names.toLocaleString('en')}${names === OBFUSCATED_COUNTED ? ' or more' : ''} names such as _0x1a2b`, loop && 'while(!![])'].filter(Boolean).join(', and ')

// A file's readability (npmFileReadability), read once a version (`details`)
// and path, whoever asks: the Overview's lists, Compare's tags and whether a
// file can be pretty-printed alike, as risk reads the version's own file
// (risk/npm/compare.js npmVersionFileRisk). Read apart for another text, as
// Compare gives one side's for both where an importer was captured on one.
const readByVersion = new WeakMap()
export function npmFileReadabilityOf(details, path, text) {
  if (text === bundleFilesAsMap(details).get(path) && typeof text === 'string') return npmVersionFileRisk(details, path).readability
  let files = readByVersion.get(details)
  if (!files) readByVersion.set(details, files = new Map())
  const kept = files.get(path)
  if (kept?.text === text) return kept.read
  const read = npmFileReadability(path, text)
  files.set(path, { text, read })
  return read
}

// Those characters of a label's kind, by code point and how often.
function charactersNote(controls, label) {
  const found = charactersOf(controls, label)
  const named = found.slice(0, 6).map(([point, times]) => `U+${point.toString(16).toUpperCase().padStart(4, '0')} ×${times.toLocaleString('en')}`)
  return `${READABILITY.get(label).name}: ${named.join(', ')}${found.length > 6 ? `, and ${found.length - 6} more` : ''}`
}

// A file's lines longer than anyone writes: how many, and the longest.
const linesNote = ({ longLines, longest }) => `${longLines.toLocaleString('en')} ${longLines === 1 ? 'line' : 'lines'} over ${NPM_LONG_LINE} characters, the longest ${longest.toLocaleString('en')}`

function readabilityNote(readability) {
  const { average, category, longLines, inlineMap } = readability
  const lines = () => linesNote(readability)
  switch (category) {
    case 'binary': return 'Not UTF-8 text, or holding a NUL: there is no text to read'
    case 'map': return 'A source map'
    case 'inline-map': return `Inline source map, ${formatBytes(inlineMap)}${longLines > 0 ? `; minified: ${lines()}` : ''}`
    case 'minified': return `Minified: ${longLines > 0 ? lines() : `its lines of code ${average.toLocaleString('en')} characters long on average, strings and comments aside, with few spaces`}`
    default: return nothing
  }
}

// A file's tag in the column a list keeps for it: how it reads, marked where
// it can't be read as it is, saying why; for one with unexpected long lines,
// how its text is encoded (ASCII or UTF-8), its long lines tagged beside it
// (npmReadabilityFlags) rather than in its place, as its control and
// invisible characters are.
export function npmEncodingTag(readability) {
  if (!readability) return nothing
  const category = npmTaggedCategory(readability)
  const { tag, mark } = READABILITY.get(category)
  return html`<span class=${`npm-encoding-tag${mark ? ` is-${mark}` : ''}`} data-tooltip=${readabilityNote({ ...readability, category })}>${tag}</span>`
}

// A file's Controls, Invisible and Long lines (npmReadabilityLabels), beside
// its tag as Obfuscated is (npmFileFlagTags), not in its place: a minified
// file can hold control and invisible characters, and has long lines. Each says what it found, marked as it is on
// the file (npmLabelMark); `marks` those to tag, all by default. Nothing for
// a file with neither.
export function npmReadabilityFlags(readability, marks = null) {
  const shown = readability ? npmReadabilityLabels(readability).filter(label => ['controls', 'invisible', 'long'].includes(label)
    && (marks === null || marks.includes(npmLabelMark(readability, label)))) : []
  if (shown.length === 0) return nothing
  const note = label => label === 'long' ? `${linesNote(readability)}${readability.category === 'long' ? ', among readable ones' : ''}`
    : charactersNote(readability.controls, label)
  return shown.map(label => html`<span class=${`npm-flag-tag is-${npmLabelMark(readability, label)}`} data-tooltip=${note(label)}>${READABILITY.get(label).tag}</span>`)
}

// A file's tags in a list of files (the Files list, Compare's), as its tags
// (npmReadabilityTag) but for ASCII, as most files are, and Map, which a
// source map's name says already: UTF-8 and what can't be read as it is.
// A file's head, wide enough, tags every one, as it does how one changed.
export function npmListedReadabilityTag(readability) {
  if (!readability) return nothing
  const category = npmTaggedCategory(readability)
  return category === 'ascii' || category === 'map' ? npmReadabilityFlags(readability) : npmReadabilityTag(readability)
}

// A file's tags of how it reads: its control and invisible characters and
// long lines, where it has them, then its tag.
export const npmReadabilityTag = readability => readability ? html`${npmReadabilityFlags(readability)}${npmEncodingTag(readability)}` : nothing

// What a file is beyond how it reads, before its tag: Large, a code file of
// NPM_LARGE_CODE or more (`bytes` its size), which says little of a file
// alone, as `notice`; and Obfuscated, one with an obfuscator's fingerprint
// (npmObfuscation), as `warn`. Nothing for neither.
export function npmFileFlagTags(path, readability, bytes) {
  const large = npmLargeCode(path, bytes)
  const obfuscation = readability?.obfuscation
  if (!large && !obfuscation) return nothing
  return html`${large ? html`<span class="npm-flag-tag is-notice" data-tooltip=${`A code file of ${formatBytes(bytes)}, 256 KiB or more`}>Large</span>` : nothing}${
    obfuscation ? html`<span class="npm-flag-tag is-warn" data-tooltip=${`An obfuscator's fingerprint: ${npmObfuscationFound(obfuscation)}`}>Obfuscated</span>` : nothing}`
}
