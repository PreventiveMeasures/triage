import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { createBundleMetadata, parseBundleMetadata } from '../common/bundle-metadata.js'

const state = { managedSession: { id: 'alice', role: 'view', csrfToken: 'session' }, managedTeams: [], currentManagedTeam: 'team' }
let allowed = false, managedCalls = [], managedReasons = [], pending = null, result
mock.module('../client/index.js', { namedExports: { state } })
mock.module('../ui/view/ingest.js', { namedExports: { bundleKind: name => name.endsWith('.br') ? 'stasis' : 'sourcemap' } })
mock.module('../ui/view/client-managed.js', { namedExports: { fetchBundleAdvisories: (id, _team, reason) => {
  managedCalls.push(id)
  managedReasons.push(reason)
  return pending ?? Promise.resolve(result)
} } })
const { ensureBundleAdvisories, grantAdvisoriesProxyConsent, renderBundleAdvisoriesTab, retryBundleAdvisories, showAdvisoriesTab } = await import('../ui/view/render-bundle-advisories.js')
function renderText(value) {
  if (value?.strings && value?.values) return value.strings.map((text, i) => text + renderText(value.values[i])).join('')
  if (Array.isArray(value)) return value.map(renderText).join('')
  return value == null || typeof value === 'symbol' ? '' : String(value)
}
beforeEach(t => {
  managedCalls = []; managedReasons = []; allowed = false; pending = null
  state.managedTeams = []
  result = { packages: { dep: ['1.0.0'] }, advisories: { dep: [{ title: 'Public vulnerability', severity: 'high', url: 'https://example.com/advisory' }] } }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => allowed ? '1' : null, setItem: () => { allowed = true } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage })
})

test('managed advisories render separate ecosystems, unrated RustSec records, CVSS and repository links', async () => {
  const details = { managedId: 'mixed-bundle', integrity: 'mixed-bundle', kind: 'stasis' }
  result = {
    packages: [{ ecosystem: 'cargo', name: 'log', versions: ['0.4.22'] }, { ecosystem: 'npm', name: 'log', versions: ['1.0.0'] }],
    advisories: [
      { ecosystem: 'cargo', name: 'log', source: 'osv', id: 'RUSTSEC-2026-0001', aliases: [], cwe: [],
        informational: 'unmaintained', versions: ['0.4.22'] },
      { ecosystem: 'npm', name: 'log', source: 'registry', id: 'GHSA-2345-6789-cfgh', ghsa: 'GHSA-2345-6789-cfgh',
        title: 'npm vulnerability', severity: 'high', cvss: 8.1, cvssVector: 'CVSS:3.1/AV:N/AC:L',
        range: '<2.0.0', aliases: [], cwe: ['CWE-79'], versions: ['1.0.0'] },
    ],
  }
  await ensureBundleAdvisories(details, () => {})
  const text = renderText(renderBundleAdvisoriesTab(details))
  for (const word of ['cargo:log', 'RUSTSEC-2026-0001', 'Unrated', 'unmaintained', '0.4.22', 'npm vulnerability', '1.0.0', '8.1', 'CVSS:3.1/AV:N/AC:L']) {
    assert.ok(text.includes(word), `renders ${word}`)
  }
  assert.match(text, /https:\/\/osv.dev\/vulnerability\/RUSTSEC-2026-0001/u)
  assert.match(text, /https:\/\/github.com\/advisories\/GHSA-2345-6789-cfgh/u)
  assert.match(text, /Matches <span class="mono">0\.4\.22<\/span>/u)
  assert.match(text, /2 advisories\s+across 2 of 2 packages/u)
})

