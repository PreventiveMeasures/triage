import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { mock, test } from 'node:test'
import { parseBundleBuild } from '../server-managed/bundle-build.ts'

let build
mock.module('@exodus/stasis/vfs-bundle', { namedExports: { buildGitHubBundle: options => build(options) } })
const { buildStasisBundle } = await import('../server-managed/bundle-build-worker.js')

const commit = 'a'.repeat(40)
const file = (path, mode = '100644') => ({ path, mode, type: 'blob', sha: 'b'.repeat(40) })

function fixture(entries, files, { scopes = [null], failAt, bundleDirectory, manifests = {} } = {}) {
  const input = parseBundleBuild({ repoId: 1, commit, entries, conditions: { preset: 'node', conditions: ['node'], platforms: [] } })
  const builds = [], fileReads = [], reads = []
  const client = { listRepoDir({ repo, sha, directory }) {
    assert.equal(repo, 'org/repo')
    assert.equal(sha, commit)
    reads.push(directory ?? '')
    if (failAt !== undefined && directory === failAt) throw new Error('GitHub unavailable')
    return Promise.resolve(files.filter(entry => posix.dirname(entry.path) === (directory || '.'))
      .map(entry => ({ ...entry, path: posix.basename(entry.path) })))
  }, getRepoFile({ repo, path, ref }) {
    assert.equal(repo, 'org/repo')
    assert.equal(ref, commit)
    assert.ok(files.some(entry => entry.path === path))
    fileReads.push(path)
    if (path === failAt) throw new Error('GitHub unavailable')
    const manifest = manifests[path] ?? {}
    return Promise.resolve(typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  } }
  build = async options => {
    builds.push(options)
    // Exercise the same repeated directory reads as Stasis's lockfile discovery.
    await options.client.listRepoDir({ repo: options.github, sha: options.sha, directory: options.directory })
    await options.client.listRepoDir({ repo: options.github, sha: options.sha, directory: options.directory })
    return { bundle: { repo: { directory: bundleDirectory ?? options.directory }, serialize: () => '{}' } }
  }
  const run = () => buildStasisBundle({ input, github: 'org/repo', token: null, maxBytes: 1000, scopes }, client)
  return { run, reads, fileReads, builds }
}

for (const extension of ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'mjsx', 'cjsx', 'tsx', 'mtsx', 'ctsx', 'JSX', 'TSX']) {
  test(`${extension} entry points use the nearest common package.json, ignoring Solidity manifests`, async () => {
    const entry = `packages/app/src/main.${extension}`
    const f = await fixture([entry], [file('package.json'), file('packages/app/package.json'), file('packages/app/src/foundry.toml')])
    const result = await f.run()
    assert.equal(f.builds[0].directory, 'packages/app')
    assert.deepEqual(f.builds[0].entries, [`src/main.${extension}`])
    assert.equal(result.filename, 'org-repo.packages-app.aaaaaaa.stasis.code.br')
    assert.equal(result.directory, 'packages/app')
    assert.deepEqual(f.reads, ['packages/app/src', 'packages/app'], 'the build reuses discovery listings')
  })
}

test('entries in sibling packages use their common manifest, not either entry point’s own package', async () => {
  const f = await fixture(['packages/a/src/a.ts', 'packages/b/src/b.js'], [
    file('package.json'), file('packages/a/package.json'), file('packages/b/package.json'),
  ])
  await f.run()
  assert.equal(f.builds[0].directory, undefined)
  assert.deepEqual(f.builds[0].entries, ['packages/a/src/a.ts', 'packages/b/src/b.js'])
  assert.deepEqual(f.reads, ['packages', ''])
})

for (const manifest of ['foundry.toml', 'soldeer.toml', 'soldeer.lock']) {
  test(`Solidity entry points use ${manifest}, ignoring a closer package.json`, async () => {
    const f = await fixture(['contracts/token/src/Token.sol', 'contracts/token/src/Base.sol'], [
      file(manifest), file(`contracts/token/${manifest}`), file('contracts/token/src/package.json'),
    ])
    await f.run()
    assert.equal(f.builds[0].directory, 'contracts/token')
    assert.deepEqual(f.builds[0].entries, ['src/Token.sol', 'src/Base.sol'])
    assert.deepEqual(f.reads, ['contracts/token/src', 'contracts/token'])
  })
}

test('a manifest in the common entry directory keeps that directory', async () => {
  const f = await fixture(['app/main.ts', 'app/worker.js'], [file('package.json'), file('app/package.json', '100755')])
  await f.run()
  assert.equal(f.builds[0].directory, 'app')
  assert.deepEqual(f.builds[0].entries, ['main.ts', 'worker.js'])
  assert.deepEqual(f.reads, ['app'])
})

