import assert from 'node:assert/strict'
import { brotliDecompressSync, gzipSync } from 'node:zlib'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { buildStasisBundle } from '../server-managed/bundle-build-worker.js'
import { buildRepositoryBundle, githubBundleFilename, parseBundleBuild } from '../server-managed/bundle-build.ts'

const commit = 'a'.repeat(40)
const conditions = { preset: 'node', conditions: ['node'], platforms: [] }
const input = (entries = ['index.ts'], extra = {}) => parseBundleBuild({ repoId: 1, commit, entries, conditions, ...extra })

test('build requests pin commits, reject unsafe inputs, and apply presets', () => {
  assert.equal(input(['packages/app/src/a.ts', 'packages/app/bin/b.js']).directory, 'packages/app')
  assert.deepEqual(input(['a.js', 'a.js']).entries, ['a.js'])
  assert.deepEqual(input(['A.sol']).options, {})
  assert.deepEqual(input(['a.js'], { conditions: { preset: 'browser', conditions: ['browser', 'development'], platforms: [] } }).options,
    { conditions: ['browser', 'development'], mainFields: ['browser', 'module', 'main'], typescript: true, jsx: true })
  assert.deepEqual(input(['a.js'], { conditions: { preset: 'metro', conditions: ['react-native'], platforms: ['ios', 'android'] } }).options,
    { metro: true, platforms: ['ios', 'android'], typescript: true, jsx: true })
  for (const entries of [[], ['../a.js'], ['/a.js'], ['a/./b.js'], ['a\\b.js'], ['a.js\n'], ['a.js', 'a.sol'], ['file.json'], ['main.rs'], Array.from({ length: 101 }, () => 'a.js')]) {
    assert.throws(() => input(entries), { status: 400 })
  }
  for (const value of ['main', 'a'.repeat(39), null]) assert.throws(() => input(['a.js'], { commit: value }))
  assert.throws(() => input(['a.js'], { conditions: { preset: 'metro', conditions: ['development'], platforms: ['ios'] } }), { code: 'metro-conditions' })
})

test('filenames follow Stasis github-bundle defaults and portable truncation', () => {
  assert.equal(githubBundleFilename('owner/repo', '', commit), 'owner-repo.aaaaaaa.stasis.code.br')
  assert.equal(githubBundleFilename('owner/repo', 'packages/my app', commit), 'owner-repo.packages-my_app.aaaaaaa.stasis.code.br')
  const long = 'very-long-directory/'.repeat(30)
  const name = githubBundleFilename('owner/repo', long, commit)
  assert.equal(name.length, 255)
  assert.match(name, /_[a-f\d]{8}\.aaaaaaa\.stasis\.code\.br$/u)
  assert.notEqual(name, githubBundleFilename('owner/repo', long + 'x', commit))
})

// Minimal regular-file tar fixture; GitHub client verification is upstream's
// responsibility. The real Stasis builder unpacks and resolves these bytes.
function tarball(files) {
  const blocks = []
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text)
    const header = Buffer.alloc(512)
    header.write(`tree/${name}`)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write('00000000000\0', 136)
    header.fill(32, 148, 156)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

function projectClient(files) {
  return {
    listRepoDir({ repo, sha, directory }) {
      assert.equal(repo, 'org/repo'); assert.equal(sha, commit); assert.equal(directory, undefined)
      return Promise.resolve(Object.keys(files).map(path => ({ path, type: 'blob', mode: '100644', sha: 'b'.repeat(40) })))
    },
    getRepoTarball({ repo, sha }) {
      assert.equal(repo, 'org/repo'); assert.equal(sha, commit)
      return Promise.resolve(tarball(files))
    },
  }
}

const files = {
  'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { install: 'must never execute' } }),
  'package-lock.json': JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0' } } }, null, 2) + '\n',
  'index.ts': 'import { value } from "./value.js"; export const result: number = value',
  'value.ts': 'export const value: number = 42',
}

