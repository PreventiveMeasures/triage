import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { brotliDecompressSync, gzipSync } from 'node:zlib'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { buildGitHubBundle } from '@exodus/stasis/vfs-bundle'
import { buildErrorCode, buildStasisBundle } from '../server-managed/bundle-build-worker.js'
import { buildRepositoryBundle, githubBundleFilename, parseBundleBuild } from '../server-managed/bundle-build.ts'
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
    ['buildVfsBundle: stasis.config.json: lock can only be \'frozen\' (got "none")', 'config-invalid'],
    ['stasis.config.json\'s lockfiles names nope/package-lock.json, which is no file in /', 'config-invalid'],
    ['buildVfsBundle: stasis.config.json: disallowedPaths refuses value.ts ("value.ts")', 'config-policy'],
    ['buildVfsBundle: stasis.config.json: entries "a.ts", "b.ts": allowedModules allows none of 2 packages: x@1.0.0, y@1.0.0', 'config-policy'],
    ['buildVfsBundle: stasis.config.json: entries "index.ts": allowedPaths does not allow secret.ts', 'config-policy'],
    ['buildVfsBundle: stasis.config.json: entries "index.ts": disallowedPaths must be an array of non-empty strings', 'config-invalid'],
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
