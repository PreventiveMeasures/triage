import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeBlocks, textLines } from '../common/line-diff.js'
import { listSourcemap, sourcemapDiffRebuilds, sourcemapGenerated, unlistSourcemap } from '../common/pretty-sourcemap.js'
import { HIDDEN } from '../common/sourcemap-listing.js'
import { encodeMappings } from '../common/sourcemap-mappings.js'

// Characters made here, not written in this file: what a listing must show
// otherwise than as itself.
const char = (...points) => String.fromCodePoint(...points)
const EMOJI = char(0x1F600), LONE = char(0xD800), LS = char(0x2028), NBSP = char(0xA0), RLO = char(0x202E), TAG = char(0xE0041), ZWSP = char(0x200B)

// A small map of a TypeScript function compiled, and the file it is of.
const TS = 'export function add(a: number, b: number) {\n  return a + b;\n}\n'
const JS = '"use strict";\nfunction add(a, b) {\n  return a + b;\n}\n//# sourceMappingURL=index.js.map\n'
const mapOf = (fields = {}) => JSON.stringify({ version: 3, file: 'index.js', sources: ['../src/index.ts'], sourcesContent: [TS], names: ['add', 'a', 'b'],
  mappings: encodeMappings([[], [[0, 0, 0, 7], [9, 0, 0, 16, 0], [13, 0, 0, 20, 1], [16, 0, 0, 31, 2]], [[2, 0, 1, 2], [9, 0, 1, 9, 1], [13, 0, 1, 13, 2]], [[0, 0, 2, 0]], []]), ...fields })
const FILES = new Map([['lib/index.js', JS]])

// Random maps, the same each run: sources, texts and names made of pieces a
// listing could misread (its own markers, line ends of every kind, quotes,
// escapes, HIDDEN characters), keys in any order with others beside them.
function randomMaps(count) {
  let seed = 5
  const rand = n => (seed = (seed * 48271) % 2147483647) % n
  const pick = list => list[rand(list.length)]
  const pieces = ['a', 'const x = 1;', '  ', '\t', '"q"', '\\', '\\u0041', '\r', '\r\n', '\n', LS, RLO, ZWSP, NBSP, LONE, char(0xDC00), TAG, EMOJI, 'é', '#', '″', '←', '│ ', '┊', '  │ ', '@ ', '}', ']', '[', ' ', '"x": [', 'decoded {', '# ']
  const text = () => Array.from({ length: rand(12) }, () => pick(pieces)).join('')
  return Array.from({ length: count }, () => {
    const sources = Array.from({ length: 1 + rand(4) }, () => pick([text(), 'src/a.ts', 'src/b/a.ts', 'a.ts', null, 'webpack:///./x.js', '', '#1']))
    const names = Array.from({ length: rand(6) }, () => pick([text(), 'x', 'x', 'add', '']))
    const lines = Array.from({ length: 1 + rand(8) }, () => {
      let at = 0
      return Array.from({ length: rand(5) }, () => {
        at += rand(30)
        if (rand(5) === 0) return [at]
        const segment = [at, rand(sources.length), rand(6), rand(40)]
        return names.length > 0 && rand(2) === 0 ? [...segment, rand(names.length)] : segment
      })
    })
    const fields = [['version', 3], ['sources', sources], ['names', names], ['mappings', encodeMappings(lines)],
      ['sourcesContent', sources.map(() => (rand(4) === 0 ? null : text())).slice(0, sources.length - rand(2))],
      ...rand(2) ? [['file', text()]] : [], ...rand(2) ? [['sourceRoot', text()]] : [], ...rand(3) ? [] : [['ignoreList', [0]]],
      ...rand(4) ? [] : [['__proto__', { polluted: true }]], ...rand(4) ? [] : [['x_extra', { nested: [text(), 1, null] }]], ...rand(5) ? [] : [[text(), text()]]]
    for (let i = fields.length - 1; i > 0; i--) {
      const j = rand(i + 1)
      ;[fields[i], fields[j]] = [fields[j], fields[i]]
    }
    // JSON.parse, not Object.fromEntries: `__proto__` a key of its own.
    return JSON.parse(`{${fields.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')}}`)
  })
}

// One value of a map changed, as an attack or a rebuild might change it.
function changed(map, k) {
  const value = structuredClone(map)
  const lines = value.mappings.split(';')
  switch (k % 6) {
    case 0: value.sourcesContent = [...value.sourcesContent ?? [], `${RLO}x`]; break
    case 1: lines[lines.length - 1] += lines.at(-1) === '' ? 'C' : ',C'; value.mappings = lines.join(';'); break
    case 2: value.names = [...value.names ?? [], ZWSP]; break
    case 3: value.sources[0] = `${value.sources[0] ?? ''}x`; break
    case 4: value.x_added = 1; break
    default: value.version = 4
  }
  return value
}

