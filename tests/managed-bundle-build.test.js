import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gzipSync } from 'node:zlib'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { buildGitHubBundle } from '@exodus/stasis/vfs-bundle'
import { buildErrorCode, buildStasisBundle, buildStasisLockfile, instanceCache, lockfileDependencies } from '../server-managed/bundle-build-worker.js'
import { buildRepositoryBundle, buildRepositoryLockfile, githubBundleFilename, parseBundleBuild, withBundleBuildLease } from '../server-managed/bundle-build.ts'
import { HttpError } from '@preventive/upstream/github.js'
import { packageOf, registry } from './_managed-npm.js'

const commit = 'a'.repeat(40)
const conditions = { preset: 'node', conditions: ['node'], platforms: [] }
const input = (entries = ['index.ts'], extra = {}) => parseBundleBuild({ repoId: 1, commit, entries, conditions, ...extra })

test('build requests pin commits, reject unsafe inputs, and apply presets', () => {
  assert.equal(input(['packages/app/src/a.ts', 'packages/app/bin/b.js']).directory, 'packages/app')
  assert.deepEqual(input(['a.js', 'a.js']).entries, ['a.js'])
  assert.deepEqual(input(['A.sol']).options, { packageManager: 'soldeer' }, 'Stasis builds Solidity with Soldeer alone')
  assert.deepEqual(input(['a.ts']).options, { conditions: ['node'] }, 'Stasis detects TypeScript itself')
  assert.deepEqual(input(['a.js'], { conditions: { preset: 'browser', conditions: ['browser', 'development'], platforms: [] } }).options,
    { conditions: ['browser', 'development'], mainFields: ['browser', 'module', 'main'] })
  assert.deepEqual(input(['a.js'], { conditions: { preset: 'metro', conditions: ['react-native'], platforms: ['ios', 'android'] } }).options,
    { metro: true, platforms: ['ios', 'android'], jsx: true })
  for (const entries of [[], ['../a.js'], ['/a.js'], ['a/./b.js'], ['a\\b.js'], ['a.js\n'], ['a.js', 'a.sol'], ['a.tsx', 'a.sol'],
    ['file.json'], ['main.rs'], ['component.tsx.map'], ['dir.jsx/source.sol', 'component.jsx'], Array.from({ length: 101 }, () => 'a.js')]) {
    assert.throws(() => input(entries), { status: 400 })
  }
  for (const value of ['main', 'a'.repeat(39), null]) assert.throws(() => input(['a.js'], { commit: value }))
  assert.throws(() => input(['a.js'], { conditions: { preset: 'metro', conditions: ['development'], platforms: ['ios'] } }), { code: 'metro-conditions' })
  for (const preset of [['metro'], ['browser']]) {
    assert.throws(() => input(['a.js'], { conditions: { preset, conditions: ['react-native'], platforms: ['ios'] } }), { code: 'bad-conditions' })
  }
  assert.deepEqual(input(['a.js'], { conditions: { preset: 'node', conditions: ['node', 'production', 'node'], platforms: ['ios'] } }).conditions,
    { preset: 'node', conditions: ['node', 'production'], platforms: [] }, 'records what the build resolves with')
  assert.deepEqual(input(['a.js'], { conditions: { preset: 'metro', conditions: ['react-native'], platforms: ['android', 'android'] } }).conditions,
    { preset: 'metro', conditions: ['react-native'], platforms: ['android'] })
  assert.equal(input(['Token.sol']).conditions, null)
})

test('a build request names the branch its commit was picked by, where it was, as git names a branch', () => {
  for (const branch of ['main', 'feature/x', 'release-1.2', 'user@host', 'a'.repeat(255)]) assert.equal(input(['a.js'], { branch }).branch, branch)
  for (const branch of [undefined, null]) assert.equal(Object.hasOwn(input(['a.js'], { branch }), 'branch'), false)
  for (const branch of ['', 'a b', 'a:b', 'a..b', 'a~1', 'a^', 'a?', 'a*', 'a[b', 'a\\b', 'a\n', '-a', '/a', 'a/', 'a//b', 'a.', '@', 'a@{1}', '.a', 'a/.b',
    'a.lock', 'a.lock/b', 'a'.repeat(256), 1, ['main'], { name: 'main' }]) {
    assert.throws(() => input(['a.js'], { branch }), { status: 400, code: 'bad-request' }, JSON.stringify(branch))
  }
})

test('JSX and TSX entry points use the same build options as other scripts for every preset', () => {
  for (const preset of ['node', 'browser', 'metro']) {
    const extra = { conditions: { preset, conditions: [preset === 'metro' ? 'react-native' : preset], platforms: ['ios', 'android'] } }
    const entries = ['src/component.jsx', 'src/view.tsx', 'src/main.ts']
    const parsed = input(entries, extra)
    assert.deepEqual(parsed.entries, entries)
    assert.equal(parsed.directory, 'src')
    assert.deepEqual(parsed.options, input(['src/main.ts'], extra).options)
  }
})

