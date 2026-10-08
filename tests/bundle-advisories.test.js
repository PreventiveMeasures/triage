import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { store } from '@rray/frontend/state-management'
import { createBundleMetadata, parseBundleMetadata } from '../common/bundle-metadata.js'

const state = { managedSession: { id: 'alice', role: 'view', csrfToken: 'session' }, managedTeams: [], currentManagedTeam: 'team' }
let allowed = false, detailRequests = [], managedCalls = [], managedReasons = [], openedDetails = [], openedWhy = [], pending = null, repositoryChecks = [], result
mock.module('../ui/view/dialogs/advisory-details-dialog.js', { namedExports: { openAdvisoryDetailsDialog: props => { openedDetails.push(props) } } })
mock.module('../ui/view/dialogs/why-dialog.js', { namedExports: { openWhyDialog: props => { openedWhy.push(props) } } })
mock.module('../client/index.js', { namedExports: { state } })
mock.module('../ui/view/ingest.js', { namedExports: { bundleKind: name => name.endsWith('.br') ? 'stasis' : 'sourcemap' } })
mock.module('../ui/view/client-managed.js', { namedExports: { fetchBundleAdvisories: (id, _team, reason, repoAdvisories, details) => {
  managedCalls.push(id)
  managedReasons.push(reason)
  repositoryChecks.push(repoAdvisories)
  detailRequests.push(details)
  return pending ?? Promise.resolve(result)
} } })
const { ensureBundleAdvisories, grantAdvisoriesProxyConsent, recheckBundleAdvisories, renderBundleAdvisoriesTab, retryBundleAdvisories, showAdvisoriesTab } = await import('../ui/view/render-bundle-advisories.js')
function renderText(value) {
  if (value?.strings && value?.values) return value.strings.map((text, i) => text + renderText(value.values[i])).join('')
  if (Array.isArray(value)) return value.map(renderText).join('')
  return value == null || typeof value === 'symbol' ? '' : String(value)
}
function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}
beforeEach(t => {
  managedCalls = []; managedReasons = []; repositoryChecks = []; detailRequests = []; openedDetails = []; openedWhy = []; allowed = false; pending = null
  state.managedSession = { id: 'alice', role: 'view', csrfToken: 'session' }
  state.currentManagedTeam = 'team'
  state.managedTeams = [{ id: 'team', permissions: { security: true, dependencies: false }, bundles: [{ id: 'bundle-id' }] }]
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
        url: 'https://osv.dev/vulnerability/RUSTSEC-2026-0001',
        informational: 'unmaintained', versions: ['0.4.22'] },
      { ecosystem: 'npm', name: 'log', source: 'registry', id: 'GHSA-2345-6789-cfgh', ghsa: 'GHSA-2345-6789-cfgh',
        url: 'https://github.com/advisories/GHSA-2345-6789-cfgh',
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

test('advisory links preserve upstream URLs and logos identify the source independently of the destination', async () => {
  const details = { managedId: 'advisory-origins', integrity: 'advisory-origins', kind: 'stasis' }
  const ghsa = 'GHSA-2345-6789-cfgh'
  const rows = [
    { source: 'registry', url: `https://github.com/advisories/${ghsa}`, label: 'Source: npm registry' },
    { source: 'repository', url: `https://github.com/org/dep/security/advisories/${ghsa}`, label: 'Source: GitHub repository' },
    { source: 'osv', url: `https://github.com/advisories/${ghsa}`, label: 'Source: OSV' },
    { source: 'osv', url: 'https://osv.dev/vulnerability/RUSTSEC-2026-0001', label: 'Source: OSV' },
  ]
  result = { packages: [], advisories: rows.map((row, i) => ({ ecosystem: 'npm', name: `dep-${i}`, id: ghsa, ghsa,
    title: `Advisory ${i}`, severity: 'high', source: row.source, url: row.url })) }
  await ensureBundleAdvisories(details, () => {})
  const text = renderText(renderBundleAdvisoriesTab(details))
  const rendered = text.match(/<li class="bundle-advisory-row">.*?<\/li>/gsu)
  assert.equal(rendered.length, rows.length)
  for (const [i, row] of rows.entries()) {
    assert.ok(rendered[i].includes(`href=${row.url}`), 'use the supplied URL unchanged')
    assert.ok(rendered[i].includes(`role="img" aria-label=${row.label}`))
  }
  assert.doesNotMatch(text, /\btitle=/u)
})

test('missing or unsafe upstream URLs never produce synthesized advisory links', async () => {
  for (const [i, url] of [undefined, 'javascript:alert(1)'].entries()) {
    const details = { managedId: `missing-url-${i}`, integrity: `missing-url-${i}`, kind: 'stasis' }
    result = { packages: [], advisories: [{ ecosystem: 'npm', name: 'dep', source: 'registry', id: 'GHSA-2345-6789-cfgh',
      ghsa: 'GHSA-2345-6789-cfgh', title: 'Advisory without a safe link', severity: 'high', url }] }
    await ensureBundleAdvisories(details, () => {})
    const text = renderText(renderBundleAdvisoriesTab(details))
    assert.match(text, /Source: npm registry/u)
    assert.doesNotMatch(text, /<a class="bundle-advisory-ghsa"/u)
  }
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

test('managed advisory tabs follow the current team security grant and bundle membership', () => {
  const entry = { managedId: 'bundle-id', integrity: 'hash', name: 'bundle.br' }
  const team = state.managedTeams[0]
  state.managedTeams.push({ id: 'other', permissions: { security: true }, bundles: [{ id: entry.managedId }] })
  for (const role of ['view', 'triage']) {
    state.managedSession.role = role
    for (const dependencies of [false, true]) {
      team.permissions = { dependencies, security: false }
      assert.equal(showAdvisoriesTab(entry, null), false, 'another team cannot override the selected team')
      team.permissions.security = true
      assert.equal(showAdvisoriesTab(entry, null), true, 'security access does not require dependency access')
    }
  }
  state.currentManagedTeam = null
  team.permissions.security = false
  assert.equal(showAdvisoriesTab(entry, null), true, 'unscoped reads accept a grant from a team containing the bundle')
  state.managedTeams[1].bundles = [{ id: 'unrelated' }]
  assert.equal(showAdvisoriesTab(entry, null), false)
  state.currentManagedTeam = 'missing'
  team.permissions.security = true
  assert.equal(showAdvisoriesTab(entry, null), false)
  state.currentManagedTeam = 'team'
  delete team.permissions
  assert.equal(showAdvisoriesTab(entry, null), false, 'missing permissions do not expose the tab')
})

test('public advisory tabs use share permissions; managers retain access outside teams', () => {
  const entry = { managedId: 'bundle-id', integrity: 'hash', name: 'bundle.br' }
  state.managedSession.publicShare = true
  for (const security of [false, true]) {
    state.managedTeams[0].permissions.security = security
    assert.equal(showAdvisoriesTab(entry, null), security)
  }
  state.managedTeams = []
  state.currentManagedTeam = null
  for (const role of ['admin', 'manage', 'view', 'triage', 'none', 'unknown']) {
    state.managedSession = { role }
    assert.equal(showAdvisoriesTab(entry, null), ['admin', 'manage'].includes(role))
  }
  state.managedSession = null
  assert.equal(showAdvisoriesTab(entry, null), false)
  assert.equal(showAdvisoriesTab({ ...entry, managedId: undefined }, null), true, 'local bundles keep their existing visibility')
  state.managedSession = { role: 'admin' }
  assert.equal(showAdvisoriesTab({ ...entry, name: 'bundle.map' }, null), false)
})

test('skipped dependencies remain visible when none of the bundle could be audited', async () => {
  const details = { managedId: 'skipped-bundle', integrity: 'skipped-bundle', kind: 'stasis' }
  result = { packages: [], advisories: [], skipped: [
    { ecosystem: 'composer', name: 'vendor/pkg', version: 'dev-main', because: 'Composer dev versions cannot be matched against release advisories.' },
    { ecosystem: 'cargo-git', name: 'private-crate', version: '1.0.0', because: 'Crate vendored from git; its identity is not a crates.io package.' },
  ] }
  await ensureBundleAdvisories(details, () => {})
  const text = renderText(renderBundleAdvisoriesTab(details))
  assert.match(text, /No packages could be audited/u)
  assert.match(text, /Not audited/u)
  assert.match(text, /composer:vendor\/pkg@dev-main/u)
  assert.match(text, /cargo-git:private-crate@1\.0\.0/u)
  assert.match(text, /cannot be matched against release advisories/u)
  assert.doesNotMatch(text, /No advisories/u)
  assert.match(text, /\?disabled=true/u)
  await recheckBundleAdvisories(details, () => {})
  assert.equal(managedCalls.length, 1, 'no repository lookup when every dependency was skipped')
})

test('managed advisories offer Validate right of the recheck button only when the viewer can scan', async () => {
  const details = { managedId: 'scan-bundle', integrity: 'scan-bundle', kind: 'stasis' }
  await ensureBundleAdvisories(details, () => {})
  assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(details)), /bundle-advisories-scan/u)
  let scans = 0
  const tab = renderBundleAdvisoriesTab(details, () => {}, () => { scans++ })
  assert.match(renderText(tab), /Recheck against repositories\s*<\/button>\s*<button type="button" class="bundle-advisories-retry bundle-advisories-scan"[^>]*>.*<span>Validate<\/span>/su)
  const validate = templates(tab).find(part => part.strings[0].includes('bundle-advisories-scan'))
  assert.doesNotMatch(validate.strings.join(''), /tooltip|title=/u, 'the button needs no tooltip')
  validate.values.find(value => typeof value === 'function')()
  assert.equal(scans, 1)
  const local = { integrity: 'local-scan', kind: 'stasis', bundle: { modules: new Map() } }
  assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(local, () => {}, () => {})), /bundle-advisories-scan/u)
})

