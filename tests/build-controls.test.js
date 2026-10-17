import assert from 'node:assert/strict'
import { test } from 'node:test'
import { transform } from 'esbuild'
import { minify } from 'oxc-minify'
import { escapedControls } from '../build-controls.js'

const RAW = /(?![\t\n\r])\p{Cc}/u
const valuesOf = async code => (await import(`data:text/javascript,${encodeURIComponent(code)}`)).default

test('control characters esbuild and oxc-minify print raw are escaped again, reading the same', async () => {
  const source = String.raw`export default { sentinel: '\u0001', subsep: '\u001C', all: '\0\x01\x07\b\v\f\x0e\x1b\x1f\x7f', template: ${'`'}\u0002${'$'}{1}${'`'}, regex: /\u0003/u.source }`
  const { code } = await transform(source, { minify: true, format: 'esm' })
  assert.match(code, RAW, 'esbuild prints them raw, whatever the source wrote')
  const escaped = escapedControls(code)
  assert.doesNotMatch(escaped, RAW, 'none left raw')
  assert.deepEqual(await valuesOf(escaped), await valuesOf(code), 'each reading as the character itself')
  // build.js minifies esbuild's output again, and escapes what that prints.
  const { code: again } = await minify('out.js', escaped, { module: true })
  assert.match(again, RAW, 'oxc-minify prints them raw, escaped or not')
  assert.doesNotMatch(escapedControls(again), RAW, 'none left raw after it either')
  assert.deepEqual(await valuesOf(escapedControls(again)), await valuesOf(code), 'still each the character itself')
  assert.equal(escapedControls('a\tb\nc\r\n'), 'a\tb\nc\r\n', 'tabs and line ends as they are')
})
