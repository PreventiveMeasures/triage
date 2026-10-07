import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleAdvisoryInventory } from '../server-managed/bundle-advisory-inventory.ts'
import { fetchBundleAdvisories } from '../server-managed/bundle-advisories.ts'

const ghsa = 'GHSA-2345-6789-cfgh'
const signal = () => new AbortController().signal
function mixedBundle() {
  return { kind: 'stasis', bundle: Bundle.parse(new Bundle({ modules: new Map([
    ['.', { ecosystem: 'npm', name: 'app', version: '1.0.0', files: { 'app.js': 'private source' } }],
    ['node_modules/log', { name: 'log', version: '1.0.0', files: { 'index.js': 'npm one' } }],
    ['node_modules/tool/node_modules/log', { name: 'log', version: '2.0.0', files: { 'index.js': 'npm two' } }],
    ['vendor/log', { ecosystem: 'cargo', name: 'log', version: '0.4.22', files: { 'src/lib.rs': 'cargo source' } }],
    ['vendor/vendor/pkg', { ecosystem: 'composer', name: 'vendor/pkg', version: '1.2.3', files: { 'src/file.php': 'php source' } }],
    ['dependencies/solpkg', { ecosystem: 'soldeer', name: 'solpkg', version: '1.0.0', files: { 'src/File.sol': 'solidity source' } }],
    ['dependencies/repo', { ecosystem: 'github', name: 'org/dep', version: 'main', files: { 'src/File.sol': 'git source' } }],
    ['dependencies/repo-copy', { ecosystem: 'github', name: 'ORG/DEP', version: 'main', files: { 'src/File.sol': 'git source' } }],
    ['vendor/unknown', { ecosystem: 'go', name: 'unknown', version: '1.0.0', files: {} }],
    ['workspace', { name: 'own-package', version: '1.0.0', files: {} }],
  ]) }).serialize()) }
}

test('advisory inventory separates ecosystems, merges versions, and selects exact reason files', () => {
  const details = mixedBundle()
  const { packages } = bundleAdvisoryInventory(details)
  assert.deepEqual(packages.map(pkg => [pkg.ecosystem, pkg.name]), [
    ['cargo', 'log'], ['composer', 'vendor/pkg'], ['github', 'org/dep'], ['npm', 'log'], ['soldeer', 'solpkg'],
  ])
  assert.deepEqual(packages.find(pkg => pkg.ecosystem === 'npm').versions, ['1.0.0', '2.0.0'])
  assert.deepEqual(bundleAdvisoryInventory(details, new Set(['vendor/log/src/lib.rs'])).packages, [
    { ecosystem: 'cargo', name: 'log', versions: ['0.4.22'] },
  ])
  assert.deepEqual(bundleAdvisoryInventory(details, new Set(['node_modules/tool/node_modules/log/index.js'])).packages, [
    { ecosystem: 'npm', name: 'log', versions: ['2.0.0'] },
  ])
  assert.deepEqual(bundleAdvisoryInventory(details, new Set(['app.js'])).packages, [])
  assert.deepEqual(bundleAdvisoryInventory({ kind: 'sourcemap' }).packages, [])
})

function inventoryOf(modules, paths = null) {
  const bundle = Bundle.parse(new Bundle({ modules: new Map(modules) }).serialize())
  return bundleAdvisoryInventory({ kind: 'stasis', bundle }, paths)
}

test('advisory inventory retains dependency repository hints across ecosystems and versions', () => {
  const modules = ['npm', 'cargo', 'composer', 'soldeer', 'github'].map(ecosystem => [
    `dependencies/${ecosystem}`, { ecosystem, name: ecosystem === 'composer' || ecosystem === 'github' ? 'org/dep' : 'dep',
      version: '1.0.0', repo: { github: `org/${ecosystem}` }, files: { 'code': 'source' } },
  ])
  modules.push(['node_modules/dep', { name: 'dep', version: '2.0.0', repo: { github: 'ORG/NPM' }, files: { 'index.js': 'source' } }])
  modules.push(['node_modules/other/node_modules/dep', { name: 'dep', version: '3.0.0', files: { 'index.js': 'source' } }])
  const { packages } = inventoryOf(modules)
  assert.deepEqual(packages.map(pkg => [pkg.ecosystem, pkg.github]), [
    ['cargo', 'org/cargo'], ['composer', 'org/composer'], ['github', undefined], ['npm', 'ORG/NPM'], ['soldeer', 'org/soldeer'],
  ])
  assert.deepEqual(packages.find(pkg => pkg.ecosystem === 'npm').versions, ['1.0.0', '2.0.0', '3.0.0'])
})

