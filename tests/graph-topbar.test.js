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
  assert.deepEqual(off.map(([name]) => name), ['main', 'issues'])
  assert.match(off[1][1], /label="Issues"/u)
  assert.doesNotMatch(off[1][1], /<severity-chips|<triage-filter|<triage-selector/u, 'issue controls stay hidden while Issues is off')

  graph2.bundleIssues = true
  const [main, issues] = rows(renderText(renderTopBar(graph, { ...bundle, hasIssues: true })))
  const order = ['label="Issues"', '<severity-chips', '<triage-filter', '<triage-selector'].map(part => issues[1].indexOf(part))
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), 'Issues, then severity, mark and status filters')
  assert.doesNotMatch(main[1], /<severity-chips|<triage-filter|<triage-selector/u)
})

test('the bundle graph pins fullscreen to the first row, after the wrapping controls', () => {
  const [[, main]] = rows(renderText(renderTopBar(graph, { ...bundle, hasIssues: true })))
  const controls = main.indexOf('class="g2-topbar-controls"')
  assert.ok(controls >= 0)
  assert.ok(main.indexOf('id="g2-fullscreen"') > main.indexOf('g2-path-filter-wrap'), 'fullscreen follows the controls in row one')
  assert.match(main, /graph2-topbar-row-pinned/u)
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
