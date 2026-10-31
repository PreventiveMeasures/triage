import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { mock, test } from 'node:test'
import { parseBundleBuild } from '../server-managed/bundle-build.ts'

let build
mock.module('@exodus/stasis/vfs-bundle', { namedExports: { buildGitHubBundle: options => build(options), setCacheDir: () => {} } })
const { buildStasisBundle } = await import('../server-managed/bundle-build-worker.js')

const commit = 'a'.repeat(40)
const file = (path, mode = '100644') => ({ path, mode, type: 'blob', sha: 'b'.repeat(40) })

const node = { preset: 'node', conditions: ['node'], platforms: [] }

function fixture(entries, files, { scopes = [null], failAt, bundleDirectory, modules = {}, contents = {}, conditions = node } = {}) {
  const input = parseBundleBuild({ repoId: 1, commit, entries, ...(conditions && { conditions }) })
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
    fileReads.push(path)
    return Promise.resolve(contents[path] ?? '{}')
  } }
  build = async options => {
    builds.push(options)
    // Exercise the same repeated directory reads as Stasis's lockfile discovery.
    await options.client.listRepoDir({ repo: options.github, sha: options.sha, directory: options.directory })
    await options.client.listRepoDir({ repo: options.github, sha: options.sha, directory: options.directory })
    return { bundle: { repo: { directory: bundleDirectory ?? options.directory }, modules: new Map(Object.entries(modules)), serialize: () => '{}' } }
  }
  const run = () => buildStasisBundle({ input, github: 'org/repo', token: null, maxBytes: 1000, scopes }, client)
  return { run, reads, builds, fileReads }
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
    assert.deepEqual(f.reads, ['packages/app/src', 'packages/app', 'packages', ''],
      'each directory up to the root is listed once, for a stasis.config.json and the project alike')
  })
}

test('entries in sibling packages use their common manifest, not either entry point’s own package', async () => {
  const f = await fixture(['packages/a/src/a.ts', 'packages/b/src/b.js'], [
    file('package.json'), file('packages/a/package.json'), file('packages/b/package.json'),
  ])
  await f.run()
  assert.equal(f.builds[0].directory, undefined)
  assert.deepEqual(f.builds[0].entries, ['packages/a/src/a.ts', 'packages/b/src/b.js'])
  assert.deepEqual(f.reads, ['packages/a/src', 'packages/b/src', 'packages/a', 'packages/b', 'packages', ''])
})

for (const manifest of ['foundry.toml', 'soldeer.toml', 'soldeer.lock']) {
  test(`Solidity entry points use ${manifest}, ignoring a closer package.json`, async () => {
    const f = await fixture(['contracts/token/src/Token.sol', 'contracts/token/src/Base.sol'], [
      file(manifest), file(`contracts/token/${manifest}`), file('contracts/token/src/package.json'),
    ])
    await f.run()
    assert.equal(f.builds[0].directory, 'contracts/token')
    assert.deepEqual(f.builds[0].entries, ['src/Token.sol', 'src/Base.sol'])
    assert.deepEqual(f.reads, ['contracts/token/src', 'contracts/token', 'contracts', ''])
  })
}

test('a manifest in the common entry directory keeps that directory', async () => {
  const f = await fixture(['app/main.ts', 'app/worker.js'], [file('package.json'), file('app/package.json', '100755')])
  await f.run()
  assert.equal(f.builds[0].directory, 'app')
  assert.deepEqual(f.builds[0].entries, ['main.ts', 'worker.js'])
  assert.deepEqual(f.reads, ['app', ''])
})

