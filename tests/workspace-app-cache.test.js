import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'
import './_polyfills.js'
import { SECURE_KEYS, getItem, hydrate, __test__ as secureTest, setItem } from '../client/secure-storage.js'
import { addReportToWorkspace, createWorkspace, deleteWorkspace, listWorkspaces, renameWorkspace } from '../client/workspaces.js'
import { cacheWorkspaceAppMetadata, getWorkspaceAppMetadata, getWorkspaceAppModeHint, invalidateWorkspaceAppMetadata, onWorkspaceAppMetadataChanged, workspaceAppCacheToken } from '../client/workspace-app-cache.js'
import { deleteFile, listFiles, saveFile } from '../client/storage.js'
import { ensureCounts, setCount } from '../client/counts.js'
import { duplicatesOf, ensureLinkedFindingsIndexed, linkFiles } from '../client/linked-findings-index.js'
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
  await indexFiles()
  return cacheWorkspaceAppMetadata(ws, metadata, await workspaceAppCacheToken(ws))
}
async function indexFiles() {
  await ensureCounts(await listFiles())
  await ensureLinkedFindingsIndexed()
  await workspaceAppCacheToken()
}
const linksContent = (groups) => JSON.stringify(groups.map((group) => group.map((id) => ({ id }))))
async function seedLinks(groups) {
  const name = `${crypto.randomUUID()}.links.json`
  await saveFile(name, linksContent(groups))
  setCount(name, groups.length, LINKS_KIND)
  return name
}

