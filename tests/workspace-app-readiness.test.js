import assert from 'node:assert/strict'
import { it } from 'node:test'
import { gzipSync } from 'node:zlib'
import './_polyfills.js'
import { getItem, hydrate, setItem } from '../client/secure-storage.js'
import { createWorkspace, listWorkspaces } from '../client/workspaces.js'
import { cacheWorkspaceAppMetadata, getWorkspaceAppMetadata, onWorkspaceAppMetadataChanged, workspaceAppCacheToken } from '../client/workspace-app-cache.js'
import { ensureCounts } from '../client/counts.js'
import { deleteFile, listFiles } from '../client/storage.js'
import { duplicatesOf, ensureLinkedFindingsIndexed, linkFiles } from '../client/linked-findings-index.js'

const KEY = 'deepview.workspaceApp'

it('distinguishes an unbuilt or incomplete links index from a verified empty index', async () => {
  await hydrate()
  const created = await createWorkspace('Cached App workspace')
  const workspace = listWorkspaces().find((w) => w.id === created.id)
  const entry = { appMode: true, appFindings: 3, reports: '[]' }
  const cache = { version: 2, revision: 'before-crash', reportRevision: 'reports', links: '[]', entries: { [workspace.id]: entry } }
  // Simulate the crash window: the first links file reached disk, but its
  // classification and the old no-links metadata invalidation did not.
  const [a, b] = [crypto.randomUUID(), crypto.randomUUID()]
  const name = 'first-links.json'
  localStorage.setItem(`deepview.report:${name}`, gzipSync(JSON.stringify([[{ id: a }, { id: b }]])).toString('base64'))
  await setItem(KEY, JSON.stringify(cache))
  const reportsToken = await workspaceAppCacheToken(workspace)
  assert.deepEqual(linkFiles(), [])
  assert.equal(getWorkspaceAppMetadata(workspace), null, 'an unbuilt empty index is not evidence for the cached snapshot')
  assert.equal(await workspaceAppCacheToken(workspace, reportsToken), null)
  assert.equal(await cacheWorkspaceAppMetadata(workspace, entry, reportsToken), false)

  await ensureLinkedFindingsIndexed()
  await ensureCounts(await listFiles())
  await ensureLinkedFindingsIndexed()
  await workspaceAppCacheToken()
  assert.deepEqual(duplicatesOf(a), [b])
  assert.equal(getWorkspaceAppMetadata(workspace), null, 'discovering the links invalidates the old cache')

  // A completed walk that really finds no links can reuse an empty snapshot.
  await deleteFile(name)
  await workspaceAppCacheToken()
  await setItem(KEY, JSON.stringify(cache))
  assert.equal(getWorkspaceAppMetadata(workspace), null, 'mutation resets index readiness')
  const updates = []
  const unsubscribe = onWorkspaceAppMetadataChanged(() => updates.push(getWorkspaceAppMetadata(workspace)))
  try {
    await ensureLinkedFindingsIndexed()
    await workspaceAppCacheToken()
    assert.deepEqual(getWorkspaceAppMetadata(workspace), entry)
    assert.deepEqual(JSON.parse(getItem(KEY)), cache)
    assert.ok(updates.some((value) => value?.appFindings === 3), 'verified emptiness notifies metadata readers')
  } finally { unsubscribe() }
})
