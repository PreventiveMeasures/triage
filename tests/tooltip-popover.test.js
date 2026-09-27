import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GITHUB_ICON_SVG } from '../ui/view/icons.js'

// The shared tooltip is a manual popover (so it shows above modal
// dialogs). Hiding it must close the popover too: an open-but-invisible
// one still matches `:popover-open`, which other code reads as "a
// popover is up" — Escape in events.js stopped dismissing the links
// preview after the first tooltip (review r4099015016).
test('tooltips preserve popover lifecycle and keep repository paths inside the viewport', async () => {
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window
  let open = false
  const classes = new Set()
  const listeners = {}
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
  globalThis.document = { addEventListener(type, listener) { listeners[type] = listener }, createElement: () => {
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
    const sidebarTarget = {
      dataset: { tooltip: 'report.json', tooltipRepo: `org/repo/${'long-directory/'.repeat(30)}` },
      getBoundingClientRect: () => ({ right: 260, top: 200, height: 32 }),
    }
    for (const [viewportWidth, tooltipWidth, expectedLeft] of [[1280, 700, 268], [800, 700, 92], [320, 288, 24], [1000, 100, 268]]) {
      globalThis.window.innerWidth = viewportWidth
      node.offsetWidth = tooltipWidth
      showTooltip(sidebarTarget, { placement: 'right' })
      assert.equal(node.style.left, `${expectedLeft}px`)
      assert.ok(expectedLeft >= 8 && expectedLeft + tooltipWidth <= viewportWidth - 8, 'the full repository row stays inside the viewport')
      assert.equal(node.style.top, '216px')
      assert.equal(node.style.transform, 'translateY(-50%)', 'sidebar tooltips stay vertically centered')
      hideTooltip()
    }
    globalThis.window.innerWidth = 800
    node.offsetWidth = 700
    for (const [clientX, expectedLeft] of [[790, 92], [0, 8]]) {
      listeners.mousemove({ clientX, clientY: 100 })
      showTooltip({ dataset: { tooltip: 'plain cursor tooltip' } })
      assert.equal(node.style.left, `${expectedLeft}px`, 'cursor placement retains both viewport margins')
      assert.equal(node.style.top, '114px')
      assert.equal(node.style.transform, 'none')
      hideTooltip()
    }
  } finally {
    globalThis.document = originalDocument
    globalThis.window = originalWindow
  }
})
