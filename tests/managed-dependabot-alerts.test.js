import assert from 'node:assert/strict'
import { test } from 'node:test'
import { alertVersions, dependabotAlerts } from '../server-managed/dependabot-alerts.ts'

// An alert as GitHub answers one, of npm's `name` in `manifest`, its advisory `ghsa`.
const raw = (number, name, ghsa, more = {}) => ({
  number, state: 'open', html_url: `https://github.com/org/one/security/dependabot/${number}`,
  dependency: { package: { ecosystem: 'npm', name }, manifest_path: 'package-lock.json', scope: 'runtime', relationship: 'transitive' },
  security_advisory: { ghsa_id: ghsa, cve_id: 'CVE-2021-23337', summary: 'Command Injection in lodash', severity: 'high',
    identifiers: [{ type: 'GHSA', value: ghsa }, { type: 'CVE', value: 'CVE-2021-23337' }], cwes: [{ cwe_id: 'CWE-77', name: 'Command injection' }] },
  security_vulnerability: { package: { ecosystem: 'npm', name }, severity: 'high', vulnerable_version_range: '< 4.17.21', first_patched_version: { identifier: '4.17.21' } },
  ...more,
})

// A fetch answering each request in turn from `answers`, each `{ status,
// body, headers }`, noting what was asked and with which token.
function github(answers) {
  const asked = []
  const fetchImpl = (url, init) => {
    asked.push({ url: String(url), authorization: init.headers.authorization, redirect: init.redirect })
    const { status = 200, body = [], headers = {} } = answers[asked.length - 1] ?? {}
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }))
  }
  return { asked, fetchImpl }
}

test('a repository\'s open Dependabot alerts of npm\'s are asked a page of 100 at a time, each by the cursor the one before names, with the user\'s token', async () => {
  const next = '<https://api.github.com/repositories/1/dependabot/alerts?state=open&ecosystem=npm&per_page=100&after=Y3Vyc29yOjI%3D>; rel="next"'
  const { asked, fetchImpl } = github([
    { body: [raw(1, 'lodash', 'GHSA-35jh-r3h4-6jhm'), raw(2, 'minimist', 'GHSA-xvch-5gv4-984h', { dependency: { package: { ecosystem: 'npm', name: 'minimist' },
      manifest_path: 'web/package.json', scope: 'development' }, security_vulnerability: { severity: 'medium', vulnerable_version_range: '>= 1.0.0, < 1.2.6' } })],
    headers: { link: next } },
    { body: [raw(3, 'debug', 'GHSA-gxpj-cx7g-858c')], headers: { link: '<https://api.github.com/repositories/1/dependabot/alerts?after=Y3Vyc29yOjI%3D>; rel="prev"' } },
  ])
  const alerts = await dependabotAlerts('org/one', 'user-token', fetchImpl)
  assert.deepEqual(asked.map(({ url }) => url), [
    'https://api.github.com/repos/org/one/dependabot/alerts?state=open&ecosystem=npm&per_page=100',
    'https://api.github.com/repos/org/one/dependabot/alerts?state=open&ecosystem=npm&per_page=100&after=Y3Vyc29yOjI%3D',
  ], 'the next page\'s cursor alone taken of its link, the repository asked by its name')
  assert.ok(asked.every(({ authorization, redirect }) => authorization === 'Bearer user-token' && redirect === 'error'))
  assert.deepEqual(alerts[0], { number: 1, url: 'https://github.com/org/one/security/dependabot/1', manifest: 'package-lock.json', name: 'lodash',
    ghsa: 'GHSA-35jh-r3h4-6jhm', aliases: ['CVE-2021-23337'], title: 'Command Injection in lodash', severity: 'high', range: '< 4.17.21', patched: '4.17.21', cwe: ['CWE-77'] })
  assert.deepEqual([alerts[1].manifest, alerts[1].severity, alerts[1].range, alerts[1].dev], ['web/package.json', 'moderate', '>= 1.0.0, < 1.2.6', true], 'GitHub\'s medium is moderate')
  assert.deepEqual(alerts.map(alert => alert.number), [1, 2, 3])
})

