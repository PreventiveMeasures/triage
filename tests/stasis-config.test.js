import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configEntryKey, parseStasisConfig } from '../server-managed/stasis-config.ts'

const config = (entries, directory) => parseStasisConfig(JSON.stringify({ entries }), directory)

test('stasis.config.json without entries lists none', () => {
  assert.equal(parseStasisConfig('{}'), null)
  assert.equal(parseStasisConfig(JSON.stringify({ scope: 'full', resources: ['png'] })), null)
  assert.deepEqual([...config({})], [])
})

test('entries name paths within the file’s directory, as `stasis bundle` there resolves them', () => {
  assert.equal(configEntryKey('', './src//index.ts'), 'src/index.ts')
  assert.equal(configEntryKey('packages/app', 'src/../bin/cli.js'), 'bin/cli.js')
  assert.equal(configEntryKey('packages/app', '../app/index.ts'), 'index.ts')
  assert.equal(configEntryKey('packages/app', '.'), '.')
  assert.deepEqual([...config({ './src/index.ts': { conditions: 'node' }, 'bin/cli.js': { babel: true }, 'x.js': { unknown: 1 } }, 'app')],
    ['src/index.ts', 'bin/cli.js', 'x.js'], 'their options are Stasis’s to check')
  for (const [directory, entry] of [['', '../x.js'], ['', '/x.js'], ['packages/app', '../other/x.js'], ['packages/app', 'src/../../x.js']]) {
    assert.equal(configEntryKey(directory, entry), null, `${directory}: ${entry}`)
    assert.throws(() => config({ [entry]: {} }, directory), /must be a path relative to the directory of stasis\.config\.json, within it/u)
  }
  assert.throws(() => config({ 'src/index.ts': {}, './src/index.ts': {} }, 'app'),
    /app\/stasis\.config\.json: entries "\.\/src\/index\.ts" names the same entry as "src\/index\.ts"/u)
})

test('one whose entries Stasis can’t tell is refused', () => {
  assert.throws(() => parseStasisConfig('{'), /stasis\.config\.json is not valid JSON/u)
  for (const entries of [[], 'index.js', null]) {
    assert.throws(() => parseStasisConfig(JSON.stringify({ entries }), 'app'), /app\/stasis\.config\.json: entries must be an object/u, JSON.stringify(entries))
  }
})
