import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GITHUB_ICON_SVG } from '../ui/view/icons.js'

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
  let text = ''
  const node = {
    id: '', style: {}, offsetWidth: 100, children: [],
    get textContent() { return text },
    set textContent(value) { text = value; this.children = [] },
    append(child) { this.children.push(child) },
    setAttribute() {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    showPopover() { if (open) throw new Error('already open'); open = true },
    hidePopover() { if (!open) throw new Error('not open'); open = false },
    matches(sel) { return sel === ':popover-open' && open },
  }
  let created = false
  globalThis.document = { addEventListener() {}, createElement: () => {
    if (!created) { created = true; return node }
    return { children: [], append(child) { this.children.push(child) } }
  }, body: { append() {} } }
  globalThis.window = { innerWidth: 1000 }
  try {
    const { showTooltip, hideTooltip } = await import('../ui/view/tooltip.js')
    const target = { dataset: { tooltip: 'hello' } }
    showTooltip(target)
    assert.equal(open, true, 'shown as a popover')
    assert.equal(classes.has('visible'), true)
    target.dataset.tooltipRepo = 'org/repo/src/<img onerror=alert(1)>'
    showTooltip(target)
    assert.equal(node.textContent, 'hello')
    assert.equal(node.children[0].innerHTML, GITHUB_ICON_SVG, 'only the built-in icon is parsed as markup')
    assert.equal(node.children[0].children[0].textContent, target.dataset.tooltipRepo, 'repository paths remain literal text')
    target.dataset.tooltipRepo = 'org/repo/updated'
    showTooltip(target)
    assert.equal(node.children[0].children[0].textContent, 'org/repo/updated', 'a visible tooltip follows location changes')
    hideTooltip()
    assert.equal(classes.has('visible'), false)
    assert.equal(open, false, 'no longer :popover-open once hidden')
    // Showing again works from the closed state.
    showTooltip({ dataset: { tooltip: 'again' } })
    assert.equal(open, true)
    assert.equal(node.children.length, 0, 'plain tooltips do not retain the GitHub row')
    hideTooltip()
    assert.equal(open, false)
  } finally {
    globalThis.document = originalDocument
    globalThis.window = originalWindow
  }
})
