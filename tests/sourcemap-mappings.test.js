import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MappingsError, decodeMappings, encodeDeltas, encodeMappings, mappingsDeltas } from '../common/sourcemap-mappings.js'

// Random lines of segments, the same each run, every value within the
// sources and names counts given.
function randomLines(count, sources, names) {
  let seed = 3
  const rand = n => (seed = (seed * 48271) % 2147483647) % n
  const lines = []
  let column = 0, line = 0, source = 0
  for (let i = 0; i < count; i++) {
    const segments = []
    let at = 0
    for (let k = rand(6); k > 0; k--) {
      at += rand(40)
      if (rand(5) === 0) segments.push([at])
      else {
        source = rand(sources)
        line = Math.max(0, line + rand(9) - 3)
        column = rand(2) === 0 ? rand(120) : column
        segments.push(names > 0 && rand(3) === 0 ? [at, source, line, column, rand(names)] : [at, source, line, column])
      }
    }
    lines.push(segments)
  }
  return lines
}

test('mappings decode to a line of segments each, every value absolute, and encode back', () => {
  assert.deepEqual(decodeMappings('', 0, 0), [[]], 'one line, mapped from nothing')
  assert.deepEqual(decodeMappings(';;', 0, 0), [[], [], []])
  assert.deepEqual(decodeMappings('AAAA,EAAE;AACA,IAAIA', 1, 1), [[[0, 0, 0, 0], [2, 0, 0, 2]], [[0, 0, 1, 2], [4, 0, 1, 6, 0]]],
    'columns from the one before on the line; sources, lines, columns and names from the segment before, whatever its line')
  assert.deepEqual(decodeMappings('A,C', 0, 0), [[[0], [1]]], 'segments of no source')
  assert.deepEqual(decodeMappings('gBAAA', 1, 0), [[[16, 0, 0, 0]]], 'a value over two digits')
  assert.equal(encodeMappings([[[0, 0, 0, 0], [2, 0, 0, 2]], [[0, 0, 1, 2], [4, 0, 1, 6, 0]]]), 'AAAA,EAAE;AACA,IAAIA')
  assert.equal(encodeMappings([[[2 ** 31 - 1]]]), '+/////D', 'the largest value')
  assert.deepEqual(decodeMappings('+/////D', 0, 0), [[[2 ** 31 - 1]]])
  const lines = randomLines(2000, 7, 30)
  const text = encodeMappings(lines)
  assert.deepEqual(decodeMappings(text, 7, 30), lines)
  assert.equal(encodeMappings(decodeMappings(text, 7, 30)), text)
})

test('mappings the format does not allow are refused, never read otherwise', () => {
  const refused = (mappings, sources = 1, names = 1) => assert.throws(() => decodeMappings(mappings, sources, names), MappingsError, JSON.stringify(mappings))
  refused('AA!A', 1)
  refused('AAAA,', 1)
  refused(',AAAA', 1)
  refused('AAAA,;AAAA', 1)
  refused('AA', 1)
  refused('AAA', 1)
  refused('AAAAAA', 1)
  refused('g', 1)
  refused('AAAg;', 1)
  refused('gggggggB', 1)
  refused('D', 1)
  refused('ACAA', 1)
  refused('ADAA', 1)
  refused('AAAAC', 1, 1)
  refused('AAAAA', 1, 0)
  refused('AAAA', 0)
  refused('AADA', 1)
  refused('AAAD', 1)
  refused('AAAAé', 1)
  refused('AAAA\u{1F600}', 1)
})

test('a value written in more digits than it needs decodes, but encodes otherwise: a reader of both tells it', () => {
  assert.deepEqual(decodeMappings('gAAAA', 1, 0), [[[0, 0, 0, 0]]])
  assert.equal(encodeMappings(decodeMappings('gAAAA', 1, 0)), 'AAAA')
  assert.equal(encodeMappings(decodeMappings('BAAA', 1, 0)), 'AAAA', 'a negative zero, as one')
})

test('segments read as each value from the one before, as the format writes them, and written back of those', () => {
  const lines = [[[0, 0, 0, 0], [2, 0, 0, 2]], [[0, 0, 1, 2], [4, 0, 1, 6, 0]], [], [[3]]]
  assert.deepEqual(mappingsDeltas(lines), [[[0, 0, 0, 0], [2, 0, 0, 2]], [[0, 0, 1, 0], [4, 0, 0, 4, 0]], [], [[3]]],
    'a column from the one before on its line, a source, line, column and name from the segment before, whatever its line')
  assert.equal(encodeDeltas(mappingsDeltas(lines)), 'AAAA,EAAE;AACA,IAAIA;;G')
  const many = randomLines(2000, 7, 30)
  assert.equal(encodeDeltas(mappingsDeltas(many)), encodeMappings(many))
})