test('repository recheck button shows a busy state, prevents duplicate requests and replaces results on completion', async () => {
  const details = { managedId: 'recheck-bundle', integrity: 'recheck-bundle', kind: 'stasis' }
  let renders = 0
  await ensureBundleAdvisories(details, () => {})
  assert.match(renderText(renderBundleAdvisoriesTab(details)), /Recheck against repositories/u)
  const gate = Promise.withResolvers()
  pending = gate.promise
  const checking = recheckBundleAdvisories(details, () => { renders++ })
  assert.equal(renders, 1, 'busy state renders before the request completes')
  const busy = renderText(renderBundleAdvisoriesTab(details))
  assert.match(busy, /Rechecking…/u)
  assert.match(busy, /aria-busy=true/u)
  assert.match(busy, /\?disabled=true/u)
  assert.match(busy, /Public vulnerability/u, 'existing results remain readable during the recheck')
  await recheckBundleAdvisories(details, () => {})
  assert.deepEqual(repositoryChecks, [false, true])
  assert.deepEqual(detailRequests, [false, true], 'only the explicit recheck requests full text')
  gate.resolve({ packages: [{ ecosystem: 'npm', name: 'dep', versions: ['1.0.0'] }], skipped: [], advisories: [
    { ecosystem: 'npm', name: 'dep', source: 'repository', id: 'GHSA-2345-6789-cfgh', ghsa: 'GHSA-2345-6789-cfgh', versions: ['1.0.0'], title: 'Maintainer vulnerability', details: '# Impact\n\nFull advisory text.' },
  ] })
  await checking
  const done = renderText(renderBundleAdvisoriesTab(details))
  assert.match(done, /Maintainer vulnerability/u)
  assert.match(done, /class="bundle-advisory-title" aria-haspopup="dialog"/u)
  assert.doesNotMatch(done, /<advisory-details|<summary>Details/u)
  const title = templates(renderBundleAdvisoriesTab(details)).find(part => part.strings[0].includes('class="bundle-advisory-title"'))
  title.values.find(value => typeof value === 'function')()
  assert.equal(openedDetails.length, 1)
  assert.equal(openedDetails[0].heading, 'Maintainer vulnerability')
  assert.equal(openedDetails[0].severity, 'unknown')
  assert.equal(openedDetails[0].markdown, '# Impact\n\nFull advisory text.')
  assert.equal(openedDetails[0].isCurrent(), true)
  state.managedTeams = store(state.managedTeams)
  assert.equal(openedDetails[0].isCurrent(), true, 'reactive wrapping is not a team change')
  assert.doesNotMatch(done, /Public vulnerability|Rechecking…/u)
  assert.match(done, /aria-busy=false/u)
  assert.match(done, /\?disabled=false/u)
  assert.equal(renders, 2)
  state.currentManagedTeam = 'different-team'
  assert.equal(openedDetails[0].isCurrent(), false, 'open details lose validity when their scope changes')
})

