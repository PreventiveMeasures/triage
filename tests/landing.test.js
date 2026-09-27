import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { html, nothing } from 'lit'

mock.module('lit', { namedExports: { html, nothing, render: (value, slot) => { slot.value = value } } })
mock.module('lit/directives/repeat.js', { namedExports: { repeat: (items, _key, template) => items.map(template) } })
mock.module('lit/directives/unsafe-html.js', { namedExports: { unsafeHTML: value => value } })
mock.module('../client/index.js', { namedExports: {
  LINKS_KIND: 'links', getKind: name => name.endsWith('.links') ? 'links' : 'report', getWorkspaceAppMetadata: () => null,
} })
const { updateManagedLanding } = await import('../ui/view/landing-managed.js')
const { renderLandingWorkspaces } = await import('../ui/view/landing-workspaces.js')

function renderText(value) {
  if (value?.strings && value?.values) return value.strings.map((text, i) => text + renderText(value.values[i])).join('')
  if (Array.isArray(value)) return value.map(renderText).join('')
  return value == null || typeof value === 'symbol' ? '' : String(value)
}
const managedSlot = {}, workspaceSlot = {}
const landing = {
  dataset: {}, setAttribute() {}, querySelector: selector => selector === '.managed-landing' ? managedSlot : null,
}
const pending = { serverMode: 'managed', session: null, sessionPending: true }
const session = { role: 'view' }
const managedText = () => renderText(managedSlot.value)

beforeEach(t => {
  const previous = globalThis.document
  globalThis.document = { querySelector: selector => selector === '#drop-zone' ? landing : workspaceSlot }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  updateManagedLanding({ serverMode: 'local' })
  t.after(() => {
    updateManagedLanding({ serverMode: 'local' })
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  })
})

test('a session loaded within one second never paints the login prompt', t => {
  updateManagedLanding(pending)
  assert.equal(managedText(), '')
  t.mock.timers.tick(999)
  assert.equal(managedText(), '')
  updateManagedLanding({ ...pending, session, sessionPending: false })
  assert.match(managedText(), /Your team's findings/u)
  t.mock.timers.tick(2000)
  assert.doesNotMatch(managedText(), /Log in to DeepView/u)
})

test('an unresolved session shows login after one second, without resetting on repaint', t => {
  updateManagedLanding(pending)
  t.mock.timers.tick(750)
  updateManagedLanding({ ...pending, alternateMode: 'e2e' })
  t.mock.timers.tick(249)
  assert.equal(managedText(), '')
  t.mock.timers.tick(1)
  assert.match(managedText(), /Log in to DeepView/u)
  assert.match(managedText(), /e2e mode/u)
  updateManagedLanding(pending)
  assert.match(managedText(), /Log in to DeepView/u)
  updateManagedLanding({ ...pending, session, sessionPending: false })
  assert.doesNotMatch(managedText(), /Log in to DeepView/u)
})

test('a confirmed anonymous session offers login immediately', t => {
  updateManagedLanding(pending)
  t.mock.timers.tick(100)
  updateManagedLanding({ ...pending, sessionPending: false })
  assert.match(managedText(), /Log in to DeepView/u)
})

test('mode changes cancel the old timer and give a new session its own grace period', t => {
  updateManagedLanding(pending)
  t.mock.timers.tick(500)
  updateManagedLanding({ serverMode: 'local' })
  t.mock.timers.tick(500)
  assert.equal(managedText(), '')
  assert.equal(landing.dataset.serverMode, 'local')
  updateManagedLanding(pending)
  t.mock.timers.tick(999)
  assert.equal(managedText(), '')
  t.mock.timers.tick(1)
  assert.match(managedText(), /Log in to DeepView/u)
})

test('background checks preserve known sessions and no-access screens', () => {
  updateManagedLanding({ ...pending, session })
  assert.match(managedText(), /Your team's findings/u)
  updateManagedLanding({ ...pending, session: { role: 'none' } })
  assert.match(managedText(), /No workspace access/u)
})

test('managed landing omits empty teams and handles all-empty accounts', () => {
  const empty = { id: 'empty', name: 'Empty team', reports: [] }
  updateManagedLanding({ serverMode: 'managed', session, teams: [empty,
    { id: 'active', name: 'Active team', reports: ['report'] },
    { id: 'bundle', name: 'Bundle team', reports: [], bundles: ['bundle'] },
  ] })
  assert.match(managedText(), /Active team/u)
  assert.match(managedText(), /Bundle team/u)
  assert.doesNotMatch(managedText(), /Empty team/u)
  updateManagedLanding({ serverMode: 'managed', session, teams: [empty] })
  assert.doesNotMatch(managedText(), /managed-team-list/u)
  assert.match(managedText(), /No team reports are available yet/u)
})

test('workspace quick links omit empty workspaces and retain bundle-only workspaces', () => {
  const workspaces = [
    { id: 'empty', name: 'Empty workspace', reports: [], bundles: [] },
    { id: 'bundle', name: 'Bundle workspace', reports: [], bundles: ['bundle'] },
    { id: 'report', name: 'Report workspace', reports: ['report'], bundles: [] },
  ]
  renderLandingWorkspaces(workspaces)
  const text = renderText(workspaceSlot.value)
  assert.doesNotMatch(text, /Empty workspace/u)
  assert.match(text, /Bundle workspace/u)
  assert.match(text, /Report workspace/u)
  assert.ok(text.indexOf('Report workspace') < text.indexOf('Bundle workspace'))
  assert.equal(workspaces[0].id, 'empty', 'rendering must not mutate the sidebar snapshot')
  renderLandingWorkspaces([workspaces[0]])
  assert.equal(workspaceSlot.value, nothing)
})
