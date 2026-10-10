import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NPM_SIZE_CLASSES, npmSizeClass } from '../ui/view/npm-size-class.js'

test('each measure of a package runs from tiny to gigantic, a bound starting the next class', () => {
  assert.deepEqual([0, 1, 3, 4, 10, 11, 25, 26].map(count => npmSizeClass('dependencies', count)),
    ['tiny', 'small', 'small', 'medium', 'medium', 'large', 'large', 'gigantic'])
  assert.deepEqual([1, 5, 1051].map(count => npmSizeClass('files', count)), ['tiny', 'small', 'gigantic'])
  assert.deepEqual([249, 40_771, 250_000].map(lines => npmSizeClass('lines', lines)), ['tiny', 'large', 'gigantic'])
  assert.deepEqual([308 * 1024, 1.3 * 1024 * 1024].map(bytes => npmSizeClass('unpacked', bytes)), ['medium', 'large'])
  assert.deepEqual(NPM_SIZE_CLASSES, ['tiny', 'small', 'medium', 'large', 'gigantic'])
})
