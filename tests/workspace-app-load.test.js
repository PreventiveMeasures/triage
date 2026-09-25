import assert from 'node:assert/strict'
import { beforeEach, it, mock } from 'node:test'

const workspace = { id: 'workspace', reports: ['app.json'] }
const reports = [{ fileName: 'app.json' }]
const indexedToken = { revision: 'after' }, originalToken = { revision: 'before' }
let computed, current, indexed, links, onLinks, ready, reportsCurrent, saved, token, verification
mock.module('../client/index.js', { namedExports: {
  ensureLinkedFindingsIndexed: () => { indexed++; return verification.promise },
  subscribeToLinkedFindings: (cb) => { onLinks = cb },
  workspaceAppReportsCurrent: () => reportsCurrent,
  workspaceAppCacheToken: (ws, previous) => {
    assert.equal(ws, workspace)
    assert.equal(previous, originalToken)
    return Promise.resolve(token)
  },
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
    assert.deepEqual(duplicatesOf('A'), links)
    computed++
    return { appMode: true, appFindings: 3 - links.length }
  },
} })
const { getLoadedWorkspaceAppMetadata, setLoadedWorkspaceAppReports, updateWorkspaceAppMetadata } = await import('../ui/view/workspace-app-load.js')

beforeEach(() => {
  verification = Promise.withResolvers()
  saved = []; ready = []; links = ['A', 'B']; indexed = 0; computed = 0
  current = true; token = indexedToken; reportsCurrent = true
})
const update = (complete = true) => updateWorkspaceAppMetadata(workspace, reports, originalToken, {
  complete, isCurrent: () => current, onReady: (metadata) => { ready.push(metadata) },
})

it('verifies links directly without waiting for unrelated report counts before persisting metadata', async () => {
  const pending = update()
  await Promise.resolve()
  assert.equal(indexed, 1)
  assert.equal(computed, 0)
  assert.deepEqual(saved, [])
  verification.resolve()
  await pending
  assert.equal(indexed, 1)
  assert.deepEqual(saved, [{ appMode: true, appFindings: 1 }])
  assert.deepEqual(ready, saved)
})

it('abandons metadata work when another view replaces the workspace load', async () => {
  const pending = update()
  current = false
  verification.resolve()
  await pending
  assert.equal(indexed, 1)
  assert.equal(computed, 0)
  assert.deepEqual(saved, [])
  assert.deepEqual(ready, [])
})

it('does not compute or cache reports invalidated during background verification', async () => {
  const pending = update()
  token = null
  verification.resolve()
  await pending
  assert.equal(computed, 0)
  assert.deepEqual(saved, [])
  assert.deepEqual(ready, [])
})

it('records an incomplete workspace as ineligible instead of promoting its partial reports', async () => {
  const pending = update(false)
  verification.resolve()
  await pending
  assert.equal(computed, 0)
  assert.deepEqual(saved, [{ appMode: false }])
})

const load = (complete = true) => setLoadedWorkspaceAppReports(workspace, reports, originalToken, {
  complete, isCurrent: () => current,
})

it('shows the completed focused workspace count while unrelated verification remains blocked', async () => {
  load()
  const pending = update()
  assert.deepEqual(getLoadedWorkspaceAppMetadata(workspace), { appMode: true, appFindings: 1 })
  assert.deepEqual(saved, [], 'the live count is not persisted before full verification')
  getLoadedWorkspaceAppMetadata(workspace)
  assert.equal(computed, 1, 'sidebar refreshes reuse the calculation while links are unchanged')
  links = ['A', 'B', 'C']
  onLinks()
  assert.deepEqual(getLoadedWorkspaceAppMetadata(workspace), { appMode: true, appFindings: 0 })
  assert.equal(computed, 2, 'new links refresh the displayed count')
  verification.resolve()
  await pending
  assert.deepEqual(saved, [{ appMode: true, appFindings: 0 }])
})

it('withholds live counts for another workspace, changed membership, invalidated reports, or navigation', () => {
  load()
  assert.equal(getLoadedWorkspaceAppMetadata({ ...workspace, id: 'other' }), null)
  assert.equal(getLoadedWorkspaceAppMetadata({ ...workspace, reports: ['new.json'] }), null)
  reportsCurrent = false
  assert.equal(getLoadedWorkspaceAppMetadata(workspace), null)
  reportsCurrent = true
  current = false
  assert.equal(getLoadedWorkspaceAppMetadata(workspace), null)
  assert.equal(computed, 0)
})

it('does not display an App count from an incomplete workspace load', () => {
  load(false)
  assert.deepEqual(getLoadedWorkspaceAppMetadata(workspace), { appMode: false })
  assert.equal(computed, 0)
})
