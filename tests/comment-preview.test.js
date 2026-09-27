import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import '../ui/view/frontend-install.js'

const state = { managedComments: new Map(), managedSession: { id: 'user' },
  managedReports: [{ id: 'report' }], reports: [] }
let managed = true
let serverComments = []
mock.module('../client/index.js', { namedExports: { state, isManagedUiMode: () => managed } })
mock.module('../ui/view/client-managed.js', { namedExports: {
  fetchReportComments: () => Promise.resolve(serverComments), deleteReportComment() {}, saveReportComment() {},
} })
mock.module('../ui/view/tooltip.js', { namedExports: { hideTooltip() {}, installShadowTooltipListener() {} } })
const { loadManagedReportComments } = await import('../ui/view/managed-comments.js')
await import('../ui/view/comment-preview.js')
const CommentPreview = customElements.get('comment-preview')

function renderText(value) {
  if (Array.isArray(value)) return value.map(renderText).join('')
  if (value?.strings) return value.strings.map((text, i) => text + renderText(value.values[i])).join('')
  if (value?.values) return renderText(value.values)
  return value == null || ['symbol', 'function'].includes(typeof value) ? '' : String(value)
}

beforeEach(() => {
  managed = true
  state.managedComments.clear()
  state.reports = [{ _managedReportId: 'report', groups: [[{ id: 'first' }, { id: 'second' }]] }]
  serverComments = []
})

test('managed previews show each author, body and timestamp for the active finding', () => {
  const preview = new CommentPreview()
  preview.finding = { id: 'active' }
  preview.comment = 'stale local comment'
  state.managedComments.set('active', [
    { body: 'First note', authorLogin: 'alice', createdAt: 0 },
    { body: 'See https://github.com/org/repo/pull/42', authorLogin: 'bob', createdAt: 1000 },
  ])
  state.managedComments.set('other', [{ body: 'unrelated note' }])
  const text = renderText(preview.render())
  for (const expected of ['alice', 'First note', 'bob', 'org/repo#42', '1970-01-01T00:00:00.000Z']) assert.ok(text.includes(expected), expected)
  assert.doesNotMatch(text, /stale local comment|unrelated note|edit-hint/u)
  state.managedComments.clear()
  assert.doesNotMatch(renderText(preview.render()), /popover="manual"/u, 'no fallback to a stale local projection after reset')
})

test('local/E2E previews preserve multiline text and links, with a separate Edit hint', () => {
  managed = false
  const preview = new CommentPreview()
  preview.comment = 'First line\nSee https://github.com/org/repo/issues/42'
  const text = renderText(preview.render())
  assert.match(text, /First line\nSee /u)
  assert.match(text, /href=https:\/\/github.com\/org\/repo\/issues\/42/u)
  assert.match(text, /class="mark-comment edit-hint">Edit</u)
  assert.doesNotMatch(text, /Edit comment:/u)
})

test('long comment lines widen the preview without widening short multiline comments', () => {
  managed = false
  const preview = new CommentPreview()
  for (const [comment, wide] of [['x'.repeat(100), false], ['x'.repeat(101), true], ['x'.repeat(60) + '\n' + 'y'.repeat(60), false]]) {
    preview.comment = comment
    assert.equal(renderText(preview.render()).includes('class=preview wide'), wide)
  }
  managed = true
  preview.finding = { id: 'active' }
  state.managedComments.set('active', [{ body: 'x'.repeat(101) }])
  assert.ok(renderText(preview.render()).includes('class=preview wide'))
})

test('subscriptions follow the active finding and refresh after comment edits', async t => {
  const preview = new CommentPreview()
  preview.finding = { id: 'first' }
  preview.requestUpdate = mock.fn()
  preview._subscribe()
  t.after(() => preview.unsubscribe())
  await loadManagedReportComments('report')
  assert.equal(preview.requestUpdate.mock.callCount(), 1)
  preview.finding = { id: 'second' }
  preview._subscribe()
  preview.requestUpdate.mock.resetCalls()
  await loadManagedReportComments('report')
  assert.equal(preview.requestUpdate.mock.callCount(), 1, 'only the new finding notifies the preview')
  preview.unsubscribe()
  await loadManagedReportComments('report')
  assert.equal(preview.requestUpdate.mock.callCount(), 1, 'unsubscribed previews stop receiving updates')
})