test('an alert that isn\'t an open one of npm\'s package and a GHSA, at a path git would take, is left out', async () => {
  const of = (more, advisory = {}) => raw(9, 'lodash', 'GHSA-35jh-r3h4-6jhm', { ...more, ...Object.keys(advisory).length > 0
    ? { security_advisory: { ...raw(9, 'lodash', 'GHSA-35jh-r3h4-6jhm').security_advisory, ...advisory } } : {} })
  const dependency = (manifest, name = 'lodash', ecosystem = 'npm') => ({ dependency: { package: { ecosystem, name }, manifest_path: manifest } })
  const { fetchImpl } = github([{ body: [
    of({ state: 'dismissed' }), of({ number: 0 }), of(dependency('package-lock.json', 'lodash', 'pip')), of(dependency('package-lock.json', '../lodash')),
    of(dependency('../package-lock.json')), of(dependency('/package-lock.json')), of(dependency('web//package-lock.json')), of(dependency('a\u0007/package-lock.json')),
    of({}, { ghsa_id: 'GHSA-../..-xxxx' }), of({}, { ghsa_id: 'CVE-2021-23337' }), null, 'alert',
    of({ number: 7 }), of({ number: 7 }),
  ] }])
  assert.deepEqual((await dependabotAlerts('org/one', 'token', fetchImpl)).map(alert => alert.number), [7], 'and one GitHub answers twice, once')
})

test('alerts that can\'t be had are thrown as why, never GitHub\'s text: off, not to be seen, a rate limit, GitHub not reached', async () => {
  const failing = (status, message, headers = {}) => github([{ status, body: { message }, headers }]).fetchImpl
  await assert.rejects(dependabotAlerts('org/one', 'token', failing(403, 'Dependabot alerts are disabled for this repository.')), { message: 'dependabot-disabled', status: 403 })
  await assert.rejects(dependabotAlerts('org/one', 'token', failing(403, 'Resource not accessible by integration')), { message: 'dependabot-forbidden' })
  await assert.rejects(dependabotAlerts('org/one', 'token', failing(404, 'Not Found')), { message: 'dependabot-forbidden' }, 'the repository found just before')
  await assert.rejects(dependabotAlerts('org/one', 'token', failing(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0' })), { message: 'github-rate-limited' })
  await assert.rejects(dependabotAlerts('org/one', 'token', failing(403, 'You have exceeded a secondary rate limit')), { message: 'github-rate-limited' })
  await assert.rejects(dependabotAlerts('org/one', 'token', failing(401, 'Bad credentials')), { message: 'github-unauthorized' })
  await assert.rejects(dependabotAlerts('org/one', 'token', github([{ body: { alerts: [] } }]).fetchImpl), { message: 'github-malformed' })
  await assert.rejects(dependabotAlerts('org/one', 'token', () => Promise.reject(new TypeError('fetch failed'))), { message: 'github-unreachable', detail: /^TypeError: fetch failed, after/u })
  const { asked, fetchImpl } = github([])
  await assert.rejects(dependabotAlerts('org/one', null, fetchImpl), { message: 'dependabot-forbidden' })
  assert.equal(asked.length, 0, 'none asked without a token')
})

test('a next page another host names, or of no cursor, isn\'t asked', async () => {
  for (const link of ['<https://evil.example/repos/org/one/dependabot/alerts?after=x>; rel="next"', '<https://api.github.com/repos/org/one/dependabot/alerts>; rel="next"']) {
    const { asked, fetchImpl } = github([{ body: [raw(1, 'lodash', 'GHSA-35jh-r3h4-6jhm')], headers: { link } }, { body: [raw(2, 'debug', 'GHSA-gxpj-cx7g-858c')] }])
    assert.deepEqual((await dependabotAlerts('org/one', 'token', fetchImpl)).map(alert => alert.number), [1])
    assert.equal(asked.length, 1)
  }
})

test('an alert\'s versions are those of its package its lockfile locks that its range, GitHub\'s, covers', () => {
  const packages = [{ name: 'minimist', version: '0.0.8', source: 'registry' }, { name: 'minimist', version: '1.2.5', source: 'registry', dev: true },
    { name: 'minimist', version: '1.2.8', source: 'registry' }, { name: 'minimist', version: '1.0.0', source: 'git' }, { name: 'other', version: '1.2.5', source: 'registry' },
    { name: 'minimist', version: '1.1.0', source: 'mirror', integrity: 'sha512-x' }]
  assert.deepEqual(alertVersions({ name: 'minimist', range: '>= 1.0.0, < 1.2.6' }, packages), ['1.2.5', '1.1.0'])
  assert.deepEqual(alertVersions({ name: 'minimist', range: '< 0.2.4' }, packages), ['0.0.8'])
  assert.deepEqual(alertVersions({ name: 'minimist', range: '= 1.2.8' }, packages), ['1.2.8'])
  assert.deepEqual(alertVersions({ name: 'minimist', range: '>= 1.0.0, < 1.2.6' }, undefined), [], 'of no lockfile read')
  assert.deepEqual(alertVersions({ name: 'minimist' }, packages), [], 'of no range')
  assert.deepEqual(alertVersions({ name: 'minimist', range: 'not a range' }, packages), [])
})
