import assert from 'node:assert/strict'
import { it } from 'node:test'
import { gzipSync } from 'node:zlib'
import './_polyfills.js'
import { hydrate, setItem } from '../client/secure-storage.js'
import { createWorkspace, listWorkspaces } from '../client/workspaces.js'
import { getWorkspaceAppMetadata, workspaceAppCacheToken } from '../client/workspace-app-cache.js'
import { getKind, setCount } from '../client/counts.js'
import { duplicatesOf, ensureLinkedFindingsIndexed, isLinkedFindingsIndexReady } from '../client/linked-findings-index.js'

it('rejects an old no-links snapshot after a report was replaced before its classification persisted', async () => {
  await hydrate()
  const created = await createWorkspace('Cached App workspace')
  const workspace = listWorkspaces().find((w) => w.id === created.id)
  await workspaceAppCacheToken()
  const name = 'replaced-report.json'
  setCount(name, 7, 'deepsec')
  const [a, b] = [crypto.randomUUID(), crypto.randomUUID()]
  // The replacement bytes reached disk, but the browser stopped before the
  // counts and metadata writes. On reload both still describe the old report.
  localStorage.setItem(`deepview.report:${name}`, gzipSync(JSON.stringify([[{ id: a }, { id: b }]])).toString('base64'))
  await setItem('deepview.workspaceApp', JSON.stringify({
    version: 2, revision: 'before-crash', reportRevision: 'reports', links: '[]',
    entries: { [workspace.id]: { appMode: true, appFindings: 3, reports: '[]' } },
  }))
  await ensureLinkedFindingsIndexed()
  await workspaceAppCacheToken()
  assert.equal(isLinkedFindingsIndexReady(), true)
  assert.equal(getWorkspaceAppMetadata(workspace), null, 'the old classification must not validate an empty snapshot')
  assert.deepEqual(duplicatesOf(a), [b])
  assert.equal(getKind(name), 'links', 'repair the obsolete classification for other readers')
})