test('an empty managed preview shows the first remote comment and hides after the last deletion', async t => {
  const preview = new CommentPreview()
  preview.finding = { id: 'first' }
  let text = ''
  const popup = { matches: () => false }
  preview.renderRoot = { querySelector: () => text.includes('popover="manual"') ? popup : null }
  preview._hidePreview = mock.fn()
  const repaint = () => {
    text = renderText(preview.render())
    preview.updated(new Map())
  }
  preview.requestUpdate = mock.fn(repaint)
  preview._subscribe()
  t.after(() => preview.unsubscribe())
  repaint()
  assert.equal(preview.hidden, true)
  assert.doesNotMatch(text, /mark-comment/u, 'empty subscribers have no focusable icon')

  serverComments = [{ id: 'remote', findingId: 'first', body: 'First remote comment', authorLogin: 'alice' }]
  await loadManagedReportComments('report')
  assert.equal(preview.requestUpdate.mock.callCount(), 1)
  assert.equal(preview.hidden, false)
  assert.match(text, /First remote comment/u)

  serverComments = []
  await loadManagedReportComments('report')
  assert.equal(preview.hidden, true)
  assert.doesNotMatch(text, /mark-comment|popover="manual"/u)
  serverComments = [{ id: 'later', findingId: 'first', body: 'Another remote comment' }]
  await loadManagedReportComments('report')
  assert.equal(preview.hidden, false, 'the hidden preview remains subscribed after deletion')
  assert.match(text, /Another remote comment/u)
})

function interactivePreview(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.document = new EventTarget()
  globalThis.window = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 })
  const element = new CommentPreview()
  let open = false
  const popup = {
    style: {}, matches: () => open, showPopover: () => { open = true }, hidePopover: () => { open = false },
    contains: node => node === popup, getBoundingClientRect: () => ({ width: 384, height: 200 }),
  }
  const trigger = { getBoundingClientRect: () => ({ left: 750, top: 560, bottom: 572 }), focus: mock.fn(), click: mock.fn() }
  element.renderRoot = { activeElement: null, querySelector: selector => selector === '.preview' ? popup : trigger }
  Object.defineProperty(element, 'isConnected', { value: true })
  t.after(() => { element._hidePreview(); delete globalThis.document; delete globalThis.window })
  return { element, popup, trigger }
}

test('clicking preview content opens the existing dialog action without intercepting links or text selection', t => {
  const { element, trigger } = interactivePreview(t)
  const event = { target: { closest: () => null }, stopPropagation: mock.fn() }
  element._previewClick(event)
  assert.equal(trigger.click.mock.callCount(), 1)
  assert.equal(event.stopPropagation.mock.callCount(), 1)

  for (const tagName of ['A', 'BUTTON']) {
    element._previewClick({ ...event, target: { closest: () => ({ tagName }) } })
  }
  window.getSelection = () => ({ toString: () => 'Selected comment text' })
  element._previewClick(event)
  assert.equal(trigger.click.mock.callCount(), 1, 'links, Edit, and selection do not synthesize another icon click')
  assert.equal(event.stopPropagation.mock.callCount(), 1, 'links and Edit still reach their own delegates')
})

test('hover previews wait briefly, stay open while entered, and dismiss on leave or Escape', t => {
  const { element, popup, trigger } = interactivePreview(t)
  element._schedulePreview()
  t.mock.timers.tick(149)
  assert.equal(popup.matches(), false)
  t.mock.timers.tick(1)
  assert.equal(popup.matches(), true)
  assert.deepEqual(popup.style, { left: '404px', top: '352px' }, 'clamp right edge and place above a low icon')
  element._leavePreview()
  element._keepPreview()
  t.mock.timers.tick(150)
  assert.equal(popup.matches(), true)
  element.renderRoot.activeElement = popup
  element._leavePreview()
  t.mock.timers.tick(150)
  assert.equal(popup.matches(), true, 'keyboard focus keeps the content open')
  const event = new Event('keydown', { cancelable: true })
  Object.defineProperty(event, 'key', { value: 'Escape' })
  document.dispatchEvent(event)
  assert.equal(popup.matches(), false)
  assert.equal(event.defaultPrevented, true)
  assert.equal(trigger.focus.mock.callCount(), 1)
  element.renderRoot.activeElement = null
  element._schedulePreview()
  t.mock.timers.tick(150)
  element._leavePreview()
  t.mock.timers.tick(150)
  assert.equal(popup.matches(), false)
})

test('scrolling comments keeps the popup open; scrolling the board or resetting comments dismisses it', t => {
  const { element, popup } = interactivePreview(t)
  element._schedulePreview()
  t.mock.timers.tick(150)
  element._previewScroll({ composedPath: () => [popup] })
  assert.equal(popup.matches(), true)
  element._previewScroll({ composedPath: () => [] })
  assert.equal(popup.matches(), false)
  element._schedulePreview()
  t.mock.timers.tick(150)
  element._resetComments()
  assert.equal(popup.matches(), false)
})
