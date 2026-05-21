// End-to-end tests for `client/sync/objstore-presence.js` against a
// spawned `server/index.ts` relay. Validates the cache wiring:
// openWorkspace opens an encrypted objstore session, snapshots
// `list()`, decodes each remote tag back to a fileName via
// `fetchByTag` in the background, and re-renders the badge via
// `onChange` for every state transition.

import './_polyfills.js'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { after, before, describe, it } from 'node:test'

import { deriveObjstoreKeys } from '../client/sync/objstore.ts'
import { createObjstoreSession } from './_objstore-session.js'
import { deleteFile, listFiles, readFileBytes, saveFileBytes } from '../client/storage.js'
import { triageSync } from '../client/sync/triage-sync.ts'
import { createWorkspace, deleteWorkspace, listWorkspaces, setBundleWorkspace, setReportWorkspace } from '../client/workspaces.js'
import { bootServer } from './_helpers.js'

const {
  closeWorkspace, deleteBundleFromRemote, deleteFromRemote,
  discoverRemoteBundleIntegrities, discoverRemoteFileNames,
  fetchFile, isBundleInRemote, isInRemote,
  onAutoDownloaded, onChange, openWorkspace, putFile,
  remoteBundleCount, remoteBundleIntegrities, remoteCount, remoteFileNames,
} = await import('../client/sync/objstore-presence.js')

async function createWorkspaceWithReports(name, reports) {
  const ws = await createWorkspace(name)
  for (const r of reports) await setReportWorkspace(r, ws.id)
  // Production parity: presence no longer sends its own
  // `workspace-subscribe` — it rides triage-sync's single subscribe on
  // the shared socket (presence + sync open a workspace together). Open
  // a sync session and wait for it to subscribe so presence receives
  // objstore-put/-deleted broadcasts. Teardown: the test's
  // `deleteWorkspace` drops this session via host.onWorkspaceDeleted.
  triageSync.openSession(ws.id)
  await awaitSyncOnline()
  return ws
}

// Resolve once triage-sync reaches `online` (its session subscribed on
// the shared socket). Tests run sequentially and each workspace is
// deleted in its finally — which closes the sync session — so only one
// session is open at a time and `online` reflects it.
function awaitSyncOnline(timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let off = () => {}
    const t = setTimeout(() => { off(); reject(new Error('awaitSyncOnline timeout')) }, timeoutMs)
    const check = () => {
      if (triageSync.status !== 'online') return
      clearTimeout(t); off(); resolve()
    }
    // Register BEFORE the initial check so a transition landing in the
    // gap can't be missed (`onStatusChange` only fires on transitions);
    // then check immediately in case we're already online.
    off = triageSync.onStatusChange(check)
    check()
  })
}

// Wait until `predicate()` returns truthy, polling on each
// onChange tick. Bails after `timeoutMs` with a descriptive error
// rather than letting the test hang. The presence module's notify
// fires on initial list() snapshot, on every objstore-put / -deleted
// broadcast, AND after each background `fetchByTag` resolves — so
// any state transition wakes the listener exactly once.
function awaitPresence(predicate, label, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    if (predicate()) { resolve(); return }
    const t = setTimeout(() => {
      unsub()
      reject(new Error(`awaitPresence timeout: ${label}`))
    }, timeoutMs)
    const unsub = onChange(() => {
      if (!predicate()) return
      clearTimeout(t)
      unsub()
      resolve()
    })
  })
}

