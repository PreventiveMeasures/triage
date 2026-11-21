// Enter / Space on the click-only cards and rows (ui/view/key-click.js,
// wired in events.js): the kanban board's and rail's cards, the focus
// queue's, the table's `<finding-row>`s and the Files tab's rows open as a
// click does, and nothing else's keys are taken.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

const { KEY_CLICK_TARGETS, keyClickTarget } = await import('../ui/view/key-click.js')
const { state } = await import('../client/state.ts')
const { renderTreeView } = await import('../ui/view/render-files.js')

// An element as the selector reads it: a tag, classes and attributes, its
// `matches` the comma list of `tag.class[attr="value"]` compounds that
// KEY_CLICK_TARGETS is written in.
function element(tag, { classes = [], attrs = {}, open = false } = {}) {
  const has = (compound) => {
    const [, name = '', rest] = compound.match(/^([a-z-]*)(.*)$/u)
    if (name && name !== tag) return false
    for (const [, cls, attr, value] of rest.matchAll(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/gu)) {
      if (cls && !classes.includes(cls)) return false
      if (attr && (!Object.hasOwn(attrs, attr) || (value !== undefined && attrs[attr] !== value))) return false
    }
    return true
  }
  return { tagName: tag.toUpperCase(), nodeType: 1, open, matches: (selector) => selector.split(/\s*,\s*/u).some(has) }
}

const boardCard = element('div', { classes: ['kanban-card'], attrs: { 'role': 'button', 'data-kanban-source': '' } })
const railCard = element('div', { classes: ['kanban-card', 'focus-side-card'], attrs: { 'role': 'button', 'data-kanban-select': '' } })
const queueCard = element('div', { classes: ['kanban-card', 'focus-side-card'], attrs: { 'role': 'button', 'data-focus-select': '' } })
const row = element('finding-row', { attrs: { tabindex: '0' } })
const fileRow = element('div', { classes: ['tree-table-row'], attrs: { 'role': 'button', 'data-tree-select': 'src/a.js' } })
const report = element('div', { attrs: { id: 'report' } })
const closedDocument = { querySelector: () => null }

// A keydown whose composed path starts at `path[0]`, the focused element.
const keydown = (key, path, extra = {}) => ({
  key, defaultPrevented: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
  composedPath: () => [...path, report], ...extra,
})
const target = (e, doc = closedDocument) => keyClickTarget(e, KEY_CLICK_TARGETS, doc)

describe('keyClickTarget', () => {
  it('clicks each kind of card and row on Enter and on Space', () => {
    for (const el of [boardCard, railCard, queueCard, row, fileRow]) {
      assert.equal(target(keydown('Enter', [el])), el)
      assert.equal(target(keydown(' ', [el])), el)
    }
  })

  it('finds a table row focused inside `<finding-table>`, the target retargeted to the table', () => {
    const table = element('finding-table')
    const shadowRoot = { nodeType: 11 }
    assert.equal(target(keydown('Enter', [row, shadowRoot, table], { target: table })), row)
  })

  it('leaves other keys and modified ones alone', () => {
    for (const key of ['a', 'Tab', 'Escape', 'ArrowRight', 'Spacebar']) assert.equal(target(keydown(key, [boardCard])), null, key)
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
      assert.equal(target(keydown('Enter', [boardCard], { [modifier]: true })), null, modifier)
    }
    assert.equal(target(keydown('Enter', [boardCard], { isComposing: true })), null, 'an IME composition commits')
    assert.equal(target(keydown(' ', [boardCard], { defaultPrevented: true })), null, 'a key already handled')
  })

  it('leaves a key from a control inside the card or row to that control', () => {
    const fixButton = element('button', { classes: ['kanban-action', 'mark-fix'] })
    const fixLink = element('a')
    const fixLinkHost = element('managed-fix-link', { classes: ['kanban-action', 'kanban-fix-link'] })
    const rowButton = element('button', { classes: ['triage-state-btn'] })
    assert.equal(target(keydown('Enter', [fixButton, boardCard])), null)
    // In a shadow root: `e.target` is the host, the path starts at the link.
    assert.equal(target(keydown('Enter', [fixLink, { nodeType: 11 }, fixLinkHost, boardCard], { target: fixLinkHost })), null)
    assert.equal(target(keydown(' ', [rowButton, { nodeType: 11 }, row])), null)
  })

  it('leaves elements that only look alike', () => {
    // Every compact card is `role="button"`; one without isn't one of them.
    assert.equal(target(keydown('Enter', [element('div', { classes: ['kanban-card'] })])), null)
    assert.equal(target(keydown('Enter', [element('div', { classes: ['tree-table-row'] })])), null)
    assert.equal(target(keydown('Enter', [element('div', { attrs: { role: 'button' } })])), null)
    assert.equal(target(keydown('Enter', [report])), null)
  })

  it('does nothing while a dialog is open', () => {
    const dialog = element('dialog', { open: true })
    assert.equal(target(keydown('Enter', [boardCard]), { querySelector: (sel) => sel === 'dialog[open]' ? dialog : null }), null)
    // In a Lit shadow root the query misses it; on the path, it is open.
    assert.equal(target(keydown('Enter', [queueCard, dialog])), null)
    assert.equal(target(keydown('Enter', [queueCard, element('dialog')])), queueCard, 'a closed one is no matter')
  })
})

describe("the Files tab's rows", () => {
  it('render as tab stops: a disclosure button for the details panel', () => {
    const saved = { filesViewMode: state.filesViewMode, filesSearch: state.filesSearch, filesSelectedFile: state.filesSelectedFile }
    try {
      Object.assign(state, { filesViewMode: 'table', filesSearch: '', filesSelectedFile: 'src/b.js' })
      const text = templateText(renderTreeView({ 'src/a.js': { size: 10 }, 'src/b.js': { size: 20 } }, new Map()))
      // templateText spells a bound value unquoted.
      const rows = [...text.matchAll(/<div\s+class=tree-table-row[^>]*>/gu)].map(([tag]) => tag)
      assert.equal(rows.length, 2)
      for (const tag of rows) {
        assert.match(tag, /role="button"/u)
        assert.match(tag, /tabindex="0"/u)
      }
      assert.match(rows.find((tag) => tag.includes('data-tree-select=src/a.js')), /aria-expanded=false/u)
      assert.match(rows.find((tag) => tag.includes('data-tree-select=src/b.js')), /aria-expanded=true/u)
    } finally {
      Object.assign(state, saved)
    }
  })
})
