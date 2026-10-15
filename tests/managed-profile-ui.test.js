import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { managedRoutePath, parseManagedRoute } from '../common/managed/routes.js'

const requests = []
let answer = null
let previewRole = null
const answered = () => answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
mock.module('../ui/view/client-managed.js', { namedExports: {
  getPreviewRole: () => previewRole,
  fetchProfile: (...args) => { requests.push(['fetch', ...args]); return answered() },
  chooseProfileAccounts: (...args) => { requests.push(['choose', ...args]); return answered() },
  unlinkGithubAccount: (...args) => { requests.push(['unlink', ...args]); return answered() },
} })
const { ManagedProfile } = await import('../ui/view/managed-profile.js')
const { appUser, knowGithubUsers } = await import('../ui/view/github-users.js')
// Lit reads `document` as it loads; the page tells the account control of
// changes through it only once one is made.
const events = []
globalThis.document ??= { dispatchEvent: event => { events.push(event) } }

function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value?.strings) return value.strings.map((str, i) => str + text(value.values[i])).join('')
  if (value?._$litDirective$) return text(value.values[0])
  return value == null || typeof value === 'symbol' || typeof value === 'function' ? '' : String(value)
}

const work = { id: '11111111-1111-4111-8111-111111111111', login: 'alice-work', name: 'Alice at Work', linkedAt: Date.UTC(2026, 9, 15) }
const profile = { login: 'alice', name: 'Alice', githubName: 'Alice', nameAccount: null, avatarAccount: null, accounts: [work] }
function page(session = {}) {
  const element = new ManagedProfile()
  element.session = { id: 'alice-id', login: 'alice', name: 'Alice', role: 'view', csrfToken: 'csrf', ...session }
  return element
}
// A page whose profile already loaded for its session.
function loaded(session) {
  const element = page(session)
  element._key = JSON.stringify([element.session.id, element.session.role])
  element._profile = profile
  return element
}

test('the profile has its own page, which shows a link refusal once', () => {
  assert.deepEqual(parseManagedRoute(new URL('https://test/my/profile')), { view: 'profile' })
  assert.deepEqual(parseManagedRoute(new URL('https://test/my/profile?link-error=github-account-own')), { view: 'profile', linkError: 'github-account-own' })
  assert.deepEqual(parseManagedRoute(new URL('https://test/my/profile?link-error=%3Cb%3E')), { view: 'profile' }, 'only a code is kept')
  assert.equal(managedRoutePath({ view: 'profile', linkError: 'github-account-own' }), '/my/profile', 'its address drops the refusal')
  assert.equal(parseManagedRoute(new URL('https://test/profile')), null)
})

test('profile shows the account and its linked GitHub accounts, each offering its name and avatar', async () => {
  answer = profile
  requests.length = 0
  const element = page()
  const markup = text(element.render())
  assert.match(markup, /<h1>Alice<\/h1>/u)
  assert.match(markup, /@alice/u)
  await Promise.resolve()
  assert.deepEqual(requests.map(([kind]) => kind), ['fetch'])
  await element._load()
  const shown = text(element.render())
  assert.match(shown, /Sign-in account/u)
  assert.match(shown, /@alice-work/u)
  assert.match(shown, /Alice at Work/u)
  assert.match(shown, /aria-label=Use @alice-work's avatar/u)
  assert.match(shown, /\/api\/avatar\/alice-id\?own/u, 'the sign-in account offers its own avatar')
  assert.match(shown, /\/api\/avatar\/11111111-1111-4111-8111-111111111111/u)
  assert.match(shown, /href=\/api\/oauth\/github\/link>Link GitHub account/u)
  assert.match(shown, /aria-label=Unlink @alice-work/u)
  assert.equal((shown.match(/Unlink @/gu) ?? []).length, 1, 'the sign-in account cannot be unlinked')
})

test('profile choices save through the API and tell the account control, keeping the profile on failure', async () => {
  // A repository's activity read before names both accounts.
  knowGithubUsers({ commits: [{ authorLogin: 'alice' }, { authorLogin: 'alice-work' }], users: {
    alice: { id: 'alice-id', login: 'alice', name: 'Alice' }, 'alice-work': { id: 'alice-id', login: 'alice', name: 'Alice' } } })
  const element = loaded()
  requests.length = 0
  events.length = 0
  answer = { ...profile, name: 'Alice at Work', nameAccount: work.id }
  await element._choose('name', work.id)
  assert.deepEqual(requests[0].slice(0, 3), ['choose', { name: work.id }, 'csrf'])
  assert.equal(element._profile.nameAccount, work.id)
  assert.deepEqual(events.map(event => [event.type, event.detail]), [['managed-profile-change', { userId: 'alice-id', name: 'Alice at Work', avatarChanged: false }]])
  assert.equal(appUser('alice-work')?.name, 'Alice at Work', 'activity read before shows the name chosen')
  answer = { ...element._profile, avatarAccount: work.id }
  await element._choose('avatar', work.id)
  assert.equal(events.at(-1).detail.avatarChanged, true)
  assert.match(text(element.render()), /\/api\/avatar\/alice-id\?v=1/u, 'the chosen avatar is asked for again')

  answer = new Error('Could not save your profile (no-account).')
  const before = element._profile
  await element._choose('name', null)
  assert.equal(element._profile, before)
  assert.match(element._error, /no-account/u)
  assert.equal(element._busy, false)

  answer = { ...profile, accounts: [] }
  await element._unlink(work)
  assert.deepEqual(requests.at(-1).slice(0, 3), ['unlink', work.id, 'csrf'])
  assert.deepEqual(element._profile.accounts, [])
  assert.equal(appUser('alice-work'), null, 'nor the account unlinked as theirs')
  assert.equal(appUser('alice')?.id, 'alice-id')
})

test('profile is read only in an admin\'s view and the preview; link refusals are explained', async () => {
  for (const [session, role] of [[{ viewer: { id: 'bob', login: 'bob', name: null } }, null], [{}, 'admin']]) {
    previewRole = role
    const element = loaded(session)
    requests.length = 0
    await element._choose('name', work.id)
    await element._unlink(work)
    assert.deepEqual(requests, [])
    const markup = text(element.render())
    assert.doesNotMatch(markup, /Link GitHub account/u)
    assert.match(markup, /\?disabled=true/u)
  }
  previewRole = null
  const element = loaded()
  element.linkError = 'github-account-registered'
  assert.match(text(element.render()), /role="alert">That GitHub account has signed in here before/u)
  element.linkError = 'something-new'
  assert.match(text(element.render()), /Could not link the account \(something-new\)/u)
})