for (const [name, filename] of [['app', 'app'], ['@org/app', 'org-app'], ['@org/org-app', 'org-app'], ['@org/org', 'org'],
  ['@org/my app', 'org-my_app'], ['@org/organizer', 'org-organizer']]) {
  test(`a project package named ${name} names the bundle without the repo or directory`, async () => {
    const f = await fixture(['packages/app/src/main.ts'], [file('package.json'), file('packages/app/package.json')],
      { modules: { '.': { name } } })
    assert.equal((await f.run()).filename, `${filename}.aaaaaaa.stasis.code.br`)
    assert.deepEqual(f.reads, ['packages/app/src', 'packages/app', 'packages', ''], 'the name reuses the build’s listings')
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

test('a project whose package.json depends on a @prisma/ package has Stasis generate Prisma Client', async () => {
  const files = [file('package.json'), file('packages/app/package.json')]
  for (const [manifest, generate] of [
    [{ dependencies: { '@prisma/client': '7.10.0' } }, ['prisma']],
    [{ devDependencies: { '@prisma/adapter-pg': '7.10.0' } }, ['prisma']],
    [{ dependencies: { prisma: '7.10.0', 'left-pad': '1.3.0' } }, undefined],
    [{ dependencies: ['@prisma/client'] }, undefined],
    ['{not json', undefined],
  ]) {
    const contents = { 'packages/app/package.json': typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'package.json': '{"dependencies":{"@prisma/client":"7.10.0"}}' }
    const f = await fixture(['packages/app/src/main.ts'], files, { contents })
    await f.run()
    assert.deepEqual(f.builds[0].generate, generate, JSON.stringify(manifest))
    assert.deepEqual(f.fileReads, ['packages/app/package.json'], 'only the project’s own package.json is read')
  }
})

test('Solidity builds never read package.json for Prisma', async () => {
  const f = await fixture(['contracts/src/Token.sol'], [file('contracts/foundry.toml'), file('contracts/package.json')],
    { contents: { 'contracts/package.json': '{"dependencies":{"@prisma/client":"7.10.0"}}' } })
  await f.run()
  assert.equal(f.builds[0].generate, undefined)
  assert.deepEqual(f.fileReads, [])
})

const config = entries => JSON.stringify({ scope: 'full', entries })

test('entries a stasis.config.json lists build from its directory, with no options but its own there', async () => {
  const contents = { 'packages/app/stasis.config.json': config({
    './src/main.ts': { conditions: 'browser', mainFields: ['browser', 'main'] }, 'src/worker.ts': {}, 'bin/cli.js': {}, 'src/other.ts': { metro: true, platforms: 'ios' },
  }) }
  const files = [file('package.json'), file('packages/app/package.json'), file('packages/app/stasis.config.json')]
  const f = await fixture(['packages/app/src/main.ts', 'packages/app/src/worker.ts', 'packages/app/bin/cli.js'], files, { contents, conditions: null })
  const result = await f.run()
  assert.equal(f.builds.length, 1)
  const { github: _github, sha: _sha, client: _client, cache: _cache, ...options } = f.builds[0]
  assert.deepEqual(options, { directory: 'packages/app', entries: ['src/main.ts', 'src/worker.ts', 'bin/cli.js'] }, 'Stasis takes each one’s from the file')
  assert.equal(result.directory, 'packages/app')
  assert.deepEqual(f.fileReads, ['packages/app/stasis.config.json', 'packages/app/package.json'], 'each stasis.config.json is read once')
})

test('a stasis.config.json above the entries’ package builds them from there, the nearest one naming each', async () => {
  const files = [file('package.json'), file('stasis.config.json'), file('packages/app/package.json'), file('packages/app/stasis.config.json')]
  const outer = { 'stasis.config.json': config({ 'packages/app/src/main.ts': { jsx: true } }) }
  const f = await fixture(['packages/app/src/main.ts'], files, { conditions: null, bundleDirectory: '',
    contents: { ...outer, 'packages/app/stasis.config.json': config({ 'src/other.ts': {} }) } })
  await f.run()
  assert.equal(f.builds[0].directory, undefined)
  assert.deepEqual(f.builds[0].entries, ['packages/app/src/main.ts'])
  const inner = await fixture(['packages/app/src/main.ts'], files, { conditions: null,
    contents: { ...outer, 'packages/app/stasis.config.json': config({ 'src/main.ts': {} }) } })
  await inner.run()
  assert.equal(inner.builds[0].directory, 'packages/app')
  assert.deepEqual(inner.builds[0].entries, ['src/main.ts'])
})

test('entries a stasis.config.json lists are never built with others, nor with conditions', async () => {
  const files = [file('package.json'), file('stasis.config.json'), file('app/package.json'), file('app/stasis.config.json')]
  const contents = { 'stasis.config.json': config({ 'index.ts': {} }), 'app/stasis.config.json': config({ 'main.ts': {} }) }
  for (const [entries, conditions, code] of [
    [['index.ts', 'other.ts'], null, 'config-mixed'],
    [['index.ts', 'other.ts'], node, 'config-mixed'],
    [['index.ts', 'app/main.ts'], null, 'config-mixed'],
    [['index.ts'], node, 'config-conditions'],
    [['other.ts'], null, 'bad-conditions'],
  ]) {
    const f = await fixture(entries, files, { contents, conditions })
    await assert.rejects(f.run(), { message: code }, JSON.stringify(entries))
    assert.equal(f.builds.length, 0)
  }
  const solidity = await fixture(['contracts/Token.sol'], [file('foundry.toml'), ...files], { contents, conditions: null })
  await solidity.run()
  assert.deepEqual(solidity.builds[0].entries, ['contracts/Token.sol'], 'Solidity takes no conditions either way')
})

test('a stasis.config.json whose entries Stasis can’t tell fails builds below it, which it may list', async () => {
  for (const text of ['{', JSON.stringify({ entries: [] }), config({ '../index.js': {} }), config({ 'index.js': {}, './index.js': {} }), 'x'.repeat(256 * 1024 + 1)]) {
    const f = await fixture(['app/other.js'], [file('stasis.config.json'), file('app/package.json')], { contents: { 'stasis.config.json': text } })
    await assert.rejects(f.run(), { message: 'config-invalid' })
    assert.equal(f.builds.length, 0)
  }
})

test('only a regular stasis.config.json with entries lists any', async () => {
  for (const [entry, text] of [[file('stasis.config.json', '120000'), config({ 'index.ts': {} })], [file('stasis.config.json'), JSON.stringify({ scope: 'full' })]]) {
    const f = await fixture(['index.ts'], [file('package.json'), entry], { contents: { 'stasis.config.json': text } })
    await f.run()
    assert.deepEqual(f.builds[0].conditions, ['node'])
  }
})

test('a stasis.config.json outside the team scope can’t build the entries it lists', async () => {
  const f = await fixture(['app/src/main.ts'], [file('stasis.config.json'), file('app/package.json')],
    { contents: { 'stasis.config.json': config({ 'app/src/main.ts': {} }) }, conditions: null, scopes: ['app'] })
  await assert.rejects(f.run(), /build-scope/u)
  assert.equal(f.builds.length, 0)
})
