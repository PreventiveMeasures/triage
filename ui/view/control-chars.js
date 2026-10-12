// Characters a code viewer shows as a labelled box, since as text they show
// as nothing, or as something they are not: Unicode's other characters (C),
// which are the controls (Cc: C0 but tab and newline, DEL, C1), the format
// characters (Cf: the zero-width ones, the bidi controls that reorder what a
// line reads as, tags), lone surrogates (Cs), private use characters (Co),
// whose glyph is whatever a font puts there, and unassigned code points and
// noncharacters (Cn); the line and paragraph separators, which end a line
// in JavaScript but not in the viewer; and what reads as a space, or as
// nothing, though it is another character: Unicode's other spaces (no-break,
// en and em, thin, ideographic), the default-ignorable characters (Hangul
// fillers, variation selectors, the grapheme joiner), each a different name
// in code from the one it looks like, and the Braille blank. A CR stays as
// it is where it ends a line with the LF after it, and so do the joiners,
// tags and variation selectors that spell an emoji.
//
// The box is a label in place of the character, which leaves the DOM: in
// highlighted markup the HTML parser drops a NUL and reads a lone CR as a
// newline, so it could not be relied on to be there anyway. The label is not
// selectable, so a copy leaves these out rather than copying their labels.
import { html } from 'lit'

// The characters, a pair of surrogates read as the one it spells (`u`), so
// \p{Cs} is only ever a lone one. A candidate, not yet one to show: see shown.
// eslint-disable-next-line no-control-regex
const CANDIDATE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u2800\u3000\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}]/u
const CANDIDATES = new RegExp(CANDIDATE.source, 'gu')

