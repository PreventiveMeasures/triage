import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import '../ui/view/frontend-install.js'
import { state } from '../client/state.ts'

const invalidations = [], paints = []
mock.module('../ui/view/render.js', { namedExports: { render: () => paints.push(state.managedIssues.get('finding')) } })
mock.module('../ui/view/dom.js', { namedExports: { report: null } })
mock.module('../ui/view/managed-pull-requests.js', { namedExports: { invalidateManagedFixes: team => invalidations.push(team) } })
mock.module('../ui/client-managed.js', { namedExports: { openManagedIssueDialog: props => props } })
// Exercise the actual lazy proxy; the browser resolves this import to the
// emitted managed chunk rather than to the proxy's source file.
const proxyUrl = new URL('../ui/view/client-managed.js', import.meta.url).href
const chunkUrl = new URL('../ui/client-managed.js', import.meta.url).href
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === './client-managed.js' && context.parentURL === proxyUrl ? chunkUrl : specifier, context)
} })
const { openManagedIssueDialog } = await import('../ui/view/client-managed.js')
const { findingCardInnerTemplate } = await import('../ui/view/render-finding.js')
const session = { id: 'viewer', csrfToken: 'csrf', role: 'view' }
const finding = { id: 'finding', title: 'Finding', severity: 'high', file: 'src/file.js', repo: { github: 'o/r' }, _managedReportId: 'report' }
const url = 'https://github.com/o/r/issues/1'
function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}
beforeEach(t => {
  const next = { serverMode: 'managed', localMode: false, currentManagedTeam: 'team', managedSession: session, managedIssues: new Map() }
  const previous = Object.fromEntries(Object.keys(next).map(key => [key, state[key]]))
  Object.assign(state, next)
  paints.length = 0; invalidations.length = 0
  t.after(() => Object.assign(state, previous))
})
const open = () => openManagedIssueDialog({ teamId: 'team', session, context: { findingId: 'finding' } })

test('creating an issue repaints the saved issue immediately without waiting for the feed', async () => {
  assert.ok(templates(findingCardInnerTemplate([finding])).some(item => item.strings[0].includes('class="mark-issue"')))
  const dialog = await open()
  dialog.onCreated(url)
  assert.deepEqual(paints, [{ url, autoFix: null }])
  assert.deepEqual(invalidations, ['team'])
  const card = templates(findingCardInnerTemplate([finding]))
  assert.equal(card.some(item => item.strings[0].includes('class="mark-issue"')), false)
  assert.ok(card.some(item => item.strings.join('').includes('Issue:') && item.values.includes(url)))
})

test('an unchanged existing issue keeps its automatic Fix and does not repaint', async () => {
  const existing = { url, autoFix: 'https://github.com/o/r/pull/2' }
  state.managedIssues.set('finding', existing)
  const dialog = await open()
  dialog.onCreated(url)
  assert.deepEqual(state.managedIssues.get('finding'), existing)
  assert.deepEqual(paints, [])
})

test('late issue creation cannot repaint or mutate another workspace', async () => {
  const dialog = await open()
  state.currentManagedTeam = 'other'
  dialog.onCreated(url)
  assert.equal(state.managedIssues.size, 0)
  assert.deepEqual(paints, [])
  assert.deepEqual(invalidations, [])
})