test('empty or missing advisory details keep the title as plain text', async () => {
  const details = { managedId: 'empty-details', integrity: 'empty-details', kind: 'stasis' }
  result = { packages: [], advisories: [undefined, null, '', ' \n', 42].map((text, i) => ({
    ecosystem: 'npm', name: `dep-${i}`, title: 'No description', details: text,
  })) }
  await ensureBundleAdvisories(details, () => {})
  const text = renderText(renderBundleAdvisoriesTab(details))
  assert.match(text, /<span class="bundle-advisory-title">No description/u)
  assert.doesNotMatch(text, /aria-haspopup="dialog"|<advisory-details/u)
})

test('failed repository rechecks preserve results and can be retried with the same button', async () => {
  const details = { managedId: 'retry-recheck', integrity: 'retry-recheck', kind: 'stasis' }
  await ensureBundleAdvisories(details, () => {})
  pending = Promise.reject(new Error('upstream-unavailable'))
  await recheckBundleAdvisories(details, () => {})
  const failed = renderText(renderBundleAdvisoriesTab(details))
  assert.match(failed, /Repository recheck failed: upstream-unavailable/u)
  assert.match(failed, /Public vulnerability/u)
  assert.match(failed, /aria-busy=false/u)
  pending = null
  await recheckBundleAdvisories(details, () => {})
  assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(details)), /Repository recheck failed/u)
  assert.deepEqual(repositoryChecks, [false, true, true])
})

