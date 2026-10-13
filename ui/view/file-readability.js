// How a file's text reads, as risk tells it (risk/files/readability.js), for
// a reviewer: the npm Overview's tags and warnings (npm-overview.js),
// Compare's tags in a file's head (bundle-compare-code.js) and its chips on
// what a version changes (npm-overview.js npmCompareBadges), and which files
// the Code tab offers pretty-printed (pretty-source.js).
import { html, nothing } from 'lit'
import { formatBytes } from '../scan/metrics.js'
import { bundleFilesAsMap } from '../../common/bundle-sources.js'
import { fileRiskOf } from './file-risk.js'
import { NPM_LONG_LINE, OBFUSCATED_COUNTED, OBFUSCATED_NAMES, READABILITY, charactersOf, npmFileReadability, npmLabelMark, npmReadabilityLabels, npmTaggedCategory } from '../../risk/files/readability.js'

export { READABILITY, npmLabelMark, npmReadabilityLabels, npmTaggedCategory } from '../../risk/files/readability.js'

// What a fingerprint holds, as a tooltip says it.
export const npmObfuscationFound = ({ names, loop }) => [names >= OBFUSCATED_NAMES
  && `${names.toLocaleString('en')}${names === OBFUSCATED_COUNTED ? ' or more' : ''} names such as _0x1a2b`, loop && 'while(!![])'].filter(Boolean).join(', and ')

// How a file of a version (`details`) reads, as the Overview's lists and
// Compare's tags show it: as risk read the version's own file (file-risk.js
// fileRiskOf), the server's for an npm version, null until it arrives; read
// here for another text (npmFileReadabilityRead), as Compare gives one side's
// for both where an importer was captured on one.
export function npmFileReadabilityOf(details, path, text) {
  if (text === bundleFilesAsMap(details).get(path) && typeof text === 'string') return fileRiskOf(details, path).readability
  return npmFileReadabilityRead(details, path, text)
}

// How a text of a file reads (npmFileReadability), read here, once a version
// (`details`) and path: for what the viewer does with a file, whether it
// pretty-prints it or hides a minifier's renames in it, not for what calls
// for a look, which npmFileReadabilityOf shows.
const readByVersion = new WeakMap()
export function npmFileReadabilityRead(details, path, text) {
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
// invisible characters are. `brief` for a file tree: its short tag, where it
// has one (Min), its tooltip naming it in full.
export function npmEncodingTag(readability, brief = false) {
  if (!readability) return nothing
  const category = npmTaggedCategory(readability)
  const { tag, short, mark } = READABILITY.get(category)
  return html`<span class=${`npm-encoding-tag${mark ? ` is-${mark}` : ''}`} data-tooltip=${readabilityNote({ ...readability, category })}>${brief ? short ?? tag : tag}</span>`
}

// How a file's text is encoded, ASCII or UTF-8, for a file's head, which tags
// it beside a tag that says something else (Minified, Inline map, Map) rather
// than leave it out; nothing where its tag says it already, or for a file
// that isn't text.
export function npmTextKindTag(readability) {
  const kind = readability?.kind
  if ((kind !== 'ascii' && kind !== 'utf8') || npmTaggedCategory(readability) === kind) return nothing
  return npmEncodingTag({ ...readability, category: kind })
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
const npmReadabilityTag = readability => readability ? html`${npmReadabilityFlags(readability)}${npmEncodingTag(readability)}` : nothing

// What a file of a version (`details`) is beyond how it reads, as risk read
// it (file-risk.js fileRiskOf), before its tag: Large, a code file of
// NPM_LARGE_CODE or more (`bytes` its size), which says little of a file
// alone, as `notice`; and Obfuscated, one with an obfuscator's fingerprint
// (npmObfuscation), as `warn`. Nothing for neither. `withLarge` false leaves
// Large out, for a list that tags it only where a file has no other tag.
export function npmFileFlagTags(details, path, bytes, withLarge = true) {
  const { stamps, readability } = fileRiskOf(details, path)
  const large = withLarge && stamps.some(({ name }) => name === 'Large')
  const obfuscation = readability?.obfuscation
  if (!large && !obfuscation) return nothing
  return html`${large ? html`<span class="npm-flag-tag is-notice" data-tooltip=${`A code file of ${formatBytes(bytes)}, 256 KiB or more`}>Large</span>` : nothing}${
    obfuscation ? html`<span class="npm-flag-tag is-warn" data-tooltip=${`An obfuscator's fingerprint: ${npmObfuscationFound(obfuscation)}`}>Obfuscated</span>` : nothing}`
}
