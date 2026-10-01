import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSolidityEntryPoints } from '../server-managed/solidity-entry-points.ts'

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