test('repository rechecks discard prior results when bundle or security access is revoked', async () => {
  const details = { managedId: 'revoked-recheck', integrity: 'revoked-recheck', kind: 'stasis' }
  await ensureBundleAdvisories(details, () => {})
  pending = Promise.reject(Object.assign(new Error('Security access required'), { status: 403 }))
  await recheckBundleAdvisories(details, () => {})
  const text = renderText(renderBundleAdvisoriesTab(details))
  assert.match(text, /Security access required/u)
  assert.doesNotMatch(text, /Public vulnerability|Previous results are shown/u)
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
  assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(local)), /Recheck against repositories/u)
  await recheckBundleAdvisories(local, () => {})
  assert.equal(calls.length, 1, 'the repository action is managed-only')
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
  assert.match(text, /Source: npm registry/u)
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

test('each advisory version opens its exact dependency chains in the current scope', async () => {
  const details = { ...reasonBundle('version-chains'), managedId: 'version-chains' }
  result = { packages: [{ ecosystem: 'npm', name: 'dep', versions: ['1.0.0', '2.0.0'] }],
    advisories: [{ ecosystem: 'npm', name: 'dep', title: 'Issue', severity: 'high' }] }
  await ensureBundleAdvisories(details, () => {})
  const versions = () => templates(renderBundleAdvisoriesTab(details)).filter(template => template.strings.join('').includes('class="bundle-advisories-version"'))
  for (const template of versions()) template.values.find(value => typeof value === 'function')()
  assert.deepEqual(openedWhy.map(props => props.version), ['1.0.0', '2.0.0'])
  assert.equal(openedWhy[0].details, details)
  assert.equal(openedWhy[0].packageKey, 'dep')
  assert.equal(openedWhy[0].reason, '')
  assert.equal(openedWhy[0].isCurrent(), true)
  await selectReason(details, 'reason:run')
  assert.equal(openedWhy[0].isCurrent(), false)
  versions()[0].values.find(value => typeof value === 'function')()
  assert.equal(openedWhy.at(-1).reason, 'run')
  assert.equal(openedWhy.at(-1).isCurrent(), true)
  state.currentManagedTeam = 'another-team'
  assert.equal(openedWhy.at(-1).isCurrent(), false)
  assert.equal(managedCalls.length, 2, 'opening versions does not fetch bundle source or advisories')
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

test('repository rechecks and skipped lists stay scoped when the selected reason changes', async () => {
  const details = { ...reasonBundle('recheck-scopes'), managedId: 'recheck-scopes' }
  result = { ...result, skipped: [{ ecosystem: 'composer', name: 'metro/pkg', version: 'dev-main', because: 'Not a release.' }] }
  await selectReason(details, 'reason:metro')
  const gate = Promise.withResolvers()
  pending = gate.promise
  const checking = recheckBundleAdvisories(details, () => {})
  pending = null
  result = { packages: [], advisories: [], skipped: [{ ecosystem: 'cargo-git', name: 'run-crate', version: '1.0.0', because: 'Git crate.' }] }
  await selectReason(details, 'reason:run')
  gate.resolve({ packages: [{ ecosystem: 'npm', name: 'dep', versions: ['1.0.0'] }], advisories: [],
    skipped: [{ ecosystem: 'composer', name: 'metro/pkg', version: 'dev-main', because: 'Not a release.' }] })
  await checking
  const text = renderText(renderBundleAdvisoriesTab(details))
  assert.match(text, /run-crate/u)
  assert.doesNotMatch(text, /metro\/pkg|Rechecking…/u)
  assert.deepEqual(managedReasons, ['metro', 'metro', 'run'])
  assert.deepEqual(repositoryChecks, [false, true, false])
})

test('a late repository recheck cannot repopulate results after the managed identity changes', async () => {
  const details = { managedId: 'recheck-session', integrity: 'recheck-session', kind: 'stasis' }
  await ensureBundleAdvisories(details, () => {})
  const gate = Promise.withResolvers()
  pending = gate.promise
  const checking = recheckBundleAdvisories(details, () => {})
  state.managedSession = { id: 'different-viewer', role: 'view', csrfToken: 'different-session' }
  assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(details)), /Public vulnerability/u)
  gate.resolve(result)
  await checking
  assert.doesNotMatch(renderText(renderBundleAdvisoriesTab(details)), /Public vulnerability/u)
})
