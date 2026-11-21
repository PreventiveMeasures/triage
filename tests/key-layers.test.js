import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findingsEscapeLayer, focusNavBlocked, nativeLayerOpen } from '../ui/view/key-layers.js'

// Escape unwinds one layer per press. A dialog or popover opened from the
// kanban modal closes itself once the keydown has dispatched, so it is still
// open when events.js's document listener reads the press. That listener
// closed the modal under it too (the comment and fix-link dialogs, the triage
// popover), leaving focus on <body>.

// The selectors key-layers.js asks for, over stub elements.
const SELECTORS = {
  'dialog:modal': el => el.tagName === 'DIALOG' && el.modal === true,
  'dialog[open]': el => el.tagName === 'DIALOG' && el.open === true,
  ':popover-open:not(#styled-tooltip)': el => el.popoverOpen === true && el.id !== 'styled-tooltip',
}
const matches = (el, selector) => selector.split(', ').some(part => {
  const match = SELECTORS[part]
  if (!match) throw new Error(`unexpected selector: ${part}`)
  return match(el)
})
// A document or shadow root holding `elements`.
const root = (...elements) => ({
  querySelector: selector => elements.find(el => matches(el, selector)) ?? null,
  querySelectorAll: selector => {
    assert.equal(selector, '*')
    return elements
  },
})
const el = (tagName, props = {}) => ({ tagName, nodeType: 1, ...props })
const host = (tagName, ...elements) => el(tagName, { shadowRoot: root(...elements) })
const escape = (path = [], defaultPrevented = false) => ({ key: 'Escape', defaultPrevented, composedPath: () => path })

// The kanban board and its modal, whose finding card is a shadow host.
const board = () => [el('DIV', { className: 'kanban-board' }), el('DIV', { className: 'kanban-detail-modal' })]

for (const tag of ['COMMENT-DIALOG', 'FIX-LINK-DIALOG']) {
  test(`${tag.toLowerCase()} opened from the kanban modal takes the Escape; the modal takes the next`, () => {
    // showModal() from an `AppDialog`, in its shadow root; focus in its field.
    const field = el(tag === 'COMMENT-DIALOG' ? 'TEXTAREA' : 'INPUT')
    const dialog = el('DIALOG', { open: true, modal: true })
    const page = root(...board(), host('FINDING-CARD'), host(tag, dialog, field))
    const open = { kanbanModal: true }
    assert.equal(nativeLayerOpen(page), true)
    assert.equal(findingsEscapeLayer(escape([field, dialog]), open, page), null, 'the dialog closes alone')
    // Closed: the dialog's own cancel ran, and the open helper removed it.
    const after = root(...board(), host('FINDING-CARD'))
    assert.equal(findingsEscapeLayer(escape(), open, after), 'kanban-modal')
  })
}

test('the triage popover in the kanban modal takes the Escape; the modal takes the next', () => {
  // A `popover="auto"` in the finding card's shadow root; focus stays on its
  // toggle, so nothing on the event's path says a popover is up.
  const toggle = el('BUTTON', { className: 'mark-triage-menu' })
  const menu = el('DIV', { className: 'triage-menu', popoverOpen: true })
  const card = host('FINDING-CARD', toggle, menu)
  const open = { kanbanModal: true }
  assert.equal(findingsEscapeLayer(escape([toggle, card]), open, root(...board(), card)), null, 'the popover closes alone')
  menu.popoverOpen = false
  assert.equal(findingsEscapeLayer(escape([toggle, card]), open, root(...board(), card)), 'kanban-modal')
})

test('a dialog or popover in nested shadow roots is found too', () => {
  const nested = (inner) => root(host('APP-SIDEBAR', host('USER-SELECTOR', inner)))
  assert.equal(nativeLayerOpen(nested(el('DIALOG', { open: true, modal: true }))), true)
  assert.equal(nativeLayerOpen(nested(el('DIV', { popoverOpen: true }))), true)
  assert.equal(nativeLayerOpen(nested(el('DIV'))), false)
})

test('the hover tooltip, a closed dialog or a non-modal one never hold the Escape', () => {
  const open = { kanbanModal: true }
  const tooltip = el('DIV', { id: 'styled-tooltip', popoverOpen: true })
  assert.equal(findingsEscapeLayer(escape(), open, root(...board(), tooltip)), 'kanban-modal')
  assert.equal(findingsEscapeLayer(escape(), open, root(...board(), host('COMMENT-DIALOG', el('DIALOG')))), 'kanban-modal')
  // `show()`, not `showModal()`: Escape doesn't close it.
  assert.equal(nativeLayerOpen(root(el('DIALOG', { open: true }))), false)
})

test('the source viewer over the kanban modal, the modal, then a fullscreen column: one per press', () => {
  const page = root(...board())
  // The viewer's own listener closes its side panel, then itself.
  assert.equal(findingsEscapeLayer(escape(), { sourceViewer: true, kanbanModal: true, kanbanColumn: true }, page), null)
  assert.equal(findingsEscapeLayer(escape(), { kanbanModal: true, kanbanColumn: true }, page), 'kanban-modal')
  assert.equal(findingsEscapeLayer(escape(), { kanbanColumn: true }, page), 'kanban-column')
  assert.equal(findingsEscapeLayer(escape(), { kanbanColumn: true }, root(...board(), el('DIV', { popoverOpen: true }))), null)
  assert.equal(findingsEscapeLayer(escape(), {}, page), null)
})

test('the links preview leaves an Escape typed in a field, or already taken, without falling through', () => {
  const page = root(el('DIV', { className: 'links-preview-backdrop' }))
  const open = { linksPreview: true, kanbanModal: true }
  assert.equal(findingsEscapeLayer(escape(), open, page), 'links-preview')
  assert.equal(findingsEscapeLayer(escape([el('INPUT', { type: 'search' })]), open, page), null)
  assert.equal(findingsEscapeLayer(escape([el('DIV', { isContentEditable: true })]), open, page), null)
  assert.equal(findingsEscapeLayer(escape([], true), open, page), null)
  assert.equal(findingsEscapeLayer(escape(), open, root(el('DIV', { popoverOpen: true }))), null)
})

test('with none of the findings layers up, the page is not walked', () => {
  const untouched = { querySelector() { throw new Error('walked') }, querySelectorAll() { throw new Error('walked') } }
  assert.equal(findingsEscapeLayer(escape(), {}, untouched), null)
  assert.equal(findingsEscapeLayer(escape(), { sourceViewer: true, kanbanModal: true }, untouched), null)
})

test('arrow keys belong to an open dialog or a field being typed in', () => {
  const page = root(...board())
  assert.equal(focusNavBlocked(escape([el('BUTTON')]), page), false)
  assert.equal(focusNavBlocked(escape([el('SELECT')]), page), true)
  assert.equal(focusNavBlocked(escape([el('DIALOG', { open: true })]), page), true)
  assert.equal(focusNavBlocked(escape([el('BUTTON')]), root(el('DIALOG', { open: true }))), true)
  // Text nodes and the document on the path are skipped.
  assert.equal(focusNavBlocked(escape([{ nodeType: 3 }, null, { nodeType: 9 }]), page), false)
})
