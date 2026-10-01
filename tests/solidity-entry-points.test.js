import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addSoliditySuggestion, readSolidityEntryPoints } from '../server-managed/solidity-entry-points.ts'

const sha = 'b'.repeat(40)
const dir = (name, parent = '') => ({ name, path: parent ? `${parent}/${name}` : name, type: 'dir', sha })
const file = (name, parent = '') => ({ name, path: parent ? `${parent}/${name}` : name, type: 'file' })
const blob = (path, overrides = {}) => ({ path, type: 'blob', mode: '100644', ...overrides })

test('Solidity suggestions use immutable source trees, keep nested sources, and exclude non-production paths', async () => {
  const calls = []
  const result = await readSolidityEntryPoints('packages/token', [dir('contracts', 'packages/token'), file('Root.sol', 'packages/token')], suffix => {
    calls.push(suffix)
    return Promise.resolve({ tree: [
      blob('Token.sol'), blob('libraries/Math.sol'), blob('lib/Local.sol'), blob('interfaces/IToken.sol'), blob('nested/Vault.sol'),
      ...['test/Token.sol', 'tests/Token.sol', 'scripts/Deploy.sol', 'script/Deploy.sol', 'mocks/Token.sol', 'node_modules/pkg/Token.sol', 'vendor/Token.sol', 'artifacts/Token.sol', 'cache/Token.sol', 'build/Token.sol', 'out/Token.sol', 'Token.t.sol', 'Token.s.sol', 'Token.test.sol', 'Token.spec.sol', '../Private.sol', '/Absolute.sol', 'a//Invalid.sol', 'a\\Invalid.sol', 'README.md'].map(path => blob(path)),
      blob('Link.sol', { mode: '120000' }), blob('Submodule.sol', { type: 'commit', mode: '160000' }),
    ], truncated: false })
  })
  assert.deepEqual(calls, [`/git/trees/${sha}?recursive=1`])
  assert.deepEqual(result, { paths: ['packages/token/Root.sol', 'packages/token/contracts/Token.sol', 'packages/token/contracts/interfaces/IToken.sol', 'packages/token/contracts/lib/Local.sol', 'packages/token/contracts/libraries/Math.sol', 'packages/token/contracts/nested/Vault.sol'], limited: false })
})

test('Foundry and Hardhat markers enable src discovery without evaluating configuration', async () => {
  for (const config of ['foundry.toml', 'hardhat.config.ts', 'hardhat.config.js', 'hardhat.config.cjs', 'hardhat.config.mjs']) {
    let calls = 0
    const result = await readSolidityEntryPoints('', [file(config), dir('src'), dir('test'), dir('lib')], suffix => {
      assert.equal(suffix, `/git/trees/${sha}?recursive=1`)
      calls++
      return Promise.resolve({ tree: [blob('Token.sol')] })
    })
    assert.deepEqual(result.paths, ['src/Token.sol'])
    assert.equal(calls, 1)
  }
})

test('ordinary projects and unsupported source roots trigger no extra GitHub reads', async () => {
  const neverRead = () => { assert.fail('must not fetch this tree') }
  for (const entries of [
    [dir('src'), file('package.json')],
    [{ ...dir('contracts'), type: 'symlink' }],
    [{ ...dir('contracts'), submodule_git_url: 'https://example.com' }],
    [{ ...dir('contracts'), sha: '../untrusted' }],
    [{ ...dir('contracts'), path: 'private/contracts' }],
    [null, { ...file('Visible.sol'), path: 'private/Secret.sol' }],
  ]) assert.deepEqual(await readSolidityEntryPoints('', entries, neverRead), { paths: [], limited: false })
  assert.deepEqual(await readSolidityEntryPoints('lib/dependency', [dir('contracts', 'lib/dependency'), file('Dependency.sol', 'lib/dependency')], neverRead), { paths: [], limited: false })
  assert.deepEqual(await readSolidityEntryPoints('custom', [file('Token.sol', 'custom')], neverRead), { paths: ['custom/Token.sol'], limited: false })
})

test('suggestions are bounded, sorted, deduplicated, and disclose truncated trees', async () => {
  const tree = Array.from({ length: 101 }, (_, i) => blob(`Token${String(i).padStart(3, '0')}.sol`)).toReversed()
  const capped = await readSolidityEntryPoints('', [dir('contracts')], () => Promise.resolve({ tree: [...tree, tree[0]], truncated: false }))
  assert.equal(capped.paths.length, 100)
  assert.equal(capped.paths[0], 'contracts/Token000.sol')
  assert.equal(capped.paths.at(-1), 'contracts/Token099.sol')
  assert.equal(capped.limited, true)
  const truncated = await readSolidityEntryPoints('', [dir('contracts')], () => Promise.resolve({ tree: [blob('Token.sol')], truncated: true }))
  assert.deepEqual(truncated, { paths: ['contracts/Token.sol'], limited: true })
})

test('optional tree failures preserve directly visible Solidity suggestions', async () => {
  for (const read of [() => Promise.reject(new Error('rate limited')), () => Promise.resolve(null), () => Promise.resolve({ tree: {} })]) {
    assert.deepEqual(await readSolidityEntryPoints('', [file('Token.sol'), dir('contracts')], read), { paths: ['Token.sol'], limited: false })
  }
})

test('candidate storage stays bounded throughout large ascending and descending inputs', () => {
  const name = i => `contracts/Token${String(i).padStart(6, '0')}.sol`
  for (const descending of [false, true]) {
    const paths = []
    let limited = false
    for (let i = 0; i < 100_000; i++) {
      const path = name(descending ? 99_999 - i : i)
      if (addSoliditySuggestion(paths, path)) limited = true
      assert.ok(paths.length <= 100, 'retained candidates stay capped after every input')
    }
    assert.deepEqual(paths, Array.from({ length: 100 }, (_, i) => name(i)))
    assert.equal(limited, true)
  }
})

test('duplicates at capacity do not mark suggestions limited or evict existing candidates', () => {
  const paths = []
  for (let i = 0; i < 100; i++) assert.equal(addSoliditySuggestion(paths, `Token${i}.sol`), false)
  const expected = [...paths]
  for (const path of expected) assert.equal(addSoliditySuggestion(paths, path), false)
  assert.deepEqual(paths, expected)
  assert.equal(addSoliditySuggestion(paths, 'Z.sol'), true)
  assert.deepEqual(paths, expected)
  assert.equal(addSoliditySuggestion(paths, 'A.sol'), true)
  assert.deepEqual(paths, ['A.sol', ...expected.slice(0, 99)])
})

test('one cap is shared by direct files and both source trees', async () => {
  const listing = [file('foundry.toml'), dir('src'), dir('contracts'), ...Array.from({ length: 120 }, (_, i) => file(`Root${i}.sol`))]
  const result = await readSolidityEntryPoints('', listing, () => Promise.resolve({ tree: Array.from({ length: 120 }, (_, i) => blob(`Token${i}.sol`)) }))
  assert.equal(result.limited, true)
  assert.deepEqual(result.paths, Array.from({ length: 120 }, (_, i) => `Root${i}.sol`).toSorted().slice(0, 100))
  const treesOnly = await readSolidityEntryPoints('', listing.slice(0, 3), () => Promise.resolve({ tree: Array.from({ length: 120 }, (_, i) => blob(`Token${i}.sol`)) }))
  assert.equal(treesOnly.limited, true)
  assert.deepEqual(treesOnly.paths, Array.from({ length: 120 }, (_, i) => `contracts/Token${i}.sol`).toSorted().slice(0, 100), 'later trees can replace earlier candidates')
})
