import assert from 'node:assert/strict'
import { test } from 'node:test'

// The shared tooltip is a manual popover (so it shows above modal
// dialogs). Hiding it must close the popover too: an open-but-invisible
// one still matches `:popover-open`, which other code reads as "a
// popover is up" — Escape in events.js stopped dismissing the links
// preview after the first tooltip (review r4099015016).
test('hideTooltip closes the popover it opened', async () => {
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window
  let open = false
  const classes = new Set()
  const node = {
    id: '', style: {}, textContent: '', offsetWidth: 100,
    setAttribute() {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    showPopover() { if (open) throw new Error('already open'); open = true },
    hidePopover() { if (!open) throw new Error('not open'); open = false },
    matches(sel) { return sel === ':popover-open' && open },
  }
  globalThis.document = { addEventListener() {}, createElement: () => node, body: { append() {} } }
  globalThis.window = { innerWidth: 1000 }
  try {
    const { showTooltip, hideTooltip } = await import('../ui/view/tooltip.js')
    const target = { dataset: { tooltip: 'hello' } }
    showTooltip(target)
    assert.equal(open, true, 'shown as a popover')
    assert.equal(classes.has('visible'), true)
    hideTooltip()
    assert.equal(classes.has('visible'), false)
    assert.equal(open, false, 'no longer :popover-open once hidden')
    // Showing again works from the closed state.
    showTooltip({ dataset: { tooltip: 'again' } })
    assert.equal(open, true)
    hideTooltip()
    assert.equal(open, false)
  } finally {
    globalThis.document = originalDocument
    globalThis.window = originalWindow
  }
})
