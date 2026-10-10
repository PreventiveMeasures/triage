import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/graph/size-flow.js'
import { BUNDLE_ICON_SVG, COMMIT_ICON_SVG, GITHUB_ICON_SVG, TAG_ICON_SVG } from '../ui/view/icons.js'
import { bundleCommitTooltip } from '../ui/view/bundle-origin-links.js'

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
  const bodyListeners = {}
  const windowListeners = {}
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
    return { children: [], append(...children) { this.children.push(...children) } }
  }, body: { append() {}, addEventListener(type, listener) { bodyListeners[type] = listener } } }
  globalThis.window = { innerWidth: 1000, innerHeight: 800, addEventListener(type, listener) { windowListeners[type] = listener } }
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
    const sha = 'a'.repeat(40)
    const info = { sha, github: 'Org/Repo', tags: ['v1.0.0', '<img onerror=alert(1)>'],
      details: { subject: 'Fix the parser', authorName: 'Alice', authorLogin: 'alice', authoredAt: 1, committedAt: Date.UTC(2026, 9, 1, 12) } }
    assert.equal(bundleCommitTooltip(info, 'b'.repeat(40)), undefined, 'catalog info only describes its own commit')
    assert.equal(bundleCommitTooltip({ sha, tags: [], details: null }, sha), undefined)
    assert.equal(bundleCommitTooltip(null, sha), undefined)
    target.dataset.tooltipCommit = sha
    target.dataset.tooltipCommitInfo = bundleCommitTooltip(info, sha, 'org/repo')
    showTooltip(target)
    const tags = node.children[1]
    assert.equal(node.children[0].children.length, 2)
    assert.equal(tags.className, 'tooltip-tags', 'tags go on a line of their own under the commit')
    assert.deepEqual(tags.children.map(tag => [tag.className, tag.innerHTML, tag.children[0].textContent]),
      [['tooltip-tag', TAG_ICON_SVG, 'v1.0.0'], ['tooltip-tag', TAG_ICON_SVG, '<img onerror=alert(1)>']], 'tag names stay literal text')
    target.dataset.tooltipCommitInfo = bundleCommitTooltip({ ...info, tags: Array.from({ length: 1020 }, (_, i) => `pkg-${i}@1.0.0`) }, sha, 'org/repo')
    showTooltip(target)
    const many = node.children[1].children
    assert.deepEqual(many.slice(0, 8).map(tag => tag.children[0].textContent), Array.from({ length: 8 }, (_, i) => `pkg-${i}@1.0.0`),
      'a tooltip, which cannot scroll, shows the first few tags')
    assert.deepEqual([many.length, many.at(-1).className, many.at(-1).textContent], [9, 'tooltip-tag-more', `+${(1012).toLocaleString()} more`])
    target.dataset.tooltipCommitInfo = bundleCommitTooltip(info, sha, 'org/repo')
    showTooltip(target)
    const details = node.children[2]
    assert.equal(details.className, 'tooltip-commit-details')
    assert.equal(details.children[0].textContent, 'Fix the parser', 'the subject leads the details')
    assert.equal(details.children[1].textContent, `Alice (@alice) · ${new Date(Date.UTC(2026, 9, 1, 12)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`)
    assert.equal(node.children[3].className, 'tooltip-bundle')
    target.dataset.tooltipCommitInfo = bundleCommitTooltip({ sha, tags: [], details: { subject: 'Only', authorName: null, authorLogin: 'bot', authoredAt: Date.UTC(2026, 0, 1), committedAt: null } }, sha)
    showTooltip(target)
    assert.deepEqual(node.children.map(child => child.className), ['tooltip-repo', 'tooltip-commit-details', 'tooltip-bundle'], 'a visible tooltip follows tag changes')
    assert.equal(node.children[1].children[1].textContent, `@bot · ${new Date(Date.UTC(2026, 0, 1)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`, 'the author date stands in for a missing commit date')
    target.dataset.tooltipCommitInfo = '{not json'
    showTooltip(target)
    assert.deepEqual(node.children.map(child => child.className), ['tooltip-repo', 'tooltip-bundle'], 'malformed commit info shows the commit alone')
    showTooltip({ dataset: { tooltip: sha, tooltipCommitInfo: bundleCommitTooltip(info, sha) } })
    assert.equal(node.textContent, sha)
    assert.deepEqual(node.children.map(child => child.className), ['tooltip-commit-details'], 'a commit link shows its details without a repository row')
    showTooltip({ dataset: { tooltip: sha, tooltipIcon: 'commit', tooltipCommitInfo: bundleCommitTooltip(info, sha) } })
    const [hashLine, commitDetails] = node.children
    assert.deepEqual([node.textContent, hashLine.className, hashLine.innerHTML, hashLine.children[0].textContent, commitDetails.className],
      ['', 'tooltip-text', COMMIT_ICON_SVG, sha, 'tooltip-commit-details'], 'the commit icon leads the hash, which stays literal text')
    for (const tooltipIcon of ['unknown', '__proto__', 'toString', '']) {
      showTooltip({ dataset: { tooltip: '<b>text</b>', tooltipIcon } })
      assert.deepEqual([node.textContent, node.children.length], ['<b>text</b>', 0], `no icon for ${JSON.stringify(tooltipIcon)}`)
    }
    delete target.dataset.tooltipCommitInfo
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
      // LoC and size arrive on hover, after the target first rendered.
      Object.assign(packageTarget.dataset, { tooltipLoc: '1234', tooltipSize: '55.5 KiB' })
      showTooltip(packageTarget)
      assert.deepEqual(packageFields().map(field => field.textContent), ['<img onerror=alert(1)>', '2.0.0', '12 files', '1,234 LoC', '55.5 KiB'])
      Object.assign(packageTarget.dataset, { tooltipLoc: '1', tooltipSize: '' })
      showTooltip(packageTarget)
      assert.deepEqual(packageFields().map(field => field.textContent), ['<img onerror=alert(1)>', '2.0.0', '12 files', '1 LoC'])
      delete packageTarget.dataset.tooltipLoc
      delete packageTarget.dataset.tooltipSize
      delete packageTarget.dataset.tooltipVersion
      delete packageTarget.dataset.tooltipRepo
      showTooltip(packageTarget)
      assert.deepEqual(packageFields().map(field => field.textContent), ['<img onerror=alert(1)>', '12 files'])
      assert.equal(node.children.length, 1)
      const githubIcon = { tagName: 'svg', className: 'github' }, npmIcon = { tagName: 'svg', className: 'bundle-code-tree-npm' }
      showTooltip({ dataset: { tooltip: 'packages/dep/index.js', tooltipPackage: 'dep', tooltipRepo: 'org/mono' },
        querySelector: selector => ({ cloneNode: () => selector === '[data-tooltip-package-icon] svg' ? npmIcon : githubIcon }) })
      assert.equal(node.children[0].children[0], npmIcon, "a marked package icon wins over the target's own first icon")
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
    await t.test('costly details are prepared only when the tooltip shows, not for a hover that leaves first', nested => {
      nested.mock.timers.enable({ apis: ['setTimeout'] })
      const prepared = []
      const row = {
        dataset: { tooltip: 'node_modules/dep', tooltipPackage: 'dep', tooltipFiles: '2' },
        querySelector: () => null,
        prepareTooltip: el => { prepared.push(el); Object.assign(el.dataset, { tooltipLoc: '42', tooltipSize: '1.0 KiB' }) },
      }
      scheduleTooltip(row)
      nested.mock.timers.tick(50)
      hideTooltip()
      nested.mock.timers.tick(100)
      assert.deepEqual(prepared, [], 'a pointer passing over the row computes nothing')
      scheduleTooltip(row)
      assert.deepEqual(prepared, [], 'nothing before the delay runs out')
      nested.mock.timers.tick(100)
      assert.deepEqual(prepared, [row])
      assert.deepEqual([...node.children[0].children[0].children].map(field => field.textContent), ['dep', '2 files', '42 LoC', '1.0 KiB'], 'prepared before the details are read')
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
    await t.test('nested roots and child transitions share one uninterrupted hover delay', nested => {
      nested.mock.timers.enable({ apis: ['setTimeout'] })
      const rootListeners = {}
      const root = { addEventListener(type, listener) { rootListeners[type] = listener } }
      installShadowTooltipListener(root)
      const bar = { nodeType: 1, dataset: { tooltip: 'entry.js' }, closest() { return this }, contains: child => child === rect }
      const rect = { nodeType: 1, dataset: {}, closest: () => bar }
      const event = { composedPath: () => [rect, bar, root], target: rect, relatedTarget: rect }
      rootListeners.mouseover(event)
      nested.mock.timers.tick(60)
      rootListeners.mouseout(event)
      rootListeners.mouseover(event)
      bodyListeners.mouseout(event)
      bodyListeners.mouseover(event)
      nested.mock.timers.tick(40)
      assert.equal(open, true, 'moving over children or reaching an outer listener does not postpone the tooltip')
      assert.equal(node.textContent, 'entry.js')
      const next = { nodeType: 1, dataset: { tooltip: 'dep.js' } }
      rootListeners.mouseover({ composedPath: () => [next, root] })
      assert.equal(open, false, 'the previous tooltip closes while the next hover is pending')
      nested.mock.timers.tick(100)
      assert.equal(node.textContent, 'dep.js')
      rootListeners.mouseout({ composedPath: () => [next, root], relatedTarget: null })
      assert.equal(open, false)
    })
    await t.test('interaction cancels both visible and pending tooltips without reopening during a drag', nested => {
      nested.mock.timers.enable({ apis: ['setTimeout'] })
      const row = { dataset: { tooltip: 'hovered row' } }
      const dismiss = [listeners.pointerdown, listeners.wheel, listeners.scroll, () => listeners.keydown({ key: 'Escape' }), windowListeners.blur]
      for (const action of dismiss) {
        scheduleTooltip(row)
        nested.mock.timers.tick(50)
        action()
        nested.mock.timers.tick(100)
        assert.equal(open, false, 'interaction cancels a pending tooltip')
        showTooltip(row)
        action()
        assert.equal(open, false, 'interaction closes a visible tooltip')
      }
      const rootListeners = {}
      const root = { addEventListener(type, listener) { rootListeners[type] = listener }, contains: el => el === row }
      installShadowTooltipListener(root)
      showTooltip(row)
      rootListeners.scroll()
      assert.equal(open, false, 'scrolling a shadow sidebar closes its tooltip')
      rootListeners.mouseover({ buttons: 1, composedPath: () => [row, root] })
      nested.mock.timers.tick(100)
      assert.equal(open, false, 'dragging across elements does not open tooltips')
    })
    await t.test('removed or newly ineligible targets never show after the delay', nested => {
      nested.mock.timers.enable({ apis: ['setTimeout'] })
      const row = { dataset: { tooltip: 'old node' }, isConnected: true }
      scheduleTooltip(row)
      row.isConnected = false
      nested.mock.timers.tick(100)
      assert.equal(open, false)
      row.isConnected = true
      let allowed = true
      scheduleTooltip(row, { gate: () => allowed })
      allowed = false
      nested.mock.timers.tick(100)
      assert.equal(open, false, 'a drag starting during the hover delay suppresses it')
      scheduleTooltip(row)
      showTooltip({ dataset: { tooltip: 'new tooltip' } })
      nested.mock.timers.tick(100)
      assert.equal(node.textContent, 'new tooltip', 'a pending tooltip cannot replace a newer immediate one')
      hideTooltip()
    })
    await t.test('component invalidation cancels its tooltip without touching another surface', nested => {
      nested.mock.timers.enable({ apis: ['setTimeout'] })
      const row = { dataset: { tooltip: 'graph node' } }
      const root = { contains: el => el === row }
      const otherRoot = { contains: () => false }
      scheduleTooltip(row)
      hideTooltip(otherRoot)
      nested.mock.timers.tick(100)
      assert.equal(open, true)
      hideTooltip(otherRoot)
      assert.equal(open, true)
      hideTooltip(root)
      assert.equal(open, false)
      scheduleTooltip(row)
      hideTooltip(root)
      nested.mock.timers.tick(100)
      assert.equal(open, false, 'replacing a graph also cancels its pending hover')
    })
    await t.test('Size flow handles internal hovers and cancels them on removal and reconnect', nested => {
      nested.mock.timers.enable({ apis: ['setTimeout'] })
      const previousObserver = globalThis.ResizeObserver
      globalThis.ResizeObserver = class { observe() {} disconnect() {} }
      const Flow = customElements.get('size-flow'), flow = new Flow()
      const rootListeners = {}, stage = new EventTarget()
      const first = { nodeType: 1, dataset: { tooltip: 'entry.js' } }
      const second = { nodeType: 1, dataset: { tooltip: 'dep.js' } }
      const root = flow.renderRoot = {
        addEventListener(type, listener) { rootListeners[type] = listener },
        querySelector: () => stage,
        contains: el => el === first || el === second,
      }
      const over = el => rootListeners.mouseover({ composedPath: () => [el, root] })
      try {
        flow.connectViewport()
        over(first)
        nested.mock.timers.tick(100)
        assert.equal(node.textContent, 'entry.js')
        rootListeners.mouseout({ composedPath: () => [first, root], relatedTarget: second })
        over(second)
        nested.mock.timers.tick(100)
        assert.equal(node.textContent, 'dep.js', 'internal transitions work without reaching graph-layout')
        over(first)
        flow.startPan({ button: 0, pointerId: 1, clientX: 10, clientY: 20 })
        nested.mock.timers.tick(100)
        assert.equal(open, false, 'the component gate cancels a hover when a drag starts')
        flow.endPan({ pointerId: 1 })
        over(first)
        nested.mock.timers.tick(100)
        assert.equal(open, true)
        flow.disconnectedCallback()
        assert.equal(open, false, 'removing the component closes its tooltip')
        const listener = rootListeners.mouseover
        flow.connectViewport()
        assert.equal(rootListeners.mouseover, listener, 'reconnecting does not duplicate listeners')
        over(second)
        flow.disconnectedCallback()
        nested.mock.timers.tick(100)
        assert.equal(open, false, 'removing the component also cancels a pending hover')
      } finally {
        hideTooltip()
        if (previousObserver) globalThis.ResizeObserver = previousObserver
        else delete globalThis.ResizeObserver
      }
    })
  } finally {
    globalThis.document = originalDocument
    globalThis.window = originalWindow
  }
})