test('conflicting repository hints fall back to discovery without affecting reason-scoped hints', () => {
  const modules = ['org/original', 'org/moved', 'org/original'].map((github, index) => [
    `node_modules/copy${index}/node_modules/dep`, { name: 'dep', version: `${index + 1}.0.0`, repo: { github }, files: { 'index.js': 'source' } },
  ])
  assert.deepEqual(inventoryOf(modules).packages, [{ ecosystem: 'npm', name: 'dep', versions: ['1.0.0', '2.0.0', '3.0.0'] }])
  assert.deepEqual(inventoryOf(modules, ['node_modules/copy1/node_modules/dep/index.js']).packages,
    [{ ecosystem: 'npm', name: 'dep', versions: ['2.0.0'], github: 'org/moved' }])
})

test('npm packages without a recorded repository use the one their bundled package.json names', () => {
  // Records from before Stasis recorded `repo`, carrying their package.json.
  const withManifest = (name, repository, text = JSON.stringify({ name, version: '1.0.0', repository })) =>
    [`node_modules/${name}`, { name, version: '1.0.0', files: { 'index.js': 'source', 'package.json': text } }]
  const modules = [
    withManifest('from-manifest', { type: 'git', url: 'git+https://github.com/org/from-manifest.git' }),
    withManifest('recorded', 'github:other/recorded'),
    withManifest('not-github', 'https://gitlab.com/org/not-github'),
    withManifest('bad-json', undefined, '{'),
    withManifest('bom', undefined, `\uFEFF${JSON.stringify({ name: 'bom', version: '1.0.0', repository: 'github:org/bom' })}`),
    ['vendor/org/php', { ecosystem: 'composer', name: 'org/php', version: '1.0.0', files: { 'a.php': 'source', 'package.json': JSON.stringify({ repository: 'org/js' }) } }],
  ]
  modules[1][1].repo = { github: 'org/recorded' }
  assert.deepEqual(inventoryOf(modules).packages.map(pkg => [pkg.name, pkg.github]), [
    ['org/php', undefined], ['bad-json', undefined], ['bom', 'org/bom'], ['from-manifest', 'org/from-manifest'], ['not-github', undefined], ['recorded', 'org/recorded'],
  ])
  // A manifest's hint conflicts with a recorded one like any other.
  const split = [withManifest('dep', 'github:org/old'), ['node_modules/a/node_modules/dep', { name: 'dep', version: '2.0.0', repo: { github: 'org/new' }, files: { 'index.js': 'source' } }]]
  assert.equal(inventoryOf(split).packages[0].github, undefined)
})

test('audit presence and reason scopes require code evidence, including version-bounded browser corrections', () => {
  const modules = [
    ['node_modules/ws', { name: 'ws', version: '8.21.1', files: { 'package.json': '{}', 'browser.js': 'stub', 'lib/websocket.js': 'code' } }],
    ['node_modules/node-fetch', { name: 'node-fetch', version: '2.7.0', files: { 'nested/package.json': '{}', 'browser.js': 'stub' } }],
    ['node_modules/latest/node_modules/ws', { name: 'ws', version: '8.22.0', files: { 'browser.js': 'stub' } }],
    ['node_modules/future/node_modules/ws', { name: 'ws', version: '8.22.1', files: { 'browser.js': 'unverified' } }],
    ['node_modules/future/node_modules/node-fetch', { name: 'node-fetch', version: '2.7.1', files: { 'browser.js': 'unverified' } }],
    ['node_modules/unknown/node_modules/ws', { name: 'ws', version: 'unknown', files: { 'browser.js': 'unverified' } }],
    ['vendor/ws', { ecosystem: 'cargo', name: 'ws', version: '1.0.0', files: { 'browser.js': 'not an npm correction' } }],
    ['node_modules/added', { name: 'added', version: '1.0.0', files: { 'index.js': 'manually added code without an import edge' } }],
    ['node_modules/empty', { name: 'empty', version: '1.0.0', files: {} }],
    ['node_modules/manifests', { name: 'manifests', version: '1.0.0', files: { 'package.json': '{}', 'nested/package.json': '{}' } }],
    ['vendor/manifests', { ecosystem: 'cargo', name: 'manifests', version: '1.0.0', files: { 'Cargo.toml': '', 'Cargo.lock': '', '.cargo-checksum.json': '{}' } }],
    ['vendor/vendor/manifests', { ecosystem: 'composer', name: 'vendor/manifests', version: '1.0.0', files: { 'composer.json': '{}', 'nested/composer.lock': '{}' } }],
    ...['soldeer', 'github'].map(ecosystem => [`lib/${ecosystem}`, { ecosystem, name: ecosystem === 'github' ? 'org/manifests' : 'manifests', version: '1.0.0',
      files: { 'package.json': '{}', 'foundry.toml': '', 'remappings.txt': '', 'soldeer.toml': '' } }]),
  ]
  assert.deepEqual(inventoryOf(modules), { packages: [
    { ecosystem: 'cargo', name: 'ws', versions: ['1.0.0'] },
    { ecosystem: 'npm', name: 'added', versions: ['1.0.0'] },
    { ecosystem: 'npm', name: 'node-fetch', versions: ['2.7.1'] },
    { ecosystem: 'npm', name: 'ws', versions: ['8.21.1', '8.22.1', 'unknown'] },
  ], skipped: [] })
  assert.deepEqual(inventoryOf(modules, ['node_modules/ws/package.json', 'node_modules/ws/browser.js']), { packages: [], skipped: [] })
  assert.deepEqual(inventoryOf(modules, ['node_modules/ws/lib/websocket.js']), { packages: [{ ecosystem: 'npm', name: 'ws', versions: ['8.21.1'] }], skipped: [] })
})