// Labels and names of the ones a viewer meets, the rest labelled by number.
const NAMED = new Map(`
0000 NUL NULL
0001 SOH START OF HEADING
0002 STX START OF TEXT
0003 ETX END OF TEXT
0004 EOT END OF TRANSMISSION
0005 ENQ ENQUIRY
0006 ACK ACKNOWLEDGE
0007 BEL BELL
0008 BS BACKSPACE
000B VT LINE TABULATION
000C FF FORM FEED
000D CR CARRIAGE RETURN
000E SO SHIFT OUT
000F SI SHIFT IN
0010 DLE DATA LINK ESCAPE
0011 DC1 DEVICE CONTROL ONE
0012 DC2 DEVICE CONTROL TWO
0013 DC3 DEVICE CONTROL THREE
0014 DC4 DEVICE CONTROL FOUR
0015 NAK NEGATIVE ACKNOWLEDGE
0016 SYN SYNCHRONOUS IDLE
0017 ETB END OF TRANSMISSION BLOCK
0018 CAN CANCEL
0019 EM END OF MEDIUM
001A SUB SUBSTITUTE
001B ESC ESCAPE
001C FS FILE SEPARATOR
001D GS GROUP SEPARATOR
001E RS RECORD SEPARATOR
001F US UNIT SEPARATOR
007F DEL DELETE
0080 PAD PADDING CHARACTER
0081 HOP HIGH OCTET PRESET
0082 BPH BREAK PERMITTED HERE
0083 NBH NO BREAK HERE
0084 IND INDEX
0085 NEL NEXT LINE
0086 SSA START OF SELECTED AREA
0087 ESA END OF SELECTED AREA
0088 HTS CHARACTER TABULATION SET
0089 HTJ CHARACTER TABULATION WITH JUSTIFICATION
008A VTS LINE TABULATION SET
008B PLD PARTIAL LINE FORWARD
008C PLU PARTIAL LINE BACKWARD
008D RI REVERSE LINE FEED
008E SS2 SINGLE SHIFT TWO
008F SS3 SINGLE SHIFT THREE
0090 DCS DEVICE CONTROL STRING
0091 PU1 PRIVATE USE ONE
0092 PU2 PRIVATE USE TWO
0093 STS SET TRANSMIT STATE
0094 CCH CANCEL CHARACTER
0095 MW MESSAGE WAITING
0096 SPA START OF GUARDED AREA
0097 EPA END OF GUARDED AREA
0098 SOS START OF STRING
0099 SGC SINGLE GRAPHIC CHARACTER INTRODUCER
009A SCI SINGLE CHARACTER INTRODUCER
009B CSI CONTROL SEQUENCE INTRODUCER
009C ST STRING TERMINATOR
009D OSC OPERATING SYSTEM COMMAND
009E PM PRIVACY MESSAGE
009F APC APPLICATION PROGRAM COMMAND
00A0 NBSP NO-BREAK SPACE
00AD SHY SOFT HYPHEN
034F CGJ COMBINING GRAPHEME JOINER
061C ALM ARABIC LETTER MARK
115F HCF HANGUL CHOSEONG FILLER
1160 HJF HANGUL JUNGSEONG FILLER
1680 OSM OGHAM SPACE MARK
17B4 KIVAQ KHMER VOWEL INHERENT AQ
17B5 KIVAA KHMER VOWEL INHERENT AA
180E MVS MONGOLIAN VOWEL SEPARATOR
2000 NQSP EN QUAD
2001 MQSP EM QUAD
2002 ENSP EN SPACE
2003 EMSP EM SPACE
2004 3/MSP THREE-PER-EM SPACE
2005 4/MSP FOUR-PER-EM SPACE
2006 6/MSP SIX-PER-EM SPACE
2007 FSP FIGURE SPACE
2008 PSP PUNCTUATION SPACE
2009 THSP THIN SPACE
200A HSP HAIR SPACE
200B ZWSP ZERO WIDTH SPACE
200C ZWNJ ZERO WIDTH NON-JOINER
200D ZWJ ZERO WIDTH JOINER
200E LRM LEFT-TO-RIGHT MARK
200F RLM RIGHT-TO-LEFT MARK
2028 LS LINE SEPARATOR
2029 PS PARAGRAPH SEPARATOR
202A LRE LEFT-TO-RIGHT EMBEDDING
202B RLE RIGHT-TO-LEFT EMBEDDING
202C PDF POP DIRECTIONAL FORMATTING
202D LRO LEFT-TO-RIGHT OVERRIDE
202E RLO RIGHT-TO-LEFT OVERRIDE
202F NNBSP NARROW NO-BREAK SPACE
205F MMSP MEDIUM MATHEMATICAL SPACE
2060 WJ WORD JOINER
2061 FA FUNCTION APPLICATION
2062 IT INVISIBLE TIMES
2063 IS INVISIBLE SEPARATOR
2064 IP INVISIBLE PLUS
2066 LRI LEFT-TO-RIGHT ISOLATE
2067 RLI RIGHT-TO-LEFT ISOLATE
2068 FSI FIRST STRONG ISOLATE
2069 PDI POP DIRECTIONAL ISOLATE
2800 BLANK BRAILLE PATTERN BLANK
3000 IDSP IDEOGRAPHIC SPACE
3164 HF HANGUL FILLER
FEFF BOM ZERO WIDTH NO-BREAK SPACE
FFA0 HWHF HALFWIDTH HANGUL FILLER
E0001 LANG LANGUAGE TAG
E0020 SP TAG SPACE
E007F CANCEL CANCEL TAG
`.trim().split('\n').map(line => {
  const [, code, label, name] = /^(\S+) (\S+) (.+)$/u.exec(line)
  return [Number.parseInt(code, 16), { label, name }]
}))