test('managed advisory view needs neither consent nor bundle contents or module metadata', async () => {
  const details = { managedId: 'bundle-id', integrity: 'same-hash', kind: 'stasis' }
  assert.equal(showAdvisoriesTab({ managedId: details.managedId, integrity: details.integrity, name: 'bundle.br' }, details), true)
  assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(details)), /data-advisories-consent/u)
  await ensureBundleAdvisories(details, () => {})
  await ensureBundleAdvisories(details, () => {})
  assert.deepEqual(managedCalls, ['bundle-id'])
  const text = renderText(renderBundleAdvisoriesTab(details))
  assert.match(text, /Public vulnerability/u)
  assert.match(text, /1\.0\.0/u)
  await ensureBundleAdvisories({ ...details, managedId: 'other-id' }, () => {})
  assert.deepEqual(managedCalls, ['bundle-id', 'other-id'], 'equal hashes do not mix managed identities')
})

test('managed results cannot populate another session or team cache', async () => {
  const details = { managedId: 'bundle-id', integrity: 'same-hash', kind: 'stasis' }
  const gate = Promise.withResolvers()
  pending = gate.promise
  const first = ensureBundleAdvisories(details, () => {})
  state.currentManagedTeam = 'other-team'
  assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(details)), /Public vulnerability/u)
  gate.resolve(result)
  await first
  assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(details)), /Public vulnerability/u)
  pending = null
  await ensureBundleAdvisories(details, () => {})
  state.managedSession = { id: 'bob', role: 'view', csrfToken: 'other' }
  assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(details)), /Public vulnerability/u)
  await ensureBundleAdvisories(details, () => {})
  assert.equal(managedCalls.length, 3)
})

test('managed request failures are retryable; e2e still posts its local inventory', async t => {
  const details = { managedId: 'bundle-id', integrity: 'same-hash', kind: 'stasis' }
  pending = Promise.reject(new Error('security-access-required'))
  await ensureBundleAdvisories(details, () => {})
  assert.match(renderText(renderBundleAdvisoriesTab(details)), /security-access-required/u)
  pending = null
  await retryBundleAdvisories(details, () => {})
  assert.match(renderText(renderBundleAdvisoriesTab(details)), /Public vulnerability/u)
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push({ url, options })
    return Promise.resolve(Response.json({}))
  })
  const local = { integrity: 'local', kind: 'stasis', bundle: { modules: new Map([
    ['node_modules/dep', { name: 'dep', version: '1.0.0' }], ['.', { name: 'app', version: '2.0.0' }],
  ]) } }
  assert.equal(allowed, false, 'managed lookups do not grant local/e2e consent')
  assert.match(renderText(renderBundleAdvisoriesTab(local)), /data-advisories-consent/u)
  await ensureBundleAdvisories(local, () => {})
  assert.equal(calls.length, 0, 'local/e2e still requires consent')
  grantAdvisoriesProxyConsent()
  await ensureBundleAdvisories(local, () => {})
  assert.equal(calls[0].url, '/api/npm-advisories')
  assert.deepEqual(JSON.parse(calls[0].options.body), { dep: ['1.0.0'] })
})

test('local npm rows retain the GHSA link instead of displaying the numeric registry ID', async t => {
  const details = { integrity: 'legacy-npm-advisory', kind: 'stasis', bundle: { modules: new Map([
    ['node_modules/dep', { name: 'dep', version: '1.0.0' }],
  ]) } }
  grantAdvisoriesProxyConsent()
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ dep: [{
    id: 123, title: 'npm vulnerability', severity: 'high', url: 'https://github.com/advisories/GHSA-2345-6789-cfgh',
  }] })))
  await ensureBundleAdvisories(details, () => {})
  const text = renderText(renderBundleAdvisoriesTab(details))
  assert.match(text, />GHSA-2345-6789-cfgh<svg/u)
  assert.doesNotMatch(text, />123<svg/u)
})