test('a source map is listed key by key, its texts line by line and its mappings decoded, glossed with the file that names it', () => {
  const { text, generated } = listSourcemap(mapOf(), 'lib/index.js.map', FILES)
  assert.deepEqual(generated, { path: 'lib/index.js', text: JS })
  assert.equal(text.split('\n').filter(row => !row.startsWith('# ')).join('\n'), [
    '"version": 3',
    '"file": "index.js"',
    '"sources": [',
    '  "../src/index.ts"',
    ']',
    '"sourcesContent": [',
    '  ┌ "../src/index.ts"',
    '  │ export function add(a: number, b: number) {',
    '  │   return a + b;',
    '  │ }',
    '  │',
    ']',
    '"names": [',
    '  "add"',
    '  "a"',
    '  "b"',
    ']',
    '"mappings": decoded {',
    '@ "use strict";',
    '@ function add(a, b) {',
    '  ← index.ts +0  export function add(a: number, b: number) {',
    '      0:7 +9:16 "add" +4:20 "a" +3:31 "b"',
    '@   return a + b;',
    '  ← index.ts +1  return a + b;',
    '      2:2 +7:9 "a" +4:13 "b"',
    '@ }',
    '  ← index.ts +1  }',
    '      0:0',
    '@ //# sourceMappingURL=index.js.map',
    '}',
    '',
  ].join('\n'))
  assert.match(text, /^# Glossed \(@ ‹\) with lib\/index\.js, whose sourceMappingURL names this map\.$/mu)
  assert.match(text, /^# Sources: 1 \(1 with text\) · names: 3 · segments: 8 · lines: 5, 3 mapped\.$/mu)
  assert.equal(JSON.stringify(unlistSourcemap(text)), mapOf())
  const alone = listSourcemap(mapOf()).text
  assert.match(alone, /^# No file beside it whose sourceMappingURL names this map, to gloss it with\.$/mu)
  assert.match(alone, /\n@\n@\n {2}← index\.ts \+0 {2}export function add/u, 'its lines unglossed with no file')
})

test('a listing reads back to the very map it lists, whatever its values hold, and shows no character as another or none', () => {
  for (const map of randomMaps(600)) {
    const text = JSON.stringify(map)
    const { text: listing } = listSourcemap(text)
    assert.equal(JSON.stringify(unlistSourcemap(listing)), text)
    for (const row of listing.split('\n')) assert.ok(!HIDDEN.test(row), `a row shows no hidden character: ${JSON.stringify(row)}`)
  }
})

test('every change between two maps changes their listings, and the diff of the two reads back to the new map', () => {
  randomMaps(300).forEach((map, k) => {
    const after = JSON.stringify(changed(map, k)), before = JSON.stringify(map)
    const [a, b] = [before, after].map(text => listSourcemap(text).text)
    const blocks = changeBlocks(a, b)
    assert.ok(blocks.length > 0, `a change shows: ${k % 6}`)
    assert.equal(sourcemapDiffRebuilds({ a: textLines(a), b: textLines(b), blocks }, { text: before }, { text: after }), null)
  })
})

test('a diff that does not show every change between two maps is refused, saying why', () => {
  const [before, after] = [mapOf(), mapOf({ sourcesContent: [TS.replace('a + b', 'a - b')], names: ['add', 'a', 'b', 'c'] })]
  const sides = [{ text: before, path: 'lib/index.js.map', files: FILES }, { text: after, path: 'lib/index.js.map', files: FILES }]
  const [a, b] = sides.map(side => textLines(listSourcemap(side.text, side.path, side.files).text))
  const blocks = changeBlocks(`${a.join('\n')}\n`, `${b.join('\n')}\n`)
  assert.equal(sourcemapDiffRebuilds({ a, b, blocks }, ...sides), null)
  assert.ok(blocks.length >= 2)
  const refused = (drawn, why) => assert.match(sourcemapDiffRebuilds({ a, b, blocks, ...drawn }, ...sides), why)
  const even = blocks.findIndex(({ a0, a1, b0, b1 }) => a1 - a0 === b1 - b0), uneven = blocks.findIndex(({ a0, a1, b0, b1 }) => a1 - a0 !== b1 - b0)
  refused({ blocks: blocks.filter((_, i) => i !== uneven) }, /^the changes drawn don't fit the listings drawn\.$/u)
  refused({ blocks: blocks.filter((_, i) => i !== even) }, /^the new side drawn isn't what the changes drawn make of the old\.$/u)
  refused({ blocks: [] }, /^the changes drawn don't fit/u)
  refused({ blocks: null }, /^the changes drawn don't fit/u)
  refused({ blocks: [{ ...blocks[0], b1: blocks[0].b1 - 1 }, ...blocks.slice(1)] }, /^the changes drawn don't fit/u)
  // A row the changes leave as it was, drawn otherwise on the new side.
  const kept = b.map((row, i) => (i === 0 ? `${row} ` : row))
  refused({ b: kept }, /^the new side drawn isn't what the changes drawn make of the old\.$/u)
  // A line of a text the changes draw otherwise than the new map holds it.
  const inText = blocks.find(({ b0, b1 }) => b.slice(b0, b1).some(row => row.startsWith('  │')))
  const retexted = b.map((row, i) => (i >= inText.b0 && i < inText.b1 && row.startsWith('  │') ? `${row}!` : row))
  refused({ b: retexted }, /^what the changes drawn make of the old listing reads back to another map than the new one\.$/u)
  // A gloss drawn otherwise than the new map's listing has it: read past, held to it by listing it again.
  const atGloss = b.findIndex(row => row.startsWith('@ '))
  const swapped = b.map((row, i) => (i === atGloss ? '@ (another line)' : row))
  refused({ b: swapped, blocks: changeBlocks(`${a.join('\n')}\n`, `${swapped.join('\n')}\n`) }, /^what the changes drawn make of the old listing isn't the new map's listing\.$/u)
  refused({ a: a.slice(1) }, /^the old side drawn isn't the old map's listing\.$/u)
  assert.match(sourcemapDiffRebuilds({ a: b, b: a, blocks: changeBlocks(`${b.join('\n')}\n`, `${a.join('\n')}\n`) }, ...sides), /^the old side drawn isn't/u, 'sides swapped')
  assert.equal(sourcemapDiffRebuilds({ a: [], b, blocks: [{ a0: 0, a1: 0, b0: 0, b1: b.length }] }, { text: '' }, sides[1]), null, 'a map added')
  assert.equal(sourcemapDiffRebuilds({ a, b: [], blocks: [{ a0: 0, a1: a.length, b0: 0, b1: 0 }] }, sides[0], { text: '' }), null, 'a map removed')
})

test('a map is listed only where its listing reads back to its text, and its mappings decoded only where they read back to theirs', () => {
  const refused = (text, why) => assert.throws(() => listSourcemap(text), { message: why }, JSON.stringify(text.slice(0, 40)))
  const notWritten = /^Its text isn't written as JSON\.stringify writes its JSON/u
  refused(JSON.stringify(JSON.parse(mapOf()), null, 2), notWritten)
  refused(`${mapOf()}\n`, notWritten)
  refused(`)]}'\n${mapOf()}`, /^Its text isn't JSON\.$/u)
  refused(mapOf().replace('{"version":3', '{"version":3,"version":3'), notWritten)
  refused(mapOf().replace('"version":3', '"version":3.0'), notWritten)
  refused(mapOf().replace('"add"', '"\\u0061dd"'), notWritten)
  refused('[1]', /^Its JSON isn't an object\.$/u)
  refused('not json', /^Its text isn't JSON\.$/u)
  refused(JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: JSON.parse(mapOf()) }] }), /^It is an index map/u)
  const asWritten = (fields, why) => {
    const text = mapOf(fields), { text: listing } = listSourcemap(text)
    assert.match(listing, new RegExp(`^# Its mappings are shown as written: ${why}`, 'mu'))
    assert.match(listing, new RegExp(`^"mappings": ${RegExp.escape(JSON.stringify(JSON.parse(text).mappings))}$`, 'mu'))
    assert.equal(JSON.stringify(unlistSourcemap(listing)), text)
  }
  asWritten({ mappings: 'AAAA,!' }, '"!" at 5 is no base64 digit\\.')
  asWritten({ mappings: 'ACAA' }, 'A segment before 4 names source 1, of 1\\.')
  asWritten({ mappings: 'gAAAA' }, 'its values are written in more digits than they need\\.')
  asWritten({ names: ['add', 1] }, 'its names are no list of strings\\.')
  asWritten({ sources: '../src/index.ts' }, 'its sources are no list\\.')
})

test('a listing is glossed only with the file beside it whose sourceMappingURL names the map', () => {
  const map = JSON.parse(mapOf())
  const found = (files, path = 'lib/index.js.map', value = map) => sourcemapGenerated(value, path, new Map(Object.entries(files)))?.path ?? null
  assert.equal(found({ 'lib/index.js': JS }), 'lib/index.js')
  assert.equal(found({ 'lib/index.js': JS }, 'lib/index.js.map', { ...map, file: undefined }), 'lib/index.js', 'at its own path without .map')
  assert.equal(found({ 'lib/out.js': '//# sourceMappingURL=index.js.map\n' }, 'lib/index.js.map', { ...map, file: 'out.js' }), 'lib/out.js', 'the one its file names')
  assert.equal(found({ 'lib/index.js': '//# sourceMappingURL=../maps/index.js.map\n' }, 'maps/index.js.map', { ...map, file: '../lib/index.js' }), 'lib/index.js')
  assert.equal(found({ 'lib/index.js': '//# sourceMappingURL=other.js.map\n' }), null, 'one that names another map')
  assert.equal(found({ 'lib/index.js': '//# sourceMappingURL=data:application/json;base64,e30=\n' }), null, 'one that holds its own')
  assert.equal(found({ 'lib/index.js': '"use strict";\n' }), null, 'one that names none')
  assert.equal(found({}), null)
  assert.equal(sourcemapGenerated(map, 'lib/index.js.map', null), null)
})

test('a character that shows as another or none is shown escaped, in a text, a name or a gloss', () => {
  const source = `const ok = true;\nconst admin = "${RLO}nimda${LS}";\n`
  const generated = `${source}//# sourceMappingURL=index.js.map\n`
  const text = JSON.stringify({ version: 3, file: 'index.js', sources: [`a${ZWSP}.ts`], sourcesContent: [source], names: [`ad${ZWSP}min`], mappings: encodeMappings([[[0, 0, 0, 0]], [[6, 0, 1, 6, 0]]]) })
  const { text: listing } = listSourcemap(text, 'index.js.map', new Map([['index.js', generated]]))
  assert.match(listing, /^ {2}│ const ok = true;$/mu, 'a line with none as written')
  assert.match(listing, /^ {2}┊ "const admin = \\"\\u202e/mu, 'one with a bidi control as JSON')
  assert.match(listing, /nimda\\u2028/u, 'a line separator as JSON')
  assert.match(listing, /^ {2}"a\\u200b\.ts"$/mu, 'a source')
  assert.match(listing, / "ad\\u200bmin"$/mu, 'a name as a segment gives it')
  assert.match(listing, /^ {2}← #0 \+1 {2}"const admin = \\"\\u202e/mu, 'a source line gloss, its source by index')
  assert.ok(listing.split('\n').every(row => !HIDDEN.test(row)))
  assert.equal(JSON.stringify(unlistSourcemap(listing)), text)
})

test('a minified line is glossed a run at a time, with what its minifier renamed', () => {
  const source = ['export function update(name, oldValue, useNewValue = false, newValue) {', '  if (useNewValue === false) {', '    newValue = this[name];', '  }', '}'].join('\n')
  const body = 'function u(t,s,e=!1,h){!1===e&&(h=this[t])}'
  const code = `${'/* license */'.repeat(12)}${body}\n//# sourceMappingURL=a.js.map`
  const at = needle => code.indexOf(needle)
  const lines = [[[at('function'), 0, 0, 0], [at('u('), 0, 0, 16, 0], [at('t,s'), 0, 0, 23, 1], [at('e=!1'), 0, 0, 39, 2], [at('h)'), 0, 0, 60, 3],
    [at('!1===e'), 0, 1, 2], [at('e&&'), 0, 1, 6, 2], [at('h=this'), 0, 2, 4, 3], [at('t])'), 0, 2, 20, 1]]]
  const text = JSON.stringify({ version: 3, file: 'a.js', sources: ['src/a.ts'], sourcesContent: [source], names: ['update', 'name', 'useNewValue', 'newValue'], mappings: encodeMappings(lines) })
  const { text: listing } = listSourcemap(text, 'a.js.map', new Map([['a.js', code]]))
  const rows = listing.slice(listing.indexOf('"mappings"')).split('\n')
  const step = (from, to) => `+${at(to) - at(from)}`
  assert.deepEqual(rows.slice(1, 16), [
    `@ (${code.split('\n')[0].length} characters)`,
    `    ‹ ${'/* license */'.repeat(12)}`,
    '  ← a.ts +0  export function update(name, oldValue, useNewValue = false, newValue) {',
    '    ‹ function u(t,s,e=!1,h){',
    '    renamed: u ← update, t ← name, e ← useNewValue, h ← newValue',
    `      ${at('function')}:0 ${step('function', 'u(')}:16 "update" ${step('u(', 't,s')}:23 "name" ${step('t,s', 'e=!1')}:39 "useNewValue" ${step('e=!1', 'h)')}:60 "newValue"`,
    '  ← a.ts +1  if (useNewValue === false) {',
    '    ‹ !1===e&&(',
    '    renamed: e ← useNewValue',
    `      ${step('h)', '!1===e')}:2 ${step('!1===e', 'e&&')}:6 "useNewValue"`,
    '  ← a.ts +1  newValue = this[name];',
    '    ‹ h=this[t])}',
    '    renamed: h ← newValue, t ← name',
    `      ${step('e&&', 'h=this')}:4 "newValue" ${step('h=this', 't])')}:20 "name"`,
    '}',
  ])
  assert.equal(JSON.stringify(unlistSourcemap(listing)), text)
})
