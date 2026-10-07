import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BUNDLE_ICON_SVG, COMMIT_ICON_SVG, GITHUB_ICON_SVG } from '../ui/view/icons.js'

// The shared tooltip is a manual popover (so it shows above modal
// dialogs). Hiding it must close the popover too: an open-but-invisible
// one still matches `:popover-open`, which other code reads as "a
// popover is up" — Escape in events.js stopped dismissing the links
// preview after the first tooltip (review r4099015016).
test('tooltips preserve popover lifecycle and keep repository paths inside the viewport', async t => {
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window
  let open = false
  const classes = new Set()
  const listeners = {}
  let text = ''
  const node = {
    id: '', style: {}, offsetWidth: 100, offsetHeight: 32, children: [],
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
  }, body: { append() {}, addEventListener() {} } }
  globalThis.window = { innerWidth: 1000, innerHeight: 800 }
  try {
    const { showTooltip, hideTooltip, scheduleTooltip, installGlobalTooltipListener, installShadowTooltipListener } = await import('../ui/view/tooltip.js')
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
    target.dataset.tooltipBundle = 'sourcemap'
    target.dataset.tooltipStats = '4 files · 123 LoC'
    showTooltip(target)
    assert.equal(node.children[1].innerHTML, BUNDLE_ICON_SVG)
    assert.equal(node.children[1].children[0].textContent, 'Sourcemap · 4 files · 123 LoC')
    target.dataset.tooltipBundle = 'stasis'
    showTooltip(target)
    assert.equal(node.children[1].children[0].src, './stasis.svg')
    assert.equal(node.children[1].children[1].textContent, 'Stasis · 4 files · 123 LoC')
    delete target.dataset.tooltipStats
    showTooltip(target)
    assert.equal(node.children[1].children[1].textContent, 'Stasis', 'missing counts do not appear as zero')
    target.dataset.tooltipBuilt = 'true'
    showTooltip(target)
    assert.equal(node.children[1].children[1].textContent, 'Stasis · Built on server', 'a visible tooltip follows the build label')
    delete target.dataset.tooltipBuilt
    for (const length of [40, 64]) {
      target.dataset.tooltipCommit = '0123456789abcdef'.repeat(4).slice(0, length)
      showTooltip(target)
      const commit = node.children[0].children[1]
      assert.equal(commit.className, 'tooltip-commit')
      assert.equal(commit.innerHTML, COMMIT_ICON_SVG, 'reuse the overview commit icon')
      assert.equal(commit.children[0].textContent, '0123456', 'match the overview seven-character hash')
    }
    target.dataset.tooltipCommit = 'b'.repeat(40)
    showTooltip(target)
    assert.equal(node.children[0].children[1].children[0].textContent, 'bbbbbbb', 'a visible tooltip follows commit changes')
    for (const invalid of ['', 'abcdef0', '<img onerror=alert(1)>', 'z'.repeat(40)]) {
      target.dataset.tooltipCommit = invalid
      showTooltip(target)
      assert.equal(node.children[0].children.length, 1, 'missing or malformed commits have no placeholder')
    }
    delete target.dataset.tooltipRepo
    target.dataset.tooltipCommit = 'a'.repeat(40)
    showTooltip(target)
    assert.equal(node.children[0].children[0].children[0].textContent, 'aaaaaaa', 'unattached bundles can still show their source commit')
    delete target.dataset.tooltipCommit
    hideTooltip()
    assert.equal(classes.has('visible'), false)
    assert.equal(open, false, 'no longer :popover-open once hidden')
    // Showing again works from the closed state.
    showTooltip({ dataset: { tooltip: 'again' } })
    assert.equal(open, true)
    assert.equal(node.children.length, 0, 'plain tooltips do not retain the GitHub row')
    hideTooltip()
    assert.equal(open, false)
    let rowTop = 200
    const sidebarTarget = {
      dataset: { tooltip: 'report.json', tooltipRepo: `org/repo/${'long-directory/'.repeat(30)}` },
      getBoundingClientRect: () => ({ right: 260, top: rowTop, height: 32 }),
    }
    for (const [viewportWidth, tooltipWidth, expectedLeft] of [[1280, 700, 268], [800, 700, 92], [320, 288, 24], [1000, 100, 268]]) {
      globalThis.window.innerWidth = viewportWidth
      node.offsetWidth = tooltipWidth
      showTooltip(sidebarTarget, { placement: 'right' })
      assert.equal(node.style.left, `${expectedLeft}px`)
      assert.ok(expectedLeft >= 8 && expectedLeft + tooltipWidth <= viewportWidth - 8, 'the full repository row stays inside the viewport')
      assert.equal(node.style.top, '200px', 'sidebar tooltips stay vertically centered when they fit')
      assert.equal(node.style.transform, 'none', 'the bounded top is the actual top edge')
      hideTooltip()
    }
    globalThis.window.innerWidth = 320
    node.offsetWidth = 288
    for (const [targetTop, tooltipHeight, viewportHeight, expectedTop] of [[0, 180, 600, 8], [200, 180, 600, 126], [568, 180, 600, 412], [0, 220, 240, 8], [208, 220, 240, 12]]) {
      rowTop = targetTop
      node.offsetHeight = tooltipHeight
      globalThis.window.innerHeight = viewportHeight
      showTooltip(sidebarTarget, { placement: 'right' })
      assert.equal(node.style.left, '24px')
      assert.equal(node.style.top, `${expectedTop}px`)
      assert.ok(expectedTop >= 8 && expectedTop + tooltipHeight <= viewportHeight - 8, 'wrapped repository paths stay inside the top and bottom edges')
      hideTooltip()
    }
    globalThis.window.innerWidth = 800
    globalThis.window.innerHeight = 800
    node.offsetWidth = 700
    node.offsetHeight = 100
    for (const [clientX, clientY, expectedLeft, expectedTop] of [[790, 100, 92, 114], [0, 100, 8, 114], [790, 790, 92, 692]]) {
      listeners.mousemove({ clientX, clientY })
      showTooltip({ dataset: { tooltip: 'plain cursor tooltip' } })
      assert.equal(node.style.left, `${expectedLeft}px`, 'cursor placement retains both viewport margins')
      assert.equal(node.style.top, `${expectedTop}px`)
      assert.equal(node.style.transform, 'none')
      hideTooltip()
    }
    await t.test('dependency tooltips keep the path first and add literal identity, icon, file count, and GitHub', () => {
      const icon = { tagName: 'svg', className: 'bundle-code-tree-soldeer' }
      const packageTarget = {
        dataset: { tooltip: 'dependencies/pkg-1.0.0/src', tooltipPackage: '<img onerror=alert(1)>', tooltipEcosystem: 'soldeer', tooltipVersion: '1.0.0', tooltipFiles: '1', tooltipRepo: 'org/pkg' },
        querySelector: () => ({ cloneNode: () => icon }),
      }
      showTooltip(packageTarget)
      assert.equal(node.textContent, 'dependencies/pkg-1.0.0/src', 'the original directory stays first')
      assert.equal(node.children[0].className, 'tooltip-package')
      assert.equal(node.children[0].children[0], icon, 'reuse the row ecosystem icon')
      const packageFields = () => node.children[0].children[1].children
      assert.deepEqual(packageFields().map(field => field.textContent), ['<img onerror=alert(1)>', '1.0.0', '1 file'])
      assert.ok(packageFields().every(field => field.innerHTML === undefined), 'package fields never become HTML')
      assert.equal(node.children[1].children[0].textContent, 'org/pkg')
      packageTarget.dataset.tooltipVersion = '2.0.0'
      packageTarget.dataset.tooltipFiles = '12'
      showTooltip(packageTarget)
      assert.deepEqual(packageFields().map(field => field.textContent), ['<img onerror=alert(1)>', '2.0.0', '12 files'])
      delete packageTarget.dataset.tooltipVersion
      delete packageTarget.dataset.tooltipRepo
      showTooltip(packageTarget)
      assert.deepEqual(packageFields().map(field => field.textContent), ['<img onerror=alert(1)>', '12 files'])
      assert.equal(node.children.length, 1)
      showTooltip({ dataset: { tooltip: 'ordinary/file.sol' } })
      assert.equal(node.children.length, 0, 'ordinary tooltips do not inherit dependency details')
      hideTooltip()
    })
    await t.test('repeated text only shows a tooltip when clipped horizontally or vertically', nested => {
      nested.mock.timers.enable({ apis: ['setTimeout'] })
      const label = { dataset: { tooltip: 'Complete text', tooltipTruncated: '' }, clientWidth: 100, clientHeight: 32 }
      for (const [width, height, visible] of [[100, 32, false], [150, 32, true], [100, 64, true]]) {
        Object.assign(label, { scrollWidth: width, scrollHeight: height })
        scheduleTooltip(label)
        nested.mock.timers.tick(100)
        assert.equal(open, visible)
        if (visible) assert.equal(node.textContent, 'Complete text')
        hideTooltip()
      }
      delete label.dataset.tooltipTruncated
      Object.assign(label, { scrollWidth: 100, scrollHeight: 32 })
      scheduleTooltip(label)
      nested.mock.timers.tick(100)
      assert.equal(open, true, 'full hashes and explanatory hints remain available without clipping')
      hideTooltip()
    })
    await t.test('pickers register with the host tooltip and handle transitions within their own root', nested => {
      nested.mock.timers.enable({ apis: ['setTimeout'] })
      const outerListeners = {}
      const pageRoot = { nodeType: 11, addEventListener(type, listener) { outerListeners[type] = listener } }
      const pickerHost = { nodeType: 1, dataset: {} }
      const innerListeners = {}
      const pickerRoot = { nodeType: 11, addEventListener(type, listener) { innerListeners[type] = listener } }
      const file = { nodeType: 1, dataset: { tooltip: 'src/entry.ts' } }
      const label = { nodeType: 1, dataset: {}, closest: () => file }
      const event = { target: pickerHost, composedPath: () => [label, file, pickerRoot, pickerHost, pageRoot] }
      installShadowTooltipListener(pageRoot)
      installGlobalTooltipListener()
      pickerHost.shadowRoot = pickerRoot
      const connected = { composedPath: () => [pickerHost, pageRoot] }
      listeners['tooltip-root-connected'](connected)
      const firstListener = innerListeners.mouseover
      assert.equal(typeof firstListener, 'function', 'the host installs the nested picker listener')
      listeners['tooltip-root-connected'](connected)
      assert.equal(innerListeners.mouseover, firstListener, 'reconnects do not add duplicate listeners')
      outerListeners.mouseover(event)
      nested.mock.timers.tick(100)
      assert.equal(open, true)
      assert.equal(node.textContent, 'src/entry.ts')
      // The browser trims transitions whose target and relatedTarget both
      // retarget to pickerHost. Deliver these only to the picker listener.
      const otherFile = { nodeType: 1, dataset: { tooltip: 'src/other.ts' }, closest() { return this } }
      const otherEvent = { target: otherFile, composedPath: () => [otherFile, pickerRoot] }
      innerListeners.mouseout({ ...event, relatedTarget: otherFile })
      innerListeners.mouseover(otherEvent)
      nested.mock.timers.tick(100)
      assert.equal(node.textContent, 'src/other.ts', 'moving between tiles replaces the tooltip')
      innerListeners.mouseout({ ...otherEvent, relatedTarget: otherFile })
      assert.equal(open, true, 'moving within the file keeps its tooltip visible')
      const gap = { nodeType: 1, dataset: {} }
      innerListeners.mouseout({ ...otherEvent, relatedTarget: gap })
      assert.equal(open, false, 'moving into a grid gap closes the tooltip')
      innerListeners.mouseover(otherEvent)
      nested.mock.timers.tick(100)
      assert.equal(open, true, 'entering a tile from a grid gap opens its tooltip')
      innerListeners.mouseout({ ...otherEvent, relatedTarget: gap })
      innerListeners.mouseover(event)
      innerListeners.mouseout({ ...event, relatedTarget: null })
      nested.mock.timers.tick(100)
      assert.equal(open, false, 'leaving before the delay cancels the tooltip')
    })
  } finally {
    globalThis.document = originalDocument
    globalThis.window = originalWindow
  }
})
