// Characters a code viewer shows as a labelled box, since as text they show
// as nothing, or as something they are not: the controls (C0 but tab and
// newline, DEL, C1), the format characters (Cf: the zero-width ones, the bidi
// controls that reorder what a line reads as, tags), lone surrogates (Cs),
// and the line and paragraph separators, which end a line in JavaScript but
// not in the viewer. A CR stays as it is where it ends a line with the LF
// after it, and so do the joiners and tags that spell an emoji.
//
// The box is a label in place of the character, which leaves the DOM: in
// highlighted markup the HTML parser drops a NUL and reads a lone CR as a
// newline, so it could not be relied on to be there anyway. The label is not
// selectable, so a copy leaves these out rather than copying their labels.
import { html } from 'lit'

// The characters, a pair of surrogates read as the one it spells (`u`), so
// \p{Cs} is only ever a lone one. A candidate, not yet one to show: see shown.
// eslint-disable-next-line no-control-regex
const CANDIDATE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\p{Cf}\p{Cs}]/u
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
00AD SHY SOFT HYPHEN
061C ALM ARABIC LETTER MARK
180E MVS MONGOLIAN VOWEL SEPARATOR
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
2060 WJ WORD JOINER
2061 FA FUNCTION APPLICATION
2062 IT INVISIBLE TIMES
2063 IS INVISIBLE SEPARATOR
2064 IP INVISIBLE PLUS
2066 LRI LEFT-TO-RIGHT ISOLATE
2067 RLI RIGHT-TO-LEFT ISOLATE
2068 FSI FIRST STRONG ISOLATE
2069 PDI POP DIRECTIONAL ISOLATE
FEFF BOM ZERO WIDTH NO-BREAK SPACE
E0001 LANG LANGUAGE TAG
E0020 SP TAG SPACE
E007F CANCEL CANCEL TAG
`.trim().split('\n').map(line => {
  const [, code, label, name] = /^(\S+) (\S+) (.+)$/u.exec(line)
  return [Number.parseInt(code, 16), { label, name }]
}))

const hex = code => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`

// A character's label, and the tooltip naming it. A tag stands for the ASCII
// character it is offset from, the text it hides read off the labels.
function describe(code) {
  const named = NAMED.get(code)
  if (named) return { label: named.label, title: `${hex(code)} ${named.name}` }
  if (code > 0xe0020 && code < 0xe007f) {
    const ascii = String.fromCodePoint(code - 0xe0000)
    return { label: ascii, title: `${hex(code)} TAG ${ascii}` }
  }
  if (code >= 0xd800 && code < 0xe000) return { label: hex(code), title: `${hex(code)} lone surrogate` }
  return { label: hex(code), title: `${hex(code)} format character` }
}

const EMOJI_BEFORE = /\p{Extended_Pictographic}(?:\u{FE0F}|[\u{1F3FB}-\u{1F3FF}])?$/u
const EMOJI_AFTER = /^\p{Extended_Pictographic}/u
const isTag = code => code >= 0xe0020 && code <= 0xe007f

// The characters in `text` to show, in order, as [at, code point]. A CR before
// a newline is part of the line end, as is one that ends `text` where
// `lineEnd` says a newline follows it. A joiner between two emoji joins them
// into one, and a black flag's tags, up to the cancel tag, name its region.
function shown(text, lineEnd) {
  const found = []
  CANDIDATES.lastIndex = 0
  for (let match = CANDIDATES.exec(text); match; match = CANDIDATES.exec(text)) {
    const at = match.index
    const code = match[0].codePointAt(0)
    if (code === 0x0d && (text[at + 1] === '\n' || lineEnd && at + 1 === text.length)) continue
    if (code === 0x200d && EMOJI_BEFORE.test(text.slice(Math.max(0, at - 4), at)) && EMOJI_AFTER.test(text.slice(at + 1, at + 3))) continue
    if (isTag(code) && !isTag(text.codePointAt(at - 2))) {
      let end = at
      while (isTag(text.codePointAt(end))) end += 2
      if (text.codePointAt(at - 2) === 0x1f3f4 && text.codePointAt(end - 2) === 0xe007f && end - at > 2) {
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