test('Composer dev versions and unregistered crates are reported without preventing release audits', async t => {
  const modules = [
    ['vendor/vendor/pkg', { ecosystem: 'composer', name: 'vendor/pkg', version: 'dev-main#abc123', files: { 'file.php': 'private source' } }],
    ['vendor/other/pkg', { ecosystem: 'composer', name: 'other/pkg', version: '1.x-dev#abc123', files: { 'file.php': 'private source' } }],
    ['copy/vendor/pkg', { ecosystem: 'composer', name: 'vendor/pkg', version: 'dev-main#abc123', files: { 'file.php': 'private source' } }],
    ['release/vendor/pkg', { ecosystem: 'composer', name: 'vendor/pkg', version: '1.2.3', files: { 'file.php': 'release source' } }],
    ['vendor/private-crate', { ecosystem: 'cargo-git', name: 'private-crate', version: '1.0.0', files: { 'src/lib.rs': 'private source' } }],
    ['vendor/unknown-crate', { ecosystem: 'cargo-unknown', name: 'unknown-crate', version: '1.0.0', files: { 'src/lib.rs': 'private source' } }],
    ['vendor/unsupported', { ecosystem: 'other', name: 'unsupported', version: '1.0.0', files: { 'source': 'private source' } }],
  ]
  const { packages, skipped } = inventoryOf(modules)
  assert.deepEqual(packages, [{ ecosystem: 'composer', name: 'vendor/pkg', versions: ['1.2.3'] }])
  assert.deepEqual(skipped.map(({ ecosystem, name, version }) => [ecosystem, name, version]), [
    ['cargo-git', 'private-crate', '1.0.0'], ['cargo-unknown', 'unknown-crate', '1.0.0'],
    ['composer', 'other/pkg', '1.x-dev#abc123'], ['composer', 'vendor/pkg', 'dev-main#abc123'], ['other', 'unsupported', '1.0.0'],
  ])
  assert.ok(skipped.every(pkg => pkg.because.length > 0))
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return Promise.resolve(Response.json({ results: [{}] }))
  })
  assert.deepEqual(await fetchBundleAdvisories(packages, signal()), { status: 200, body: [] })
  assert.deepEqual(calls, [{ url: 'https://api.osv.dev/v1/querybatch', body: { queries: [{ package: { ecosystem: 'Packagist', name: 'vendor/pkg' }, version: '1.2.3' }] } }])
  const scoped = inventoryOf(modules, ['vendor/private-crate/src/lib.rs'])
  assert.deepEqual(scoped, { packages: [], skipped: [skipped[0]] })
  assert.deepEqual(await fetchBundleAdvisories(scoped.packages, signal()), { status: 200, body: [] })
  assert.equal(calls.length, 1, 'a skipped-only scope never contacts upstream')
})

