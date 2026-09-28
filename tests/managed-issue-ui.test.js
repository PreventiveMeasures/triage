import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { state } from '../client/state.ts'
import { newIssueLabels } from '../common/github-issue-labels.js'
globalThis[Symbol.for('@rray/frontend')] ??= {}
const { githubIssueUrl } = await import('../ui/view/format.js')

class TestDialog { static styles = []; _finish() { this._settled = true } }
mock.module('../ui/view/dialogs/app-dialog.js', { namedExports: { AppDialog: TestDialog, openAppDialog: () => {} } })
await import('../ui/view/dialogs/managed-issue-dialog.js')
const Dialog = customElements.get('managed-issue-dialog')
const session = { id: 'user', login: 'author', role: 'view', csrfToken: 'csrf' }
function dialogFixture(t) {
  const old = { managedSession: state.managedSession, currentManagedTeam: state.currentManagedTeam }
  state.managedSession = session; state.currentManagedTeam = 'team'
  t.after(() => Object.assign(state, old))
  return Object.assign(new Dialog(), { teamId: 'team', session, context: { reportId: 'report', findingId: 'finding', repository: 'o/r' },
    formUrl: 'https://github.com/o/r/issues/new?labels=deepview', title: 'Finding', body: 'Description',
    isCurrent: () => state.managedSession?.id === session.id && state.managedSession?.csrfToken === session.csrfToken && state.currentManagedTeam === 'team' })
}

test('prefilled issues encode labels, title and body and deduplicate configured labels', () => {
  assert.deepEqual(newIssueLabels(false, 'review, DEEPVIEW, , review'), ['deepview', 'review'])
  assert.deepEqual(newIssueLabels(true, 'review, Security'), ['deepview', 'security', 'review'])
  for (const security of [false, true]) {
    const url = new URL(githubIssueUrl('o/r', { title: 'Title & stuff', body: 'Multiline\n#text', labels: newIssueLabels(security, 'triage') }))
    assert.equal(url.pathname, '/o/r/issues/new')
    assert.equal(url.searchParams.get('title'), 'Title & stuff')
    assert.equal(url.searchParams.get('body'), 'Multiline\n#text')
    assert.equal(url.searchParams.get('labels'), security ? 'deepview,security,triage' : 'deepview,triage')
  }
})

test('managed issue check never posts; confirmation sends edited draft once, with CSRF', async t => {
  const dialog = dialogFixture(t), writes = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if (init.method === 'GET') return Response.json({ mode: 'api', labels: ['security'] })
    writes.push({ url, init }); return Response.json({ url: 'https://github.com/o/r/issues/12' }, { status: 201 })
  })
  await dialog.check()
  assert.equal(writes.length, 0)
  assert.equal(dialog.prepared.mode, 'api')
  dialog.title = 'Edited title'; dialog.body = 'Edited description'
  await Promise.all([dialog.create(), dialog.create()])
  await dialog.create()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].init.headers['x-csrf-token'], 'csrf')
  assert.deepEqual(JSON.parse(writes[0].init.body), { ...dialog.context, title: 'Edited title', body: 'Edited description' })
  assert.equal(dialog.createdUrl, 'https://github.com/o/r/issues/12')
})

test('managed issue redirects uninstalled repos to an editable GitHub form', async t => {
  const dialog = dialogFixture(t)
  const previous = globalThis.window
  let destination
  globalThis.window = { location: { assign: url => { destination = url } } }
  t.after(() => { globalThis.window = previous })
  t.mock.method(globalThis, 'fetch', () => Response.json({ mode: 'form', labels: ['deepview', 'security'] }))
  await dialog.check(true)
  assert.equal(new URL(destination).searchParams.get('labels'), 'deepview,security')
  assert.equal(new URL(destination).searchParams.get('title'), 'Finding')
})

test('managed issue waits for authorization and never auto-submits after approval', async t => {
  const dialog = dialogFixture(t)
  let calls = 0, mode = 'permissions'
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(init.method, 'GET'); calls++
    return Response.json({ mode, labels: [], authorizationPath: '/api/oauth/github/issues/login' })
  })
  await dialog.check(); await dialog.create()
  assert.equal(calls, 1)
  mode = 'authorize'; await dialog.check(); await dialog.create()
  assert.equal(calls, 2)
  mode = 'api'; await dialog.check()
  assert.equal(calls, 3)
  assert.equal(dialog.createdUrl, '')
})

test('managed issue blocks automatic retries after uncertain creation and stale session writes', async t => {
  const dialog = dialogFixture(t)
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => { calls++; throw new Error('lost response') })
  dialog.prepared = { mode: 'api' }
  await dialog.create(); await dialog.create()
  assert.equal(calls, 1)
  assert.equal(dialog.uncertain, true)
  assert.match(dialog.message, /may have created/u)
  const stale = dialogFixture(t)
  stale.prepared = { mode: 'api' }
  state.managedSession = { ...session, csrfToken: 'changed' }
  await stale.create()
  assert.equal(calls, 1)
})

test('second issue click navigates to the immutable existing reference without posting', async t => {
  const dialog = dialogFixture(t)
  const previous = globalThis.window
  let destination
  globalThis.window = { location: { assign: url => { destination = url } } }
  t.after(() => { globalThis.window = previous })
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(init.method, 'GET')
    return Response.json({ mode: 'existing', url: 'https://github.com/o/r/issues/55' })
  })
  await dialog.check(true)
  assert.equal(destination, 'https://github.com/o/r/issues/55')
  await dialog.create()
})
