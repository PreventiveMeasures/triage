import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { mock, test } from 'node:test'
import { parseBundleBuild } from '../server-managed/bundle-build.ts'

let build
mock.module('@exodus/stasis/vfs-bundle', { namedExports: { buildGitHubBundle: options => build(options), setCacheDir: () => {} } })
const { buildStasisBundle } = await import('../server-managed/bundle-build-worker.js')

const commit = 'a'.repeat(40)
const file = (path, mode = '100644') => ({ path, mode, type: 'blob', sha: 'b'.repeat(40) })

function fixture(entries, files, { scopes = [null], failAt, bundleDirectory, modules = {} } = {}) {
  const input = parseBundleBuild({ repoId: 1, commit, entries, conditions: { preset: 'node', conditions: ['node'], platforms: [] } })
  const builds = [], reads = []
  const client = { listRepoDir({ repo, sha, directory }) {
    assert.equal(repo, 'org/repo')
    assert.equal(sha, commit)
    reads.push(directory ?? '')
    if (failAt !== undefined && directory === failAt) throw new Error('GitHub unavailable')
    return Promise.resolve(files.filter(entry => posix.dirname(entry.path) === (directory || '.'))
      .map(entry => ({ ...entry, path: posix.basename(entry.path) })))
  } }
  build = async options => {
    builds.push(options)
    // Exercise the same repeated directory reads as Stasis's lockfile discovery.
    await options.client.listRepoDir({ repo: options.github, sha: options.sha, directory: options.directory })
    await options.client.listRepoDir({ repo: options.github, sha: options.sha, directory: options.directory })
    return { bundle: { repo: { directory: bundleDirectory ?? options.directory }, modules: new Map(Object.entries(modules)), serialize: () => '{}' } }
  }
  const run = () => buildStasisBundle({ input, github: 'org/repo', token: null, maxBytes: 1000, scopes }, client)
  return { run, reads, builds }
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
      { modules: { '.': { name } } })
    assert.equal((await f.run()).filename, `${filename}.aaaaaaa.stasis.code.br`)
    assert.deepEqual(f.reads, ['packages/app/src', 'packages/app'], 'the name reuses the build’s listings')
  })
}

test('a workspace root wider than the project still names the bundle for the project’s package', async () => {
  const f = await fixture(['packages/app/src/main.ts'], [file('package.json'), file('packages/app/package.json')],
    { bundleDirectory: '', modules: { '.': { name: 'root' }, 'packages/app': { name: '@org/org-app' } } })
  assert.equal((await f.run()).filename, 'org-app.aaaaaaa.stasis.code.br')
})

test('bundles keep repository names without a usable package name of the provided directory', async () => {
  const named = { modules: { '.': { name: 'named' } } }
  // The repository root is never a provided directory.
  assert.equal((await fixture(['src/main.ts'], [file('package.json')], named).run()).filename, 'org-repo.aaaaaaa.stasis.code.br')
  // Without a package.json there, Stasis's module name is an ancestor's or a Solidity placeholder.
  assert.equal((await fixture(['app/src/main.ts'], [], named).run()).filename, 'org-repo.app-src.aaaaaaa.stasis.code.br')
  assert.equal((await fixture(['app/src/Token.sol'], [file('app/foundry.toml'), file('app/package.json')], { modules: { '.': { name: 'solidity-bundle' } } }).run()).filename,
    'org-repo.app.aaaaaaa.stasis.code.br')
  assert.equal((await fixture(['app/main.ts'], [file('app/package.json')], { modules: { 'app/lib': { name: 'lib' } } }).run()).filename,
    'org-repo.app.aaaaaaa.stasis.code.br')
  for (const name of ['', '.hidden', '@org/', '@.org/app', 'a/b', 'x'.repeat(215), undefined]) {
    assert.equal((await fixture(['app/main.ts'], [file('app/package.json')], { modules: { '.': { name } } }).run()).filename,
      'org-repo.app.aaaaaaa.stasis.code.br', `package name ${name}`)
  }
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