test('GitHub branch dot is normalized to the unknown-version placeholder and conservatively matches ranges', async t => {
  const { packages } = inventoryOf([
    ['lib/repo', { ecosystem: 'github', name: 'org/dep', version: '.', files: { 'src/File.sol': 'code' } }],
    ['lib/copy', { ecosystem: 'github', name: 'ORG/DEP', version: '0.0.0', files: { 'src/File.sol': 'code' } }],
  ])
  assert.deepEqual(packages, [{ ecosystem: 'github', name: 'ORG/DEP', versions: ['0.0.0'] }])
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json([{ ghsa_id: ghsa, state: 'published', summary: 'Repository vulnerability',
    vulnerabilities: [{ vulnerable_version_range: '>=3.0.0, <4.0.0' }] }])))
  const result = await fetchBundleAdvisories(packages, signal())
  assert.equal(result.status, 200)
  assert.deepEqual(result.body[0].versions, ['0.0.0'])
})

test('managed audits use the real upstream API and authenticate only GitHub across all five ecosystems', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const parsed = new URL(url)
    requests.push({ url, options })
    assert.equal(new Headers(options.headers).get('authorization'), parsed.hostname === 'api.github.com' ? 'Bearer viewer-token' : null)
    if (parsed.hostname === 'registry.npmjs.org') {
      assert.deepEqual(JSON.parse(options.body), { log: ['1.0.0', '2.0.0'] })
      return Promise.resolve(Response.json({ log: [{ id: 1, title: 'npm vulnerability', severity: 'high',
        url: `https://github.com/advisories/${ghsa}`, vulnerable_versions: '<2.0.0' }] }))
    }
    if (parsed.pathname === '/v1/querybatch') {
      const query = JSON.parse(options.body).queries[0]
      assert.ok(['crates.io', 'Packagist'].includes(query.package.ecosystem))
      const id = query.package.ecosystem === 'crates.io' ? 'RUSTSEC-2026-0001' : ghsa
      return Promise.resolve(Response.json({ results: [{ vulns: [{ id }] }] }))
    }
    if (parsed.pathname.startsWith('/v1/vulns/')) {
      const id = parsed.pathname.split('/').at(-1)
      return Promise.resolve(Response.json({ id, aliases: [], details: '# OSV details', affected: [{
        package: { ecosystem: 'crates.io', name: 'log' }, database_specific: { informational: 'unmaintained' },
      }] }))
    }
    if (parsed.hostname === 'api.soldeer.xyz') {
      assert.equal(parsed.searchParams.get('project_name'), 'solpkg')
      return Promise.resolve(Response.json({ data: [{ name: 'solpkg', github_url: 'https://github.com/org/dep' }] }))
    }
    assert.equal(parsed.pathname, '/repos/org/dep/security-advisories')
    assert.equal(parsed.searchParams.get('state'), 'published')
    assert.equal(options.redirect, 'manual')
    return Promise.resolve(Response.json([{ ghsa_id: ghsa, state: 'published', summary: 'Repository vulnerability', description: '# Repository details',
      severity: 'medium', vulnerabilities: [{ vulnerable_version_range: '<2.0.0' }] }]))
  })
  const result = await fetchBundleAdvisories(bundleAdvisoryInventory(mixedBundle()).packages, signal(), { githubToken: 'viewer-token' })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.map(row => row.ecosystem), ['cargo', 'composer', 'github', 'npm', 'soldeer'])
  assert.deepEqual(result.body.find(row => row.ecosystem === 'npm').versions, ['1.0.0'])
  assert.equal(result.body.find(row => row.ecosystem === 'cargo').informational, 'unmaintained')
  assert.equal(result.body.find(row => row.ecosystem === 'github').severity, 'moderate')
  assert.equal(result.body.find(row => row.ecosystem === 'github').url, `https://github.com/org/dep/security/advisories/${ghsa}`)
  assert.equal(result.body.find(row => row.ecosystem === 'npm').url, `https://github.com/advisories/${ghsa}`)
  assert.equal(result.body.find(row => row.ecosystem === 'cargo').url, 'https://osv.dev/vulnerability/RUSTSEC-2026-0001')
  assert.ok(requests.some(request => request.url.startsWith('https://api.osv.dev/')))
  assert.ok(requests.every(request => !request.options.body?.includes('private source')))
  assert.ok(result.body.every(row => row.details === undefined), 'initial lookups omit full text')
  const detailed = await fetchBundleAdvisories(bundleAdvisoryInventory(mixedBundle()).packages, signal(), { githubToken: 'viewer-token', details: true })
  assert.equal(detailed.status, 200)
  assert.deepEqual(detailed.body.map(row => [row.ecosystem, row.details]), [
    ['cargo', '# OSV details'], ['composer', '# OSV details'], ['github', '# Repository details'],
    ['npm', '# OSV details'], ['soldeer', '# Repository details'],
  ])
})

