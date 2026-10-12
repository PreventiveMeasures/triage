import assert from 'node:assert/strict'
import { test } from 'node:test'
import { controlMarkup, controlParts, hasControls } from '../ui/view/control-chars.js'
import { sourceText } from '../ui/view/source-text.js'

// Parts as text, a box as [label|tooltip].
const parts = list => list.map(part => typeof part === 'string' ? part : `[${part.values[1]}|${part.values[0]}]`).join('')

test('controls, format characters, lone surrogates and separators show as labelled boxes', () => {
  assert.equal(parts(controlParts('a\u0000b\u001Bc\u007Fd\u0085e\u009Bf')),
    'a[NUL|U+0000 NULL]b[ESC|U+001B ESCAPE]c[DEL|U+007F DELETE]d[NEL|U+0085 NEXT LINE]e[CSI|U+009B CONTROL SEQUENCE INTRODUCER]f')
  assert.equal(parts(controlParts('if (x\u202E) {\u2066}')), 'if (x[RLO|U+202E RIGHT-TO-LEFT OVERRIDE]) {[LRI|U+2066 LEFT-TO-RIGHT ISOLATE]}')
  assert.equal(parts(controlParts('\uFEFFa\u200Bb\u00ADc')), '[BOM|U+FEFF ZERO WIDTH NO-BREAK SPACE]a[ZWSP|U+200B ZERO WIDTH SPACE]b[SHY|U+00AD SOFT HYPHEN]c')
  assert.equal(parts(controlParts('a\u2028b\u2029c')), 'a[LS|U+2028 LINE SEPARATOR]b[PS|U+2029 PARAGRAPH SEPARATOR]c')
  assert.equal(parts(controlParts('lone \uD800, pair 😀')), 'lone [U+D800|U+D800 lone surrogate], pair 😀')
  assert.equal(parts(controlParts('\u0600')), '[U+0600|U+0600 format character]', 'one without a name goes by its number')
  assert.equal(parts(controlParts('x\u{E0068}\u{E0069}')), 'x[h|U+E0068 TAG h][i|U+E0069 TAG i]', 'tags read as the text they hide')
})

test('the controls run C0 but tab and newline, DEL, and C1 to U+009F; the character after them is text', () => {
  const controls = [...Array.from({ length: 0x20 }, (_, i) => i).filter(code => code !== 0x09 && code !== 0x0A), ...Array.from({ length: 0x21 }, (_, i) => 0x7F + i)]
  const text = String.fromCodePoint(...controls)
  assert.equal(controlParts(text).length, controls.length, 'each one a box')
  assert.equal(parts(controlParts('\u009F\u00A1')), '[APC|U+009F APPLICATION PROGRAM COMMAND]\u00A1', 'past the no-break space, boxed as a space')
})

test('what reads as a space or as nothing, though it is another character, shows as a labelled box', () => {
  assert.equal(parts(controlParts('a\u00A0b\u3000c\u2009d')),
    'a[NBSP|U+00A0 NO-BREAK SPACE]b[IDSP|U+3000 IDEOGRAPHIC SPACE]c[THSP|U+2009 THIN SPACE]d', "Unicode's other spaces")
  assert.equal(parts(controlParts('const x\u3164 = 1')), 'const x[HF|U+3164 HANGUL FILLER] = 1', 'a letter that draws as nothing, making another name')
  assert.equal(parts(controlParts('\u115F\u1160\uFFA0\u2800')),
    '[HCF|U+115F HANGUL CHOSEONG FILLER][HJF|U+1160 HANGUL JUNGSEONG FILLER][HWHF|U+FFA0 HALFWIDTH HANGUL FILLER][BLANK|U+2800 BRAILLE PATTERN BLANK]')
  assert.equal(parts(controlParts('a\u034Fb')), 'a[CGJ|U+034F COMBINING GRAPHEME JOINER]b')
  assert.equal(parts(controlParts('x\uFE0F y\u{E0101}')), 'x[VS16|U+FE0F VARIATION SELECTOR-16] y[VS18|U+E0101 VARIATION SELECTOR-18]', 'a variation selector after a letter')
  assert.equal(parts(controlParts('id1\uFE0F')), 'id1[VS16|U+FE0F VARIATION SELECTOR-16]', 'or a digit, no keycap after it')
  assert.equal(parts(controlParts('x\uFE0F\u20E3')), 'x[VS16|U+FE0F VARIATION SELECTOR-16]\u20E3', 'or a keycap mark after what no keycap is')
  assert.equal(parts(controlParts('\u180B')), '[U+180B|U+180B invisible character]', 'one unnamed, as invisible')
  const drawn = '❤\uFE0F ☺\uFE0E 1\uFE0F\u20E3 #\uFE0F\u20E3'
  assert.deepEqual(controlParts(drawn), [drawn], "an emoji's own presentation selectors and keycaps stay text")
  assert.equal(hasControls('a b'), false, 'an ASCII space is none')
})

