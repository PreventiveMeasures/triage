import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

const state = { managedSession: { id: 'alice', role: 'view', csrfToken: 'session' }, managedTeams: [], currentManagedTeam: 'team' }
let allowed = false, managedCalls = [], pending = null, result
mock.module('../client/index.js', { namedExports: { state } })
mock.module('../ui/view/ingest.js', { namedExports: { bundleKind: name => name.endsWith('.br') ? 'stasis' : 'sourcemap' } })
mock.module('../ui/view/client-managed.js', { namedExports: { fetchBundleAdvisories: id => {
  managedCalls.push(id)
  return pending ?? Promise.resolve(result)
} } })
const { ensureBundleAdvisories, grantAdvisoriesProxyConsent, renderBundleAdvisoriesTab, retryBundleAdvisories, showAdvisoriesTab } = await import('../ui/view/render-bundle-advisories.js')
function renderText(value) {
  if (value?.strings && value?.values) return value.strings.map((text, i) => text + renderText(value.values[i])).join('')
  if (Array.isArray(value)) return value.map(renderText).join('')
  return value == null || typeof value === 'symbol' ? '' : String(value)
}
beforeEach(t => {
  managedCalls = []; allowed = false; pending = null
  state.managedTeams = []
  result = { packages: { dep: ['1.0.0'] }, advisories: { dep: [{ title: 'Public vulnerability', severity: 'high', url: 'https://example.com/advisory' }] } }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => allowed ? '1' : null, setItem: () => { allowed = true } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage })
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