for (const [name, filename] of [['app', 'app'], ['@org/app', 'org-app'], ['@org/org-app', 'org-app'], ['@org/org', 'org'],
  ['@org/my app', 'org-my_app'], ['@org/organizer', 'org-organizer']]) {
  test(`a project package named ${name} names the bundle without the repo or directory`, async () => {
    const f = await fixture(['packages/app/src/main.ts'], [file('package.json'), file('packages/app/package.json')],
      { manifests: { 'package.json': { name: 'root' }, 'packages/app/package.json': { name } } })
    assert.equal((await f.run()).filename, `${filename}.aaaaaaa.stasis.code.br`)
    assert.deepEqual(f.reads, ['packages/app/src', 'packages/app'], 'the name reuses the build’s listings')
    assert.deepEqual(f.fileReads, ['packages/app/package.json'])
  })
}

test('the repository root’s package names a bundle built from the root', async () => {
  const files = [file('package.json'), file('packages/a/package.json'), file('packages/b/package.json')]
  for (const entries of [['main.ts'], ['src/main.ts'], ['packages/a/src/a.ts', 'packages/b/src/b.js']]) {
    const f = await fixture(entries, files, { manifests: { 'package.json': { name: '@org/org-app' } } })
    assert.equal((await f.run()).filename, 'org-app.aaaaaaa.stasis.code.br', entries.join())
    assert.deepEqual(f.fileReads, ['package.json'])
  }
})

test('a Solidity project is named for a package.json beside its dependency files', async () => {
  const f = await fixture(['contracts/src/Token.sol'], [file('contracts/foundry.toml'), file('contracts/package.json'), file('contracts/src/package.json')],
    { manifests: { 'contracts/package.json': { name: '@org/contracts' }, 'contracts/src/package.json': { name: 'unrelated' } } })
  assert.equal((await f.run()).filename, 'org-contracts.aaaaaaa.stasis.code.br')
  assert.deepEqual(f.fileReads, ['contracts/package.json'])
})

test('bundles keep repository names without a usable package.json name in the project directory', async () => {
  const name = async (entries, files, manifests) => {
    const f = await fixture(entries, files, { manifests })
    return [(await f.run()).filename, f.fileReads]
  }
  assert.deepEqual(await name(['app/src/main.ts'], []), ['org-repo.app-src.aaaaaaa.stasis.code.br', []])
  assert.deepEqual(await name(['main.ts'], [file('package.json', '120000')]), ['org-repo.aaaaaaa.stasis.code.br', []])
  assert.deepEqual(await name(['app/src/Token.sol'], [file('app/foundry.toml'), file('app/src/package.json')]), ['org-repo.app.aaaaaaa.stasis.code.br', []])
  for (const manifest of ['{', 'null', '[]', { private: true }, { name: 1 }, ...['', '.hidden', '@org/', '@.org/app', 'a/b', 'x'.repeat(215)].map(value => ({ name: value }))]) {
    assert.deepEqual(await name(['app/main.ts'], [file('app/package.json')], { 'app/package.json': manifest }),
      ['org-repo.app.aaaaaaa.stasis.code.br', ['app/package.json']], JSON.stringify(manifest))
  }
})

test('a failed package.json read fails the build instead of changing its name', async () => {
  const f = await fixture(['app/main.ts'], [file('app/package.json')], { failAt: 'app/package.json' })
  await assert.rejects(f.run(), /GitHub unavailable/u)
})

for (const entry of ['app/src/main.ts', 'app/src/Token.sol']) {
  test(`absent dependency files retain the common directory for ${entry}`, async () => {
    const f = await fixture([entry], [])
    await f.run()
    assert.equal(f.builds[0].directory, 'app/src')
    assert.deepEqual(f.builds[0].entries, [posix.basename(entry)])
    assert.deepEqual(f.reads, ['app/src', 'app', ''])
  })
}

test('symlinks and directories named package.json do not select a project root', async () => {
  const f = await fixture(['app/src/main.ts'], [
    file('package.json'), { ...file('app/package.json'), type: 'tree', mode: '040000' }, file('app/src/package.json', '120000'),
  ])
  await f.run()
  assert.equal(f.builds[0].directory, undefined)
  assert.deepEqual(f.builds[0].entries, ['app/src/main.ts'])
})

test('failed GitHub reads cannot masquerade as absent dependency files', async () => {
  const f = await fixture(['app/src/main.ts'], [file('package.json')], { failAt: 'app' })
  await assert.rejects(f.run(), /GitHub unavailable/u)
  assert.equal(f.builds.length, 0)
})

test('a discovered project outside the team scope is rejected before building', async () => {
  const f = await fixture(['app/src/main.ts'], [file('app/package.json')], { scopes: ['app/src'] })
  await assert.rejects(f.run(), /build-scope/u)
  assert.equal(f.builds.length, 0)
})

test('a workspace lockfile widening the bundle beyond the project still needs access', async () => {
  const f = await fixture(['app/src/main.ts'], [file('app/package.json')], { scopes: ['app'], bundleDirectory: '' })
  await assert.rejects(f.run(), /build-scope/u)
  assert.equal(f.builds.length, 1)
})