test('private use characters, noncharacters and unassigned code points show by number', () => {
  assert.equal(parts(controlParts('\uE0B0\u{F0000}')), '[U+E0B0|U+E0B0 private use character][U+F0000|U+F0000 private use character]')
  assert.equal(parts(controlParts('\uFFFE\uFDD0\u{10FFFF}')), '[U+FFFE|U+FFFE noncharacter][U+FDD0|U+FDD0 noncharacter][U+10FFFF|U+10FFFF noncharacter]')
  assert.equal(parts(controlParts('\u0378')), '[U+0378|U+0378 unassigned code point]')
})

test('tabs, newlines, CRLF line ends and the joiners and tags of an emoji stay text', () => {
  assert.deepEqual(controlParts('a\tb\nc\r\nd'), ['a\tb\nc\r\nd'])
  assert.equal(hasControls('a\tb\nc'), false)
  const emoji = '👩\u{1F3FD}\u200D💻 ❤\uFE0F\u200D🔥 🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'
  assert.deepEqual(controlParts(emoji), [emoji])
  assert.equal(parts(controlParts('a\u200Db')), 'a[ZWJ|U+200D ZERO WIDTH JOINER]b', 'a joiner between letters shows')
  assert.equal(parts(controlParts('🏴\u{E0067}\u{E0062}')), '🏴[g|U+E0067 TAG g][b|U+E0062 TAG b]', 'tags no cancel tag ends name no flag')
})

test('a lone CR shows; one ending the text ends a line only where a newline follows it', () => {
  assert.equal(parts(controlParts('a\rb\r\nc\r')), 'a[CR|U+000D CARRIAGE RETURN]b\r\nc[CR|U+000D CARRIAGE RETURN]')
  assert.deepEqual(controlParts('c\r', true), ['c\r'])
})

test('in highlighted markup the boxes go in the text, never in a tag, and a CR before a tag and a newline ends its line', () => {
  const markup = '<span class="token string" data-link="a\u0001b">"a\u0001b"</span>\r<span class="token punctuation">\n</span>x\u001B'
  assert.equal(controlMarkup(markup),
    '<span class="token string" data-link="a\u0001b">"a<span class="code-control" data-tooltip="U+0001 START OF HEADING">SOH</span>b"</span>\r<span class="token punctuation">\n</span>x<span class="code-control" data-tooltip="U+001B ESCAPE">ESC</span>')
  assert.equal(controlMarkup('<b>a\r</b>', true), '<b>a\r</b>')
  assert.equal(controlMarkup('&lt;\u{E003C}'), '&lt;<span class="code-control" data-tooltip="U+E003C TAG &lt;">&lt;</span>', 'labels are escaped')
  const plain = '<span class="token keyword">const</span> a = 1\r\n'
  assert.equal(controlMarkup(plain), plain, 'markup with none is returned as it is')
})

test('source text keeps to text nodes Chromium paints, with the boxes between them', () => {
  assert.equal(sourceText('const a = 1\n'), 'const a = 1\n')
  const long = 'x'.repeat(2 ** 20 + 1)
  const nodes = sourceText(`${long}\u001B`)
  assert.equal(nodes.length, 3)
  assert.ok(nodes.slice(0, 2).every(node => typeof node === 'string' && node.length <= 2 ** 20))
  assert.equal(parts(nodes.slice(2)), '[ESC|U+001B ESCAPE]')
})
