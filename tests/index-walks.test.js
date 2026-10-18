import assert from 'node:assert/strict'
import { test } from 'node:test'

test('the sidebar\'s index walks wait for the boot\'s first view, start then if still asked for in that mode, and at once after', async (t) => {
  let mode = 'local'
  const walks = []
  t.mock.module('../client/index.js', { namedExports: {
    clientModeLabel: () => mode,
    ensureBundleFindingsIndexed: () => { walks.push('bundle'); return Promise.resolve() },
    ensureLinkedFindingsIndexed: () => { walks.push('links'); return Promise.resolve() },
  } })
  const { releaseIndexWalks, startIndexWalks } = await import(`../ui/view/index-walks.js?boot=${Date.now()}`)
  startIndexWalks()
  startIndexWalks()
  assert.deepEqual(walks, [], 'none while the first view is being restored')
  releaseIndexWalks()
  assert.deepEqual(walks, ['bundle', 'links'], 'those asked for, once, at the release')
  releaseIndexWalks()
  assert.equal(walks.length, 2, 'released once')
  startIndexWalks()
  assert.deepEqual(walks.slice(2), ['bundle', 'links'], 'at once after it')

  // Asked for in a mode the client has since left: the release starts none.
  const later = await import(`../ui/view/index-walks.js?moved=${Date.now()}`)
  walks.length = 0
  later.startIndexWalks()
  mode = 'managed'
  later.releaseIndexWalks()
  assert.deepEqual(walks, [])
  // And none asked for at all: none.
  const unasked = await import(`../ui/view/index-walks.js?unasked=${Date.now()}`)
  unasked.releaseIndexWalks()
  assert.deepEqual(walks, [])
})