const hex = code => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`

// A character's label, and the tooltip naming it. A tag stands for the ASCII
// character it is offset from, the text it hides read off the labels; a
// variation selector is numbered as Unicode numbers them.
function describe(code) {
  const named = NAMED.get(code)
  if (named) return { label: named.label, title: `${hex(code)} ${named.name}` }
  if (code > 0xe0020 && code < 0xe007f) {
    const ascii = String.fromCodePoint(code - 0xe0000)
    return { label: ascii, title: `${hex(code)} TAG ${ascii}` }
  }
  const selector = code >= 0xfe00 && code <= 0xfe0f ? code - 0xfe00 + 1 : code >= 0xe0100 && code <= 0xe01ef ? code - 0xe0100 + 17 : 0
  if (selector) return { label: `VS${selector}`, title: `${hex(code)} VARIATION SELECTOR-${selector}` }
  return { label: hex(code), title: `${hex(code)} ${kind(code)}` }
}

// What an unnamed one is. The last two code points of every plane are
// noncharacters, the private use planes' too, and so is a block of 32 in
// Arabic Presentation Forms-A.
const FORMAT = /\p{Cf}/u
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u
const UNASSIGNED = /\p{Cn}/u
function kind(code) {
  if (code >= 0xd800 && code < 0xe000) return 'lone surrogate'
  if ((code & 0xfffe) === 0xfffe || code >= 0xfdd0 && code <= 0xfdef) return 'noncharacter'
  if (code >= 0xe000 && code <= 0xf8ff || code >= 0xf0000) return 'private use character'
  const char = String.fromCodePoint(code)
  return FORMAT.test(char) ? 'format character' : IGNORABLE.test(char) && !UNASSIGNED.test(char) ? 'invisible character' : 'unassigned code point'
}

// A pictograph is an assigned one (Emoji): Extended_Pictographic also takes
// in code points reserved for emoji to come, unassigned, each boxed itself,
// and a joiner or selector beside one would go unseen.
const EMOJI_BEFORE = /(?=\p{Emoji})\p{Extended_Pictographic}(?:\u{FE0F}|[\u{1F3FB}-\u{1F3FF}])?$/u
const EMOJI_AFTER = /^(?=\p{Emoji})\p{Extended_Pictographic}/u
const PICTOGRAPH_BEFORE = /(?=\p{Emoji})\p{Extended_Pictographic}$/u
const KEYCAP_BASE = /^[\d#*]$/u
const isTag = code => code >= 0xe0020 && code <= 0xe007f
// The subdivision flags Unicode recommends (RGI), their tags spelling the
// subdivision after a black flag: England's, Scotland's and Wales's. Others
// show as a black flag and their tags as nothing, as a payload in them would.
const FLAGS = new Set(['gbeng', 'gbsct', 'gbwls'])
const tagged = (text, from, to) => to - from === 10 ? String.fromCodePoint(...Array.from({ length: 5 }, (_, i) => text.codePointAt(from + 2 * i) - 0xe0000)) : ''

// The characters in `text` to show, in order, as [at, code point]. A CR before
// a newline is part of the line end, as is one that ends `text` where
// `lineEnd` says a newline follows it. A joiner between two emoji joins them
// into one, a recommended subdivision flag's tags, up to the cancel tag, name
// its region (FLAGS), and the text or emoji presentation selector after a
// pictograph, or the emoji one between a keycap's digit, # or * and its mark,
// draws it; after a letter or a digit alone it is another name.
function shown(text, lineEnd) {
  const found = []
  CANDIDATES.lastIndex = 0
  for (let match = CANDIDATES.exec(text); match; match = CANDIDATES.exec(text)) {
    const at = match.index
    const code = match[0].codePointAt(0)
    if (code === 0x0d && (text[at + 1] === '\n' || lineEnd && at + 1 === text.length)) continue
    if (code === 0x200d && EMOJI_BEFORE.test(text.slice(Math.max(0, at - 4), at)) && EMOJI_AFTER.test(text.slice(at + 1, at + 3))) continue
    if ((code === 0xfe0e || code === 0xfe0f) && PICTOGRAPH_BEFORE.test(text.slice(Math.max(0, at - 2), at))) continue
    if (code === 0xfe0f && KEYCAP_BASE.test(text[at - 1] ?? '') && text[at + 1] === '\u20E3') continue
    if (isTag(code) && !isTag(text.codePointAt(at - 2))) {
      let end = at
      while (isTag(text.codePointAt(end))) end += 2
      if (text.codePointAt(at - 2) === 0x1f3f4 && text.codePointAt(end - 2) === 0xe007f && FLAGS.has(tagged(text, at, end - 2))) {
        CANDIDATES.lastIndex = end
        continue
      }
    }
    found.push([at, code])
  }
  return found
}

// Whether `text` may have any to show: a quick test, before the work of
// finding which.
export function hasControls(text) {
  return CANDIDATE.test(text)
}

// Those text is hidden in, as the npm Overview counts them
// (file-readability.js), where they show: variation selectors (a payload, a
// byte a selector), Hangul fillers (a name no one sees) and tags (ASCII no one
// sees). Not the format characters, a BOM or a zero-width space, which text
// has its uses for, nor the other marks that show as nothing (the combining
// grapheme joiner, the Khmer inherent vowels and the Mongolian free variation
// selectors), which tables of the characters a name may hold, as JavaScript
// parsers have, hold too; nor what of these hides nothing (benign).
const INVISIBLE = /[\u115F\u1160\u3164\uFFA0\u{E0001}\u{E0020}-\u{E007F}]|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/u
// A table's code points, from its ranges in hex (`30 2018-2019`).
const codePoints = ranges => new Set(ranges.split(' ').flatMap(range => {
  const [from, to = from] = range.split('-').map(digits => Number.parseInt(digits, 16))
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}))
// The variation sequences Unicode registers, which hide nothing, though Code
// shows their selectors after a letter or a digit, another name there: VS1 to
// VS14's on other than an ideograph (StandardizedVariants.txt, Unicode
// 18.0.0), each selector's bases, as an HTML entity table's math symbols, and
// the emoji with a text and an emoji presentation, VS15 and VS16 after each
// (emoji-variation-sequences.txt), as a heading's anchor keeps one (`#`).
const STANDARDIZED = new Map([
  [0xfe00, '30 1000 1002 1004 1010-1011 1015 1019-101a 101c-101d 1022 1031 1075'
    + ' 1078 107a 1080 2018-2019 201c-201d 210b 2110 2112 211b 212c 2130-2131'
    + ' 2133 2205 2229-222a 223d 2242-2243 2248 2268-2269 2272-2273 228a-228b'
    + ' 2293-2295 2297 229c 22cd 22da-22dd 29b7 2a3c-2a3d 2a6c 2a9d-2a9e'
    + ' 2aac-2aad 2acb-2acc 3001-3002 31c0 31c6 31c9 31cf-31d2 31d4-31d5 31d7'
    + ' 31db-31dd 31e5 a856 a85c a85e-a860 a868 aa60-aa66 aa6b-aa6c aa6f aa7a'
    + ' ff01 ff0c ff0e ff10 ff1a-ff1b ff1f 10ac5-10ac6 10ad6-10ad7 10ae1 13091'
    + ' 1310f 1311c 13121 13127 13139 131a0 131b1 131b8-131b9 131cb 131e0'
    + ' 131f9-131fa 1327b 1327f 13285 1328c 132aa 132cb 132dc 132e7 13307'
    + ' 1331b 13322 1333c 13377-13378 13399-1339a 133d3 133e4-133e5 133e7'
    + ' 133ee 133f2 133f5-133f6 13416 13419-1341a 13423 13443-13446'
    + ' 13be8-13bea 13f72 1d49c 1d49e-1d49f 1d4a2 1d4a5-1d4a6 1d4a9-1d4ac'
    + ' 1d4ae-1d4b5 1db10'],
  [0xfe01, '2018-2019 201c-201d 210b 2110 2112 211b 212c 2130-2131 2133 3001-3002'
    + ' 31c6 31cf 31dd ff01 ff0c ff0e ff1a-ff1b ff1f 13093 13132 13139 13187'
    + ' 131b1 131ee 131f8-131fa 13257 1327f 1328b 132a4 13308 13312-13314'
    + ' 1331b 13321-13322 13331 133e8 13419 13f1f 14274 1d49c 1d49e-1d49f'
    + ' 1d4a2 1d4a5-1d4a6 1d4a9-1d4ac 1d4ae-1d4b5'],
  [0xfe02, '2018-2019 201c-201d 13117 13139 13183 131a0 131ba 131ee 13216 1327b'
    + ' 132a4 132e7 132e9 132f8 132fd 13302-13303 13310-13314 1331c 13321'
    + ' 13331 1334a 13361 13373 1337d 13385 133af-133b0 133bf 133db 133dd'
    + ' 13419 1342c 1342e 14274 1d4cf'],
  [0xfe03, '13012 130b8 130ba 1310f 1312f 13139 13184 1319c-1319d 1319f 131b1'
    + ' 131db 13205 13296 13338 13419'],
  [0xfe04, '13139 1340d'],
  [0xfe05, '13139 14274'],
  [0xfe06, '1312f 13139 13184 131db 131ee 13205 132a4 132e9 1332b 13338'
    + ' 13370-13371 13419 14274'],
].map(([selector, bases]) => [selector, codePoints(bases)]))
const EMOJI = codePoints('23 2a 30-39 a9 ae 203c 2049 2122 2139 2194-2199 21a9-21aa 231a-231b 2328'
  + ' 23cf 23e9-23f3 23f8-23fa 24c2 25aa-25ab 25b6 25c0 25fb-25fe 2600-2604 260e'
  + ' 2611 2614-2615 2618 261d 2620 2622-2623 2626 262a 262e-262f 2638-263a 2640'
  + ' 2642 2648-2653 265f-2660 2663 2665-2666 2668 267b 267e-267f 2692-2697 2699'
  + ' 269b-269c 26a0-26a1 26a7 26aa-26ab 26b0-26b1 26bd-26be 26c4-26c5 26c8'
  + ' 26ce-26cf 26d1 26d3-26d4 26e9-26ea 26f0-26f5 26f7-26fa 26fd 2702 2705'
  + ' 2708-270d 270f 2712 2714 2716 271d 2721 2728 2733-2734 2744 2747 274c 274e'
  + ' 2753-2755 2757 2763-2764 2795-2797 27a1 27b0 27bf 2934-2935 2b05-2b07'
  + ' 2b1b-2b1c 2b50 2b55 3030 303d 3297 3299 1f004 1f170-1f171 1f17e-1f17f'
  + ' 1f202 1f21a 1f22f 1f237 1f30d-1f30f 1f315 1f31c 1f321 1f324-1f32c 1f336'
  + ' 1f378 1f37d 1f393 1f396-1f397 1f399-1f39b 1f39e-1f39f 1f3a7 1f3ac-1f3ae'
  + ' 1f3c2 1f3c4 1f3c6 1f3ca-1f3ce 1f3d4-1f3e0 1f3ed 1f3f3 1f3f5 1f3f7 1f408'
  + ' 1f415 1f41f 1f426 1f43f 1f441-1f442 1f446-1f449 1f44d-1f44e 1f453 1f46a'
  + ' 1f47d 1f4a3 1f4b0 1f4b3 1f4bb 1f4bf 1f4cb 1f4da 1f4df 1f4e4-1f4e6'
  + ' 1f4ea-1f4ed 1f4f7 1f4f9-1f4fb 1f4fd 1f508 1f50d 1f512-1f513 1f549-1f54a'
  + ' 1f550-1f567 1f56f-1f570 1f573-1f579 1f587 1f58a-1f58d 1f590 1f5a5 1f5a8'
  + ' 1f5b1-1f5b2 1f5bc 1f5c2-1f5c4 1f5d1-1f5d3 1f5dc-1f5de 1f5e1 1f5e3 1f5e8'
  + ' 1f5ef 1f5f3 1f5fa 1f610 1f687 1f68d 1f691 1f694 1f698 1f6ad 1f6b2'
  + ' 1f6b9-1f6ba 1f6bc 1f6cb 1f6cd-1f6cf 1f6e0-1f6e5 1f6e9 1f6f0 1f6f3')