describe('workspace App metadata cache', () => {
  beforeEach(async () => {
    for (const { name } of linkFiles()) await deleteFile(name)
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
  it('preserves the compact layout hint while withholding hydrated counts until links are indexed', async () => {
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()]
    const name = await seedLinks([[a, b]])
    const ws = await workspace()
    // A reload restores the persisted metadata before rebuilding the index.
    const cache = JSON.parse(getItem(KEY))
    const entry = { ...metadata, reports: JSON.stringify(ws.reports.toSorted()) }
    cache.links = JSON.stringify([{ name, groups: [[a, b]] }])
    cache.entries[ws.id] = entry
    await setItem(KEY, JSON.stringify(cache))
    await hydrate()
    assert.deepEqual(duplicatesOf(a), [])
    assert.equal(getWorkspaceAppMetadata(ws), null)
    assert.equal(getWorkspaceAppModeHint(ws), true, 'previously seen App workspaces start closed before links are ready')

    const updates = []
    const unsubscribe = onWorkspaceAppMetadataChanged(() => updates.push(getWorkspaceAppMetadata(ws)))
    try {
      await ensureLinkedFindingsIndexed()
      await workspaceAppCacheToken()
      assert.deepEqual(duplicatesOf(a), [b])
      assert.deepEqual(getWorkspaceAppMetadata(ws), entry)
      assert.equal(getWorkspaceAppModeHint(ws), true, 'the layout stays compact after verification')
      assert.deepEqual(JSON.parse(getItem(KEY)), cache, 'the matching cache is reused without rewriting it')
      assert.ok(updates.some((update) => update?.appFindings === metadata.appFindings), 'readers repaint once cached metadata is usable')
    } finally { unsubscribe() }
  })
  it('opens unknown workspaces and drops the compact hint when fresh metadata rules out App mode', async () => {
    const ws = await workspace()
    assert.equal(getWorkspaceAppModeHint(ws), null)
    await record(ws)
    assert.equal(getWorkspaceAppModeHint(ws), true)
    assert.equal(await cacheWorkspaceAppMetadata(ws, { appMode: false }, await workspaceAppCacheToken(ws)), true)
    await hydrate()
    assert.equal(getWorkspaceAppModeHint(ws), false)
  })
  it('discards metadata calculated using the previous severity-dependent rules', async () => {
    const ws = await workspace()
    await record(ws)
    const old = JSON.parse(getItem(KEY))
    old.version = 1
    await setItem(KEY, JSON.stringify(old))
    assert.equal(getWorkspaceAppMetadata(ws), null)
    assert.equal(getWorkspaceAppModeHint(ws), null)
    assert.equal(await record(ws), true)
    assert.equal(getWorkspaceAppMetadata(ws).appFindings, 3)
  })
  it('resets on membership changes and rejects a result from the old membership', async () => {
    const ws = await workspace()
    await record(ws)
    const token = await workspaceAppCacheToken(ws)
    await addReportToWorkspace('second.json', ws.id)
    assert.equal(getWorkspaceAppMetadata(ws), null)
    assert.equal(getWorkspaceAppModeHint(ws), null, 'changed membership reveals the workspace children')
    assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, token), false)
    await workspaceAppCacheToken()
    assert.equal(getWorkspaceAppMetadata(listWorkspaces()[0]), null)
  })
  it('refreshes a report snapshot token after only the background links index changes', async () => {
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()]
    await seedLinks([[a, b]])
    const ws = await workspace()
    const reportsToken = await workspaceAppCacheToken(ws)
    await ensureLinkedFindingsIndexed()
    assert.deepEqual(duplicatesOf(a), [b])
    assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, reportsToken), false)
    const indexedToken = await workspaceAppCacheToken(ws, reportsToken)
    assert.ok(indexedToken)
    assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, indexedToken), true)
  })
  for (const change of ['overwrite', 'delete']) {
    it(`withholds metadata recomputed by a sibling after a links ${change}`, async () => {
      const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
      const name = await seedLinks([[a, b]])
      await ensureLinkedFindingsIndexed()
      const ws = await workspace()
      await record(ws)
      assert.equal(getWorkspaceAppMetadata(ws).appFindings, metadata.appFindings)

      // The sibling has already recomputed the entry using its updated index.
      const cache = JSON.parse(getItem(KEY))
      cache.revision = crypto.randomUUID()
      cache.links = JSON.stringify(change === 'delete' ? [] : [{ name, groups: [[a, c]] }])
      cache.entries[ws.id].appFindings = 4
      if (change === 'delete') localStorage.removeItem(`deepview.report:${name}`)
      else localStorage.setItem(`deepview.report:${name}`, gzipSync(linksContent([[a, c]])).toString('base64'))
      localStorage.setItem(KEY, JSON.stringify(cache))
      await hydrate()
      await ensureLinkedFindingsIndexed()
      assert.deepEqual(duplicatesOf(a), [b], 'this tab still groups findings using the old links')
      assert.equal(getWorkspaceAppMetadata(ws), null)
      assert.deepEqual(JSON.parse(getItem(KEY)), cache, 'withholding the entry does not discard the sibling cache')
    })
    it(`rejects stale indexed links after a sibling tab's ${change}`, async () => {
      const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
      const name = await seedLinks([[a, b]])
      await ensureLinkedFindingsIndexed()
      const ws = await workspace()
      await record(ws)
      const reportsToken = await workspaceAppCacheToken(ws)

      // Change the shared backing store without this tab's onFileMutated
      // notification, then hydrate the sibling's links-only invalidation.
      const cache = JSON.parse(getItem(KEY))
      cache.revision = crypto.randomUUID()
      cache.links = JSON.stringify(change === 'delete' ? [] : [{ name, groups: [[a, c]] }])
      cache.entries = {}
      if (change === 'delete') localStorage.removeItem(`deepview.report:${name}`)
      else localStorage.setItem(`deepview.report:${name}`, gzipSync(linksContent([[a, c]])).toString('base64'))
      localStorage.setItem(KEY, JSON.stringify(cache))
      await hydrate()
      await ensureLinkedFindingsIndexed()
      assert.deepEqual(duplicatesOf(a), [b], 'the idempotent walk still holds the old links')
      assert.equal(cache.reportRevision, reportsToken.reportRevision, 'the report snapshot is still valid')
      assert.equal(await workspaceAppCacheToken(ws, reportsToken), null)
      assert.equal(await record(ws), false, 'a fresh report token must not bypass the links check')
      assert.equal(getWorkspaceAppMetadata(ws), null)
      assert.deepEqual(JSON.parse(getItem(KEY)).entries, {}, 'stale metadata must not be republished')

      // Once this tab has indexed the same links, metadata can be cached again.
      if (change === 'delete') await deleteFile(name)
      else await saveFile(name, linksContent([[a, c]]))
      const freshReportsToken = await workspaceAppCacheToken(ws)
      await ensureLinkedFindingsIndexed()
      assert.deepEqual(duplicatesOf(a), change === 'delete' ? [] : [c])
      const indexedToken = await workspaceAppCacheToken(ws, freshReportsToken)
      assert.ok(indexedToken)
      assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, indexedToken), true)
    })
  }
  it('cannot refresh a report snapshot after report or membership changes, even if links also change', async () => {
    const ws = await workspace()
    for (const change of [
      () => saveFile(ws.reports[0], '{"findings":[]}'),
      () => addReportToWorkspace('another.json', ws.id),
    ]) {
      const reportsToken = await workspaceAppCacheToken(ws)
      await change()
      await invalidateWorkspaceAppMetadata(null, '["new links"]')
      assert.equal(await workspaceAppCacheToken(ws, reportsToken), null)
    }
  })
  it('cannot refresh a report snapshot invalidated by a sibling tab', async () => {
    const ws = await workspace()
    const reportsToken = await workspaceAppCacheToken(ws)
    const cache = JSON.parse(getItem(KEY))
    cache.reportRevision = cache.revision = crypto.randomUUID()
    cache.entries = {}
    await setItem(KEY, JSON.stringify(cache))
    assert.equal(await workspaceAppCacheToken(ws, reportsToken), null)
  })
  it('resets only affected workspaces when a known report is overwritten', async () => {
    const other = await workspace('Other'), ws = await workspace()
    await record(ws)
    await record(other)
    const token = await workspaceAppCacheToken(ws)
    setCount(ws.reports[0], 1)
    await saveFile(ws.reports[0], '{"findings":[]}')
    assert.equal(getWorkspaceAppMetadata(ws), null)
    assert.equal(getWorkspaceAppModeHint(ws), null, 'changed report content discards the layout hint too')
    assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, token), false)
    await indexFiles()
    assert.equal(getWorkspaceAppMetadata(other).appFindings, 3)
  })
  it('preserves unrelated workspace headers when a new ordinary report is saved', async () => {
    const ws = await workspace()
    await record(ws)
    await saveFile('new-unattached-report.json', '{"findings":[]}')
    await indexFiles()
    assert.equal(getWorkspaceAppMetadata(ws).appFindings, 3)
  })
  for (const attached of [false, true]) {
    it(`preserves an in-flight calculation when ${attached ? 'another workspace report' : 'an unattached report'} changes`, async () => {
      const other = await workspace('Other'), ws = await workspace()
      await record(ws)
      const token = await workspaceAppCacheToken(ws)
      const name = attached ? other.reports[0] : 'background-download.json'
      await saveFile(name, '{"findings":[]}')
      await indexFiles()
      assert.ok(await workspaceAppCacheToken(ws, token), 'unrelated bytes do not invalidate the loaded reports')
      assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, token), true, 'a completed calculation also survives an unrelated write')
      assert.equal(getWorkspaceAppMetadata(ws).appFindings, 3)
    })
  }
  it('isolates workspace membership revisions while rejecting tokens for another workspace', async () => {
    const other = await workspace('Other'), ws = await workspace()
    await record(ws)
    const otherToken = await workspaceAppCacheToken(other), token = await workspaceAppCacheToken(ws)
    await addReportToWorkspace('second.json', other.id)
    assert.ok(await workspaceAppCacheToken(ws, token))
    assert.equal(await workspaceAppCacheToken(other, otherToken), null)
    assert.equal(await cacheWorkspaceAppMetadata(other, metadata, token), false)
    assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, token), true)
  })
  for (const affected of [false, true]) {
    it(`handles a sibling tab's ${affected ? 'matching' : 'unrelated'} workspace revision`, async () => {
      const other = await workspace('Other'), ws = await workspace()
      await record(ws)
      const token = await workspaceAppCacheToken(ws)
      const cache = JSON.parse(getItem(KEY))
      const changed = affected ? ws.id : other.id
      cache.workspaceRevisions[changed] = crypto.randomUUID()
      delete cache.entries[changed]
      await setItem(KEY, JSON.stringify(cache))
      assert.equal(Boolean(await workspaceAppCacheToken(ws, token)), !affected)
      assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, token), !affected)
    })
  }
  it('invalidates every workspace that contains the changed report', async () => {
    let other = await workspace('Other')
    const ws = await workspace()
    await addReportToWorkspace(ws.reports[0], other.id)
    other = listWorkspaces().find((w) => w.id === other.id)
    await record(ws)
    await record(other)
    const otherToken = await workspaceAppCacheToken(other), token = await workspaceAppCacheToken(ws)
    await saveFile(ws.reports[0], '{"findings":[]}')
    await indexFiles()
    assert.equal(await workspaceAppCacheToken(ws, token), null)
    assert.equal(await workspaceAppCacheToken(other, otherToken), null)
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
    const token = await workspaceAppCacheToken(ws)
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
    const stale = await workspaceAppCacheToken(ws)
    const a = invalidateWorkspaceAppMetadata([ws.id])
    const b = invalidateWorkspaceAppMetadata([ws.id])
    assert.equal(getWorkspaceAppMetadata(ws), null)
    assert.equal(await cacheWorkspaceAppMetadata(ws, metadata, stale), false)
    await Promise.all([a, b])
    assert.equal(await record(ws), true)
    await deleteWorkspace(ws.id)
    await workspaceAppCacheToken()
    assert.equal(getWorkspaceAppMetadata(ws), null)
    assert.equal(getWorkspaceAppModeHint(ws), null)
    assert.equal(await record(ws), false)
  })
})
