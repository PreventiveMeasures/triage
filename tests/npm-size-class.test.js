import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NPM_SIZE_CLASSES, npmSizeClass } from '../ui/view/npm-size-class.js'

test('each measure of a package runs from tiny to gigantic, a bound starting the next class', () => {
  assert.deepEqual([0, 1, 3, 4, 10, 11, 25, 26].map(count => npmSizeClass('dependencies', count)),
    ['tiny', 'small', 'small', 'medium', 'medium', 'large', 'large', 'gigantic'])
  assert.deepEqual([2, 3, 62, 1048, 1536].map(count => npmSizeClass('files', count)), ['tiny', 'small', 'medium', 'large', 'gigantic'])
  assert.deepEqual([399, 400, 4800, 40_700, 204_800].map(lines => npmSizeClass('lines', lines)), ['tiny', 'small', 'medium', 'large', 'gigantic'])
  assert.deepEqual([5 * 1024, 205 * 1024, 1.3 * 1024 * 1024, 8 * 1024 * 1024].map(bytes => npmSizeClass('unpacked', bytes)), ['tiny', 'medium', 'large', 'gigantic'])
  assert.deepEqual(NPM_SIZE_CLASSES, ['tiny', 'small', 'medium', 'large', 'gigantic'])
})
