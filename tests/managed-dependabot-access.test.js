import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { appDependabotAlerts } from '../server-managed/dependabot-access.ts'
import { GithubApiError } from '../server-managed/github-errors.ts'

const config = { githubAppId: '1', githubAppPrivateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }
const ada = { id: 11, login: 'ada' }
const alert = { number: 1, state: 'dismissed', dismissed_reason: 'tolerable_risk', dependency: { package: { ecosystem: 'npm', name: 'lodash' }, manifest_path: 'package-lock.json' },
  security_advisory: { ghsa_id: 'GHSA-35jh-r3h4-6jhm', summary: 'Command Injection in lodash', identifiers: [], cwes: [] },
  security_vulnerability: { severity: 'high', vulnerable_version_range: '< 4.17.21' } }

// GitHub as the App's installations answer it: `installations` by id, each
// minting `token-<id>`, or failing with a status; the one GitHub tells the App
// is on the repository (`installed`, null for none); the account's permission
// as `permission` (null for a 404) and of whom (`userId`); and the alerts.
// What was asked noted, with the token it was asked with.
function github({ installations = { 7: 'ok' }, installed = null, permission = 'admin', userId = ada.id } = {}) {
  const asked = []
  const fetchImpl = (url, init = {}) => {
    const { pathname } = new URL(url)
    const auth = init.headers?.authorization ?? ''
    asked.push([pathname, auth.startsWith('Bearer ey') ? 'jwt' : auth.replace('Bearer ', '')])
    const minted = /^\/app\/installations\/(\d+)\/access_tokens$/u.exec(pathname)?.[1]
    if (minted) {
      return Promise.resolve(installations[minted] === 'ok' ? Response.json({ token: `token-${minted}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
        : Response.json({ message: 'Not Found' }, { status: installations[minted] ?? 404 }))
    }
    if (pathname === '/repos/org/one/installation') {
      return Promise.resolve(installed ? Response.json({ id: installed, permissions: { contents: 'read', vulnerability_alerts: 'read' } }) : Response.json({ message: 'Not Found' }, { status: 404 }))
    }
    if (pathname === '/repos/org/one') return Promise.resolve(Response.json({ id: 1, full_name: 'org/one', private: false, visibility: 'public' }))
    if (pathname === '/repos/org/one/collaborators/ada/permission') {
      return Promise.resolve(permission ? Response.json({ permission, user: { id: userId, login: 'ada' } }) : Response.json({ message: 'Not Found' }, { status: 404 }))
    }
    if (pathname === '/repos/org/one/dependabot/alerts') return Promise.resolve(Response.json([alert]))
    return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
  }
  return { asked, fetchImpl }
}
const repo = (installationId = 7) => ({ repoId: 1, fullName: 'org/one', installationId })
const asked = (calls, path) => calls.filter(([pathname]) => pathname === path).map(([, token]) => token)

test('a repository\'s alerts are read with the App\'s installation token once the admin\'s own access lets them see them on GitHub: admin, or write, maintain\'s among it', async () => {
  for (const permission of ['admin', 'write']) {
    const { asked: calls, fetchImpl } = github({ permission, installations: { 9: 'ok' } })
    const alerts = await appDependabotAlerts(config, repo(9), () => Promise.resolve(ada), fetchImpl)
    assert.deepEqual(alerts.map(({ number, dismissed }) => [number, dismissed]), [[1, { reason: 'tolerable_risk' }]], permission)
    assert.deepEqual(asked(calls, '/repos/org/one/collaborators/ada/permission'), ['token-9'], 'the access asked by the installation')
    assert.deepEqual(asked(calls, '/repos/org/one/dependabot/alerts'), ['token-9'], 'the alerts read with its token')
  }
})

test('an admin whose access doesn\'t let them see the alerts on GitHub is refused, saying theirs, and the alerts aren\'t asked', async () => {
  for (const [permission, userId, told] of [['read', ada.id, 'read'], ['triage', ada.id, 'triage'], [null, ada.id, 'none'], ['admin', 12, 'none']]) {
    const { asked: calls, fetchImpl } = github({ permission, userId })
    await assert.rejects(appDependabotAlerts(config, repo(), () => Promise.resolve(ada), fetchImpl), { message: 'dependabot-forbidden', status: 403,
      detail: `@ada's access to this repository (${told}) doesn't let them see its Dependabot alerts on GitHub, which takes write, maintain or admin` }, `${permission} of ${userId}`)
    assert.deepEqual(asked(calls, '/repos/org/one/dependabot/alerts'), [])
  }
})

test('an admin whose sign-in can\'t be verified is refused so, the alerts not asked; GitHub not reached told as it is', async () => {
  const { asked: calls, fetchImpl } = github()
  await assert.rejects(appDependabotAlerts(config, repo(), () => Promise.reject(new GithubApiError(404, 'no-repository')), fetchImpl), { message: 'dependabot-unverified', detail: /sign in again/u })
  await assert.rejects(appDependabotAlerts(config, repo(), () => Promise.reject(new GithubApiError(502, 'github-unreachable', null, 'TypeError: fetch failed')), fetchImpl),
    { message: 'github-unreachable', detail: 'TypeError: fetch failed' })
  assert.deepEqual(asked(calls, '/repos/org/one/collaborators/ada/permission'), [])
  assert.deepEqual(asked(calls, '/repos/org/one/dependabot/alerts'), [])
})

test('the installation is the one the connection keeps, else, or where that one is gone, the one GitHub tells the App of now; none, refused so', async () => {
  const unkept = github({ installed: 8, installations: { 8: 'ok' } })
  assert.equal((await appDependabotAlerts(config, repo(null), () => Promise.resolve(ada), unkept.fetchImpl)).length, 1)
  assert.deepEqual(asked(unkept.asked, '/repos/org/one/installation'), ['jwt'], 'asked of GitHub with the App\'s JWT')
  assert.deepEqual(asked(unkept.asked, '/repos/org/one/dependabot/alerts'), ['token-8'])
  const gone = github({ installed: 8, installations: { 6: 404, 8: 'ok' } })
  assert.equal((await appDependabotAlerts(config, repo(6), () => Promise.resolve(ada), gone.fetchImpl)).length, 1)
  assert.deepEqual(asked(gone.asked, '/repos/org/one/dependabot/alerts'), ['token-8'], 'the kept one gone')
  const none = github({ installed: null })
  await assert.rejects(appDependabotAlerts(config, repo(null), () => Promise.resolve(ada), none.fetchImpl), { message: 'dependabot-not-installed', detail: /install it there/u })
  assert.deepEqual(asked(none.asked, '/repos/org/one/collaborators/ada/permission'), [])
})