// The blocks of variation selectors, as those tables write them out as ranges.
const BLOCKS = [[0xfe00, 0xfe0f], [0xe0100, 0xe01ef]]
// The compatibility jamo but their filler.
const JAMO = [[0x3131, 0x3163], [0x3165, 0x318e]]

// The code point before `at` in `text`, a pair of surrogates read as one.
function codePointBefore(text, at) {
  if (at === 0) return undefined
  const pair = at >= 2 ? text.codePointAt(at - 2) : 0
  return pair > 0xffff ? pair : text.codePointAt(at - 1)
}
const within = (code, ...ranges) => code !== undefined && ranges.some(([from, to]) => code >= from && code <= to)

// Whether the one shown as `code` at `at` hides nothing: a Hangul filler
// composing Hangul (the initial consonant's before a vowel, a syllable with
// none, or the vowel's after an initial consonant, one with none), or a
// compatibility or halfwidth jamo's among those jamo, as a codepage's table
// lists them, though not one after a syllable, a name that reads as it; a
// variation sequence Unicode registers; a block of selectors written out as a
// range in a table (`VS1-VS16`); or an emoji's presentation selector doubled,
// as copying text leaves it.
function benign(text, at, code) {
  const end = at + (code > 0xffff ? 2 : 1)
  const after = text.codePointAt(end), before = codePointBefore(text, at)
  switch (code) {
    case 0x115f: return within(after, [0x1161, 0x11a7], [0xd7b0, 0xd7c6])
    case 0x1160: return within(before, [0x1100, 0x115e], [0xa960, 0xa97c])
    case 0x3164: return within(before, ...JAMO) || within(after, ...JAMO)
    case 0xffa0: return within(before, [0xffa1, 0xffdc]) || within(after, [0xffa1, 0xffdc])
    default: return (code === 0xfe0e || code === 0xfe0f ? EMOJI.has(before) : STANDARDIZED.get(code)?.has(before))
      || BLOCKS.some(([from, to]) => code === from && text[end] === '-' && text.codePointAt(end + 1) === to
        || code === to && text[at - 1] === '-' && codePointBefore(text, at - 1) === from)
      || (code === 0xfe0e || code === 0xfe0f) && before === code && PICTOGRAPH_BEFORE.test(text.slice(Math.max(0, at - 3), at - 1))
  }
}

