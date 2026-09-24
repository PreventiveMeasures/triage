import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hasOpenModal } from '../ui/view/open-modal.js'

// `showModal()` stacks a second modal instead of refusing, so dialogs
// that must not stack (`AppDialog` opened `exclusive`, the auto-opened
// sync suggestion) look first — including inside the shadow roots the
// app's dialogs render into, which `:modal` alone can't see into.
const el = (shadowRoot = null) => ({ shadowRoot })
const root = (modal, children = []) => ({
  querySelector: (sel) => (sel === ':modal' && modal ? {} : null),
  querySelectorAll: () => children,
})

test('no modal anywhere', () => {
  assert.equal(hasOpenModal(root(false, [el(), el(root(false))])), false)
})

test('a light-DOM modal', () => {
  assert.equal(hasOpenModal(root(true)), true)
})

test('a modal inside a dialog component\'s shadow root', () => {
  assert.equal(hasOpenModal(root(false, [el(), el(root(true))])), true)
})

test('a modal in nested shadow roots', () => {
  assert.equal(hasOpenModal(root(false, [el(root(false, [el(root(true))]))])), true)
})