test('empty, canceled and invalid inventories never send requests', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not contact upstream') })
  assert.deepEqual(await fetchBundleAdvisories([], signal()), { status: 200, body: [] })
  const packages = [{ ecosystem: 'npm', name: 'invalid package name', versions: ['1.0.0'] }]
  assert.equal((await fetchBundleAdvisories(packages, signal())).status, 502)
  assert.equal((await fetchBundleAdvisories(packages, AbortSignal.abort())).status, 502)
  assert.equal(fetch.mock.callCount(), 0)
})

test('repository rechecks enrich npm, Cargo and Composer with matching maintainer advisories and deduplicate known ones', async t => {
  const packages = [
    { ecosystem: 'npm', name: 'log', versions: ['1.0.0', '2.0.0'] },
    { ecosystem: 'cargo', name: 'log', versions: ['0.4.22'] },
    { ecosystem: 'composer', name: 'vendor/pkg', versions: ['1.2.3'] },
  ]
  const calls = [], repositoryGhsa = 'GHSA-3456-789c-fghj'
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push(url)
    const { hostname, pathname } = new URL(url)
    assert.equal(new Headers(options.headers).get('authorization'), null)
    if (pathname.endsWith('/advisories/bulk')) {
      return Promise.resolve(Response.json({ log: [{ id: 1, title: 'Registry vulnerability', severity: 'high',
        url: `https://github.com/advisories/${ghsa}`, vulnerable_versions: '<2.0.0' }] }))
    }
    if (pathname === '/v1/querybatch') return Promise.resolve(Response.json({ results: [{}] }))
    if (hostname === 'registry.npmjs.org') {
      assert.equal(pathname, '/log/2.0.0', 'the newest version asked names the repository')
      return Promise.resolve(Response.json({ name: 'log', version: '2.0.0', repository: 'https://github.com/org/npm-log' }))
    }
    if (hostname === 'crates.io') return Promise.resolve(Response.json({ crates: [{ id: 'log', repository: 'https://github.com/org/cargo-log' }] }))
    if (hostname === 'repo.packagist.org') return Promise.resolve(Response.json({ packages: { 'vendor/pkg': [{ source: { url: 'https://github.com/org/composer-pkg' } }] } }))
    assert.equal(hostname, 'api.github.com')
    const ecosystem = pathname.includes('npm-log') ? 'npm' : pathname.includes('cargo-log') ? 'rust' : 'composer'
    const name = ecosystem === 'composer' ? 'vendor/pkg' : 'log'
    const advisory = id => ({ ghsa_id: id, state: 'published', summary: 'Maintainer vulnerability',
      vulnerabilities: [{ package: { ecosystem, name }, vulnerable_version_range: '<2.0.0' }] })
    return Promise.resolve(Response.json([advisory(repositoryGhsa), ...(ecosystem === 'npm' ? [advisory(ghsa)] : []),
      { ...advisory('GHSA-4567-89cf-ghjm'), vulnerabilities: [{ package: { ecosystem, name: 'unrelated' }, vulnerable_version_range: '*' }] }]))
  })
  const normal = await fetchBundleAdvisories(packages, signal())
  assert.equal(normal.status, 200)
  assert.equal(normal.body.length, 1)
  assert.equal(calls.length, 3, 'the default audit only asks npm and OSV')
  const rechecked = await fetchBundleAdvisories(packages, signal(), { repoAdvisories: true })
  assert.equal(rechecked.status, 200)
  assert.equal(rechecked.body.length, 4)
  assert.deepEqual(rechecked.body.filter(row => row.source === 'repository').map(row => [row.ecosystem, row.id, row.versions]), [
    ['cargo', repositoryGhsa, ['0.4.22']], ['composer', repositoryGhsa, ['1.2.3']], ['npm', repositoryGhsa, ['1.0.0']],
  ])
  assert.equal(rechecked.body.filter(row => row.id === ghsa).length, 1, 'the registry GHSA is not repeated from the repository')
})

