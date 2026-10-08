import assert from 'node:assert/strict'
import { test } from 'node:test'

const { cleanupGraph2, graph2 } = await import('../ui/view/graph/state.js')

test('a kept viewport survives the re-attach teardown and is dropped by any other teardown', t => {
  t.after(() => { graph2.graphState = null; graph2.keptViewport = null })
  const kept = { key: 'view', k: 3, tx: 1, ty: 2 }
  graph2.graphState = { _cleanup: ({ keepViewport }) => { graph2.keptViewport = keepViewport ? kept : null } }
  // The Issues switch keeps the viewport, then the re-attach tears down
  // again with nothing attached: the kept viewport must still be there.
  cleanupGraph2({ keepViewport: true })
  assert.equal(graph2.keptViewport, kept)
  cleanupGraph2({ keepViewport: true })
  assert.equal(graph2.keptViewport, kept)
  // Layout, Packages, reason, focus and navigation teardowns refit.
  cleanupGraph2()
  assert.equal(graph2.keptViewport, null)
  graph2.graphState = { _cleanup: ({ keepViewport }) => { graph2.keptViewport = keepViewport ? kept : null } }
  cleanupGraph2()
  assert.equal(graph2.keptViewport, null)
})
