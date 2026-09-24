import assert from 'node:assert/strict'
import { beforeEach, it, mock } from 'node:test'

const workspace = { id: 'workspace', reports: ['app.json'] }
const reports = [{ fileName: 'app.json' }]
const indexedToken = { revision: 'after' }, originalToken = { revision: 'before' }
let computed, counts, current, indexed, links, ready, saved, token
mock.module('../client/index.js', { namedExports: {
  listFiles: () => Promise.resolve(['unrelated.json', 'app.json', 'links.json']),
  ensureCounts: () => counts.promise,
  ensureLinkedFindingsIndexed: () => { indexed++; links = ['A', 'B']; return Promise.resolve() },
  workspaceAppCacheToken: (previous) => { assert.equal(previous, originalToken); return Promise.resolve(token) },
  duplicatesOf: () => links,
  cacheWorkspaceAppMetadata: (ws, metadata, captured) => {
    assert.equal(ws, workspace)
    assert.equal(captured, indexedToken)
    saved.push(metadata)
    return Promise.resolve(true)
  },
} })
mock.module('../ui/view/workspace-app.js', { namedExports: {
  workspaceAppMetadata: (loaded, duplicatesOf) => {
    assert.equal(loaded, reports)
    assert.deepEqual(duplicatesOf('A'), ['A', 'B'])
    computed++
    return { appMode: true, appFindings: 1 }
  },
} })
const { updateWorkspaceAppMetadata } = await import('../ui/view/workspace-app-load.js')

beforeEach(() => {
  counts = Promise.withResolvers()
  saved = []; ready = []; links = []; indexed = 0; computed = 0
  current = true; token = indexedToken
})
const update = (complete = true) => updateWorkspaceAppMetadata(workspace, reports, originalToken, {
  complete, isCurrent: () => current, onReady: (metadata) => { ready.push(metadata) },
})

it('waits for global classification and linking before caching metadata for the loaded snapshot', async () => {
  const pending = update()
  await Promise.resolve()
  assert.equal(indexed, 0)
  assert.equal(computed, 0)
  assert.deepEqual(saved, [])
  counts.resolve()
  await pending
  assert.equal(indexed, 1)
  assert.deepEqual(saved, [{ appMode: true, appFindings: 1 }])
  assert.deepEqual(ready, saved)
})

it('abandons metadata work when another view replaces the workspace load', async () => {
  const pending = update()
  current = false
  counts.resolve()
  await pending
  assert.equal(indexed, 0)
  assert.equal(computed, 0)
  assert.deepEqual(saved, [])
  assert.deepEqual(ready, [])
})

it('does not compute or cache reports invalidated during background classification', async () => {
  const pending = update()
  token = null
  counts.resolve()
  await pending
  assert.equal(computed, 0)
  assert.deepEqual(saved, [])
  assert.deepEqual(ready, [])
})

it('records an incomplete workspace as ineligible instead of promoting its partial reports', async () => {
  const pending = update(false)
  counts.resolve()
  await pending
  assert.equal(computed, 0)
  assert.deepEqual(saved, [{ appMode: false }])
})
