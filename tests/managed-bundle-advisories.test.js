import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleAdvisoryPackages } from '../common/bundle-sources.js'
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
  const packages = bundleAdvisoryPackages(details)
  assert.deepEqual(packages.map(pkg => [pkg.ecosystem, pkg.name]), [
    ['cargo', 'log'], ['composer', 'vendor/pkg'], ['github', 'org/dep'], ['npm', 'log'], ['soldeer', 'solpkg'],
  ])
  assert.deepEqual(packages.find(pkg => pkg.ecosystem === 'npm').versions, ['1.0.0', '2.0.0'])
  assert.deepEqual(bundleAdvisoryPackages(details, new Set(['vendor/log/src/lib.rs'])), [
    { ecosystem: 'cargo', name: 'log', versions: ['0.4.22'] },
  ])
  assert.deepEqual(bundleAdvisoryPackages(details, new Set(['node_modules/tool/node_modules/log/index.js'])), [
    { ecosystem: 'npm', name: 'log', versions: ['2.0.0'] },
  ])
  assert.deepEqual(bundleAdvisoryPackages(details, new Set(['app.js'])), [])
  assert.deepEqual(bundleAdvisoryPackages({ kind: 'sourcemap' }), [])
})

test('managed audits use the real upstream API for npm, Cargo, Composer, Soldeer and GitHub', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const parsed = new URL(url)
    requests.push({ url, options })
    assert.equal(new Headers(options.headers).get('authorization'), null)
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
      return Promise.resolve(Response.json({ id, aliases: [], affected: [{
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
    return Promise.resolve(Response.json([{ ghsa_id: ghsa, state: 'published', summary: 'Repository vulnerability',
      severity: 'medium', vulnerabilities: [{ vulnerable_version_range: '<2.0.0' }] }]))
  })
  const result = await fetchBundleAdvisories(bundleAdvisoryPackages(mixedBundle()), signal())
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.map(row => row.ecosystem), ['cargo', 'composer', 'github', 'npm', 'soldeer'])
  assert.deepEqual(result.body.find(row => row.ecosystem === 'npm').versions, ['1.0.0'])
  assert.equal(result.body.find(row => row.ecosystem === 'cargo').informational, 'unmaintained')
  assert.equal(result.body.find(row => row.ecosystem === 'github').severity, 'moderate')
  assert.ok(requests.some(request => request.url.startsWith('https://api.osv.dev/')))
  assert.ok(requests.every(request => !request.options.body?.includes('private source')))
})

test('empty, canceled and invalid inventories never send requests', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not contact upstream') })
  assert.deepEqual(await fetchBundleAdvisories([], signal()), { status: 200, body: [] })
  const packages = [{ ecosystem: 'composer', name: 'vendor/pkg', versions: ['dev-main'] }]
  assert.equal((await fetchBundleAdvisories(packages, signal())).status, 502)
  assert.equal((await fetchBundleAdvisories(packages, AbortSignal.abort())).status, 502)
  assert.equal(fetch.mock.callCount(), 0)
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
