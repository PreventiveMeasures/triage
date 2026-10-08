import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
import '../ui/view/frontend-install.js'

const { renderStage, renderTopBar } = await import('../ui/view/graph/render.js')
const { graph2 } = await import('../ui/view/graph/state.js')

function renderText(value) {
  if (Array.isArray(value)) return value.map(renderText).join('')
  if (value?.strings) return value.strings.map((text, index) => text + renderText(value.values[index])).join('')
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

const graph = {
  nodes: [{ file: 'src/a.js', pkg: '__own__', totalIssues: 1, severitySet: new Set(['high']), colorSet: new Set(['none']) }],
  edges: [], packages: ['__own__'], reasons: [],
}
const bundle = { showBundleLayouts: true, hideAllFiles: true }
// Each top-level row of the topbar, by its row class.
const rows = markup => [...markup.matchAll(/<div class="graph2-topbar-row graph2-topbar-row-(\w+)[^"]*">/gu)].map((m, i, all) =>
  [m[1], markup.slice(m.index, all[i + 1]?.index ?? markup.length)])

test('the bundle graph offers Issues only when findings matched, and shows issue controls only while it is on', t => {
  t.after(() => { graph2.bundleIssues = false })
  graph2.bundleIssues = false
  const none = renderText(renderTopBar(graph, { ...bundle, hasIssues: false }))
  assert.deepEqual(rows(none).map(([name]) => name), ['main'])
  assert.doesNotMatch(none, /data-g2-bundle-issues|<severity-chips|<triage-filter|<triage-selector/u)

  const off = rows(renderText(renderTopBar(graph, { ...bundle, hasIssues: true })))
  assert.deepEqual(off.map(([name]) => name), ['main'], 'no issue row while Issues is off')
  assert.match(off[0][1], /label="Issues"/u)
  assert.doesNotMatch(off[0][1], /<severity-chips|<triage-filter|<triage-selector/u)

  graph2.bundleIssues = true
  const [main, issues] = rows(renderText(renderTopBar(graph, { ...bundle, hasIssues: true })))
  assert.equal(issues?.[0], 'issues')
  const order = ['<severity-chips', '<triage-filter', '<triage-selector'].map(part => issues[1].indexOf(part))
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), 'severity, then mark and status filters')
  assert.doesNotMatch(main[1], /<severity-chips|<triage-filter|<triage-selector/u)
})

test('the bundle graph ends its first row with the scope selector, Issues, then fullscreen pinned after the wrapping controls', () => {
  const [[, main]] = rows(renderText(renderTopBar({ ...graph, reasons: ['run'] }, { ...bundle, hasIssues: true })))
  assert.match(main, /graph2-topbar-row-pinned/u)
  const at = part => main.indexOf(part)
  assert.ok(at('class="g2-topbar-controls"') >= 0)
  const order = ['g2-path-filter-wrap', '<bundle-scope-selector', 'label="Issues"', 'id="g2-fullscreen"'].map(at)
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), 'path filter, scope selector, Issues, fullscreen')
  assert.doesNotMatch(main, /<select/u, 'the full scope selector replaces the plain reason select')
})

test('a bundle Issues switch that does not fit in the first row leads the issue row, before its filters', t => {
  t.after(() => { graph2.bundleIssues = false })
  for (const on of [false, true]) {
    graph2.bundleIssues = on
    const [main, issues] = rows(renderText(renderTopBar(graph, { ...bundle, hasIssues: true }, null, { issuesWrapped: true })))
    assert.doesNotMatch(main[1], /label="Issues"/u)
    assert.equal(issues?.[0], 'issues', `the issue row is shown with Issues ${on ? 'on' : 'off'}`)
    const at = part => issues[1].indexOf(part)
    assert.ok(at('label="Issues"') >= 0 && (on ? at('label="Issues"') < at('<severity-chips') : at('<severity-chips') < 0))
  }
})

test('the findings graph keeps its single toolbar row with issue controls', () => {
  const markup = renderText(renderTopBar(graph, {}))
  assert.deepEqual(rows(markup).map(([name]) => name), ['main'])
  assert.match(markup, /<severity-chips[\s\S]*<triage-filter[\s\S]*<triage-selector[\s\S]*id="g2-fullscreen"/u)
  assert.doesNotMatch(markup, /data-g2-bundle-issues/u)
})

test('the stage footer counts issues only when the graph shows them', () => {
  assert.match(renderText(renderStage(graph)), /<b>1<\/b> issues/u)
  assert.doesNotMatch(renderText(renderStage({ ...graph, issuesHidden: true })), / issues</u)
})
