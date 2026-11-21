import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeBlocks, textLines } from '../common/line-diff.js'
import { listSourcemap, sourcemapDiffRebuilds, unlistSourcemap } from '../common/pretty-sourcemap.js'
import { UNSEEN } from '../risk/files/characters.js'
import { encodeMappings } from '../common/sourcemap-mappings.js'

// Characters made here, not written in this file: what a listing must show
// otherwise than as itself.
const char = (...points) => String.fromCodePoint(...points)
const EMOJI = char(0x1F600), LONE = char(0xD800), LS = char(0x2028), NBSP = char(0xA0), RLO = char(0x202E), TAG = char(0xE0041), ZWSP = char(0x200B)

// A small map of a TypeScript function compiled.
const TS = 'export function add(a: number, b: number) {\n  return a + b;\n}\n'
const mapOf = (fields = {}) => JSON.stringify({ version: 3, file: 'index.js', sources: ['../src/index.ts'], sourcesContent: [TS], names: ['add', 'a', 'b'],
  mappings: encodeMappings([[], [[0, 0, 0, 7], [9, 0, 0, 16, 0], [13, 0, 0, 20, 1], [16, 0, 0, 31, 2]], [[2, 0, 1, 2], [9, 0, 1, 9, 1], [13, 0, 1, 13, 2]], [[0, 0, 2, 0]], []]), ...fields })

