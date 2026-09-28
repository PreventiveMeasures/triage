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

function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}
function dialogLinks(dialog) {
  return templates(dialog.render()).filter(item => item.strings[0].startsWith('<a href=')).map(item => item.values[0])
}
function canCreate(dialog) {
  return templates(dialog.render()).some(item => item.strings.join('').includes('>Create issue</button>'))
}

for (const repositoryUrl of [undefined, 'https://github.com/o/reserved-repo/issues']) {
  test(`pending creation only links to an issue listing ${repositoryUrl ? 'from the server' : 'without a server URL'}`, async t => {
    const dialog = dialogFixture(t)
    dialog.prepared = { mode: 'api' }
    let writes = 0
    t.mock.method(globalThis, 'fetch', () => { writes++; return Response.json({ mode: 'pending', ...(repositoryUrl ? { repositoryUrl } : {}) }) })
    await dialog.create()
    assert.deepEqual(dialogLinks(dialog), [repositoryUrl ?? 'https://github.com/o/r/issues'])
    assert.equal(canCreate(dialog), false)
    await dialog.create()
    assert.equal(writes, 1)
  })
}

test('saved creation without current access offers no creation or URL and survives failed status checks', async t => {
  const dialog = dialogFixture(t), methods = []
  dialog.prepared = { mode: 'api' }
  let accessRestored = false, destination
  const previous = globalThis.window
  globalThis.window = { location: { assign: url => { destination = url } } }
  t.after(() => { globalThis.window = previous })
  t.mock.method(globalThis, 'fetch', (url, init) => {
    methods.push(init.method)
    return init.method === 'POST' ? Response.json({ mode: 'created-unavailable' }, { status: 201 })
      : accessRestored ? Response.json({ mode: 'existing', url: 'https://github.com/o/r/issues/77' })
      : Response.json({ error: 'no-team' }, { status: 404 })
  })
  await dialog.create()
  assert.equal(dialog.prepared.mode, 'created-unavailable')
  assert.ok(templates(dialog.render()).some(item => item.strings.join('').includes('The issue was created and linked permanently')))
  assert.deepEqual(dialogLinks(dialog), [])
  assert.equal(canCreate(dialog), false)
  await dialog.create()
  await dialog.check()
  assert.equal(dialog.prepared.mode, 'created-unavailable')
  assert.deepEqual(dialogLinks(dialog), [])
  await dialog.create()
  accessRestored = true
  await dialog.check()
  assert.equal(destination, 'https://github.com/o/r/issues/77')
  assert.deepEqual(methods, ['POST', 'GET', 'GET'])
})

test('a rejected access check discards stale API preparation and never exposes a new-issue form', async t => {
  const dialog = dialogFixture(t)
  dialog.prepared = { mode: 'api' }
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => { calls++; return Response.json({ error: 'workspace-changed' }, { status: 404 }) })
  await dialog.create()
  assert.equal(dialog.prepared, null)
  assert.deepEqual(dialogLinks(dialog), [])
  assert.equal(canCreate(dialog), false)
  await dialog.create()
  assert.equal(calls, 1)
})

test('the GitHub form is unavailable until the initial issue lookup succeeds', async t => {
  const dialog = dialogFixture(t), response = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', () => response.promise)
  assert.deepEqual(dialogLinks(dialog), [])
  const check = dialog.check()
  assert.deepEqual(dialogLinks(dialog), [])
  response.resolve(Response.json({ error: 'github-unavailable' }, { status: 502 }))
  await check
  assert.deepEqual(dialogLinks(dialog), [])
})

test('an authoritative unavailable lookup clears an uncertain outcome without exposing a fallback URL', async t => {
  const dialog = dialogFixture(t)
  dialog.prepared = { mode: 'api' }; dialog.uncertain = true
  t.mock.method(globalThis, 'fetch', () => Response.json({ mode: 'unavailable' }))
  await dialog.check()
  assert.deepEqual(dialogLinks(dialog), [])
  assert.equal(canCreate(dialog), false)
})

test('installed repositories keep creation in the managed flow, including during authorization', t => {
  const dialog = dialogFixture(t)
  for (const mode of ['api', 'authorize', 'permissions']) {
    dialog.prepared = { mode, authorizationPath: '/api/oauth/github/issues/login' }
    assert.ok(dialogLinks(dialog).every(url => !url.includes('/issues/new')), `${mode} must not offer untracked creation`)
  }
  dialog.prepared = { mode: 'form' }
  assert.equal(new URL(dialogLinks(dialog)[0]).pathname, '/o/r/issues/new', 'server-approved form fallback remains available')
})