test('filenames follow Stasis github-bundle defaults and portable truncation', () => {
  assert.equal(githubBundleFilename('owner/repo', '', commit), 'owner-repo.aaaaaaa.stasis.code.br')
  assert.equal(githubBundleFilename('owner/repo', 'packages/my app', commit), 'owner-repo.packages-my_app.aaaaaaa.stasis.code.br')
  const long = 'very-long-directory/'.repeat(30)
  const name = githubBundleFilename('owner/repo', long, commit)
  assert.equal(name.length, 255)
  assert.match(name, /_[a-f\d]{8}\.aaaaaaa\.stasis\.code\.br$/u)
  assert.notEqual(name, githubBundleFilename('owner/repo', long + 'x', commit))
  assert.equal(githubBundleFilename('owner/repo', 'packages/app', commit, '@owner/owner-app'), 'owner-app.aaaaaaa.stasis.code.br')
  assert.equal(githubBundleFilename('owner/repo', 'packages/app', commit, '@scope/app'), 'scope-app.aaaaaaa.stasis.code.br')
  assert.equal(githubBundleFilename('owner/repo', 'packages/app', commit, '.app'), 'owner-repo.packages-app.aaaaaaa.stasis.code.br')
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
  const trees = new Map()
  return {
    listRepoDir({ repo, sha, directory }) {
      assert.equal(repo, 'org/repo'); assert.equal(sha, commit)
      const prefix = directory ? directory + '/' : ''
      // As upstream's: a directory the commit hasn't is refused, not listed empty.
      if (prefix && !Object.keys(files).some(path => path.startsWith(prefix))) throw new Error(`listRepoDir: ${repo}@${sha} has no directory at ${JSON.stringify(directory)}`)
      const entries = new Map()
      for (const path of Object.keys(files).filter(candidate => candidate.startsWith(prefix))) {
        const relative = path.slice(prefix.length)
        const name = relative.split('/')[0]
        const isDirectory = relative.includes('/')
        const treeSha = createHash('sha1').update(prefix + name).digest('hex')
        if (isDirectory) trees.set(treeSha, prefix + name)
        entries.set(name, { path: name, type: isDirectory ? 'tree' : 'blob', mode: isDirectory ? '040000' : '100644', sha: treeSha })
      }
      return Promise.resolve([...entries.values()])
    },
    getRepoTreeTarball({ repo, tree }) {
      assert.equal(repo, 'org/repo')
      assert.ok(trees.has(tree))
      const prefix = trees.get(tree) + '/'
      return Promise.resolve(tarball(Object.fromEntries(Object.entries(files)
        .filter(([path]) => path.startsWith(prefix)).map(([path, text]) => [path.slice(prefix.length), text]))))
    },
    getRepoTarball({ repo, sha }) {
      assert.equal(repo, 'org/repo'); assert.equal(sha, commit)
      return Promise.resolve(tarball(files))
    },
    getRepoFile({ repo, path, ref }) {
      assert.equal(repo, 'org/repo'); assert.equal(ref, commit)
      return Object.hasOwn(files, path) ? Promise.resolve(files[path]) : Promise.reject(new Error(`no ${path} in the fixture`))
    },
    // The commit the default branch's head, the repo's own, as Stasis holds a
    // commit given by its sha to the repo's history.
    getRepoHead({ repo }) {
      assert.equal(repo, 'org/repo')
      return Promise.resolve({ oid: commit, branch: 'main' })
    },
    // Soldeer's git dependencies are fetched by their commit's tree, and
    // follow a moved repository; the fixture has none.
    getCommitTree({ repo }) {
      return Promise.reject(new Error(`no ${repo} in the fixture`))
    },
    getRepo({ repo }) {
      return Promise.reject(new Error(`no ${repo} in the fixture`))
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
  const stages = []
  const result = await buildStasisBundle({ input: input(), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }, projectClient(files), stage => stages.push(stage))
  assert.deepEqual(stages, ['build', 'scope', 'serialize', 'compress'])
  const bundle = Bundle.parse(brotliDecompressSync(result.bytes).toString())
  assert.equal(result.filename, 'org-repo.aaaaaaa.stasis.code.br')
  assert.equal(result.directory, '')
  assert.deepEqual({ ...bundle.repo }, { github: 'org/repo', commit, directory: '' })
  assert.ok(bundle.sources.has('index.ts'))
  assert.ok(bundle.sources.has('value.ts'))
  assert.deepEqual([...bundle.entries], ['index.ts'])
  await assert.rejects(buildStasisBundle({ input: input(), github: 'org/repo', token: null, maxBytes: 1, scopes: [null] }, projectClient(files)), /too-large/u)
  await assert.rejects(buildStasisBundle({ input: input(), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: ['src'] }, projectClient(files)), /build-scope/u)
})

for (const preset of ['node', 'browser', 'metro']) {
  for (const extension of ['jsx', 'tsx']) {
    test(`real Stasis auto-detects ${extension} entry syntax with the ${preset} preset`, async () => {
      const entry = `src/index.${extension}`
      const project = { ...files,
        [entry]: 'import { view } from "./view.tsx"; export const app = <main>{view}</main>',
        'src/view.tsx': 'const label: string = "ready"; export const view = <span>{label}</span>',
      }
      const request = input([entry], { conditions: { preset, conditions: [preset === 'metro' ? 'react-native' : preset], platforms: ['ios', 'android'] } })
      // Extension-based parsing works without the option for JSX inside .js files.
      delete request.options.jsx
      const result = await buildStasisBundle({ input: request, github: 'org/repo', token: null,
        maxBytes: 1_000_000, scopes: [null] }, projectClient(project))
      const bundle = Bundle.parse(brotliDecompressSync(result.bytes).toString())
      assert.equal(result.directory, '')
      assert.deepEqual([...bundle.entries], [entry])
      assert.equal(bundle.sources.get(entry), project[entry])
      assert.equal(bundle.sources.get('src/view.tsx'), project['src/view.tsx'])
    })
  }
}

test('real Stasis uses the innermost package root and checks access when imports widen it', async () => {
  const root = { name: 'fixture', version: '1.0.0', workspaces: ['app'] }
  const app = { name: 'app', version: '1.0.0', type: 'module' }
  const project = {
    'package.json': JSON.stringify(root),
    'package-lock.json': JSON.stringify({ name: root.name, version: root.version, lockfileVersion: 3, requires: true,
      packages: { '': root, app: { version: app.version }, 'node_modules/app': { resolved: 'app', link: true } } }, null, 2) + '\n',
    'app/package.json': JSON.stringify(app),
    'app/src/index.ts': files['index.ts'], 'app/src/value.ts': files['value.ts'],
  }
  const request = { input: input(['app/src/index.ts']), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: ['app'] }
  const result = await buildStasisBundle(request, projectClient(project))
  const bundle = Bundle.parse(brotliDecompressSync(result.bytes).toString())
  assert.equal(result.filename, 'app.aaaaaaa.stasis.code.br')
  assert.equal(result.directory, 'app')
  assert.deepEqual([...bundle.entries], ['src/index.ts'])
  assert.ok(bundle.sources.has('src/value.ts'))
  project['shared.ts'] = 'export const shared = 1'
  project['app/src/index.ts'] += '; export { shared } from "../../shared.ts"'
  await assert.rejects(buildStasisBundle(request, projectClient(project)), /build-scope/u)
  const wider = await buildStasisBundle({ ...request, scopes: [null] }, projectClient(project))
  const widerBundle = Bundle.parse(brotliDecompressSync(wider.bytes).toString())
  assert.equal(wider.filename, 'app.aaaaaaa.stasis.code.br')
  assert.equal(wider.directory, '')
  assert.deepEqual([...widerBundle.entries], ['app/src/index.ts'])
  assert.ok(widerBundle.sources.has('shared.ts'))
})

test('real Stasis names a standalone package’s bundle for its package.json', async () => {
  const app = { name: '@org/org-app', version: '1.0.0', type: 'module' }
  const project = {
    'app/package.json': JSON.stringify(app),
    'app/package-lock.json': JSON.stringify({ name: app.name, version: app.version, lockfileVersion: 3, requires: true,
      packages: { '': { name: app.name, version: app.version } } }, null, 2) + '\n',
    'app/src/index.ts': files['index.ts'], 'app/src/value.ts': files['value.ts'],
  }
  const result = await buildStasisBundle({ input: input(['app/src/index.ts']), github: 'org/repo', token: null,
    maxBytes: 1_000_000, scopes: [null] }, projectClient(project))
  assert.equal(result.filename, 'org-app.aaaaaaa.stasis.code.br')
  assert.equal(result.directory, 'app')
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

test('real Stasis builds a Soldeer project beside or below a JS lockfile', async () => {
  const foundry = '[profile.default]\nsrc = "src"\nlibs = ["dependencies"]\n[dependencies]\n'
  const contracts = {
    'foundry.toml': foundry, 'soldeer.lock': 'version = 2\ndependencies = []\n',
    'src/Token.sol': 'pragma solidity ^0.8.0; import "./Base.sol"; contract Token is Base {}',
    'src/Base.sol': 'pragma solidity ^0.8.0; contract Base {}',
  }
  const pnpm = { 'package.json': '{"name":"app","version":"1.0.0"}', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n" }
  const npm = { 'package.json': '{"name":"app","version":"1.0.0"}', 'package-lock.json': files['package-lock.json'] }
  const nested = Object.fromEntries(Object.entries(contracts).map(([path, text]) => [`contracts/${path}`, text]))
  for (const [project, entry, directory] of [
    [{ ...pnpm, ...nested }, 'contracts/src/Token.sol', 'contracts'],
    [{ ...pnpm, ...contracts }, 'src/Token.sol', ''],
    [{ ...npm, ...contracts }, 'src/Token.sol', ''],
  ]) {
    const result = await buildStasisBundle({ input: input([entry]), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }, projectClient(project))
    const bundle = Bundle.parse(brotliDecompressSync(result.bytes).toString())
    assert.equal(result.directory, directory, entry)
    assert.deepEqual([...bundle.entries], ['src/Token.sol'])
    assert.equal(bundle.formats.get('src/Base.sol'), 'solidity')
  }
})

test('missing, ambiguous and named-but-missing lockfiles are reported as the lockfile', () => {
  for (const message of [
    'buildGitHubBundle: org/repo@a: no packageManager given, and more than one lockfile installs /: /pnpm-lock.yaml (pnpm), /soldeer.lock (soldeer)',
    'buildGitHubBundle: org/repo@a: no packageManager given, and none of pnpm-lock.yaml, yarn.lock, package-lock.json, soldeer.lock installs /',
    'no soldeer.lock found in /, where / is installed from',
  ]) assert.equal(buildErrorCode(new Error(message), message), 'build-lockfile', message)
  assert.equal(buildErrorCode(new Error('x'), 'something else'), 'build-failed')
  for (const [message, code] of [
    ['buildVfsBundle: stasis.config.json: entries "index.js" sets babel, which runs the project\'s Babel config, and nothing of the project runs here', 'config-runs-code'],
    ['buildVfsBundle: stasis.config.json\'s entries name index.js but not main.js: bundle either the entries it names or others, not both', 'config-mixed'],
    ['buildVfsBundle: stasis.config.json is not valid JSON', 'config-invalid'],
    ['buildVfsBundle: stasis.config.json: entries "index.js": unknown option "x"', 'config-invalid'],
    [`buildGitHubBundle: ${commit} is in the history of no branch or tag of org/repo (a fork's, say, which GitHub serves through its name too): give a commit of its own`, 'commit-not-own'],
    [`buildGitHubBundle: ${commit} is at no tag or branch head of org/repo nor in its default branch's history, and 20 of its 120 other branches were left uncompared (100 compared at most): give --sha= a commit of its default branch or at a tag`, 'commit-not-own'],
    ['buildVfsBundle: stasis.config.json: lock can only be \'frozen\' (got "none")', 'config-invalid'],
    ['stasis.config.json\'s lockfiles names nope/package-lock.json, which is no file in /', 'config-invalid'],
    ['buildVfsBundle: stasis.config.json: disallowedPaths refuses value.ts ("value.ts")', 'config-policy'],
    ['buildVfsBundle: stasis.config.json: entries "a.ts", "b.ts": allowedModules allows none of 2 packages: x@1.0.0, y@1.0.0', 'config-policy'],
    ['buildVfsBundle: stasis.config.json: entries "index.ts": allowedPaths does not allow secret.ts', 'config-policy'],
    ['buildVfsBundle: stasis.config.json: entries "index.ts": disallowedPaths must be an array of non-empty strings', 'config-invalid'],
    ['buildVfsBundle: stasis.config.json: excludeModules excludes tool@1.0.0 at node_modules/tool ("tool")', 'config-policy'],
    ['entry not found: /node_modules/tool/cli.js (stasis.config.json: entries "cli.js": excludeModules excludes node_modules/tool ("tool"))', 'config-policy'],
    ['JS bundle would be broken at load time:\n  unresolved import tool from index.js (excluded by excludeModules)\n  unresolved require tool/x from a.js (excluded by excludeModules; resolves to x.ts under --typescript)', 'config-policy'],
    ['JS bundle would be broken at load time (ios):\n  unresolved import tool from index.js (excluded by excludeModules)', 'config-policy'],
    ['JS bundle would be broken at load time:\n  unresolved import tool from index.js (excluded by excludeModules)\n  unresolved import other from index.js (not found)', 'build-failed'],
    [`JS bundle would be broken at load time:\n${'  unresolved import tool from index.js (excluded by excludeModules)\n'.repeat(10)}  ... and 2 more`, 'build-failed'],
    ['app/stasis.lock.json: content mismatch for \'value.ts\'', 'stasis-lock'],
    ['stasis.lock.json isn\'t there, and lock = frozen holds the build to it', 'stasis-lock'],
    ['stasis.lock.json (lock = frozen) doesn\'t attest extra.ts', 'stasis-lock'],
  ]) assert.equal(buildErrorCode(new Error(message), message), code, message)
  assert.equal(buildErrorCode(new Error('too-large'), 'too-large'), 'too-large')
})

test('real Stasis builds nested Solidity from its dependency files despite a closer package.json', async () => {
  const project = {
    'contracts/foundry.toml': '[profile.default]\nsrc = "src"\nlibs = ["dependencies"]\n[dependencies]\n',
    'contracts/soldeer.lock': 'version = 2\ndependencies = []\n',
    'contracts/package.json': '{"name":"@org/contracts","version":"1.0.0"}',
    'contracts/src/package.json': '{"name":"unrelated"}',
    'contracts/src/Token.sol': 'pragma solidity ^0.8.0; import "./Base.sol"; contract Token is Base {}',
    'contracts/src/Base.sol': 'pragma solidity ^0.8.0; contract Base {}',
  }
  const result = await buildStasisBundle({ input: input(['contracts/src/Token.sol']), github: 'org/repo', token: null,
    maxBytes: 1_000_000, scopes: ['contracts'] }, projectClient(project))
  const bundle = Bundle.parse(brotliDecompressSync(result.bytes).toString())
  assert.equal(result.filename, 'org-repo.contracts.aaaaaaa.stasis.code.br')
  assert.equal(result.directory, 'contracts')
  assert.deepEqual([...bundle.entries], ['src/Token.sol'])
  assert.equal(bundle.formats.get('src/Base.sol'), 'solidity')
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

test('real Stasis builds the entries stasis.config.json lists with their options there, into one bundle', async () => {
  const project = { ...files, 'index.ts': 'export { value } from "#value";', 'worker.ts': 'export { value } from "#value";',
    'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module',
      imports: { '#value': { browser: './browser.ts', default: './value.ts' } } }),
    'browser.ts': 'export const value = "browser"',
    'stasis.config.json': JSON.stringify({ entries: { 'index.ts': { conditions: ['browser'] }, './worker.ts': {} } }),
  }
  const request = { input: parseBundleBuild({ repoId: 1, commit, entries: ['index.ts', 'worker.ts'] }), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }
  assert.equal(request.input.conditions, null)
  const built = await buildStasisBundle(request, projectClient(project))
  const bundle = Bundle.parse(brotliDecompressSync(built.bytes).toString())
  assert.equal(built.directory, '')
  assert.deepEqual([...bundle.entries].toSorted(), ['index.ts', 'worker.ts'])
  assert.ok(bundle.sources.has('browser.ts'), 'index.ts resolves with its browser condition')
  assert.ok(bundle.sources.has('value.ts'), 'worker.ts resolves without it')
  await assert.rejects(buildStasisBundle({ ...request, input: input(['index.ts']) }, projectClient(project)), { message: 'config-conditions' })
})

test('real Stasis refuses stasis.config.json entries that run code, or that it can’t build with their options', async () => {
  const project = { ...files, 'index.js': '// @flow\nconst value: number = 1\nexport default value\n' }
  const build = async options => {
    project['stasis.config.json'] = JSON.stringify({ entries: { 'index.js': options } })
    return await buildStasisBundle({ input: parseBundleBuild({ repoId: 1, commit, entries: ['index.js'] }), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }, projectClient(project))
  }
  const refused = async options => {
    const error = await build(options).then(() => null, failure => failure)
    assert.ok(error, JSON.stringify(options))
    return buildErrorCode(error, error.message)
  }
  const flow = Bundle.parse(brotliDecompressSync((await build({ flow: true })).bytes).toString())
  assert.deepEqual([...flow.entries], ['index.js'], 'Stasis strips Flow with its own flow-remove-types, running nothing of the repo')
  for (const options of [{ metro: true, platforms: ['ios'], babel: true }, { metro: true, platforms: ['ios'], 'metro-resolver': true }]) {
    assert.equal(await refused(options), 'config-runs-code', JSON.stringify(options))
  }
  for (const options of [{ unknown: true }, { output: 'x.br' }, { metro: true }, { conditions: [] }]) {
    assert.equal(await refused(options), 'config-invalid', JSON.stringify(options))
  }
})

const lockOf = (root, packages) => JSON.stringify({ name: root.name, version: root.version, lockfileVersion: 3, requires: true,
  packages: { '': root, ...packages } }, null, 2) + '\n'
const soldeer = {
  'foundry.toml': '[profile.default]\nsrc = "src"\nlibs = ["dependencies"]\n[dependencies]\n', 'soldeer.lock': 'version = 2\ndependencies = []\n',
  'src/Token.sol': 'pragma solidity ^0.8.0; import "./Base.sol"; contract Token is Base {}', 'src/Base.sol': 'pragma solidity ^0.8.0; contract Base {}',
}
const under = (directory, tree) => Object.fromEntries(Object.entries(tree).map(([path, text]) => [`${directory}/${path}`, text]))
const configured = (project, entries, extra = {}) => buildStasisBundle({ input: parseBundleBuild({ repoId: 1, commit, entries, ...extra }), github: 'org/repo', token: null,
  maxBytes: 1_000_000, scopes: [null] }, projectClient(project))
const entriesOf = async built => [...Bundle.parse(brotliDecompressSync((await built).bytes).toString()).entries]
const codeOf = promise => promise.then(() => null, error => buildErrorCode(error, error.message))

test('real Stasis lays out the lockfiles stasis.config.json names, a JS workspace’s above it and a Soldeer project’s alike', async () => {
  const root = { name: 'root', version: '1.0.0', workspaces: ['app'] }
  const workspace = { 'package.json': JSON.stringify(root), 'package-lock.json': lockOf(root, { app: { version: '1.0.0' }, 'node_modules/app': { resolved: 'app', link: true } }),
    ...under('app', { 'package.json': JSON.stringify({ name: 'app', version: '1.0.0', type: 'module' }), 'index.ts': files['index.ts'], 'value.ts': files['value.ts'],
      'stasis.config.json': JSON.stringify({ entries: { 'index.ts': {} }, lockfiles: ['../package-lock.json'] }) }) }
  assert.deepEqual(await entriesOf(configured(workspace, ['app/index.ts'])), ['index.ts'])
  const contracts = { ...under('contracts', soldeer), 'contracts/stasis.config.json': JSON.stringify({ entries: { 'src/Token.sol': {} }, lockfiles: ['soldeer.lock'] }) }
  assert.deepEqual(await entriesOf(configured(contracts, ['contracts/src/Token.sol'])), ['src/Token.sol'], 'no package manager given beside them')
  const unnamed = { ...under('contracts', soldeer), 'contracts/stasis.config.json': JSON.stringify({ lockfiles: ['soldeer.lock'] }) }
  assert.deepEqual(await entriesOf(configured(unnamed, ['contracts/src/Token.sol'])), ['src/Token.sol'], 'named by a config listing no entries')
  const missing = { ...files, 'stasis.config.json': JSON.stringify({ entries: { 'index.ts': {} }, lockfiles: ['app/package-lock.json'] }) }
  assert.equal(await codeOf(configured(missing, ['index.ts'])), 'config-invalid', 'one naming no file is the config’s')
})

test('real Stasis holds a bundle to stasis.config.json’s policy, the file’s or an entry’s', async () => {
  const policed = policy => ({ ...files, 'stasis.config.json': JSON.stringify({ entries: { 'index.ts': policy.entry ?? {} }, ...policy.file }) })
  assert.deepEqual(await entriesOf(configured(policed({ entry: { allowedPaths: ['*.ts', 'package.json'] } }), ['index.ts'])), ['index.ts'])
  for (const policy of [{ file: { disallowedPaths: ['value.ts'] } }, { entry: { disallowedPaths: ['value.ts'] } }, { entry: { allowedPaths: ['index.ts'] } }]) {
    assert.equal(await codeOf(configured(policed(policy), ['index.ts'])), 'config-policy', JSON.stringify(policy))
  }
  assert.equal(await codeOf(configured(policed({ entry: { disallowedPaths: 'value.ts' } }), ['index.ts'])), 'config-invalid', 'one Stasis can’t read is the config’s')
})

test('real Stasis holds a build to the repository’s stasis.lock.json, by the lock mode stasis.config.json pins', async () => {
  // As `stasis github-bundle --lockfile` writes it, of the same tree.
  const built = await buildGitHubBundle({ github: 'org/repo', sha: commit, entries: ['index.ts'], conditions: ['node'], client: projectClient(files), cache: false })
  const locked = { ...files, 'stasis.lock.json': built.lockfile.serialize() }
  assert.deepEqual(await entriesOf(configured(locked, ['index.ts'], { conditions })), ['index.ts'], 'one agreeing with it builds')
  assert.equal(await codeOf(configured({ ...locked, 'value.ts': 'export const value: number = 43' }, ['index.ts'], { conditions })), 'stasis-lock', 'one that disagrees is refused')
  const frozen = JSON.stringify({ entries: { 'index.ts': {} }, lock: 'frozen' })
  assert.deepEqual(await entriesOf(configured({ ...locked, 'stasis.config.json': frozen }, ['index.ts'])), ['index.ts'])
  assert.equal(await codeOf(configured({ ...files, 'stasis.config.json': frozen }, ['index.ts'])), 'stasis-lock', 'frozen, it needs one there')
})

test('real Stasis builds the entries stasis.config.json lists in a package the lockfile installs, which the repository doesn’t hold', async t => {
  const tool = packageOf('tool', '1.0.0', { 'package.json': JSON.stringify({ name: 'tool', version: '1.0.0', type: 'module', bin: { tool: 'cli.js' } }),
    'cli.js': 'import { run } from "./lib/run.js"\nrun()\n', 'lib/run.js': 'export const run = () => {}\n' })
  registry(t, [tool])
  const app = { name: 'app', version: '1.0.0', type: 'module', dependencies: { tool: '1.0.0' } }
  const project = { 'package.json': JSON.stringify(app), 'index.js': 'export const app = 1\n',
    'package-lock.json': lockOf({ name: app.name, version: app.version, dependencies: app.dependencies },
      { 'node_modules/tool': { version: '1.0.0', resolved: tool.doc.dist.tarball, integrity: tool.doc.dist.integrity, bin: { tool: 'cli.js' } } }),
    'stasis.config.json': JSON.stringify({ entries: { 'index.js': {}, 'node_modules/tool/cli.js': {} } }) }
  const built = await configured(project, ['index.js', 'node_modules/tool/cli.js'])
  const bundle = Bundle.parse(brotliDecompressSync(built.bytes).toString())
  assert.equal(built.directory, '')
  assert.deepEqual([...bundle.entries].toSorted(), ['index.js', 'node_modules/tool/cli.js'])
  assert.ok(bundle.sources.has('node_modules/tool/lib/run.js'), 'what it imports, from the tree laid out')
})

test('real Stasis leaves out the packages stasis.config.json’s excludeModules names: a build needing one is the policy’s', async t => {
  const tool = packageOf('tool', '1.0.0', { 'package.json': JSON.stringify({ name: 'tool', version: '1.0.0', type: 'module', bin: { tool: 'cli.js' } }),
    'cli.js': 'import { run } from "./lib/run.js"\nrun()\n', 'lib/run.js': 'export const run = () => {}\n' })
  registry(t, [tool])
  const app = { name: 'app', version: '1.0.0', type: 'module', dependencies: { tool: '1.0.0' } }
  const project = (index, config) => ({ 'package.json': JSON.stringify(app), 'index.js': index,
    'package-lock.json': lockOf({ name: app.name, version: app.version, dependencies: app.dependencies },
      { 'node_modules/tool': { version: '1.0.0', resolved: tool.doc.dist.tarball, integrity: tool.doc.dist.integrity, bin: { tool: 'cli.js' } } }),
    'stasis.config.json': JSON.stringify(config) })
  const plain = 'export const app = 1\n'
  assert.deepEqual(await entriesOf(configured(project(plain, { entries: { 'index.js': {} }, excludeModules: ['tool'] }), ['index.js'])), ['index.js'], 'one nothing needs')
  assert.equal(await codeOf(configured(project('import "tool/lib/run.js"\nexport const app = 1\n', { entries: { 'index.js': {} }, excludeModules: ['tool'] }), ['index.js'])),
    'config-policy', 'one an import needs')
  assert.equal(await codeOf(configured(project(plain, { entries: { 'index.js': {}, 'node_modules/tool/cli.js': {} }, excludeModules: ['tool'] }), ['index.js', 'node_modules/tool/cli.js'])),
    'config-policy', 'one an entry is in')
  assert.equal(await codeOf(configured(project(plain, { entries: { 'index.js': {} }, excludeModules: 'tool' }), ['index.js'])), 'config-invalid', 'one Stasis can’t read')
})

// A package as npm's registry serves it, of one module.
const moduleOf = (name, version) => packageOf(name, version, { 'package.json': JSON.stringify({ name, version, type: 'module', main: 'index.js' }), 'index.js': `export const ${name} = () => {}\n` })
const lockfileOf = (project, config = 'stasis.config.json', ...more) => buildStasisLockfile({ input: { repoId: 1, commit, config }, github: 'org/repo', token: null },
  projectClient(project), ...more)

test('real Stasis builds a lockfile in place of a bundle, as `stasis github-bundle --lockfile-only` does: the versions the entries stasis.config.json lists reach, never the lockfile', async t => {
  const [tool, unused] = [moduleOf('tool', '1.0.0'), moduleOf('unused', '2.0.0')]
  registry(t, [tool, unused])
  const app = { name: 'app', version: '1.0.0', type: 'module', dependencies: { tool: '1.0.0', unused: '2.0.0' } }
  const locked = pkg => ({ version: pkg.doc.version, resolved: pkg.doc.dist.tarball, integrity: pkg.doc.dist.integrity })
  const project = { 'package.json': JSON.stringify(app), 'index.js': 'import { tool } from "tool"\ntool()\n',
    'package-lock.json': lockOf({ name: app.name, version: app.version, dependencies: app.dependencies }, { 'node_modules/tool': locked(tool), 'node_modules/unused': locked(unused) }),
    'stasis.config.json': JSON.stringify({ entries: { 'index.js': {} } }) }
  const notes = [], stages = []
  const built = await lockfileOf(project, 'stasis.config.json', stage => stages.push(stage), (event, details) => notes.push([event, details.project ?? details.tree]))
  assert.deepEqual(built, [{ name: 'tool', version: '1.0.0', integrity: tool.doc.dist.integrity }],
    'the one its entry imports, with the integrity it was installed by; one the lockfile locks that nothing reaches, not')
  assert.deepEqual(stages, ['build', 'lockfile'], 'nothing serialized or compressed')
  assert.deepEqual(notes, [['project', ''], ['download', 'repo']])
  assert.deepEqual(await lockfileOf(under('app', project), 'app/stasis.config.json'), built, 'in a directory of its own')
  assert.deepEqual(await lockfileOf(project, 'nowhere/stasis.config.json'), [], 'a commit with no such file reaches nothing')
  assert.equal(await codeOf(lockfileOf({ ...project, 'stasis.config.json': '{' })), 'config-invalid')
  assert.equal(await codeOf(lockfileOf({ ...project, 'stasis.config.json': JSON.stringify({ entries: { 'index.js': { babel: true, metro: true, platforms: ['ios'] } } }) })), 'config-runs-code')
  assert.equal(await codeOf(lockfileOf({ ...soldeer, 'stasis.config.json': JSON.stringify({ entries: { 'src/Token.sol': {} } }) })), 'build-failed', 'a lockfile is a JS build’s alone')
})

test('real Stasis’s lockfile tells a version pnpm patches with its patch’s hash, as pnpm’s lockfile names it', async t => {
  const tool = moduleOf('tool', '1.0.0')
  registry(t, [tool])
  const patch = 'diff --git a/index.js b/index.js\nindex 1111111..2222222 100644\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-export const tool = () => {}\n+export const tool = () => 1\n'
  const hash = createHash('sha256').update(patch).digest('hex')
  const app = { name: 'app', version: '1.0.0', type: 'module', dependencies: { tool: '1.0.0' }, packageManager: 'pnpm@10.33.4' }
  const lock = `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\npatchedDependencies:\n  tool@1.0.0:\n    hash: ${hash}\n    path: patches/tool@1.0.0.patch
\nimporters:\n\n  .:\n    dependencies:\n      tool:\n        specifier: 1.0.0\n        version: 1.0.0(patch_hash=${hash})\n\npackages:\n\n  tool@1.0.0:\n    resolution: {integrity: ${tool.doc.dist.integrity}}
\nsnapshots:\n\n  tool@1.0.0(patch_hash=${hash}): {}\n`
  const project = under('app', { 'package.json': JSON.stringify(app), 'index.js': 'import { tool } from "tool"\ntool()\n', 'pnpm-lock.yaml': lock,
    'pnpm-workspace.yaml': 'patchedDependencies:\n  tool@1.0.0: patches/tool@1.0.0.patch\n', 'patches/tool@1.0.0.patch': patch,
    'stasis.config.json': JSON.stringify({ entries: { 'index.js': {} } }) })
  assert.deepEqual(await lockfileOf(project, 'app/stasis.config.json'), [{ name: 'tool', version: '1.0.0', integrity: tool.doc.dist.integrity, patch: hash }])
})

// How many bytes the files in `dir` hold.
const sizeOf = async dir => (await Promise.all((await readdir(dir)).map(name => stat(join(dir, name))))).reduce((sum, file) => sum + file.size, 0)

test('a lockfile’s build keeps what it downloads of npm in its instance’s directory, where no cache is set: the builds after it there download none of it again', async t => {
  const [tool, other] = [moduleOf('tool', '1.0.0'), moduleOf('other', '1.0.0')]
  const calls = registry(t, [tool, other])
  const dir = await mkdtemp(join(tmpdir(), 'triage-instance-cache-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const locked = pkg => ({ version: pkg.doc.version, resolved: pkg.doc.dist.tarball, integrity: pkg.doc.dist.integrity })
  const project = (...packages) => {
    const dependencies = Object.fromEntries(packages.map(pkg => [pkg.doc.name, pkg.doc.version]))
    return { 'package.json': JSON.stringify({ name: 'app', version: '1.0.0', type: 'module', dependencies }),
      'index.js': packages.map(pkg => `import "${pkg.doc.name}"\n`).join(''), 'stasis.config.json': JSON.stringify({ entries: { 'index.js': {} } }),
      'package-lock.json': lockOf({ name: 'app', version: '1.0.0', dependencies }, Object.fromEntries(packages.map(pkg => [`node_modules/${pkg.doc.name}`, locked(pkg)]))) }
  }
  const build = (tree, instanceDir = dir) => buildStasisLockfile({ input: { repoId: 1, commit, config: 'stasis.config.json' }, github: 'org/repo', token: null, instanceDir }, projectClient(tree))
  const asked = () => calls.splice(0).map(({ url }) => url.slice('https://registry.npmjs.org/'.length))
  assert.deepEqual((await build(project(tool))).map(one => one.name), ['tool'])
  assert.deepEqual(asked(), ['tool/1.0.0', 'tool/-/tool-1.0.0.tgz'], 'its version’s document and its tarball')
  assert.deepEqual((await build(project(tool))).map(one => one.name), ['tool'])
  assert.deepEqual(asked(), [], 'the next build there asks npm for nothing')
  assert.deepEqual((await build(project(tool, other))).map(one => one.name), ['other', 'tool'])
  assert.deepEqual(asked(), ['other/1.0.0', 'other/-/other-1.0.0.tgz'], 'nor for what it holds of another’s')
  await build(project(tool), null)
  assert.equal(asked().length, 2, 'with no directory, nothing is kept, as before')
  // A bundle's build reads and keeps them there too.
  const bundled = { ...project(tool, other), 'index.ts': 'import "tool"\nimport "other"\n' }
  await buildStasisBundle({ input: input(), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null], instanceDir: dir }, projectClient(bundled))
  assert.deepEqual(asked(), [], 'a bundle’s build asks npm for none of them either')

  // As much as its budget: nothing written past it; found past it, emptied; a file half-written removed; none but npm’s kept.
  const store = await instanceCache(dir, (await sizeOf(dir)) + 12)
  await store.write('npm/tarballs', 'big@1.0.0', new Uint8Array(13))
  await store.write('github/trees', 'tree', new Uint8Array(1))
  await store.write('npm/versions', 'small@1.0.0', { ok: true })
  assert.deepEqual([await store.read('npm/tarballs', 'big@1.0.0'), await store.read('github/trees', 'tree'), await store.read('npm/versions', 'small@1.0.0')], [null, null, { ok: true }])
  await writeFile(join(dir, 'half.1.tmp'), 'x')
  const kept = (await readdir(dir)).length
  await instanceCache(dir, 1_000_000)
  assert.equal((await readdir(dir)).length, kept - 1, 'the half-written one gone, the rest kept')
  await instanceCache(dir, 1)
  assert.deepEqual(await readdir(dir), [], 'emptied once past its budget')
  await (await instanceCache(dir)).write('npm/versions', 'small@1.0.0', { ok: true })
  await instanceCache(dir, 1_000_000, Infinity)
  assert.deepEqual(await readdir(dir), [], 'or once its disk is nearly full')
})

test('a Stasis lockfile’s dependencies are its npm versions with an evidence file, each once as installed', () => {
  const integrity = `sha512-${'A'.repeat(86)}==`
  const patch = `sha256-${Buffer.from('ab'.repeat(32), 'hex').toString('base64')}`
  const modules = new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'index.js': 'x' } }],
    ['packages/lib', { name: 'lib', version: '1.0.0', files: { 'index.js': 'x' } }],
    ['node_modules/b', { name: 'b', version: '2.0.0', integrity, patch: { integrity: patch, file: 'patches/b.patch' }, files: { 'index.js': 'x' } }],
    ['node_modules/a', { name: 'a', version: '1.0.0', integrity, files: { 'lib/index.js': 'x', 'package.json': 'x' } }],
    ['node_modules/c/node_modules/a', { name: 'a', version: '1.0.0', integrity, files: { 'lib/other.js': 'x' } }],
    ['node_modules/manifest-only', { name: 'manifest-only', version: '1.0.0', integrity, files: { 'package.json': 'x' } }],
    ['node_modules/git', { name: 'git', version: '1.0.0', repo: { github: 'org/git', commit: 'c'.repeat(40) }, files: { 'index.js': 'x' } }],
    ['node_modules/nameless', { files: { 'index.js': 'x' } }],
    ['vendor/crate', { ecosystem: 'cargo', name: 'crate', version: '1.0.0', files: { 'src/lib.rs': 'x' } }],
  ])
  assert.deepEqual(lockfileDependencies({ modules }), [{ name: 'a', version: '1.0.0', integrity }, { name: 'b', version: '2.0.0', integrity, patch: 'ab'.repeat(32) },
    { name: 'git', version: '1.0.0' }], 'the project’s own, a package of its manifest alone and another ecosystem’s left out; one from git with no integrity')
})

test('a lockfile’s build, behind no request, gives its slot up to a build asked for, and is refused while one holds it', async () => {
  const request = { input: input(), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }
  const lockfile = { input: { repoId: 1, commit, config: 'stasis.config.json' }, github: 'org/repo', token: null, cacheDir: null }
  // The deployment's lease, claimed as its one builder of them, and released.
  const leases = { claimed: [], claimBundleBuildLease(user) { this.claimed.push(user); return Promise.resolve(true) }, releaseBundleBuildLease: () => Promise.resolve() }
  const behind = buildRepositoryLockfile(leases, lockfile, new AbortController().signal)
  const settled = behind.then(() => null, error => error.code)
  // Once it holds the slot, its lease claimed.
  await new Promise(resolve => { setImmediate(resolve) })
  const asked = new AbortController()
  const building = buildRepositoryBundle('test-user', request, asked.signal)
  assert.equal(await settled, 'build-yielded', 'told to yield, for its asker to build again later')
  await assert.rejects(buildRepositoryLockfile(leases, lockfile, new AbortController().signal), { code: 'build-busy' }, 'the slot the build asked for took')
  assert.deepEqual(leases.claimed, ['dependency-review'], 'refused its slot, the lease not asked for')
  asked.abort()
  await assert.rejects(building, { code: 'build-cancelled' })
  const stopping = new AbortController()
  const again = buildRepositoryLockfile(leases, lockfile, stopping.signal)
  await new Promise(resolve => { setImmediate(resolve) })
  stopping.abort()
  await assert.rejects(again, { code: 'build-cancelled' }, 'the slot free again')
})

test('a build asked for takes this instance’s lockfile build’s lease too: that one yields, its lease released, before the one asked for claims its own', async () => {
  const lockfile = { input: { repoId: 1, commit, config: 'stasis.config.json' }, github: 'org/repo', token: null, cacheDir: null }
  // The deployment's two leases, one a user's at a time, the first held by another instance.
  const store = () => {
    const held = new Map([['another', 'another-user']]), log = []
    return { held, log, claimBundleBuildLease(user, owner) {
      const free = held.size < 2 && ![...held.values()].includes(user)
      if (free) held.set(owner, user)
      log.push(['claim', user, free])
      return Promise.resolve(free)
    }, releaseBundleBuildLease(owner) {
      log.push(['release', held.get(owner)])
      held.delete(owner)
      return Promise.resolve()
    } }
  }
  const yieldedTo = [['claim', 'dependency-review', true], ['release', 'dependency-review'], ['claim', 'test-user', true], ['release', 'test-user']]
  // While it builds, and while it still asks for its lease.
  for (const building of [true, false]) {
    const leases = store()
    const behind = buildRepositoryLockfile(leases, lockfile, new AbortController().signal).then(() => null, error => error.code)
    if (building) {
      await new Promise(resolve => { setImmediate(resolve) })
      assert.deepEqual([...leases.held.values()], ['another-user', 'dependency-review'], 'every lease held, one by the build behind no request')
    }
    assert.equal(await withBundleBuildLease(leases, 'test-user', new AbortController().signal, () => Promise.resolve('built')), 'built', 'not refused as busy')
    assert.equal(await behind, 'build-yielded')
    assert.deepEqual(leases.log, yieldedTo, `its lease released before the one asked for is claimed${building ? '' : ', as it was still asking for it'}`)
  }
  // The other instance's is none of this one's to take: busy, as before.
  const full = store()
  full.held.set('third', 'third-user')
  await assert.rejects(withBundleBuildLease(full, 'test-user', new AbortController().signal, () => Promise.resolve('built')), { code: 'build-busy' })
})

test('real Stasis lays a pnpm tree out for no Node: engineStrict takes an engines.node the server’s Node isn’t', async () => {
  const project = {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', type: 'module', engines: { node: '1.0.0' }, packageManager: 'pnpm@10.33.4' }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
    'pnpm-workspace.yaml': 'engineStrict: true\n',
    'index.js': 'export const app = 1\n',
  }
  assert.deepEqual(await entriesOf(configured(project, ['index.js'], { conditions })), ['index.js'])
})

test('real Stasis’s build notes the directory it builds from and each tree it downloads of the repo, the whole repo’s or a directory’s', async () => {
  const noted = async project => {
    const notes = []
    await buildStasisBundle({ input: input(['app/index.ts']), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }, projectClient(project), () => {},
      (event, details) => notes.push([event, details]))
    return notes
  }
  const app = under('app', files)
  const alone = await noted(app)
  assert.deepEqual(alone.map(([event, details]) => [event, details.project ?? details.tree]), [['project', 'app'], ['download', 'directory']], 'a directory standing alone')
  assert.equal(alone[0][1].configured, false)
  assert.ok(alone[1][1].bytes > 0)
  const workspace = { ...app, 'app/package-lock.json': undefined, 'package.json': JSON.stringify({ name: 'root', version: '1.0.0', workspaces: ['app'] }),
    'package-lock.json': lockOf({ name: 'root', version: '1.0.0', workspaces: ['app'] }, { app: { name: 'fixture', version: '1.0.0' }, 'node_modules/fixture': { resolved: 'app', link: true } }) }
  delete workspace['app/package-lock.json']
  const notes = await noted(workspace)
  assert.deepEqual(notes.map(([event, { tree }]) => [event, tree]), [['project', undefined], ['download', 'repo']], 'a workspace’s, the whole repo')
  assert.ok(notes[1][1].bytes > 0)
})


test('real Stasis holds the commit to the repo’s own history: a fork’s, which GitHub serves through the repo’s name too, is refused', async () => {
  const other = 'b'.repeat(40)
  const forked = { ...projectClient(files),
    getRepoHead: () => Promise.resolve({ oid: other, branch: 'main' }),
    compareCommits: () => Promise.resolve({ status: 'diverged', aheadBy: 1, behindBy: 1, mergeBase: other }),
    listRepoTags: () => Promise.resolve([]),
    listRepoBranches: () => Promise.resolve([{ branch: 'main', oid: other }]) }
  const error = await buildStasisBundle({ input: input(), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }, forked).then(() => null, failure => failure)
  assert.ok(error, 'refused')
  assert.equal(buildErrorCode(error, error.message), 'commit-not-own')
  const behind = { ...forked, compareCommits: ({ base, head }) => Promise.resolve(base === commit && head === 'main' ? { status: 'ahead', aheadBy: 1, behindBy: 0, mergeBase: commit } : { status: 'diverged' }) }
  const built = await buildStasisBundle({ input: input(), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }, behind)
  assert.ok(built.bytes.length > 0, 'one in its default branch’s history builds')
})

test('real Stasis asks the branch a commit was picked by first: one in its history builds with no ref listed, a fork’s is refused all the same', async () => {
  const [main, feature] = ['b'.repeat(40), 'c'.repeat(40)]
  const asked = []
  const notListed = what => () => Promise.reject(new Error(`${what} listed`))
  const repo = holds => ({ ...projectClient(files),
    getRepoHead: ({ branch }) => {
      asked.push(branch ?? '(default)')
      if (branch === undefined) return Promise.resolve({ oid: main, branch: 'main' })
      if (branch === 'feature') return Promise.resolve({ oid: feature, branch: 'feature' })
      return Promise.reject(new HttpError(404, `GitHub has no branch ${branch}`))
    },
    compareCommits: ({ base, head }) => Promise.resolve(base === commit && holds.includes(head) ? { status: 'ahead', aheadBy: 1, behindBy: 0, mergeBase: commit } : { status: 'diverged' }),
    listRepoTags: notListed('tags'), listRepoBranches: notListed('branches') })
  const build = (client, branch) => buildStasisBundle({ input: input(['index.ts'], { branch }), github: 'org/repo', token: null, maxBytes: 1_000_000, scopes: [null] }, client)
  assert.ok((await build(repo(['feature']), 'feature')).bytes.length > 0, 'its branch has it')
  assert.deepEqual(asked, ['feature'], 'asked of that branch alone')
  const listed = { ...repo([]), listRepoTags: () => Promise.resolve([]), listRepoBranches: () => Promise.resolve([{ branch: 'main', oid: main }, { branch: 'feature', oid: feature }]) }
  for (const branch of ['feature', 'gone']) {
    const error = await build(listed, branch).then(() => null, failure => failure)
    assert.equal(error && buildErrorCode(error, error.message), 'commit-not-own', `a branch ${branch === 'gone' ? 'GitHub hasn’t' : 'without it'} tells nothing`)
  }
})
