import assert from 'node:assert/strict'
import { test } from 'node:test'

const { graphViewKey } = await import('../ui/view/graph/view-key.js')
const { graph2 } = await import('../ui/view/graph/state.js')

test('a graph view key tells apart bundles with the same files, and layouts, but not repeat builds of one view', t => {
  const previous = graph2.bundleLayout
  t.after(() => { graph2.bundleLayout = previous })
  const graph = (viewId, files = ['src/a.js', 'src/b.js']) => ({ viewId, files, edges: [{ a: 'src/a.js', b: 'src/b.js' }] })
  assert.equal(graphViewKey(graph('sha512-one')), graphViewKey(graph('sha512-one')), 'a rebuilt graph of the same bundle keeps its view')
  assert.notEqual(graphViewKey(graph('sha512-one')), graphViewKey(graph('sha512-two')), 'another bundle with the same files refits')
  assert.notEqual(graphViewKey(graph('sha512-one')), graphViewKey(graph('sha512-one', ['src/a.js', 'src/c.js'])))
  const key = graphViewKey(graph('sha512-one'))
  graph2.bundleLayout = graph2.bundleLayout === 'layers' ? 'graph' : 'layers'
  assert.notEqual(graphViewKey(graph('sha512-one')), key, 'another layout refits')
})
