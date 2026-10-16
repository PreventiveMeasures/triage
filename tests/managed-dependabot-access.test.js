import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { appDependabotAlerts } from '../server-managed/dependabot-access.ts'
import { GithubApiError } from '../server-managed/github-errors.ts'

const config = { githubAppId: '1', githubAppPrivateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }
const ada = { id: 11, login: 'ada' }
const repo = { repoId: 1, fullName: 'org/one', installationId: 7 }
const alert = { number: 1, state: 'dismissed', dismissed_reason: 'tolerable_risk', dependency: { package: { ecosystem: 'npm', name: 'lodash' }, manifest_path: 'package-lock.json' },
  security_advisory: { ghsa_id: 'GHSA-35jh-r3h4-6jhm', summary: 'Command Injection in lodash', identifiers: [], cwes: [] },
  security_vulnerability: { severity: 'high', vulnerable_version_range: '< 4.17.21' } }

// GitHub as the App answers it: the installation it tells the App is on the
// repository (`installed`, null for none), minting `token-<id>`, then
// `token-<id>.<n>` as minted again; the account's
// permission (`permission`, null for a 404) and of whom (`userId`); and the
// alerts. What was asked noted, with the token it was asked with.
function github({ installed = null, permission = 'admin', userId = ada.id } = {}) {
  const asked = [], minted = new Map()
  const fetchImpl = (url, init = {}) => {
    const { pathname } = new URL(url)
    const auth = init.headers?.authorization ?? ''
    asked.push([pathname, auth.startsWith('Bearer ey') ? 'jwt' : auth.replace('Bearer ', '')])
    const answer = (body, status = 200) => Promise.resolve(Response.json(body, { status }))
    if (/^\/app\/installations\/\d+\/access_tokens$/u.test(pathname)) {
      const id = pathname.split('/')[3], n = (minted.get(id) ?? 0) + 1
      minted.set(id, n)
      return answer({ token: n === 1 ? `token-${id}` : `token-${id}.${n}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    }
    if (pathname === '/repos/org/one/installation') return installed ? answer({ id: installed, permissions: { contents: 'read' } }) : answer({ message: 'Not Found' }, 404)
    if (pathname === '/repos/org/one') return answer({ id: 1, full_name: 'org/one', private: false, visibility: 'public' })
    if (pathname === '/repos/org/one/collaborators/ada/permission') return permission ? answer({ permission, user: { id: userId, login: 'ada' } }) : answer({ message: 'Not Found' }, 404)
    if (pathname === '/repos/org/one/dependabot/alerts') return answer([alert])
    return answer({ message: 'Not Found' }, 404)
  }
  return { asked, fetchImpl }
}
// A repository's reader (repository-browser.ts): its installation's token, null
// where it has none, the user's identity, and their permission level where its
// gate asked it.
const readerOf = ({ token = 'reader-token', identity = Promise.resolve(ada), permission = null } = {}) => ({
  installationToken: () => Promise.resolve(token), identity: () => identity, permission: () => permission })
const tokensFor = (asked, path) => asked.filter(([pathname]) => pathname === path).map(([, token]) => token)
const ALERTS = '/repos/org/one/dependabot/alerts', PERMISSION = '/repos/org/one/collaborators/ada/permission'

test('a repository\'s alerts are read with its installation\'s token once the admin\'s own access lets them see them on GitHub: admin, or write, maintain\'s among it', async () => {
  for (const permission of ['admin', 'write']) {
    const { asked, fetchImpl } = github({ permission })
    const { alerts } = await appDependabotAlerts(config, repo, readerOf(), fetchImpl)
    assert.deepEqual(alerts.map(({ number, dismissed }) => [number, dismissed]), [[1, { reason: 'tolerable_risk' }]], permission)
    assert.deepEqual([tokensFor(asked, PERMISSION), tokensFor(asked, ALERTS)], [['token-7'], ['token-7']], 'the access asked by the reader\'s installation, the alerts read with its token')
  }
  const { asked, fetchImpl } = github({ permission: 'read' })
  assert.equal((await appDependabotAlerts(config, repo, readerOf({ permission: 'admin' }), fetchImpl)).alerts.length, 1)
  assert.deepEqual(tokensFor(asked, PERMISSION), [], 'the level the reader\'s gate asked of a private repository used, not asked again')
})

test('an admin whose access doesn\'t let them see the alerts on GitHub is refused, saying theirs, and the alerts aren\'t asked', async () => {
  for (const [permission, userId, told] of [['read', ada.id, 'read'], ['triage', ada.id, 'triage'], [null, ada.id, 'none'], ['admin', 12, 'none']]) {
    const { asked, fetchImpl } = github({ permission, userId })
    await assert.rejects(appDependabotAlerts(config, repo, readerOf(), fetchImpl), { message: 'dependabot-forbidden', status: 403,
      detail: `@ada's access to this repository (${told}) doesn't let them see its Dependabot alerts on GitHub` }, `${permission} of ${userId}`)
    assert.deepEqual(tokensFor(asked, ALERTS), [])
  }
})

test('an admin whose sign-in can\'t be verified is refused so, nothing more asked; GitHub failing to answer told as it is', async () => {
  const { asked, fetchImpl } = github()
  for (const code of ['no-repository', 'github-unauthorized']) {
    await assert.rejects(appDependabotAlerts(config, repo, readerOf({ identity: Promise.reject(new GithubApiError(404, code)) }), fetchImpl), { message: 'dependabot-unverified' }, code)
  }
  for (const failed of [new GithubApiError(502, 'github-unreachable', null, 'TypeError: fetch failed'), new GithubApiError(502, 'github-status-500'),
    new GithubApiError(502, 'github-malformed'), new GithubApiError(429, 'github-rate-limited', 60)]) {
    await assert.rejects(appDependabotAlerts(config, repo, readerOf({ identity: Promise.reject(failed) }), fetchImpl), failed, failed.message)
  }
  assert.deepEqual([tokensFor(asked, PERMISSION), tokensFor(asked, ALERTS)], [[], []])
})

test('where the reader has no installation\'s token, the one GitHub tells the App of now is used; none, refused so', async () => {
  const unkept = github({ installed: 8 })
  assert.equal((await appDependabotAlerts(config, repo, readerOf({ token: null }), unkept.fetchImpl)).alerts.length, 1)
  assert.deepEqual(tokensFor(unkept.asked, '/repos/org/one/installation'), ['jwt'], 'asked with the App\'s JWT')
  assert.deepEqual(tokensFor(unkept.asked, ALERTS), ['token-8'])
  const none = github({ installed: null })
  await assert.rejects(appDependabotAlerts(config, repo, readerOf({ token: null }), none.fetchImpl), { message: 'dependabot-not-installed' })
  assert.deepEqual(tokensFor(none.asked, PERMISSION), [])
})

test('access to the alerts is checked again before they are told, asked of GitHub afresh, never as the reader kept it: withdrawn since, refused so', async () => {
  let permission = 'admin'
  const { asked, fetchImpl } = github()
  const counted = (url, init) => {
    if (new URL(url).pathname === PERMISSION) return Promise.resolve(Response.json({ permission, user: { id: ada.id, login: 'ada' } }))
    return fetchImpl(url, init)
  }
  const read = await appDependabotAlerts(config, repo, readerOf({ permission: 'admin' }), counted)
  await read.recheck()
  permission = 'read'
  await assert.rejects(read.recheck(), { message: 'dependabot-forbidden', detail: /\(read\)/u })
  assert.deepEqual(tokensFor(asked, ALERTS), ['token-7'], 'the alerts read once')
})

test('the recheck asks with the installation\'s token as it is then, renewed where the one the alerts were read with has been since', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const { asked, fetchImpl } = github()
  const read = await appDependabotAlerts(config, repo, readerOf(), fetchImpl)
  t.mock.timers.tick(60 * 60_000)
  await read.recheck()
  assert.deepEqual([tokensFor(asked, ALERTS), tokensFor(asked, PERMISSION)], [['token-7'], ['token-7', 'token-7.2']], 'read with one, rechecked an hour on with another')
})