test('repository rechecks retry a rejected GitHub token anonymously without repeating npm requests', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const authorization = new Headers(options.headers).get('authorization')
    calls.push({ url, authorization })
    if (new URL(url).hostname !== 'api.github.com') {
      assert.equal(authorization, null)
      return Promise.resolve(Response.json(url.endsWith('/advisories/bulk') ? {} : { name: 'dep', version: '1.0.0', repository: 'https://github.com/org/dep' }))
    }
    if (authorization) return Promise.resolve(Response.json({ message: 'Bad credentials' }, { status: 401 }))
    return Promise.resolve(Response.json([{ ghsa_id: ghsa, state: 'published', summary: 'Public advisory',
      vulnerabilities: [{ package: { ecosystem: 'npm', name: 'dep' }, vulnerable_version_range: '*' }] }]))
  })
  const result = await fetchBundleAdvisories([{ ecosystem: 'npm', name: 'dep', versions: ['1.0.0'] }], signal(), { repoAdvisories: true, githubToken: 'revoked' })
  assert.equal(result.status, 200)
  assert.equal(result.body[0].title, 'Public advisory')
  assert.deepEqual(calls.map(call => call.authorization), [null, null, 'Bearer revoked', null])
  assert.equal(calls[2].url, calls[3].url, 'retry only the rejected repository lookup')
})

test('a rejected token is not reused for later repositories in the same audit', async t => {
  const packages = Array.from({ length: 8 }, (_, i) => ({ ecosystem: 'github', name: `org/dep${i}`, versions: ['1.0.0'] }))
  const anonymous = new Set()
  let rejected = 0
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (new Headers(options.headers).has('authorization')) {
      assert.equal(anonymous.size, 0, 'stop using the token once anonymous fallback has started')
      rejected++
      return Promise.resolve(Response.json({ message: 'Bad credentials' }, { status: 401 }))
    }
    anonymous.add(new URL(url).pathname)
    return Promise.resolve(Response.json([]))
  })
  assert.deepEqual(await fetchBundleAdvisories(packages, signal(), { githubToken: 'revoked' }), { status: 200, body: [] })
  assert.equal(anonymous.size, packages.length)
  assert.ok(rejected > 0 && rejected < packages.length, 'queued repositories use the anonymous client directly')
})

for (const status of [401, 403, 429, 500]) {
  test(`GitHub advisory failure ${status} retries only an authenticated 401, once`, async t => {
    const credentials = []
    t.mock.method(globalThis, 'fetch', (_url, options) => {
      credentials.push(new Headers(options.headers).get('authorization'))
      return Promise.resolve(Response.json({ message: 'Rejected' }, { status }))
    })
    const result = await fetchBundleAdvisories([{ ecosystem: 'github', name: 'org/dep', versions: ['1.0.0'] }], signal(), { githubToken: 'viewer-token' })
    assert.deepEqual(result, { status: 502, body: { error: 'upstream-unavailable' } })
    assert.deepEqual(credentials, status === 401 ? ['Bearer viewer-token', null] : ['Bearer viewer-token'])
  })
}

test('an aborted audit does not retry a rejected GitHub token', async t => {
  const controller = new AbortController()
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => {
    calls++
    controller.abort()
    return Promise.resolve(Response.json({ message: 'Bad credentials' }, { status: 401 }))
  })
  const result = await fetchBundleAdvisories([{ ecosystem: 'github', name: 'org/dep', versions: ['1.0.0'] }], controller.signal, { githubToken: 'revoked' })
  assert.deepEqual(result, { status: 502, body: { error: 'upstream-unavailable' } })
  assert.equal(calls, 1)
})

test('an aborted caller stops waiting for an audit and late transport failures are handled', async t => {
  const controller = new AbortController(), started = Promise.withResolvers(), transport = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', () => { started.resolve(); return transport.promise })
  const result = fetchBundleAdvisories([{ ecosystem: 'npm', name: 'dep', versions: ['1.0.0'] }], controller.signal)
  await started.promise
  controller.abort()
  assert.deepEqual(await result, { status: 502, body: { error: 'upstream-unavailable' } })
  transport.reject(new Error('late network failure'))
})

test('a registry response for a package outside the authorized inventory fails the audit', async t => {
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ other: [] })))
  assert.deepEqual(await fetchBundleAdvisories([{ ecosystem: 'npm', name: 'dep', versions: ['1.0.0'] }], signal()),
    { status: 502, body: { error: 'upstream-unavailable' } })
})
