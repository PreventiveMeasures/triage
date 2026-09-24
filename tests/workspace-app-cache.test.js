import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import './_polyfills.js'
import { SECURE_KEYS, getItem, hydrate, __test__ as secureTest, setItem } from '../client/secure-storage.js'
import { addReportToWorkspace, createWorkspace, deleteWorkspace, listWorkspaces, renameWorkspace } from '../client/workspaces.js'
import { cacheWorkspaceAppMetadata, getWorkspaceAppMetadata, invalidateWorkspaceAppMetadata, workspaceAppCacheToken } from '../client/workspace-app-cache.js'
import { saveFile } from '../client/storage.js'
import { setCount } from '../client/counts.js'
import { ensureLinkedFindingsIndexed } from '../client/linked-findings-index.js'
import { LINKS_KIND } from '../client/linked-findings.js'

const KEY = 'deepview.workspaceApp'
const metadata = { appMode: true, appFindings: 3 }
async function workspace(name = 'App workspace') {
  const created = await createWorkspace(name)
  await addReportToWorkspace(`${created.id}.json`, created.id)
  await workspaceAppCacheToken()
  return listWorkspaces().find((w) => w.id === created.id)
}
async function record(ws) {
  return cacheWorkspaceAppMetadata(ws, metadata, await workspaceAppCacheToken())
}

describe('workspace App metadata cache', () => {
  beforeEach(async () => {
    await workspaceAppCacheToken()
    secureTest.reset()
    localStorage.clear()
    await hydrate()
    await workspaceAppCacheToken()
  })
  it('persists through secure hydration and keeps derived metadata out of workspace exports', async () => {
    const ws = await workspace()
    assert.equal(await record(ws), true)
    assert.ok(SECURE_KEYS.includes(KEY))
    await hydrate()
    assert.equal(getWorkspaceAppMetadata(ws).appFindings, 3)
    assert.equal(listWorkspaces()[0].appMode, undefined)
    await renameWorkspace(ws.id, 'Renamed')
    assert.equal(getWorkspaceAppMetadata(listWorkspaces()[0]).appFindings, 3)
  })
  it('resets on membership changes and rejects a result from the old membership', async () => {
    const ws = await workspace()
    await record(ws)
    const token = await workspaceAppCacheToken()
    await addReportToWorkspace('second.json', ws.id)
    assert.equal(getWorkspaceAppMetadata(ws), null)
    assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, token), false)
    await workspaceAppCacheToken()
    assert.equal(getWorkspaceAppMetadata(listWorkspaces()[0]), null)
  })
  it('resets only affected workspaces when a known report is overwritten', async () => {
    const other = await workspace('Other'), ws = await workspace()
    await record(ws)
    await record(other)
    const token = await workspaceAppCacheToken()
    setCount(ws.reports[0], 1)
    await saveFile(ws.reports[0], '{"findings":[]}')
    assert.equal(getWorkspaceAppMetadata(ws), null)
    assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, token), false)
    await workspaceAppCacheToken()
    assert.equal(getWorkspaceAppMetadata(other).appFindings, 3)
  })
  it('preserves unrelated workspace headers when a new ordinary report is saved', async () => {
    const ws = await workspace()
    await record(ws)
    await saveFile('new-unattached-report.json', '{"findings":[]}')
    await workspaceAppCacheToken()
    assert.equal(getWorkspaceAppMetadata(ws).appFindings, 3)
  })
  it('invalidates global linked counts when a links file outside the workspace changes', async () => {
    const ws = await workspace()
    await record(ws)
    const name = 'app-workspace-links.json'
    await saveFile(name, JSON.stringify([[{ id: 'A' }, { id: 'B' }]]))
    setCount(name, 2, LINKS_KIND)
    await ensureLinkedFindingsIndexed()
    await workspaceAppCacheToken()
    assert.equal(getWorkspaceAppMetadata(ws), null)
    await record(ws)
    await hydrate()
    await ensureLinkedFindingsIndexed()
    assert.equal(getWorkspaceAppMetadata(ws).appFindings, 3, 'an unchanged index preserves the cache')
  })
  it('cannot resurrect metadata invalidated by a sibling tab', async () => {
    const ws = await workspace()
    const token = await workspaceAppCacheToken()
    const cache = JSON.parse(getItem(KEY))
    cache.revision = crypto.randomUUID()
    cache.entries = {}
    await setItem(KEY, JSON.stringify(cache))
    assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, token), false)
    assert.equal(getWorkspaceAppMetadata(ws), null)
  })
  it('serializes overlapping invalidations and new calculations, and removes deleted workspaces', async () => {
    const ws = await workspace()
    await record(ws)
    const stale = await workspaceAppCacheToken()
    const a = invalidateWorkspaceAppMetadata([ws.id])
    const b = invalidateWorkspaceAppMetadata([ws.id])
    assert.equal(getWorkspaceAppMetadata(ws), null)
    assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, stale), false)
    await Promise.all([a, b])
    assert.equal(await record(ws), true)
    await deleteWorkspace(ws.id)
    await workspaceAppCacheToken()
    assert.equal(getWorkspaceAppMetadata(ws), null)
    assert.equal(await record(ws), false)
  })
})