function scopeControl(value) {
  if (value?.strings?.join('').includes('<bundle-scope-selector')) return value
  for (const child of value?.values ?? (Array.isArray(value) ? value : [])) {
    const found = scopeControl(child)
    if (found) return found
  }
  return null
}
function selectReason(details, value) {
  const control = scopeControl(renderBundleAdvisoriesTab(details))
  assert.ok(control, 'reuse the annotated selector')
  return control.values.find(item => typeof item === 'function')({ detail: { value } })
}
function reasonBundle(integrity) {
  return { kind: 'stasis', integrity, size: 123, bundle: Bundle.parse(new Bundle({
    modules: new Map([
      ['.', { name: 'app', version: '1', files: { 'app.js': 'app' } }],
      ['node_modules/dep', { name: 'dep', version: '1.0.0', files: { 'index.js': 'one' } }],
      ['node_modules/tool/node_modules/dep', { name: 'dep', version: '2.0.0', files: { 'index.js': 'two' } }],
    ]),
    reason: { metro: ['node_modules/dep/index.js'], run: ['node_modules/tool/node_modules/dep/index.js'], add: ['app.js'] },
  }).serialize()) }
}

[false, true].forEach(managed => {
  test(`${managed ? 'managed' : 'e2e'} advisory scopes query exact versions and keep separate cached results`, async t => {
    let details = reasonBundle(`scoped-${managed}`)
    const queries = []
    if (managed) {
      details = { ...parseBundleMetadata(await createBundleMetadata(details), details.integrity), managedId: 'scoped-bundle' }
    } else {
      grantAdvisoriesProxyConsent()
      t.mock.method(globalThis, 'fetch', (_url, options) => {
        const query = JSON.parse(options.body)
        queries.push(query)
        return Promise.resolve(Response.json({ dep: [{ title: query.dep.join(', '), severity: 'high' }] }))
      })
    }
    await ensureBundleAdvisories(details, () => {})
    result = { packages: { dep: ['1.0.0'] }, advisories: { dep: [{ title: 'Metro vulnerability', severity: 'high' }] } }
    await selectReason(details, 'reason:metro')
    assert.match(renderText(renderBundleAdvisoriesTab(details)), /1\.0\.0/u)
    assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(details)), /2\.0\.0/u)
    result = { packages: { dep: ['2.0.0'] }, advisories: { dep: [{ title: 'Run vulnerability', severity: 'high' }] } }
    await selectReason(details, 'reason:run')
    assert.match(renderText(renderBundleAdvisoriesTab(details)), /2\.0\.0/u)
    assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(details)), /1\.0\.0/u)
    await selectReason(details, 'reason:metro')
    assert.match(renderText(renderBundleAdvisoriesTab(details)), /1\.0\.0/u)
    assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(details)), /2\.0\.0/u)
    await selectReason(details, '')
    if (managed) assert.deepEqual(managedReasons, ['', 'metro', 'run'])
    else assert.deepEqual(queries, [{ dep: ['1.0.0', '2.0.0'] }, { dep: ['1.0.0'] }, { dep: ['2.0.0'] }])
    result = { packages: {}, advisories: {} }
    await selectReason(details, 'reason:add')
    assert.match(renderText(renderBundleAdvisoriesTab(details)), /No advisories for the 0 packages in this scope/u)
  })
})

test('advisory scope control is hidden if every named reason equals all files', () => {
  const details = reasonBundle('unfiltered')
  details.bundle.reason = { run: [...details.bundle.sources.keys()] }
  assert.equal(scopeControl(renderBundleAdvisoriesTab(details)), null)
  const noReasons = reasonBundle('no-reasons')
  noReasons.bundle.reason = {}
  assert.equal(scopeControl(renderBundleAdvisoriesTab(noReasons)), null)
})

test('a late response for the old reason cannot replace the selected reason', async () => {
  const details = { ...reasonBundle('late-scope'), managedId: 'late-scope' }
  const gate = Promise.withResolvers()
  pending = gate.promise
  const oldRequest = selectReason(details, 'reason:metro')
  pending = null
  result = { packages: { dep: ['2.0.0'] }, advisories: { dep: [{ title: 'Current run vulnerability', severity: 'high' }] } }
  await selectReason(details, 'reason:run')
  gate.resolve({ packages: { dep: ['1.0.0'] }, advisories: { dep: [{ title: 'Old metro vulnerability', severity: 'high' }] } })
  await oldRequest
  const text = renderText(renderBundleAdvisoriesTab(details))
  assert.match(text, /Current run vulnerability/u)
  assert.doesNotMatch(text, /Old metro vulnerability/u)
})