// Random maps, the same each run: sources, texts and names made of pieces a
// listing could misread (its own markers, line ends of every kind, quotes,
// escapes, UNSEEN characters), keys in any order with others beside them.
function randomMaps(count) {
  let seed = 5
  const rand = n => (seed = (seed * 48271) % 2147483647) % n
  const pick = list => list[rand(list.length)]
  const pieces = ['a', 'const x = 1;', '  ', '\t', '"q"', '\\', '\\u0041', '\r', '\r\n', '\n', LS, RLO, ZWSP, NBSP, LONE, char(0xDC00), TAG, EMOJI, 'é', '#', '┌', '│ ', '┊', '  │ ', '}', ']', '[', '{', ' ', '"x": [', '0 0 1 0, ', '-1']
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

// One value of a map changed, as an attack or a rebuild might change it, or
// what follows its JSON.
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
const ENDS = ['', '\n', '\r\n', '\n\n', ' \n']

test('a source map is listed key by key, its texts line by line and its mappings a line of the generated file to a row', () => {
  const text = listSourcemap(mapOf())
  assert.equal(text, [
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
    '"mappings": {',
    '',
    '  0 0 0 7, 9 0 0 9 0, 4 0 0 4 1, 3 0 0 11 1',
    '  2 0 1 -29, 7 0 0 7 -1, 4 0 0 4 1',
    '  0 0 1 -13',
    '',
    '}',
    '',
  ].join('\n'))
  assert.equal(unlistSourcemap(text), mapOf())
  assert.throws(() => unlistSourcemap(text.slice(0, -1)), { message: 'Its listing ends with no line end.' })
  assert.throws(() => unlistSourcemap(`${text}x\n`), { message: /^Its listing's row \d+ names no key\.$/u })
})

test('what follows a map\'s JSON, a line end, is listed as its last row and read back with it', () => {
  for (const end of ['\n', '\r\n', '\n\n', ' \t\n']) {
    const listing = listSourcemap(`${mapOf()}${end}`)
    assert.equal(listing.split('\n').at(-2), JSON.stringify(end))
    assert.equal(unlistSourcemap(listing), `${mapOf()}${end}`)
  }
  const [a, b] = [mapOf(), `${mapOf()}\n`].map(listSourcemap)
  assert.deepEqual(changeBlocks(a, b), [{ a0: textLines(a).length, a1: textLines(a).length, b0: textLines(a).length, b1: textLines(a).length + 1 }], 'a line end added, a row added')
  assert.throws(() => unlistSourcemap(`${a}"x"\n`), { message: /^Its listing's row \d+ follows the JSON with more than blanks\.$/u })
})

test('a listing reads back to the very map it lists, whatever its values hold, and shows no character as another or none', () => {
  randomMaps(600).forEach((map, k) => {
    const text = `${JSON.stringify(map)}${ENDS[k % ENDS.length]}`
    const listing = listSourcemap(text)
    assert.equal(unlistSourcemap(listing), text)
    for (const row of listing.split('\n')) assert.ok(!UNSEEN.test(row), `a row shows no hidden character: ${JSON.stringify(row)}`)
  })
})

test('every change between two maps changes their listings, and the diff of the two reads back to the new map', () => {
  randomMaps(300).forEach((map, k) => {
    const end = ENDS[k % ENDS.length]
    const before = `${JSON.stringify(map)}${end}`
    const after = k % 7 === 6 ? `${JSON.stringify(map)}${end === '\n' ? '' : '\n'}` : `${JSON.stringify(changed(map, k))}${end}`
    const [a, b] = [before, after].map(listSourcemap)
    const blocks = changeBlocks(a, b)
    assert.ok(blocks.length > 0, `a change shows: ${k % 7 === 6 ? 'a line end' : k % 6}`)
    assert.equal(sourcemapDiffRebuilds({ a: textLines(a), b: textLines(b), blocks }, { text: before, listing: a }, { text: after, listing: b }), null)
  })
})

test('a diff that does not show every change between two maps is refused, saying why', () => {
  const [before, after] = [mapOf(), mapOf({ sourcesContent: [TS.replace('a + b', 'a - b')], names: ['add', 'a', 'b', 'c'] })]
  const [oldListing, newListing] = [before, after].map(listSourcemap)
  const [a, b] = [oldListing, newListing].map(textLines)
  const sides = [{ text: before, listing: oldListing }, { text: after, listing: newListing }]
  const blocks = changeBlocks(oldListing, newListing)
  assert.equal(sourcemapDiffRebuilds({ a, b, blocks }, ...sides), null)
  assert.ok(blocks.length >= 2)
  const refused = (drawn, why, given = sides) => assert.match(sourcemapDiffRebuilds({ a, b, blocks, ...drawn }, ...given), why)
  const notTaken = /^the changes drawn don't take the old map's listing to the new side drawn\.$/u
  for (const tampered of [blocks.slice(1), blocks.slice(0, -1), [], null, [{ ...blocks[0], b1: blocks[0].b1 - 1 }, ...blocks.slice(1)]]) refused({ blocks: tampered }, notTaken)
  // A row the changes leave as it was, drawn otherwise on the new side.
  refused({ b: b.map((row, i) => (i === 0 ? `${row} ` : row)) }, notTaken)
  // A row a change draws otherwise than the new map's listing has it.
  const inText = blocks.find(({ b0, b1 }) => b.slice(b0, b1).some(row => row.startsWith('  │')))
  refused({ b: b.map((row, i) => (i >= inText.b0 && i < inText.b1 && row.startsWith('  │') ? `${row}!` : row)) }, /^the new side drawn isn't the new map's listing\.$/u)
  refused({ a: a.slice(1) }, /^the old side drawn isn't the old map's listing\.$/u)
  refused({ a: b, b: a, blocks: changeBlocks(newListing, oldListing) }, /^the old side drawn isn't/u, sides)
  // The new map read back of the side drawn: another map than the new one, or none.
  refused({}, /^the new side drawn reads back to another map than the new one\.$/u, [sides[0], { text: before, listing: newListing }])
  const broken = [...b.slice(0, -1), 'not a row', b.at(-1)]
  refused({ b: broken, blocks: changeBlocks(oldListing, `${broken.join('\n')}\n`) }, /^Its listing's row \d+ is no line of mappings\.$/u, [sides[0], { text: after, listing: `${broken.join('\n')}\n` }])
  assert.equal(sourcemapDiffRebuilds({ a: [], b, blocks: [{ a0: 0, a1: 0, b0: 0, b1: b.length }] }, { text: '', listing: '' }, sides[1]), null, 'a map added')
  assert.equal(sourcemapDiffRebuilds({ a, b: [], blocks: [{ a0: 0, a1: a.length, b0: 0, b1: 0 }] }, sides[0], { text: '', listing: '' }), null, 'a map removed')
})

test('a map is listed only where its listing reads back to its text, and its mappings decoded only where they read back to theirs', () => {
  const refused = (text, why) => assert.throws(() => listSourcemap(text), { message: why }, JSON.stringify(text.slice(0, 40)))
  const notWritten = /^Its text isn't written as JSON\.stringify writes its JSON/u
  refused(JSON.stringify(JSON.parse(mapOf()), null, 2), notWritten)
  refused(`\n${mapOf()}`, notWritten)
  refused(`)]}'\n${mapOf()}`, /^Its text isn't JSON\.$/u)
  refused(mapOf().replace('{"version":3', '{"version":3,"version":3'), notWritten)
  refused(mapOf().replace('"version":3', '"version":3.0'), notWritten)
  refused(mapOf().replace('"add"', '"\\u0061dd"'), notWritten)
  refused('[1]', /^Its JSON isn't an object\.$/u)
  refused('not json', /^Its text isn't JSON\.$/u)
  refused(JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: JSON.parse(mapOf()) }] }), /^It is an index map/u)
  for (const fields of [{ mappings: 'AAAA,!' }, { mappings: 'ACAA' }, { mappings: 'gAAAA' }, { names: 'add' }, { sources: '../src/index.ts' }]) {
    const text = mapOf(fields)
    const listing = listSourcemap(text)
    assert.match(listing, new RegExp(`^"mappings": ${RegExp.escape(JSON.stringify(JSON.parse(text).mappings))}$`, 'mu'), 'shown as written')
    assert.equal(unlistSourcemap(listing), text)
  }
})

test('a character that shows as another or none is shown escaped, in a text, a source or a name', () => {
  const source = `const ok = true;\nconst admin = "${RLO}nimda${LS}";\n`
  const text = JSON.stringify({ version: 3, sources: [`a${ZWSP}.ts`], sourcesContent: [source], names: [`ad${ZWSP}min`], mappings: encodeMappings([[[0, 0, 0, 0]], [[6, 0, 1, 6, 0]]]) })
  const listing = listSourcemap(text)
  assert.match(listing, /^ {2}│ const ok = true;$/mu, 'a line with none as written')
  assert.match(listing, /^ {2}┊ "const admin = \\"\\u202enimda\\u2028\\";"$/mu, 'one with a bidi control or a line separator as JSON')
  assert.match(listing, /^ {2}"a\\u200b\.ts"$/mu, 'a source')
  assert.match(listing, /^ {2}┌ "a\\u200b\.ts"$/mu, 'a source over its text')
  assert.match(listing, /^ {2}"ad\\u200bmin"$/mu, 'a name')
  assert.ok(listing.split('\n').every(row => !UNSEEN.test(row)))
  assert.equal(unlistSourcemap(listing), text)
})

test('a listing is given up on past its limit', () => {
  const text = JSON.stringify({ version: 3, sources: ['a.ts'], sourcesContent: ['\n'.repeat(4_200_000)], names: [], mappings: 'AAAA' })
  assert.throws(() => listSourcemap(text), { name: 'RangeError', message: 'Its listing would run past 16,777,216 characters.' })
})
