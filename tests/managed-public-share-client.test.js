import assert from 'node:assert/strict'
import { test } from 'node:test'

const token = 'A'.repeat(43)
globalThis.location = new URL(`https://triage.test/teams/team#public=team.${token}`)
let onHashChange
globalThis.addEventListener = (event, listener) => { if (event === 'hashchange') onHashChange = listener }
const { parsePublicShare } = await import('../client/managed/public-share.js')
const { managedFetch } = await import('../client/managed/request.js')
const { probeSession, probeTeams } = await import('../client/managed/session.js')

test('public link parsing separates capabilities from ordinary and malformed links', () => {
  assert.equal(parsePublicShare('#share=encrypted-e2e-link'), null)
  assert.equal(parsePublicShare(''), null)
  assert.deepEqual(parsePublicShare(`#public=team.${token}`), { teamId: 'team', token })
  for (const hash of ['#public=', '#public=team.wrong', `#public=../other.${token}`]) {
    assert.deepEqual(parsePublicShare(hash), { teamId: '', token: '' }, 'malformed links cannot fall back to cookie auth')
  }
})

test('public reads send a header without cookies and refuse cross-origin requests or redirects', async t => {
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, '/api/teams/team/reports')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.headers.get('x-deepview-share'), token)
    assert.equal(options.headers.get('accept'), 'application/json')
    return Promise.resolve(Response.json({ reports: [] }))
  })
  await managedFetch('/api/teams/team/reports', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  await assert.rejects(managedFetch('https://elsewhere.test/api/teams/team/reports'), /same-origin/u)
  await assert.rejects(managedFetch('//elsewhere.test/api/teams/team/reports'), /same-origin/u)
})

test('public startup uses only scoped bootstrap and clears revoked access without a login probe', async t => {
  let revoked = false
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, '/api/teams/team/shared')
    assert.equal(options.headers.get('x-deepview-share'), token)
    return Promise.resolve(revoked ? Response.json({ error: 'invalid-share' }, { status: 401 }) : Response.json({
      user: { id: 'share:hash', login: 'public', name: 'Public workspace', role: 'view' },
      team: { id: 'team', slug: 'team', name: 'Shared workspace', reports: [], bundles: [] },
    }))
  })
  const session = await probeSession()
  assert.equal(session.publicShare, true)
  assert.equal(session.role, 'view')
  assert.equal(session.csrfToken, null)
  const teams = await probeTeams()
  assert.deepEqual(teams.map(team => team.id), ['team'])
  revoked = true
  assert.equal(await probeSession({ fallback: session }), null)
  assert.deepEqual(await probeTeams({ fallback: teams }), [])
})

test('pasting a different share fragment reinitializes the capability instead of retaining the old identity', t => {
  const initial = globalThis.location.hash
  t.after(() => { globalThis.location.hash = initial })
  const reload = t.mock.fn()
  globalThis.location.reload = reload
  globalThis.location.hash = `#public=other.${'B'.repeat(43)}`
  onHashChange()
  assert.equal(reload.mock.callCount(), 1)
  globalThis.location.hash = '#finding=example'
  onHashChange()
  assert.equal(reload.mock.callCount(), 1, 'ordinary finding navigation keeps the public capability')
})
