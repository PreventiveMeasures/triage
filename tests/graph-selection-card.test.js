import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
import '../ui/view/frontend-install.js'

const { renderSelectionCard } = await import('../ui/view/graph/render.js')
const { graph2 } = await import('../ui/view/graph/state.js')

function renderText(value) {
  if (Array.isArray(value)) return value.map(renderText).join('')
  if (value?.strings) return value.strings.map((text, index) => text + renderText(value.values[index])).join('')
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

test('a bundle file card jumps to its findings only where bundles have an Issues tab', t => {
  const previous = graph2.selected
  t.after(() => { graph2.selected = previous })
  graph2.selected = 'src/a.js'
  const node = { pkg: '__own__', size: 10, own: { high: 1 }, subtree: { high: 2 }, totalIssues: 2, origFile: 'app/src/a.js' }
  const graph = { nodeByFile: new Map([['src/a.js', node]]), importedBy: new Map(), importsOf: new Map() }
  const card = ctx => renderText(renderSelectionCard(graph, ctx))
  assert.match(card({ isBundleContext: true }), /data-g2-jump-findings=src\/a\.js/u)
  // Managed bundles have no Issues tab: View source shows the file's issues instead.
  const managed = card({ isBundleContext: true, findingsJump: false })
  assert.doesNotMatch(managed, /data-g2-jump-findings/u)
  assert.match(managed, /data-bundle-view-source=app\/src\/a\.js/u)
})
