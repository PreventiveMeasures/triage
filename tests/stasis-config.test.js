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
  for (const [directory, entry] of [['', '../x.js'], ['', '/x.js'], ['packages/app', '../other/x.js'], ['packages/app', 'src/../../x.js']]) {
    assert.equal(configEntryKey(directory, entry), null, `${directory}: ${entry}`)
    assert.throws(() => config({ [entry]: {} }, directory), /must be a path relative to the directory of stasis\.config\.json, within it/u)
  }
  assert.throws(() => config({ 'src/index.ts': {}, './src/index.ts': {} }, 'app'),
    /app\/stasis\.config\.json: entries "\.\/src\/index\.ts" names the same entry as "src\/index\.ts"/u)
})

test('entry options become buildGitHubBundle’s, in one order whatever the file’s', () => {
  const named = config({
    'index.js': { platforms: ['ios', 'android,ios'], metro: true, jsx: true, define: ['__DEV__=false', 'process.env.NODE_ENV="production"'], 'babel-aliases': 'aliases.json' },
    'node.js': { 'package-json': true, conditions: 'node, worker', mainFields: ['module', 'main'], typescript: false, resources: 'png,svg', scope: 'full' },
    'Token.sol': { manifests: true, mapping: 'remappings.txt' },
    'quiet.js': { babel: false, flow: false, define: '__DEV__=true' },
  })
  assert.deepEqual([...named.keys()], ['index.js', 'node.js', 'Token.sol', 'quiet.js'])
  const index = named.get('index.js')
  assert.deepEqual(index, { entry: 'index.js', runs: null, options: {
    metro: true, babelAliases: 'aliases.json', platforms: ['ios', 'android'], jsx: true, define: { __DEV__: false, 'process.env.NODE_ENV': 'production' },
  } })
  assert.deepEqual(Object.keys(index.options), ['metro', 'babelAliases', 'platforms', 'jsx', 'define'])
  assert.deepEqual(named.get('node.js').options, { scope: 'full', conditions: ['node', 'worker'], mainFields: ['module', 'main'], resources: ['png', 'svg'], packageJSON: true })
  assert.deepEqual(named.get('Token.sol').options, { mappingFile: 'remappings.txt', manifests: true })
  assert.deepEqual(named.get('quiet.js'), { entry: 'quiet.js', runs: null, options: { define: { __DEV__: true } } }, 'false is no option, as `stasis bundle` takes it')
})

test('options that run code are kept as such: no build runs them', () => {
  for (const [option, value] of [['babel', true], ['metro-resolver', true], ['flow', true], ['cargo', true], ['cargo-target', 'host']]) {
    const named = config({ 'index.js': { metro: true, platforms: 'ios', [option]: value } })
    assert.equal(named.get('index.js').runs, option)
    assert.deepEqual(named.get('index.js').options, { metro: true, platforms: ['ios'] })
  }
})

test('what `stasis bundle` refuses to read is refused', () => {
  assert.throws(() => parseStasisConfig('{'), /stasis\.config\.json is not valid JSON/u)
  assert.throws(() => parseStasisConfig('{"entries":[]}'), /entries must be an object/u)
  for (const [options, message] of [
    [[], /must be an object of stasis bundle options/u],
    [{ output: 'x.br' }, /output is the bundle's option, not an entry's/u],
    [{ lockfile: 'stasis.lock.json' }, /lockfile is the bundle's option/u],
    [{ generate: 'prisma' }, /unknown option "generate"/u],
    [{ metro: 'yes' }, /metro must be true or false/u],
    [{ babel: 'yes' }, /babel must be true or false/u],
    [{ scope: ['full'] }, /scope must be a string$/u],
    [{ conditions: [1] }, /conditions must be a string or an array of strings/u],
    [{ conditions: ' , ' }, /conditions must list at least one value/u],
    [{ define: 'DEV' }, /define must be KEY=VALUE/u],
    [{ define: ['A=1', 'A=2'] }, /define gives A a value twice/u],
    [{ define: 'A=production' }, /define's value for A must be JSON/u],
    [{ define: [] }, /define must give at least one KEY=VALUE/u],
  ]) {
    assert.throws(() => config({ 'index.js': options }, 'app'), error => message.test(error.message) && error.message.startsWith('app/stasis.config.json: entries "index.js"'), JSON.stringify(options))
  }
})