test('real Stasis builds a commit-pinned TypeScript import graph and produces readable Brotli bytes', async () => {
  const result = await buildStasisBundle({ input: input(), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }, projectClient(files))
  const bundle = Bundle.parse(brotliDecompressSync(result.bytes).toString())
  assert.equal(result.filename, 'org-repo.aaaaaaa.stasis.code.br')
  assert.equal(result.directory, '')
  assert.deepEqual({ ...bundle.repo }, { github: 'org/repo', commit, root: true })
  assert.ok(bundle.sources.has('index.ts'))
  assert.ok(bundle.sources.has('value.ts'))
  assert.deepEqual([...bundle.entries], ['index.ts'])
  await assert.rejects(buildStasisBundle({ input: input(), github: 'org/repo', token: null, maxBytes: 1, scopes: [null] }, projectClient(files)), /too-large/u)
  await assert.rejects(buildStasisBundle({ input: input(), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: ['src'] }, projectClient(files)), /build-scope/u)
})

test('worker cancellation releases the per-user build slot and prevents duplicate builds', async () => {
  const request = { input: input(), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }
  const controller = new AbortController()
  const pending = buildRepositoryBundle('test-user', request, controller.signal)
  await assert.rejects(buildRepositoryBundle('test-user', request, new AbortController().signal), { code: 'build-busy' })
  controller.abort()
  await assert.rejects(pending, { code: 'build-cancelled' })
  const next = new AbortController()
  const retry = buildRepositoryBundle('test-user', request, next.signal)
  next.abort()
  await assert.rejects(retry, { code: 'build-cancelled' })
})

test('worker loads Stasis, reports rejected builds, and releases its build slot', async () => {
  // Stasis rejects this repo name before any network request. Exercise the
  // actual worker module with its empty environment and no inherited hooks.
  const request = { input: input(), github: 'invalid-repo', token: null, maxBytes: 1_000_000, scopes: [null] }
  for (let i = 0; i < 2; i++) {
    await assert.rejects(buildRepositoryBundle('worker-error-user', request, new AbortController().signal), { code: 'build-failed' })
  }
})

test('real Stasis builds Solidity with Soldeer and follows local imports', async () => {
  const project = {
    'foundry.toml': '[profile.default]\nsrc = "src"\nlibs = ["dependencies"]\n[dependencies]\n',
    'soldeer.lock': 'version = 2\ndependencies = []\n',
    'Token.sol': 'pragma solidity ^0.8.0; import "./Base.sol"; contract Token is Base {}',
    'Base.sol': 'pragma solidity ^0.8.0; contract Base {}',
  }
  const built = await buildStasisBundle({ input: input(['Token.sol']), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }, projectClient(project))
  const bundle = Bundle.parse(brotliDecompressSync(built.bytes).toString())
  assert.deepEqual([...bundle.entries], ['Token.sol'])
  assert.equal(bundle.formats.get('Base.sol'), 'solidity')
})

test('Stasis honors Browser conditions and Metro platform-specific imports', async () => {
  const project = { ...files, 'index.ts': 'export { value } from "#value";',
    'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module',
      imports: { '#value': { browser: './browser.ts', default: './value.ts' } } }),
    'browser.ts': 'export const value = "browser"',
  }
  const built = await buildStasisBundle({ input: input(['index.ts'], { conditions: { preset: 'browser', conditions: ['browser'], platforms: [] } }),
    github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }, projectClient(project))
  const bundle = Bundle.parse(brotliDecompressSync(built.bytes).toString())
  assert.ok(bundle.sources.has('browser.ts'))
  assert.equal(bundle.sources.has('value.ts'), false)
  const metro = { ...files, 'index.ts': 'export { value } from "./value";',
    'value.ios.ts': 'export const value = "ios"', 'value.android.ts': 'export const value = "android"' }
  const mobile = await buildStasisBundle({ input: input(['index.ts'], { conditions: { preset: 'metro', conditions: ['react-native'], platforms: ['ios', 'android'] } }),
    github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }, projectClient(metro))
  const mobileBundle = Bundle.parse(brotliDecompressSync(mobile.bytes).toString())
  assert.ok(mobileBundle.sources.has('value.ios.ts'))
  assert.ok(mobileBundle.sources.has('value.android.ts'))
})