// How many of each a text holds, by code point, or null for none.
export function invisibleCharacters(text) {
  if (!INVISIBLE.test(text)) return null
  const found = new Map()
  for (const [at, code] of shown(text)) {
    if (INVISIBLE.test(String.fromCodePoint(code)) && !benign(text, at, code)) found.set(code, (found.get(code) ?? 0) + 1)
  }
  return found.size > 0 ? found : null
}

const box = code => {
  const { label, title } = describe(code)
  return html`<span class="code-control" data-tooltip=${title}>${label}</span>`
}

// Plain text as the parts a template renders: its runs of text, and a box
// for each character to show between them. `lineEnd`: see shown.
export function controlParts(text, lineEnd = false) {
  if (!hasControls(text)) return [text]
  const parts = []
  let from = 0
  for (const [at, code] of shown(text, lineEnd)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(box(code))
    from = at + (code > 0xffff ? 2 : 1)
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

// Highlighted markup with the same boxes. The markup is Prism's, or the
// viewers' own built on it (prism-source-links.js, markHighlighted): every
// `<` in its text escaped, so each one starts a tag. Its text is searched
// with the tags left out, so a CR is read as ending its line by the newline
// after a tag, and a tag's attributes are never searched.
export function controlMarkup(markup, lineEnd = false) {
  if (!hasControls(markup)) return markup
  // The text, and where each run of it between tags starts, in it and in
  // the markup.
  let text = ''
  const runs = []
  for (let at = 0; at < markup.length;) {
    const lt = markup.indexOf('<', at)
    const end = lt === -1 ? markup.length : lt
    if (end > at) {
      runs.push({ text: text.length, markup: at })
      text += markup.slice(at, end)
    }
    if (lt === -1) break
    const gt = markup.indexOf('>', lt)
    at = gt === -1 ? markup.length : gt + 1
  }
  let out = ''
  let copied = 0
  let run = 0
  for (const [at, code] of shown(text, lineEnd)) {
    while (runs[run + 1]?.text <= at) run++
    const from = runs[run].markup + at - runs[run].text
    const { label, title } = describe(code)
    out += `${markup.slice(copied, from)}<span class="code-control" data-tooltip="${escape(title)}">${escape(label)}</span>`
    copied = from + (code > 0xffff ? 2 : 1)
  }
  return out + markup.slice(copied)
}