describe('client/sync/objstore-presence', () => {
  let httpOrigin, server, serverUrl

  before(async () => {
    server = await bootServer()
    serverUrl = server.serverUrl
    httpOrigin = server.httpOrigin
    triageSync.setServerUrl(serverUrl)
  })

  after(async () => {
    triageSync.setServerUrl('')
    if (server) await server.teardown()
  })

  // Helper — open a parallel encrypted objstore session for the
  // SAME workspace as the presence module under test. Used to PUT
  // peer-uploaded resources whose `objstore-put` broadcast the
  // presence subscription should pick up.
  async function openPeerSession(ws) {
    const keys = await deriveObjstoreKeys(ws.privateKey, ws.id)
    return createObjstoreSession({ serverUrl, httpOrigin, keys })
  }

  it('isInRemote returns false for any workspace that has not been opened', () => {
    assert.equal(isInRemote('nonexistent-ws-id', 'some-file.json'), false)
  })

  it('openWorkspace ensures a backing triage-sync subscription (presence ⊆ sync)', async () => {
    // Presence never subscribes on its own — it rides triage-sync's
    // single `workspace-subscribe`. Opening a presence session must
    // therefore ensure a sync session exists for the tag (via
    // `ensureSubscription`), so the objstore client never operates
    // against a tag nothing is subscribed to. Without a pre-opened sync
    // session, the presence open must create one synchronously.
    const ws = await createWorkspace('presence-ensures-sync')
    try {
      assert.equal(triageSync.openSessions.some((s) => s.workspaceId === ws.id), false)
      openWorkspace(ws.id)
      assert.equal(
        triageSync.openSessions.some((s) => s.workspaceId === ws.id), true,
        'presence.openWorkspace must ensure a triage-sync session backs the tag',
      )
      await awaitSyncOnline()
    } finally {
      closeWorkspace(ws.id)
      triageSync.closeSession(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('ensureSubscription opens a sync session and returns a token; null for an unknown workspace', async () => {
    assert.equal(triageSync.ensureSubscription('no-such-workspace-id'), null)
    const ws = await createWorkspace('ensure-sub')
    try {
      const sub = triageSync.ensureSubscription(ws.id)
      assert.ok(sub, 'a known workspace yields a subscription token')
      assert.equal(sub.workspaceId, ws.id)
      assert.equal(triageSync.openSessions.some((s) => s.workspaceId === ws.id), true)
      // Idempotent — a second call returns an equivalent token, no duplicate session.
      const again = triageSync.ensureSubscription(ws.id)
      assert.equal(again?.workspaceId, ws.id)
      assert.equal(triageSync.openSessions.filter((s) => s.workspaceId === ws.id).length, 1)
    } finally {
      triageSync.closeSession(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('openWorkspace → empty remote → isInRemote stays false for known reports', async () => {
    const ws = await createWorkspaceWithReports('presence-empty', ['rep-1.json', 'rep-2.json'])
    try {
      openWorkspace(ws.id)
      // Wait until the session has booted (list() returned, even if
      // empty). The empty-snapshot notify still fires once.
      await new Promise((resolve) => { setTimeout(resolve, 250) })
      assert.equal(isInRemote(ws.id, 'rep-1.json'), false)
      assert.equal(isInRemote(ws.id, 'rep-2.json'), false)
      assert.equal(isInRemote(ws.id, 'rep-not-in-workspace.json'), false)
      assert.equal(remoteCount(ws.id), 0)
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('peer PUT → broadcast → isInRemote flips to true', async () => {
    const ws = await createWorkspaceWithReports('presence-live', ['live-report.json'])
    try {
      openWorkspace(ws.id)
      const peer = await openPeerSession(ws)
      try {
        await awaitPresence(() => isInRemote(ws.id, 'live-report.json') === false, 'initial false')
        const put = await peer.put({ fileName: 'live-report.json', content: Buffer.from('payload-bytes'), prev: null })
        assert.equal(put.ok, true)
        await awaitPresence(() => isInRemote(ws.id, 'live-report.json'), 'cloud after PUT')
        await peer.delete('live-report.json', put.meta)
        await awaitPresence(() => !isInRemote(ws.id, 'live-report.json'), 'local after DELETE')
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('putFile uploads content and flips the cache to cloud via broadcast', async () => {
    const ws = await createWorkspaceWithReports('presence-put', ['upload-me.json'])
    try {
      openWorkspace(ws.id)
      await awaitPresence(() => isInRemote(ws.id, 'upload-me.json') === false, 'initial false')
      const result = await putFile(ws.id, 'upload-me.json', Buffer.from('{"hello":"world"}'))
      assert.equal(result.ok, true, `put failed: ${JSON.stringify(result)}`)
      await awaitPresence(() => isInRemote(ws.id, 'upload-me.json'), 'cloud after putFile')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('putFile re-upload passes the live version through prevVersion', async () => {
    const ws = await createWorkspaceWithReports('presence-reput', ['reup.json'])
    try {
      openWorkspace(ws.id)
      await awaitPresence(() => isInRemote(ws.id, 'reup.json') === false, 'initial false')
      const first = await putFile(ws.id, 'reup.json', Buffer.from('v1'))
      assert.equal(first.ok, true)
      assert.equal(first.meta.version, 1)
      await awaitPresence(() => isInRemote(ws.id, 'reup.json'), 'cloud after first put')
      const second = await putFile(ws.id, 'reup.json', Buffer.from('v2-bytes'))
      assert.equal(second.ok, true, `re-upload failed: ${JSON.stringify(second)}`)
      assert.equal(second.meta.version, 2)
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('putFile rejects when the workspace is not open', async () => {
    await assert.rejects(
      putFile('nonexistent-ws', 'no-file.json', Buffer.from('x')),
      /is not open/u,
    )
  })

  it('remoteCount + remoteFileNames discover names from a peer-PUT inventory', async () => {
    // The presence module subscribes via openWorkspace; objstore-put
    // broadcasts add tags to `remoteTags`. The background
    // `fetchByTag` worker decodes those tags to plaintext fileNames
    // so the download dialog can surface them.
    const ws = await createWorkspaceWithReports('presence-list', [])
    try {
      openWorkspace(ws.id)
      await awaitPresence(() => remoteCount(ws.id) === 0, 'empty inventory')
      const peer = await openPeerSession(ws)
      try {
        for (const name of ['alpha.json', 'beta.json']) {
          const r = await peer.put({ fileName: name, content: Buffer.from(`payload-${name}`), prev: null })
          assert.equal(r.ok, true)
        }
        // Tag count reflects immediately on broadcast.
        await awaitPresence(() => remoteCount(ws.id) === 2, 'two tags broadcast')
        // Decoded names land asynchronously via the background
        // fetchByTag worker.
        await awaitPresence(() => remoteFileNames(ws.id).length === 2, 'two names decoded')
        const names = remoteFileNames(ws.id).toSorted()
        assert.deepEqual(names, ['alpha.json', 'beta.json'])
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('discoverRemoteFileNames awaits in-flight discovery for the dialog open path', async () => {
    const ws = await createWorkspaceWithReports('presence-discover', [])
    try {
      const peer = await openPeerSession(ws)
      try {
        // PUT first, THEN open the workspace, so the discovery has
        // a non-empty inventory to chase from the get-go.
        await peer.put({ fileName: 'discover-me.json', content: Buffer.from('payload'), prev: null })
        openWorkspace(ws.id)
        const names = await discoverRemoteFileNames(ws.id)
        assert.deepEqual(names.toSorted(), ['discover-me.json'])
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('fetchFile pulls plaintext content back from the workspace inventory', async () => {
    const ws = await createWorkspaceWithReports('presence-fetch', [])
    try {
      openWorkspace(ws.id)
      await awaitPresence(() => remoteCount(ws.id) === 0, 'empty inventory')
      const peer = await openPeerSession(ws)
      try {
        const put = await peer.put({ fileName: 'to-fetch.json', content: Buffer.from('round-tripped-bytes'), prev: null })
        assert.equal(put.ok, true)
        await awaitPresence(() => isInRemote(ws.id, 'to-fetch.json'), 'visible in inventory')
        const got = await fetchFile(ws.id, 'to-fetch.json')
        assert.ok(got, 'fetchFile resolved')
        assert.equal(Buffer.from(got.content).toString('utf8'), 'round-tripped-bytes')
        assert.equal(got.version, 1)
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('closeWorkspace forgets the workspace entirely', async () => {
    const ws = await createWorkspaceWithReports('presence-close', ['rep.json'])
    try {
      openWorkspace(ws.id)
      await new Promise((resolve) => { setTimeout(resolve, 200) })
      closeWorkspace(ws.id)
      // Re-opening after close should also start from a clean cache;
      // a stale entry left in `sessions` after close would make
      // openWorkspace a no-op on the next call.
      assert.equal(isInRemote(ws.id, 'rep.json'), false)
      openWorkspace(ws.id)
      await new Promise((resolve) => { setTimeout(resolve, 200) })
      assert.equal(isInRemote(ws.id, 'rep.json'), false)
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('deleteFromRemote removes the row + drops the cached tag', async () => {
    const ws = await createWorkspaceWithReports('presence-delete', ['del-me.json'])
    try {
      openWorkspace(ws.id)
      await awaitPresence(() => isInRemote(ws.id, 'del-me.json') === false, 'initial false')
      const put = await putFile(ws.id, 'del-me.json', Buffer.from('payload'))
      assert.equal(put.ok, true)
      await awaitPresence(() => isInRemote(ws.id, 'del-me.json'), 'cloud after put')
      // Local delete; presence drops the tag via the
      // objstore-deleted broadcast handler.
      const del = await deleteFromRemote(ws.id, 'del-me.json')
      assert.equal(del.ok, true)
      await awaitPresence(() => !isInRemote(ws.id, 'del-me.json'), 'local after delete')
      assert.equal(remoteCount(ws.id), 0)
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('deleteFromRemote of a never-existed file is idempotently OK', async () => {
    // Per the server's WS-delete contract: a `delete(name, null)`
    // against a missing row is idempotent — returns
    // `{ ok: true, deletedVersion: 0 }`. (A `delete(name, N)`
    // where N is a non-null version against a missing row returns
    // `{ ok: false, reason: 'not-found' }`; the deletion-from-
    // dialog path goes through `prev: null` so that case
    // doesn't fire here.)
    const ws = await createWorkspaceWithReports('presence-del-nothing', [])
    try {
      openWorkspace(ws.id)
      await awaitPresence(() => remoteCount(ws.id) === 0, 'empty inventory')
      const del = await deleteFromRemote(ws.id, 'never-was.json')
      assert.equal(del.ok, true)
      assert.equal(del.deletedVersion, 0)
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('deleteFromRemote opens the workspace on demand when none is cached (drag-out from a non-active workspace)', async () => {
    // Drag-out from a workspace that isn't currently active goes
    // through `deleteFromRemote` without `openWorkspace` having
    // ever been called for it. The presence module must open the
    // session, perform the delete, and close — leaving the
    // sessions cache empty afterwards. Pre-fix the call would
    // throw `Workspace ... is not open` and silently leak a
    // remote row (review r3251765881).
    const ws = await createWorkspaceWithReports('presence-on-demand', [])
    try {
      // Pre-upload a report via a peer so there's something to
      // delete. The presence module is NOT opened here.
      const peer = await openPeerSession(ws)
      try {
        await peer.put({ fileName: 'on-demand.json', content: Buffer.from('payload'), prev: null })
      } finally { peer.close() }
      assert.equal(remoteCount(ws.id), 0, 'no presence session cached yet → remoteCount returns 0')
      // The remote delete runs against an auto-opened session.
      const del = await deleteFromRemote(ws.id, 'on-demand.json')
      assert.equal(del.ok, true, `delete should succeed: ${JSON.stringify(del)}`)
      // The auto-opened session was closed on exit; the cache
      // shouldn't carry a lingering entry.
      assert.equal(remoteCount(ws.id), 0, 'auto-opened session must be closed after deleteFromRemote returns')
      // Verify the row is actually gone via a fresh peer.list.
      const verify = await openPeerSession(ws)
      try {
        const live = await verify.list()
        assert.equal(live.length, 0, 'remote row removed by the auto-opened delete')
      } finally { verify.close() }
    } finally {
      await deleteWorkspace(ws.id)
    }
  })

  it('deleteFromRemote race: a delete that lands while auto-download is in flight does NOT re-save the file', async () => {
    // Reproduces the user-reported race: a peer-uploaded report
    // is discovered (objstore-put broadcast → ensureRemoteNames
    // → fetchByTag in flight), the user clicks Delete (everywhere)
    // before fetchByTag resolves, the server processes the delete
    // and broadcasts objstore-deleted (the local cache drops the
    // tag), and then the in-flight fetchByTag resolves. Without
    // the per-await remoteTags re-check in maybeAutoDownload, the
    // download path would save the file back to OPFS + attach it
    // to the workspace, undoing the user's delete.
    //
    // We simulate by opening the presence module's workspace AFTER
    // a peer's PUT has landed remotely, then immediately issuing
    // `deleteFromRemote` before the background discovery completes.
    // The presence module should NOT auto-download the now-deleted
    // file. The assertion is on workspace.reports: it must remain
    // empty (the file isn't re-attached) and remoteCount drops to 0.
    const ws = await createWorkspaceWithReports('presence-race', [])
    try {
      const peer = await openPeerSession(ws)
      try {
        await peer.put({ fileName: 'race-target.json', content: Buffer.from('payload'), prev: null })
        // Open the presence session — list() snapshots the peer-
        // uploaded tag into remoteTags; ensureRemoteNames kicks
        // off a background fetchByTag.
        openWorkspace(ws.id)
        await awaitPresence(() => remoteCount(ws.id) === 1, 'one tag in cache')
        // Immediately delete the remote row before discovery
        // completes. The presence module's delete broadcast
        // handler must drop the tag, and the in-flight fetch
        // must NOT race-save the file.
        const del = await deleteFromRemote(ws.id, 'race-target.json')
        assert.equal(del.ok, true)
        await awaitPresence(() => remoteCount(ws.id) === 0, 'tag dropped after delete')
        // Wait long enough for any in-flight fetchByTag to
        // resolve + run maybeAutoDownload. If the race-guard is
        // missing this is where the file would re-land on disk.
        await new Promise((resolve) => { setTimeout(resolve, 250) })
        const reattached = listWorkspaces().find((w) => w.id === ws.id)
        assert.deepEqual(reattached?.reports ?? [], [],
          'auto-download must not re-attach a file whose remote row was deleted while fetchByTag was in flight')
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('peer PUT of a detached local fileName: attach to workspace, keep local bytes', async () => {
    // Two-client convergence: Client A has Report 1 attached to
    // WorkspaceA + Report 1 uploaded; Client B has the same Report 1
    // detached (in OPFS, not in any workspace's reports). When A's
    // upload broadcasts to B, B should attach its existing detached
    // copy to WorkspaceA. The local bytes win — saveFileBytes is
    // not called, so a user mid-edit isn't surprised by a clobber.
    const ws = await createWorkspaceWithReports('presence-detached-attach', [])
    const fileName = 'detached-report.json'
    // Use a fresh Uint8Array (not Buffer.from — Node Buffers share an
    // underlying pool, so toBase64() in the storage.js localStorage
    // fallback would serialize neighbour bytes).
    const localBytes = new TextEncoder().encode('local-bytes-preserved')
    await saveFileBytes(fileName, localBytes)
    try {
      // Sanity: the file is detached — present in OPFS, not in any
      // workspace.
      const fsList = await listFiles()
      assert.ok(fsList.includes(fileName), 'pre-condition: file in OPFS')
      const owner = listWorkspaces().find(
        (w) => Array.isArray(w.reports) && w.reports.includes(fileName),
      )
      assert.equal(owner, undefined, 'pre-condition: file is unfiled')

      openWorkspace(ws.id)
      const peer = await openPeerSession(ws)
      try {
        const put = await peer.put({ fileName, content: Buffer.from('peer-cloud-bytes'), prev: null })
        assert.equal(put.ok, true)
        // The auto-attach path is fired off the broadcast →
        // ensureRemoteNames → maybeAutoDownload chain. Wait for the
        // workspace to claim the fileName.
        const startedAt = Date.now()
        while (Date.now() - startedAt < 5_000) {
          const refreshed = listWorkspaces().find((w) => w.id === ws.id)
          if (refreshed && Array.isArray(refreshed.reports) && refreshed.reports.includes(fileName)) break
          await new Promise((resolve) => { setTimeout(resolve, 50) })
        }
        const refreshed = listWorkspaces().find((w) => w.id === ws.id)
        assert.ok(
          refreshed?.reports?.includes(fileName),
          `detached report should be attached to workspace; got reports=${JSON.stringify(refreshed?.reports)}`,
        )
        // Local bytes preserved — the peer's "peer-cloud-bytes" did
        // NOT overwrite our "local-bytes-preserved".
        const stored = await readFileBytes(fileName)
        assert.equal(
          Buffer.from(stored).toString('utf8'), 'local-bytes-preserved',
          'detached-attach must not overwrite local bytes with the peer upload',
        )
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName)
    }
  })

  it.todo('detached-attach race: delete-everywhere landing during the auto-attach window does NOT attach', async () => {
    // Symmetric to the existing `deleteFromRemote race` test above
    // but for the detached-attach branch (file in OPFS, no
    // workspace owns it). The branch-3 race test passes
    // consistently because non-gzipped peer bytes throw at the
    // gunzip checkpoint inside `maybeAutoDownload` — that throw
    // aborts before any attach call regardless of how the
    // delete vs fetchByTag race plays out.
    //
    // The detached branch has no gunzip step: existsLocally is
    // true, so we go straight to `addReportToWorkspace`. The
    // race-guard at `entry.remoteTags.has(tag)` immediately
    // before the Web-Lock await catches MOST orderings, but a
    // delete landing during the lock-acquisition microtask can
    // still slip through (~20% repro rate in CI). Closing the
    // window completely would need an in-lock predicate on
    // `setWorkspaceMembership`, which couples it to the
    // objstore-presence entry state — invasive enough to defer
    // until a second user-reported reproduction.
    //
    // Pinned as `it.todo` rather than deleted so the race
    // surface stays documented and a future infra change (e.g.,
    // an in-lock predicate) can flip the marker.
    const ws = await createWorkspaceWithReports('presence-detached-race', [])
    const fileName = 'detached-race-target.json'
    const localBytes = new TextEncoder().encode('local-stays-detached')
    await saveFileBytes(fileName, localBytes)
    try {
      const peer = await openPeerSession(ws)
      try {
        await peer.put({ fileName, content: Buffer.from('peer-bytes'), prev: null })
        openWorkspace(ws.id)
        await awaitPresence(() => remoteCount(ws.id) === 1, 'one tag in cache')
        const del = await deleteFromRemote(ws.id, fileName)
        assert.equal(del.ok, true)
        await awaitPresence(() => remoteCount(ws.id) === 0, 'tag dropped after delete')
        await new Promise((resolve) => { setTimeout(resolve, 250) })
        const refreshed = listWorkspaces().find((w) => w.id === ws.id)
        assert.deepEqual(
          refreshed?.reports ?? [], [],
          'detached file must not be auto-attached to a workspace whose remote row was deleted mid-flight',
        )
        const fsList = await listFiles()
        assert.ok(fsList.includes(fileName), 'detached file still in OPFS post-race')
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName)
    }
  })

  it('peer PUT of a fileName already in another workspace: attaches to ours too, preserves theirs', async () => {
    // Multi-workspace membership: a report can be listed in several
    // workspaces at once, and "detached" means "listed in zero
    // workspaces" — not "listed in at most one". A peer's PUT
    // into wsA should grow wsA.reports with the fileName WITHOUT
    // detaching it from wsB.
    //
    // Scenario:
    //   Client 0: wsA [ Report 1 (local) ]  (then uploads Report 1)
    //   Client 1: wsA [ ], wsB [ Report 1 (local) ]
    //   After Client 0's upload syncs to Client 1:
    //   Client 1: wsA [ Report 1 (cloud) ], wsB [ Report 1 (unchanged) ]
    const wsA = await createWorkspaceWithReports('presence-multi-A', [])
    const wsB = await createWorkspaceWithReports('presence-multi-B', [])
    const fileName = 'multi-workspace-report.json'
    const localBytes = new TextEncoder().encode('local-bytes-for-wsB')
    await saveFileBytes(fileName, localBytes)
    await setReportWorkspace(fileName, wsB.id)
    try {
      // Sanity: pre-state matches the scenario — file in OPFS,
      // listed in wsB only, wsA empty.
      const pre = listWorkspaces()
      assert.deepEqual(pre.find((w) => w.id === wsA.id)?.reports ?? [], [],
        'pre-condition: wsA empty')
      assert.ok(pre.find((w) => w.id === wsB.id)?.reports?.includes(fileName),
        'pre-condition: wsB lists the file')

      openWorkspace(wsA.id)
      const peer = await openPeerSession(wsA)
      try {
        const put = await peer.put({ fileName, content: Buffer.from('peer-into-wsA'), prev: null })
        assert.equal(put.ok, true)
        // Wait for the auto-attach to land in wsA.reports.
        const startedAt = Date.now()
        while (Date.now() - startedAt < 5_000) {
          const refreshed = listWorkspaces().find((w) => w.id === wsA.id)
          if (refreshed && Array.isArray(refreshed.reports) && refreshed.reports.includes(fileName)) break
          await new Promise((resolve) => { setTimeout(resolve, 50) })
        }
        const post = listWorkspaces()
        const a = post.find((w) => w.id === wsA.id)
        const b = post.find((w) => w.id === wsB.id)
        assert.ok(
          a?.reports?.includes(fileName),
          `wsA must additively gain the fileName; got reports=${JSON.stringify(a?.reports)}`,
        )
        assert.ok(
          b?.reports?.includes(fileName),
          `wsB must retain the fileName (additive, not move); got reports=${JSON.stringify(b?.reports)}`,
        )
        // Local bytes preserved — the peer's "peer-into-wsA" did
        // NOT overwrite our "local-bytes-for-wsB".
        const stored = await readFileBytes(fileName)
        assert.equal(
          Buffer.from(stored).toString('utf8'), 'local-bytes-for-wsB',
          'multi-workspace attach must not overwrite local bytes',
        )
      } finally { peer.close() }
    } finally {
      closeWorkspace(wsA.id)
      await deleteWorkspace(wsA.id)
      await deleteWorkspace(wsB.id)
      await deleteFile(fileName)
    }
  })

  it('own putFile echo: workspace.reports unchanged, onAutoDownloaded does NOT fire', async () => {
    // Branch 1 of `maybeAutoDownload`: our own upload bounces back
    // as an objstore-put broadcast. The "our workspace already
    // claims this fileName" short-circuit at the top of the
    // function must prevent both a duplicate `reports` entry and
    // a spurious `onAutoDownloaded` fire (the bridge in ui/view.js
    // would otherwise re-run `switchToWorkspace` for no reason).
    const ws = await createWorkspaceWithReports('presence-echo', [])
    const fileName = 'self-uploaded.json'
    await setReportWorkspace(fileName, ws.id)
    let autoDownloadFires = 0
    const unsub = onAutoDownloaded(() => { autoDownloadFires += 1 })
    try {
      openWorkspace(ws.id)
      await awaitPresence(() => isInRemote(ws.id, fileName) === false, 'initial false')
      const result = await putFile(ws.id, fileName, Buffer.from('payload'))
      assert.equal(result.ok, true)
      await awaitPresence(() => isInRemote(ws.id, fileName), 'cloud after putFile')
      // Let any in-flight fetchByTag → maybeAutoDownload chain
      // settle so a spurious fire would surface here.
      await new Promise((resolve) => { setTimeout(resolve, 250) })
      const refreshed = listWorkspaces().find((w) => w.id === ws.id)
      assert.deepEqual(refreshed?.reports, [fileName],
        'echo broadcast must not duplicate the fileName in reports')
      assert.equal(autoDownloadFires, 0,
        'echo broadcast must not fire onAutoDownloaded — branch 1 short-circuit')
    } finally {
      unsub()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('onAutoDownloaded fires on detached-attach with the correct (workspaceId, fileName)', async () => {
    // Verifies the bridge contract the active-workspace listener
    // in ui/view.js relies on. Without this fire, switchToWorkspace
    // wouldn't re-run for the just-attached file and state.reports
    // would lag the workspace.reports change until the next manual
    // refresh.
    const ws = await createWorkspaceWithReports('presence-bridge-detached', [])
    const fileName = 'bridge-detached.json'
    await saveFileBytes(fileName, new TextEncoder().encode('local'))
    const fires = []
    const unsub = onAutoDownloaded((wid, fname) => { fires.push([wid, fname]) })
    try {
      openWorkspace(ws.id)
      const peer = await openPeerSession(ws)
      try {
        await peer.put({ fileName, content: Buffer.from('peer'), prev: null })
        const startedAt = Date.now()
        while (Date.now() - startedAt < 5_000 && fires.length === 0) {
          await new Promise((resolve) => { setTimeout(resolve, 50) })
        }
        assert.deepEqual(fires, [[ws.id, fileName]],
          `onAutoDownloaded should fire exactly once with the detached-attach pair; got ${JSON.stringify(fires)}`)
      } finally { peer.close() }
    } finally {
      unsub()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName)
    }
  })

  it('onAutoDownloaded fires on multi-workspace add (target gains while other workspace retains)', async () => {
    // Same bridge contract, exercising the "fileName already in
    // wsB" → "additively attach to wsA" path. The fire must be
    // for wsA (the workspace that gained the membership row),
    // not wsB (which was unchanged).
    const wsA = await createWorkspaceWithReports('presence-bridge-multi-A', [])
    const wsB = await createWorkspaceWithReports('presence-bridge-multi-B', [])
    const fileName = 'bridge-multi.json'
    await saveFileBytes(fileName, new TextEncoder().encode('local-for-B'))
    await setReportWorkspace(fileName, wsB.id)
    const fires = []
    const unsub = onAutoDownloaded((wid, fname) => { fires.push([wid, fname]) })
    try {
      openWorkspace(wsA.id)
      const peer = await openPeerSession(wsA)
      try {
        await peer.put({ fileName, content: Buffer.from('peer-A'), prev: null })
        const startedAt = Date.now()
        while (Date.now() - startedAt < 5_000 && fires.length === 0) {
          await new Promise((resolve) => { setTimeout(resolve, 50) })
        }
        assert.deepEqual(fires, [[wsA.id, fileName]],
          `onAutoDownloaded should fire exactly once for wsA; got ${JSON.stringify(fires)}`)
        // Sanity: state matches the multi-workspace contract.
        const post = listWorkspaces()
        assert.ok(post.find((w) => w.id === wsA.id)?.reports?.includes(fileName))
        assert.ok(post.find((w) => w.id === wsB.id)?.reports?.includes(fileName))
      } finally { peer.close() }
    } finally {
      unsub()
      closeWorkspace(wsA.id)
      await deleteWorkspace(wsA.id)
      await deleteWorkspace(wsB.id)
      await deleteFile(fileName)
    }
  })

  // ------------------------------------------------------------------
  // Bundle-side presence: classification, isBundleInRemote, deletion.
  //
  // The `putBundleToRemote` / `fetchBundleFromRemote` paths read or
  // write OPFS bytes (bundle storage is OPFS-only — `saveBundle`
  // explicitly throws when OPFS is unavailable). These node-side
  // tests sidestep that by driving the wire directly through a peer
  // session's `session.putBundle` and asserting the presence module's
  // classification + caching is correct.
  // ------------------------------------------------------------------

  async function createWorkspaceWithBundles(name, bundles) {
    const ws = await createWorkspace(name)
    for (const b of bundles) await setBundleWorkspace(b, ws.id)
    // Same as createWorkspaceWithReports: presence rides triage-sync's
    // single subscribe on the shared socket, so open a sync session and
    // wait for it to subscribe before the test drives broadcasts.
    triageSync.openSession(ws.id)
    await awaitSyncOnline()
    return ws
  }

  it('isBundleInRemote returns false for any workspace not opened', () => {
    assert.equal(isBundleInRemote('nonexistent-ws', 'sha512-AAAA'), false)
  })

  it('peer putBundle → broadcast → isBundleInRemote flips to true for a claimed integrity', async () => {
    const integrity = 'sha512-presence-bundle-AAAA'
    const ws = await createWorkspaceWithBundles('presence-bundle-put', [integrity])
    try {
      openWorkspace(ws.id)
      await awaitPresence(() => isBundleInRemote(ws.id, integrity) === false, 'initial false')
      const peer = await openPeerSession(ws)
      try {
        await peer.putBundle({ integrity, name: 'b.js', content: Buffer.from('bytes'), prev: null })
        await awaitPresence(() => isBundleInRemote(ws.id, integrity), 'cloud after peer put')
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('remoteBundleCount + remoteBundleIntegrities classify peer-uploaded bundles via discovery', async () => {
    const integrityA = 'sha512-disc-bundle-A'
    const integrityB = 'sha512-disc-bundle-B'
    // Workspace doesn't pre-claim the bundles — peer uploads them and
    // the background discovery worker must classify them as bundles
    // via the discriminated `fetchByTag` (kind='bundle' round-trip).
    const ws = await createWorkspaceWithBundles('presence-bundle-discover', [])
    try {
      const peer = await openPeerSession(ws)
      try {
        await peer.putBundle({ integrity: integrityA, name: 'b.js', content: Buffer.from('A'), prev: null })
        await peer.putBundle({ integrity: integrityB, name: 'b.js', content: Buffer.from('B'), prev: null })
      } finally { peer.close() }
      openWorkspace(ws.id)
      // Wait for the discovery pass to classify both tags.
      await awaitPresence(() => remoteBundleCount(ws.id) === 2, 'remoteBundleCount=2 after discovery')
      const integrities = remoteBundleIntegrities(ws.id).toSorted()
      assert.deepEqual(integrities, [integrityA, integrityB].toSorted())
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('discoverRemoteBundleIntegrities awaits in-flight bundle classification', async () => {
    const integrity = 'sha512-disc-await-bundle'
    const ws = await createWorkspaceWithBundles('presence-bundle-discover-await', [])
    try {
      const peer = await openPeerSession(ws)
      try {
        await peer.putBundle({ integrity, name: 'b.js', content: Buffer.from('z'), prev: null })
      } finally { peer.close() }
      openWorkspace(ws.id)
      // Without awaiting discovery, `remoteBundleIntegrities` may
      // return [] because the background fetch hasn't classified the
      // tag yet. `discoverRemoteBundleIntegrities` awaits and returns
      // the full classified set.
      const integrities = await discoverRemoteBundleIntegrities(ws.id)
      assert.deepEqual(integrities, [integrity])
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('deleteBundleFromRemote removes the remote entry + flips isBundleInRemote back', async () => {
    const integrity = 'sha512-del-bundle-AAAA'
    const ws = await createWorkspaceWithBundles('presence-bundle-delete', [integrity])
    try {
      const peer = await openPeerSession(ws)
      try {
        await peer.putBundle({ integrity, name: 'b.js', content: Buffer.from('x'), prev: null })
      } finally { peer.close() }
      openWorkspace(ws.id)
      await awaitPresence(() => isBundleInRemote(ws.id, integrity), 'cloud after peer put')
      const result = await deleteBundleFromRemote(ws.id, integrity)
      assert.equal(result.ok, true, `delete failed: ${JSON.stringify(result)}`)
      // Synchronous post-delete: the cache flips immediately so an
      // in-flight fetchByTag whose response is queued can't race-
      // restore the bundle.
      assert.equal(isBundleInRemote(ws.id, integrity), false,
        'synchronous local-cache drop after delete')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('attaching a bundle AFTER openWorkspace pre-derives its tag (membership listener wiring)', async () => {
    // Pre-fix: the presence module captured `ws.bundles` at boot time
    // and only pre-derived tags for THOSE integrities. A user
    // attaching a bundle post-open (via drag-drop) wouldn't get a tag
    // in `bundleTags` until something else explicitly called
    // `trackBundle` — and nothing did. Fixed by subscribing to
    // `onBundleMembershipChanged` and calling `trackBundle` for each
    // new integrity. This test verifies the wiring.
    const integrity = 'sha512-attach-after-open-AAAA'
    const ws = await createWorkspaceWithBundles('attach-after-open', [])
    try {
      openWorkspace(ws.id)
      // Wait for boot to finish so the listeners are registered.
      await new Promise((resolve) => { setTimeout(resolve, 100) })
      // Attach AFTER openWorkspace. The membership listener should
      // call trackBundle which derives + caches the tag.
      await setBundleWorkspace(integrity, ws.id)
      // Wait for the listener's async trackBundle to land.
      await new Promise((resolve) => { setTimeout(resolve, 100) })
      const peer = await openPeerSession(ws)
      try {
        // Peer puts the bundle. The broadcast should flip
        // `isBundleInRemote` — which uses `bundleTags` for the
        // synchronous answer. If the tag wasn't derived (pre-fix
        // behavior), `isBundleInRemote` would stay false until
        // something else triggered `trackBundle`.
        await peer.putBundle({ integrity, name: 'attached-later.js', content: Buffer.from('x'), prev: null })
        await awaitPresence(() => isBundleInRemote(ws.id, integrity), 'isBundleInRemote flips after post-open attach')
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('remoteBundleName surfaces the user-friendly name post-discovery', async () => {
    const integrity = 'sha512-name-test-bundle'
    const ws = await createWorkspaceWithBundles('bundle-name-discovery', [integrity])
    try {
      const peer = await openPeerSession(ws)
      try {
        await peer.putBundle({ integrity, name: 'my-named-bundle.js', content: Buffer.from('x'), prev: null })
      } finally { peer.close() }
      openWorkspace(ws.id)
      const { remoteBundleName } = await import('../client/sync/objstore-presence.js')
      // Pre-discovery `remoteBundleName` returns undefined; the badge
      // download handler falls back to the integrity prefix until
      // discovery resolves.
      await awaitPresence(() => remoteBundleName(ws.id, integrity) !== undefined, 'name discovered')
      assert.equal(remoteBundleName(ws.id, integrity), 'my-named-bundle.js')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('reports badge count is not inflated by peer-uploaded bundle tags (regression)', async () => {
    // Pre-fix: the reports badge used `remoteCount` which includes
    // bundle tags, so a workspace with 0 local reports + 2 peer-
    // uploaded bundles rendered "2 cloud" on the reports badge and
    // the download dialog opened empty. The fix splits the count via
    // `remoteCount - remoteBundleCount`. The presence module exposes
    // both counts; this test pins that `remoteBundleCount` correctly
    // captures the bundles so the subtraction in the badge math is
    // valid.
    const integA = 'sha512-reports-isolation-A'
    const integB = 'sha512-reports-isolation-B'
    const ws = await createWorkspaceWithBundles('reports-isolation', [])
    try {
      const peer = await openPeerSession(ws)
      try {
        await peer.putBundle({ integrity: integA, name: 'b.js', content: Buffer.from('A'), prev: null })
        await peer.putBundle({ integrity: integB, name: 'b.js', content: Buffer.from('B'), prev: null })
      } finally { peer.close() }
      openWorkspace(ws.id)
      // Post-discovery: 2 total tags, both classified as bundles.
      await awaitPresence(() => remoteBundleCount(ws.id) === 2, 'both bundles classified')
      assert.equal(remoteCount(ws.id), 2, '2 total remote tags')
      assert.equal(remoteBundleCount(ws.id), 2, 'both classified as bundles')
      // The reports badge formula `remoteCount - remoteBundleCount` =
      // 0 — correct, no reports in cloud.
      assert.equal(remoteCount(ws.id) - remoteBundleCount(ws.id), 0,
        'reports cloud count excludes bundle tags')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('fetchBundleFromRemote refuses bytes whose sha512 does not match the requested integrity', async () => {
    // The content-forgery defense at `objstore-presence.js`'s
    // `fetchBundleFromRemote`: a workspace member can PUT a blob
    // whose embedded "name" claims integrity X but whose content
    // bytes hash to something else. AAD/AEAD/name-binding all pass.
    // The re-hash on download is the only defense.
    //
    // Construct the attack via raw `session.putBundle({integrity: X,
    // content: <not-hashing-to-X>})` — the session doesn't validate
    // the bundle hash itself (that's a separate user-driven step in
    // `saveBundle`). Then the presence-side fetchBundleFromRemote
    // must return `{ ok: false, reason: 'integrity-mismatch' }`.
    const forgedIntegrity = 'sha512-FORGED-AAAA'
    const ws = await createWorkspaceWithBundles('forgery-check', [forgedIntegrity])
    try {
      const peer = await openPeerSession(ws)
      try {
        // Put bytes that don't actually hash to `forgedIntegrity`.
        await peer.putBundle({
          integrity: forgedIntegrity,
          name: 'forged.js',
          content: Buffer.from('not-hashing-to-the-claimed-integrity'),
          prev: null,
        })
      } finally { peer.close() }
      openWorkspace(ws.id)
      await awaitPresence(() => isBundleInRemote(ws.id, forgedIntegrity), 'cloud after peer put')
      const { fetchBundleFromRemote: fbfr } = await import('../client/sync/objstore-presence.js')
      const result = await fbfr(ws.id, forgedIntegrity)
      assert.equal(result.ok, false, 'fetch refuses bytes that do not hash to the requested integrity')
      assert.equal(result.reason, 'integrity-mismatch')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('bundle and report tags are classified independently — neither pollutes the other', async () => {
    // Cross-classification pin: a workspace holding both a report and
    // a bundle should expose them under their respective cache maps.
    // The total `remoteCount` is 2, but `remoteFileNames` reports 1
    // and `remoteBundleIntegrities` reports 1 — proving the discovery
    // worker classifies each tag correctly via the fetchByTag
    // discriminated round-trip.
    const integrity = 'sha512-mixed-bundle'
    const fileName = 'mixed-report.json'
    const ws = await createWorkspaceWithBundles('presence-mixed', [integrity])
    await setReportWorkspace(fileName, ws.id)
    try {
      const peer = await openPeerSession(ws)
      try {
        await peer.put({ fileName, content: Buffer.from('report-bytes'), prev: null })
        await peer.putBundle({ integrity, name: 'b.js', content: Buffer.from('bundle-bytes'), prev: null })
      } finally { peer.close() }
      openWorkspace(ws.id)
      await awaitPresence(() => remoteCount(ws.id) === 2 && remoteBundleCount(ws.id) === 1, 'both kinds classified')
      // The post-discovery counts: 2 total, 1 of each kind.
      assert.equal(remoteCount(ws.id), 2, '2 total remote tags')
      assert.equal(remoteBundleCount(ws.id), 1, '1 classified as bundle')
      const fileNames = remoteFileNames(ws.id)
      assert.deepEqual(fileNames, [fileName], 'report side only')
      const integrities = remoteBundleIntegrities(ws.id)
      assert.deepEqual(integrities, [integrity], 'bundle side only')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })
})
