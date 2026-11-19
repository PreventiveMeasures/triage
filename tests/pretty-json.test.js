import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prettyJSON, prettyJsonText } from '../common/pretty-json.js'

// Random JSON values, the same each run.
function values(count) {
  let seed = 7
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  const pick = list => list[Math.floor(rand() * list.length)]
  const value = depth => {
    const r = rand()
    if (depth > 5 || r < 0.35) return pick([null, true, false, 0, -1.5, 1e21, 'a', '', 'x'.repeat(Math.floor(rand() * 150)), 'q"\\\n é'])
    if (r < 0.65) return Array.from({ length: Math.floor(rand() * 6) }, () => value(depth + 1))
    return Object.fromEntries(Array.from({ length: Math.floor(rand() * 6) }, (_, i) => [pick(['k', 'a longer key', '2', '__proto__', `k${i}`, '']), value(depth + 1)]))
  }
  return Array.from({ length: count }, () => value(0))
}

test('prettyJSON lays JSON out two spaces deep, as JSON.stringify does, keeping on one line what fits', () => {
  const report = { findings: [{ file: 'a.js', line: 12 }, { file: 'b.js', line: 3, tags: [] }], meta: {} }
  assert.equal(prettyJSON(report, { width: 50 }), [
    '{',
    '  "findings": [',
    '    { "file": "a.js", "line": 12 },',
    '    { "file": "b.js", "line": 3, "tags": [] }',
    '  ],',
    '  "meta": {}',
    '}',
  ].join('\n'))
  assert.equal(prettyJSON(report), '{ "findings": [{ "file": "a.js", "line": 12 }, { "file": "b.js", "line": 3, "tags": [] }], "meta": {} }')
  assert.equal(prettyJSON('x'.repeat(200)), JSON.stringify('x'.repeat(200)), 'a value too long for any line is written on its own')
  for (const value of values(2000)) {
    assert.equal(prettyJSON(value, { width: 0 }), JSON.stringify(value, undefined, 2), 'with no room, JSON.stringify\'s layout')
    const text = prettyJSON(value)
    assert.equal(JSON.stringify(JSON.parse(text)), JSON.stringify(value))
    for (const line of text.split('\n')) {
      if (line.length > 120) assert.match(line, /^ *(?:"(?:[^"\\]|\\.)*": )?(?:"(?:[^"\\]|\\.)*"|[[{]),?$/u, 'only a long string, or a long key\'s bracket, runs past the width')
    }
  }
})

test('prettyJSON folds within the width at any depth, its indentation and key counted', () => {
  const nested = { a: { b: { c: { list: Array.from({ length: 21 }, (_, i) => i * 100) } } } }
  assert.ok(prettyJSON(nested).split('\n').every(line => line.length <= 120))
  const folded = `        "list": [${nested.a.b.c.list.join(', ')}]`
  assert.ok(prettyJSON(nested, { width: folded.length }).split('\n').includes(folded), 'folded where it fits')
  assert.ok(prettyJSON(nested, { width: folded.length - 1 }).split('\n').includes('          0,'), 'unfolded one character short')
})

test('prettyJsonText pretty-prints a JSON text, keeping whether it ends in a line end, null for one that isn\'t JSON', () => {
  assert.equal(prettyJsonText('{"a":1,"b":[1,2,{"c":"d"}]}\n'), '{ "a": 1, "b": [1, 2, { "c": "d" }] }\n')
  assert.equal(prettyJsonText('[1,2]'), '[1, 2]')
  assert.equal(prettyJsonText('{\r\n  "a": 1\r\n}\r\n'), '{ "a": 1 }\n')
  assert.equal(prettyJsonText('["\\ud800", "é", {"__proto__": {"x": 1}}]'), '["\\ud800", "é", { "__proto__": { "x": 1 } }]', 'escaped as JSON.stringify escapes it')
  for (const text of ['module.exports = {}', '{ // c\n "a": 1 }', '{"a":1,}', '﻿{"a":1}', '']) assert.equal(prettyJsonText(text), null, text)
})

test('prettyJSON gives up past its limit, which deep nesting reaches from a short text', () => {
  const nested = `${'['.repeat(500)}${'0,'.repeat(100_000)}0${']'.repeat(500)}`
  assert.throws(() => prettyJSON(JSON.parse(nested), { limit: 1_000_000 }), { name: 'RangeError', message: 'The copy would run past 1,000,000 characters.' })
  assert.throws(() => prettyJsonText(nested), /would run past 16,777,216 characters/u)
  assert.equal(prettyJSON([1, [2, 3]], { width: 0, limit: 29 }).length, 29, 'up to it')
  assert.throws(() => prettyJSON([1, [2, 3]], { width: 0, limit: 28 }), RangeError)
})

test('prettyJsonText refuses a text of lone surrogates, or one its copy would read otherwise than', () => {
  assert.throws(() => prettyJsonText('["\uD800"]'), /lone surrogates/u)
  for (const text of ['{"a":1,"a":2}', '{"b":1,"2":2,"1":3}', '{"u":"a\\/b"}', '{"u":"\\u00e9"}', '["\\uD800"]', '[1.0]', '[1E3]', '[-0]', '[12345678901234567890]']) {
    assert.throws(() => prettyJsonText(text), /more than its layout/u, text)
  }
  for (const value of values(500)) {
    const text = JSON.stringify(value)
    assert.equal(prettyJsonText(text), prettyJSON(value), 'any text JSON.stringify writes')
  }
})
