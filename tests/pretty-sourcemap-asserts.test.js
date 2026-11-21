import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

// The listing as sourcemap-listing.js makes it, or as `fault.make` makes it of
// that in its place: a writer gone wrong, which what listSourcemap asserts of
// every listing at runtime must refuse.
const fault = { make: null }
const listing = await import('../common/sourcemap-listing.js')
mock.module('../common/sourcemap-listing.js', { exports: { ...listing,
  sourcemapListing: (...args) => {
    const made = listing.sourcemapListing(...args)
    return fault.make ? fault.make(made) : made
  } } })
const { listSourcemap, unlistSourcemap } = await import('../common/pretty-sourcemap.js')
const { encodeMappings } = await import('../common/sourcemap-mappings.js')

const RLO = String.fromCodePoint(0x202E)
const TS = 'export function add(a: number, b: number) {\n  return a + b;\n}\n'
const JS = '"use strict";\nfunction add(a, b) {\n  return a + b;\n}\n//# sourceMappingURL=index.js.map\n'
const MAP = JSON.stringify({ version: 3, file: 'index.js', sources: ['../src/index.ts'], sourcesContent: [TS], names: ['add', 'a', 'b'],
  mappings: encodeMappings([[], [[0, 0, 0, 7], [9, 0, 0, 16, 0], [13, 0, 0, 20, 1], [16, 0, 0, 31, 2]], [[2, 0, 1, 2], [9, 0, 1, 9, 1], [13, 0, 1, 13, 2]], [[0, 0, 2, 0]], []]) })
const FILES = new Map([['lib/index.js', JS]])
const listed = () => listSourcemap(MAP, 'lib/index.js.map', FILES).text

test('a listing that would read back to another map than it lists is refused at runtime, before it is shown', t => {
  t.after(() => { fault.make = null })
  assert.equal(JSON.stringify(unlistSourcemap(listed())), MAP, 'the writer as it is')
  fault.make = made => made.replace('  │   return a + b;', '  │   return a - b;')
  assert.throws(listed, { message: "Its listing doesn't read back to its text." }, 'a line of a source written otherwise')
  fault.make = made => made.replace('      2:2 +7:9 "a" +4:13 "b"', '      2:2 +7:9 "a" +4:14 "b"')
  assert.throws(listed, { message: "Its listing doesn't read back to its text." }, 'a segment moved a column')
  fault.make = made => made.replace('\n  "b"\n', '\n')
  assert.throws(listed, { message: /^Its listing's row \d+ names no name of the map\.$/u }, 'a name left out that a segment gives')
})

test('a listing that would show a character as another or none is refused at runtime, though it reads back', t => {
  t.after(() => { fault.make = null })
  fault.make = made => made.replace('@ "use strict";', `@ "use strict";${RLO}`)
  assert.equal(JSON.stringify(unlistSourcemap(fault.make(listing.sourcemapListing(JSON.parse(MAP), { path: 'lib/index.js', text: JS })))), MAP, 'a gloss, which reads back')
  assert.throws(listed, { message: 'Its listing would show a character as another or none.' })
})
