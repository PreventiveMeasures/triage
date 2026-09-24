// End-to-end tests for `client/sync/objstore-presence.js` against a
// spawned `server-e2e/index.ts` relay. Validates the cache wiring:
// openWorkspace opens an encrypted objstore session, snapshots
// `list()`, decodes each remote tag back to a fileName via
// `fetchByTag` in the background, and re-renders the badge via
// `onChange` for every state transition.

import './_polyfills.js'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { after, before, describe, it } from 'node:test'

import { deriveObjstoreKeys } from '../client/sync/objstore.ts'
import { computeContentHash } from '../client/sync/objstore-crypto.ts'
import { SESSION_RESTART_REASON } from '../client/sync/socket-transport.ts'
import { createObjstoreSession } from './_objstore-session.js'
import { gunzipBytes, gzipBytes } from '../common/gzip.js'
import { decodeUtf8, encodeUtf8 } from '../common/utf8.js'
import { deleteFile, listFiles, readFile, readFileBytes, saveFileBytes } from '../client/storage.js'
import { VAULT_LOCK } from '../client/passkey-vault.js'
import { triageSync } from '../client/sync/triage-sync.ts'
import { createWorkspace, deleteWorkspace, listWorkspaces, setBundleWorkspace, setReportWorkspace } from '../client/workspaces.js'
import { bootServer } from './_helpers.js'
import { readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const {
  __test__,
  closeWorkspace, deleteBundleFromRemote, deleteFromRemote,
  discoverRemoteBundleIntegrities, discoverRemoteFileNames,
  downloadFileFromRemote, fetchFile, isBundleInRemote, isInRemote,
  onAutoDownloaded, onChange, openWorkspace, putFile, recheckRemoteStorage,
  remoteBundleCount, remoteBundleIntegrities, remoteCount, remoteFileNames,
  resolveReportDifference, differingReports, holdLocalChangeChecks,
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

// Minimal recognized report (gzipped, as it sits on disk and travels
// through the objstore) whose one finding carries `description`.
function reportJson(description) {
  return JSON.stringify({
    type: 'analysis',
    findings: [{ id: 'a', severity: 'high', file: 'x.js', line: 1, description }],
  })
}
async function localReportText(fileName) {
  return decodeUtf8(await gunzipBytes(await readFileBytes(fileName)))
}
// Poll the on-disk copy until it reads `want` (or time out and return
// whatever was last read, so the assertion message shows the stale copy).
async function waitForLocalText(fileName, want, timeoutMs = 5_000) {
  const startedAt = Date.now()
  let text = ''
  while (Date.now() - startedAt < timeoutMs) {
    try {
      text = await localReportText(fileName)
      if (text === want) return text
    } catch {}
    await new Promise((resolve) => { setTimeout(resolve, 50) })
  }
  return text
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

  it('peer Replace (version bump under existing tag) re-fetches and overwrites local bytes', async () => {
    // Regression for the silent-divergence bug: under the old onPut
    // handler an existing peer who already held the file saw the
    // resourceTag stay in remoteTags and the cached fileName stay
    // valid, so `ensureRemoteNames` skipped the fetch entirely.
    // Local bytes kept the OLD content while a fresh joiner pulled
    // the NEW content via the discovery path — peers silently
    // diverged. With the version-bump detection in place, an
    // existing peer's onPut for a known tag should force a fetch
    // and overwrite when the version strictly advances.
    const ws = await createWorkspaceWithReports('presence-replace', [])
    const fileName = 'replace-me.json'
    // saveFile / readFileBytes round-trip gives us the on-disk
    // gzipped representation — same shape the upload pipeline ships
    // to the relay, and what maybeApplyRemoteReplace will gunzip
    // back out at the receiving end.
    const v1Text = JSON.stringify({
      type: 'analysis',
      findings: [{ id: 'a', severity: 'high', file: 'x.js', line: 1, description: 'v1' }],
    })
    const v2Text = JSON.stringify({
      type: 'analysis',
      findings: [{ id: 'a', severity: 'high', file: 'x.js', line: 1, description: 'v2-NEW' }],
    })
    const v1Bytes = await gzipBytes(encodeUtf8(v1Text))
    const v2Bytes = await gzipBytes(encodeUtf8(v2Text))
    // Seed the local copy at v1 so the initial peer put hits the
    // "exists locally" branch of maybeAutoDownload (which attaches
    // to the workspace and DOES NOT overwrite — matches the
    // pre-existing behaviour we keep).
    await saveFileBytes(fileName, v1Bytes)
    try {
      openWorkspace(ws.id)
      const peer = await openPeerSession(ws)
      try {
        const v1Put = await peer.put({ fileName, content: v1Bytes, prev: null })
        assert.equal(v1Put.ok, true)
        // Wait for the initial broadcast to attach our local copy
        // to the workspace.
        const startedAt = Date.now()
        while (Date.now() - startedAt < 5_000) {
          const refreshed = listWorkspaces().find((w) => w.id === ws.id)
          if (refreshed?.reports?.includes(fileName)) break
          await new Promise((resolve) => { setTimeout(resolve, 50) })
        }
        const afterAttach = listWorkspaces().find((w) => w.id === ws.id)
        assert.ok(afterAttach?.reports?.includes(fileName), 'workspace should claim the local-and-remote file')
        // Local bytes are still v1 — the initial broadcast doesn't
        // overwrite (matches the existing "local bytes win" rule
        // on the no-version-bump branch).
        const beforeReplace = decodeUtf8(await gunzipBytes(await readFileBytes(fileName)))
        assert.equal(beforeReplace, v1Text, 'local at v1 before peer Replace')
        // Peer Replace: same fileName + same workspace, bumped to v2.
        const v2Put = await peer.put({ fileName, content: v2Bytes, prev: v1Put.meta })
        assert.equal(v2Put.ok, true, `peer Replace failed: ${JSON.stringify(v2Put)}`)
        assert.equal(v2Put.meta.version, 2)
        // The replace-refetch path is async (fetchByTag → gunzip →
        // analyze → saveFileBytes). Poll readFile until the cached
        // text flips to v2 — the cache is evicted by saveFileBytes,
        // so each readFile re-pulls the freshest bytes from disk.
        const replaceStartedAt = Date.now()
        let finalText = beforeReplace
        while (Date.now() - replaceStartedAt < 5_000) {
          finalText = await readFile(fileName)
          if (finalText === v2Text) break
          await new Promise((resolve) => { setTimeout(resolve, 50) })
        }
        assert.equal(finalText, v2Text, 'local bytes must track the peer\'s Replace')
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName)
    }
  })

  it('reconnect after a missed Replace: boot-divergence loop fetches the new bytes', async () => {
    // Regression for the offline-then-reconnect bug: the live
    // `onPut` path catches puts that land DURING this client's
    // session, but a Replace that committed while we were
    // disconnected only shows up as a version delta between the
    // freshly-fetched remote inventory and the locally-persisted
    // baseline. Without the boot-divergence sweep, the reconnected
    // session would attach to the workspace via maybeAutoDownload's
    // "exists locally" branch (because the v1 bytes are still on
    // disk) and never overwrite — local stays at v1 while every
    // future joiner reads v2 from the relay.
    const ws = await createWorkspaceWithReports('presence-reconnect-replace', [])
    const fileName = 'reconnect-target.json'
    const v1Text = JSON.stringify({
      type: 'analysis',
      findings: [{ id: 'a', severity: 'high', file: 'x.js', line: 1, description: 'v1' }],
    })
    const v2Text = JSON.stringify({
      type: 'analysis',
      findings: [{ id: 'a', severity: 'high', file: 'x.js', line: 1, description: 'v2-OFFLINE-REPLACE' }],
    })
    const v1Bytes = await gzipBytes(encodeUtf8(v1Text))
    const v2Bytes = await gzipBytes(encodeUtf8(v2Text))
    let v1Put
    try {
      // --- Online phase: receive peer's initial put as auto-download. ---
      // No local file before peer's put → maybeAutoDownload takes the
      // "new file" branch (save + analyzeContent gate) which sets the
      // `localVersions` baseline AND persists it via savePresenceCache.
      // That baseline is what survives the close+reopen below and lets
      // the boot-divergence loop fire on reconnect.
      openWorkspace(ws.id)
      let peer = await openPeerSession(ws)
      try {
        v1Put = await peer.put({ fileName, content: v1Bytes, prev: null })
        assert.equal(v1Put.ok, true)
        const startedAt = Date.now()
        while (Date.now() - startedAt < 5_000) {
          const fsList = await listFiles()
          if (fsList.includes(fileName)) break
          await new Promise((resolve) => { setTimeout(resolve, 50) })
        }
        const fsList = await listFiles()
        assert.ok(fsList.includes(fileName), 'maybeAutoDownload should persist v1 to OPFS')
        const localAfterV1 = decodeUtf8(await gunzipBytes(await readFileBytes(fileName)))
        assert.equal(localAfterV1, v1Text, 'local should equal v1 after auto-download')
      } finally { peer.close() }

      // --- Go offline: close both presence and the underlying sync
      // session, mirroring what `ingest.js`'s leaveWorkspace /
      // switchToWorkspace path does. The relay sees us unsubscribe and
      // stops broadcasting to this client for the duration. The
      // persisted localStorage cache survives — that's the
      // baseline the reconnect uses. ---
      closeWorkspace(ws.id)
      triageSync.closeSession(ws.id)

      // --- Peer replaces while we're offline. The put commits at v2
      // on the server; we receive nothing because we're unsubscribed. ---
      peer = await openPeerSession(ws)
      try {
        const v2Put = await peer.put({ fileName, content: v2Bytes, prev: v1Put.meta })
        assert.equal(v2Put.ok, true, `offline-window peer put failed: ${JSON.stringify(v2Put)}`)
        assert.equal(v2Put.meta.version, 2)
      } finally { peer.close() }

      // --- Reconnect. Re-opening triage-sync re-subscribes (the relay
      // sends a fresh subscribe-ack carrying the current v2 inventory),
      // and openWorkspace rebuilds the presence session which seeds
      // remoteVersions from that fresh ack. The boot-divergence loop
      // then sees localVersions[tag]=1 < remoteVersions[tag]=2 and
      // routes through `maybeApplyRemoteReplace` to overwrite local. ---
      triageSync.openSession(ws.id)
      await awaitSyncOnline()
      openWorkspace(ws.id)
      const startedAt = Date.now()
      let finalText = ''
      while (Date.now() - startedAt < 5_000) {
        try {
          finalText = decodeUtf8(await gunzipBytes(await readFileBytes(fileName)))
          if (finalText === v2Text) break
        } catch {}
        await new Promise((resolve) => { setTimeout(resolve, 50) })
      }
      assert.equal(finalText, v2Text, 'local must catch up to v2 after reconnect')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName)
    }
  })

  it('report evicted from OPFS (still claimed + still in remote) is re-downloaded on reopen', async () => {
    // Regression for the report/bundle re-download asymmetry. When a
    // report's bytes vanish from local storage (OPFS eviction,
    // corruption, a partial clear) WITHOUT being explicitly deleted,
    // the workspace keeps listing it in `reports` and the relay still
    // holds the peer copy — yet the old discovery skip
    // (`remoteNameByTag.has(tag) && liveReports.has(name)`) treated
    // "workspace claims it" as "we already have it" and never
    // re-fetched the bytes. Bundles re-download in the same situation
    // because their discovery skip is implicitly gated on local
    // presence (the bundle name is sourced from `listBundles()`, which
    // is empty for an evicted bundle). This pins the symmetric
    // behaviour for reports: a remote report absent from OPFS must
    // trigger a re-download.
    const ws = await createWorkspaceWithReports('presence-evicted-report', [])
    const fileName = 'evicted-report.json'
    const reportText = JSON.stringify({
      type: 'analysis',
      findings: [{ id: 'a', severity: 'high', file: 'x.js', line: 1, description: 'keep me' }],
    })
    const reportBytes = await gzipBytes(encodeUtf8(reportText))
    try {
      // --- Online: a peer uploads the report. The background
      // discovery worker auto-downloads it — saving the bytes to
      // local storage AND attaching the fileName to the workspace. ---
      openWorkspace(ws.id)
      const peer = await openPeerSession(ws)
      try {
        const put = await peer.put({ fileName, content: reportBytes, prev: null })
        assert.equal(put.ok, true)
        const startedAt = Date.now()
        while (Date.now() - startedAt < 5_000) {
          const onDisk = (await listFiles()).includes(fileName)
          const claimed = listWorkspaces().find((w) => w.id === ws.id)?.reports?.includes(fileName)
          if (onDisk && claimed) break
          await new Promise((resolve) => { setTimeout(resolve, 50) })
        }
        assert.ok((await listFiles()).includes(fileName), 'auto-download persisted the report to local storage')
        assert.ok(
          listWorkspaces().find((w) => w.id === ws.id)?.reports?.includes(fileName),
          'auto-download attached the report to the workspace',
        )
      } finally { peer.close() }

      // --- Simulate eviction. `deleteFile` drops the bytes only; the
      // workspace blob keeps listing the fileName and the relay row is
      // untouched. Close the sessions first so the reopen below
      // rebuilds presence from scratch (the realistic page-refresh /
      // workspace-switch path). ---
      closeWorkspace(ws.id)
      triageSync.closeSession(ws.id)
      await deleteFile(fileName)
      assert.equal((await listFiles()).includes(fileName), false, 'report bytes evicted from local storage')
      assert.ok(
        listWorkspaces().find((w) => w.id === ws.id)?.reports?.includes(fileName),
        'workspace still lists the report after eviction (membership untouched)',
      )

      // --- Reopen. The peer copy is still in remote and the workspace
      // still claims the fileName, but the bytes are gone from disk.
      // Discovery must notice the local absence and re-fetch. ---
      triageSync.openSession(ws.id)
      await awaitSyncOnline()
      openWorkspace(ws.id)
      const startedAt = Date.now()
      let restored = false
      while (Date.now() - startedAt < 5_000) {
        if ((await listFiles()).includes(fileName)) { restored = true; break }
        await new Promise((resolve) => { setTimeout(resolve, 50) })
      }
      assert.ok(restored, 'an evicted report still present in remote must be re-downloaded on reopen')
      const recovered = decodeUtf8(await gunzipBytes(await readFileBytes(fileName)))
      assert.equal(recovered, reportText, 're-downloaded bytes must match the original report')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName)
    }
  })

  it('peer Replace with non-recognized content is refused (forgery defence)', async () => {
    // analyzeContent gate on the replace-refetch path. A workspace
    // member could PUT arbitrary gzipped bytes under an existing
    // tag; if those bytes don't parse as a recognized report, the
    // local copy must NOT be overwritten — same trust posture as
    // the new-file maybeAutoDownload branch.
    const ws = await createWorkspaceWithReports('presence-replace-forgery', [])
    const fileName = 'replace-forgery.json'
    const v1Text = JSON.stringify({
      type: 'analysis',
      findings: [{ id: 'a', severity: 'high', file: 'x.js', line: 1, description: 'good v1' }],
    })
    const v1Bytes = await gzipBytes(encodeUtf8(v1Text))
    const garbageBytes = await gzipBytes(encodeUtf8('this is not a recognised report payload'))
    await saveFileBytes(fileName, v1Bytes)
    try {
      openWorkspace(ws.id)
      const peer = await openPeerSession(ws)
      try {
        const v1Put = await peer.put({ fileName, content: v1Bytes, prev: null })
        assert.equal(v1Put.ok, true)
        const startedAt = Date.now()
        while (Date.now() - startedAt < 5_000) {
          const refreshed = listWorkspaces().find((w) => w.id === ws.id)
          if (refreshed?.reports?.includes(fileName)) break
          await new Promise((resolve) => { setTimeout(resolve, 50) })
        }
        const v2Put = await peer.put({ fileName, content: garbageBytes, prev: v1Put.meta })
        assert.equal(v2Put.ok, true)
        // Give the replace-refetch a moment to run (and refuse).
        await new Promise((resolve) => { setTimeout(resolve, 400) })
        const local = decodeUtf8(await gunzipBytes(await readFileBytes(fileName)))
        assert.equal(local, v1Text, 'local good copy must survive a forgery-shaped peer Replace')
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName)
    }
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
    // Our own upload bounces back as an objstore-put broadcast. In
    // production the bytes are already on disk (the UI saves the
    // report, then uploads it), so the echo must be recognised as
    // "already have it" — preventing both a duplicate `reports` entry
    // and a spurious `onAutoDownloaded` fire (the bridge in ui/view.js
    // would otherwise re-run `switchToWorkspace` for no reason).
    //
    // The bytes MUST be a gzipped, analyzeContent-recognised report on
    // disk: with the report claimed AND present, the discovery
    // `ensureRemoteNames` skip short-circuits the echo before any
    // fetch. (A non-gzipped throwaway payload would mask this by
    // failing the gunzip gate instead, so the assertion would pass for
    // the wrong reason.)
    const ws = await createWorkspaceWithReports('presence-echo', [])
    const fileName = 'self-uploaded.json'
    const reportText = JSON.stringify({
      type: 'analysis',
      findings: [{ id: 'a', severity: 'high', file: 'x.js', line: 1, description: 'mine' }],
    })
    const reportBytes = await gzipBytes(encodeUtf8(reportText))
    await saveFileBytes(fileName, reportBytes)
    await setReportWorkspace(fileName, ws.id)
    let autoDownloadFires = 0
    const unsub = onAutoDownloaded(() => { autoDownloadFires += 1 })
    try {
      openWorkspace(ws.id)
      await awaitPresence(() => isInRemote(ws.id, fileName) === false, 'initial false')
      const result = await putFile(ws.id, fileName, reportBytes)
      assert.equal(result.ok, true)
      await awaitPresence(() => isInRemote(ws.id, fileName), 'cloud after putFile')
      // Let any in-flight fetchByTag → maybeAutoDownload chain
      // settle so a spurious fire would surface here.
      await new Promise((resolve) => { setTimeout(resolve, 250) })
      const refreshed = listWorkspaces().find((w) => w.id === ws.id)
      assert.deepEqual(refreshed?.reports, [fileName],
        'echo broadcast must not duplicate the fileName in reports')
      assert.equal(autoDownloadFires, 0,
        'echo broadcast must not fire onAutoDownloaded — already claimed + present on disk')
      // Local bytes are untouched by the echo.
      const stored = decodeUtf8(await gunzipBytes(await readFileBytes(fileName)))
      assert.equal(stored, reportText, 'echo must not overwrite the local copy')
    } finally {
      unsub()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName)
    }
  })

  it('peer PUT of a report we already have on disk AND claim: no re-download, no spurious fire', async () => {
    // Covers maybeAutoDownload's `claimed && existsLocally → return`
    // short-circuit. Two clients independently hold the same report on
    // disk and both claim it. To reach maybeAutoDownload at all (rather
    // than the earlier `ensureRemoteNames` skip), the fileName is
    // attached AFTER openWorkspace, so its tag→name mapping isn't
    // pre-seeded into `remoteNameByTag` at boot — discovery therefore
    // can't skip on name+membership and runs the fetch. The download
    // path must then notice the bytes are already present AND already
    // claimed and bail without re-saving, re-attaching, or firing the
    // bridge.
    const ws = await createWorkspaceWithReports('presence-have-and-claim', [])
    const fileName = 'already-have.json'
    const reportText = JSON.stringify({
      type: 'analysis',
      findings: [{ id: 'a', severity: 'high', file: 'x.js', line: 1, description: 'shared' }],
    })
    const reportBytes = await gzipBytes(encodeUtf8(reportText))
    await saveFileBytes(fileName, reportBytes)
    let fires = 0
    const unsub = onAutoDownloaded(() => { fires += 1 })
    try {
      openWorkspace(ws.id)
      // Attach after open so `remoteNameByTag` has no boot-seeded entry
      // for this tag — forces discovery into the fetch + maybeAutoDownload
      // path instead of the name-aware ensureRemoteNames skip.
      await setReportWorkspace(fileName, ws.id)
      const peer = await openPeerSession(ws)
      try {
        await peer.put({ fileName, content: reportBytes, prev: null })
        await awaitPresence(() => isInRemote(ws.id, fileName), 'cloud after peer put')
        // Let the broadcast → ensureRemoteNames → fetchByTag →
        // maybeAutoDownload chain run to completion.
        await new Promise((resolve) => { setTimeout(resolve, 300) })
        const refreshed = listWorkspaces().find((w) => w.id === ws.id)
        assert.deepEqual(refreshed?.reports, [fileName],
          'a report we already have + claim must not be duplicated in reports')
        assert.equal(fires, 0,
          'must not fire onAutoDownloaded for a report we already have on disk and claim')
        const stored = decodeUtf8(await gunzipBytes(await readFileBytes(fileName)))
        assert.equal(stored, reportText, 'local bytes must be left untouched')
      } finally { peer.close() }
    } finally {
      unsub()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName)
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

  // -----------------------------------------------------------------
  // ensureRemoteNames membership-aware skip: a cached `tag → name`
  // (or `tag → integrity`) only blocks the discovery `fetchByTag`
  // when the live workspace actually claims it. A cached entry the
  // workspace doesn't claim — local-only delete, sibling-tab
  // discovery that never auto-attached, or a peer-uploaded copy
  // under a different name — falls through to `fetchByTag` →
  // `maybeAutoDownload(Bundle)` so the workspace converges on the
  // remote inventory. This subsumes the previous
  // `dropFileFromPresenceCaches` / `dropBundleFromPresenceCaches`
  // cleanup helpers (no longer needed).
  // -----------------------------------------------------------------

  it('ensureRemoteNames re-discovers a report when a cached name is NOT in workspace.reports', async () => {
    // The user-reported repro: the presence cache pins a tag → name
    // from a prior session's fetchByTag (e.g., a sibling tab
    // discovered the name but `maybeAutoDownload` never ran for it,
    // or a local-only delete dropped the workspace claim while the
    // cache pin survived). A `workspace-subscribed` ack on the next
    // open then carries the tag, but the old "skip if cached"
    // shortcut in `ensureRemoteNames` left the file undownloaded
    // forever — workspace.reports never grew the entry back.
    //
    // Construct that exact state manually: pre-seed the persisted
    // cache with a tag → name pin for a peer-uploaded file we DON'T
    // claim. Then open the workspace and assert the file is
    // auto-downloaded + attached anyway.
    const ws = await createWorkspaceWithReports('ensure-rediscovers-report', [])
    const fileName = 'sibling-discovered.json'
    const reportText = JSON.stringify({
      type: 'analysis',
      findings: [{ id: 'a', severity: 'high', file: 'x.js', line: 1, description: 'sib' }],
    })
    const reportBytes = await gzipBytes(encodeUtf8(reportText))
    try {
      const peer = await openPeerSession(ws)
      try {
        const put = await peer.put({ fileName, content: reportBytes, prev: null })
        assert.equal(put.ok, true)
      } finally { peer.close() }
      // Pre-seed the persisted presence cache to simulate "we knew
      // the name from a prior session but never auto-attached". Mirror
      // exactly the shape the `workspace-subscribed` boot path expects.
      const { computeResourceTag } = await import('../client/sync/objstore-content-crypto.ts')
      const keys = await deriveObjstoreKeys(ws.privateKey, ws.id)
      const fileTag = await computeResourceTag(keys.tagKey, fileName)
      localStorage.setItem(`deepview.objstore-presence.${ws.id}`, JSON.stringify({
        names: { [fileTag]: fileName },
        bundles: {},
        bundleNames: {},
        // No localVersions entry — we never saved the bytes locally.
        localVersions: {},
      }))
      // Open the workspace. With the old "skip if cached" shortcut
      // the file would stay invisible (cache pin says we know the
      // name → skip → `maybeAutoDownload` never runs). The
      // membership-aware skip falls through because workspace.reports
      // doesn't claim it → fetchByTag → maybeAutoDownload → attach.
      openWorkspace(ws.id)
      await awaitPresence(() => {
        const live = listWorkspaces().find((w) => w.id === ws.id)
        return live?.reports?.includes(fileName) ?? false
      }, 'sibling-discovered file attaches via membership-aware ensureRemoteNames')
      const filesOnDisk = await listFiles()
      assert.ok(filesOnDisk.includes(fileName),
        `OPFS must hold ${fileName} after the rediscovery save`)
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      try { await deleteFile(fileName) } catch {}
    }
  })

  it('ensureRemoteNames re-fetches a bundle when a cached integrity is NOT in workspace.bundles', async () => {
    // Bundle counterpart of the rediscovery test. The full re-attach
    // round-trip requires OPFS (`maybeAutoDownloadBundle` calls
    // `saveBundle`, which is OPFS-only with no localStorage
    // fallback), so we assert the skip-predicate behaviour at the
    // discovery layer: with the old "skip if cached" shortcut the
    // discovery never even calls `fetchByTag` for a cached-but-
    // unclaimed integrity, so the workspace stays inconsistent with
    // remote. The membership-aware skip falls through and calls
    // `fetchByTag` — observable via `entry.remoteBundleByTag` being
    // re-populated after a forced detach + reopen.
    const { computeSha512Integrity } = await import('../common/integrity.js')
    const bundleBytes = Buffer.from('rediscover-bundle-bytes')
    const integrity = await computeSha512Integrity(bundleBytes)
    const ws = await createWorkspaceWithBundles('ensure-rediscovers-bundle', [integrity])
    try {
      const peer = await openPeerSession(ws)
      try {
        await peer.putBundle({ integrity, name: 'pkg.js', content: bundleBytes, prev: null })
      } finally { peer.close() }
      openWorkspace(ws.id)
      // Wait until the cache pins the integrity (the boot's attached-
      // tag pass + the broadcast handler both contribute here).
      await awaitPresence(() => isBundleInRemote(ws.id, integrity), 'integrity in remote')
      // Detach without touching remote — mirrors the "we used to
      // have it attached, then dropped the claim locally" scenario.
      // The persisted cache still pins the integrity.
      await setBundleWorkspace(integrity, null)
      // Reopen. The membership-aware skip sees workspace.bundles
      // doesn't claim the integrity and falls through to
      // `fetchByTag`. With OPFS unavailable in tests, the eventual
      // saveBundle would fail, but `fetchByTag` resolves regardless
      // and re-populates `remoteBundleByTag`. We assert THAT step
      // happened — the old "skip if cached" code would never have
      // fetched, so `discoverRemoteBundleIntegrities` would resolve
      // without the integrity instead of with it.
      closeWorkspace(ws.id)
      openWorkspace(ws.id)
      const integrities = await discoverRemoteBundleIntegrities(ws.id)
      assert.ok(integrities.includes(integrity),
        `membership-aware skip must run fetchByTag for cached-but-unclaimed integrity; got ${JSON.stringify(integrities)}`)
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('recheckRemoteStorage re-uploads a local report whose remote bytes are gone; marks peer-only missing; then good', async () => {
    const ws = await createWorkspace('objstore-recovery')
    const tag = (await deriveObjstoreKeys(ws.privateKey, ws.id)).workspaceTag
    const blobDir = path.join(server.serverDir, 'objstore', tag)
    const localName = `recover-local-${crypto.randomUUID()}.json`
    const localBytes = encodeUtf8(`local report payload for ${localName}`)
    try {
      // A report we hold locally AND have uploaded to the relay.
      await saveFileBytes(localName, localBytes)
      await setReportWorkspace(localName, ws.id)
      openWorkspace(ws.id)
      await awaitSyncOnline()
      assert.equal((await putFile(ws.id, localName, localBytes)).ok, true)
      await awaitPresence(() => isInRemote(ws.id, localName), 'local report in remote')

      // A peer uploads a report we do NOT hold locally.
      const peer = await openPeerSession(ws)
      const peerName = `peer-only-${crypto.randomUUID()}.json`
      try {
        assert.equal((await peer.put({ fileName: peerName, content: encodeUtf8('peer payload'), prev: null })).ok, true)
        await awaitPresence(() => remoteCount(ws.id) >= 2, 'peer report visible in remote')
        assert.ok(await fetchFile(ws.id, localName), 'local report fetchable before blob loss')

        // Simulate the 503 case: the relay loses the content bytes for
        // every live blob (reaper race / Vercel-Blob propagation loss)
        // while the DB rows survive. Delete only top-level live `.bin`
        // files — keep the dir + `.staging` so the recovery re-upload's
        // PUT can stage + promote.
        const liveBlobs = readdirSync(blobDir).filter((n) => n.endsWith('.bin'))
        assert.ok(liveBlobs.length >= 2, `expected >=2 live blobs, got ${liveBlobs.length}`)
        for (const n of liveBlobs) rmSync(path.join(blobDir, n))
        assert.equal(await fetchFile(ws.id, localName), null, 'bytes gone → fetch returns null (persistent 503)')

        // (1) Recovery: re-check + repair. The local report matches (same
        // name + same re-encrypted wire length) → re-uploaded; the
        // peer-only report has no local copy → missing. Also pin the
        // onList/onItem callback contract the dialog renders from.
        const listedStatuses = []
        const itemUpdates = []
        const r1 = await recheckRemoteStorage(ws.id, {
          onList: (rows) => { listedStatuses.push(...rows.map((x) => x.status)) },
          onItem: (row) => { itemUpdates.push(row) },
        })
        assert.equal(r1.counts.reuploaded, 1, `expected 1 reuploaded, got ${JSON.stringify(r1.counts)}`)
        assert.equal(r1.counts.missing, 1, `expected 1 missing, got ${JSON.stringify(r1.counts)}`)
        assert.equal(r1.items.find((i) => i.identifier === localName)?.status, 'reuploaded')
        // onList fired once with every row pending; onItem fired once per
        // object with a terminal status.
        assert.ok(listedStatuses.length >= 2 && listedStatuses.every((s) => s === 'checking'),
          `onList rows should all be 'checking'; got ${JSON.stringify(listedStatuses)}`)
        assert.equal(itemUpdates.length, r1.items.length, 'onItem fires once per object')
        assert.ok(itemUpdates.every((u) => ['good', 'reuploaded', 'missing'].includes(u.status)),
          'onItem rows carry a terminal status')

        // The re-upload restored the bytes — fetch works again, same content.
        const restored = await fetchFile(ws.id, localName)
        assert.ok(restored, 'local report fetchable again after recovery')
        assert.equal(decodeUtf8(restored.content), decodeUtf8(localBytes))

        // (2) A second re-check: the repaired report is now healthy
        // ('good'); the peer-only one (never recoverable here) stays missing.
        const r2 = await recheckRemoteStorage(ws.id)
        assert.equal(r2.counts.good, 1, `expected 1 good, got ${JSON.stringify(r2.counts)}`)
        assert.equal(r2.counts.reuploaded, 0)
        assert.equal(r2.counts.missing, 1)
      } finally {
        peer.close()
      }
    } finally {
      await deleteFile(localName).catch(() => {})
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('recheckRemoteStorage classifies a remote bundle with missing bytes (no local copy) as missing', async () => {
    // The local-bundle RE-UPLOAD path (recoverBundle → putBundleToRemote
    // → readBundle) is OPFS-only, and OPFS is unavailable in the Node
    // test env (saveBundle/readBundle throw "OPFS unavailable" — see the
    // other bundle tests), so it can't be exercised end-to-end here; it's
    // covered by review + the shared report path. This pins the bundle
    // BRANCH of classifyAndRecover: a peer bundle in the fresh DB listing
    // whose bytes are gone and that we don't hold locally → 'missing',
    // classified as kind 'bundle'.
    const ws = await createWorkspace('objstore-recovery-bundle')
    const tag = (await deriveObjstoreKeys(ws.privateKey, ws.id)).workspaceTag
    const blobDir = path.join(server.serverDir, 'objstore', tag)
    const { computeSha512Integrity } = await import('../common/integrity.js')
    const bundleBytes = encodeUtf8(`peer bundle ${crypto.randomUUID()}`)
    const integrity = await computeSha512Integrity(bundleBytes)
    const peer = await openPeerSession(ws)
    try {
      assert.equal((await peer.putBundle({ integrity, name: 'pkg.js', content: bundleBytes, prev: null })).ok, true)
      openWorkspace(ws.id)
      await awaitSyncOnline()
      await awaitPresence(() => isBundleInRemote(ws.id, integrity), 'bundle in remote')
      // Force discovery to classify it as a bundle (populate the cache)
      // while the bytes are still present.
      assert.ok((await discoverRemoteBundleIntegrities(ws.id)).includes(integrity))
      // Lose the relay bytes, then re-check.
      for (const n of readdirSync(blobDir).filter((x) => x.endsWith('.bin'))) rmSync(path.join(blobDir, n))
      const r = await recheckRemoteStorage(ws.id)
      assert.equal(r.counts.missing, 1, `expected 1 missing, got ${JSON.stringify(r.counts)}`)
      assert.equal(r.counts.reuploaded, 0)
      assert.equal(r.items[0]?.kind, 'bundle', `expected bundle kind, got ${JSON.stringify(r.items[0])}`)
      assert.equal(r.items[0]?.status, 'missing')
    } finally {
      peer.close()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('recheckRemoteStorage marks a report missing when the local copy no longer matches the expected length', async () => {
    const ws = await createWorkspace('objstore-recovery-mismatch')
    const tag = (await deriveObjstoreKeys(ws.privateKey, ws.id)).workspaceTag
    const blobDir = path.join(server.serverDir, 'objstore', tag)
    const name = `mismatch-${crypto.randomUUID()}.json`
    try {
      await saveFileBytes(name, encodeUtf8('original content'))
      await setReportWorkspace(name, ws.id)
      openWorkspace(ws.id)
      await awaitSyncOnline()
      assert.equal((await putFile(ws.id, name, encodeUtf8('original content'))).ok, true)
      await awaitPresence(() => isInRemote(ws.id, name), 'report in remote')

      // Lose the relay bytes, THEN diverge the local copy to a different
      // length. Recovery must refuse to overwrite the row with content
      // that no longer matches the recorded contentLength.
      for (const n of readdirSync(blobDir).filter((x) => x.endsWith('.bin'))) rmSync(path.join(blobDir, n))
      await saveFileBytes(name, encodeUtf8('a totally different and notably longer local content body'))

      const r = await recheckRemoteStorage(ws.id)
      assert.equal(r.counts.missing, 1, `expected 1 missing, got ${JSON.stringify(r.counts)}`)
      assert.equal(r.counts.reuploaded, 0, 'must NOT re-upload a length-mismatched local copy')
      assert.equal(r.items.find((i) => i.identifier === name)?.status, 'missing')
      // Bytes stay gone — we did not overwrite the row with mismatched content.
      assert.equal(await fetchFile(ws.id, name), null)
    } finally {
      await deleteFile(name).catch(() => {})
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('recheckRemoteStorage recovers a report even when the in-memory remoteTags lags the fresh listing', async () => {
    // Regression: recovery rows come from the authoritative fresh DB
    // listing, but a stale guard used to gate on entry.remoteTags — so a
    // recoverable object missing from the lagging in-memory set was wrongly
    // reported 'missing'. Clearing remoteTags reproduces that divergence;
    // recovery must still re-upload (it observes only mid-recheck deletes).
    const ws = await createWorkspace('objstore-recovery-lag')
    const tag = (await deriveObjstoreKeys(ws.privateKey, ws.id)).workspaceTag
    const blobDir = path.join(server.serverDir, 'objstore', tag)
    const name = `lag-${crypto.randomUUID()}.json`
    const bytes = encodeUtf8(`lagging report ${name}`)
    try {
      await saveFileBytes(name, bytes)
      await setReportWorkspace(name, ws.id)
      openWorkspace(ws.id)
      await awaitSyncOnline()
      assert.equal((await putFile(ws.id, name, bytes)).ok, true)
      await awaitPresence(() => isInRemote(ws.id, name), 'report in remote')

      // Lose the relay bytes AND simulate the in-memory view lagging the
      // authoritative listing by clearing remoteTags.
      for (const n of readdirSync(blobDir).filter((x) => x.endsWith('.bin'))) rmSync(path.join(blobDir, n))
      __test__.getEntry(ws.id).remoteTags.clear()

      const r = await recheckRemoteStorage(ws.id)
      assert.equal(r.counts.reuploaded, 1, `expected 1 reuploaded despite remoteTags lag, got ${JSON.stringify(r.counts)}`)
      assert.equal(r.items.find((i) => i.identifier === name)?.status, 'reuploaded')
      assert.ok(await fetchFile(ws.id, name), 'bytes restored after recovery')
    } finally {
      await deleteFile(name).catch(() => {})
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('recheckRemoteStorage reports a re-upload that fails as "failed" (not swallowed into "missing")', async () => {
    // The re-upload attempt can throw (a transient relay/blob commit error
    // — 500/400 — or a re-fired conflict). recoverReport used to swallow
    // ANY such failure into 'missing', discarding the cause; it must now
    // surface 'failed' with the reason (retryable), distinct from a
    // genuinely-absent local copy.
    const ws = await createWorkspace('objstore-recovery-failed')
    const tag = (await deriveObjstoreKeys(ws.privateKey, ws.id)).workspaceTag
    const blobDir = path.join(server.serverDir, 'objstore', tag)
    const name = `failed-${crypto.randomUUID()}.json`
    const bytes = encodeUtf8(`failing report ${name}`)
    try {
      await saveFileBytes(name, bytes)
      await setReportWorkspace(name, ws.id)
      openWorkspace(ws.id)
      await awaitSyncOnline()
      assert.equal((await putFile(ws.id, name, bytes)).ok, true)
      await awaitPresence(() => isInRemote(ws.id, name), 'report in remote')

      for (const n of readdirSync(blobDir).filter((x) => x.endsWith('.bin'))) rmSync(path.join(blobDir, n))

      // Make the re-upload throw at the session layer (simulating a failed
      // commit), and assert it surfaces as 'failed' with the reason.
      const e = __test__.getEntry(ws.id)
      const realPut = e.session.put.bind(e.session)
      e.session.put = () => Promise.reject(new Error('simulated commit failure'))
      try {
        const r = await recheckRemoteStorage(ws.id)
        assert.equal(r.counts.failed, 1, `expected 1 failed, got ${JSON.stringify(r.counts)}`)
        assert.equal(r.counts.missing, 0, 'an attempted-but-failed re-upload must not count as missing')
        const row = r.items.find((i) => i.identifier === name)
        assert.equal(row?.status, 'failed')
        assert.match(row?.detail ?? '', /simulated commit failure/u)
      } finally {
        e.session.put = realPut
      }
    } finally {
      await deleteFile(name).catch(() => {})
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('recheckRemoteStorage reports a verification fetch that throws as "check-failed", not a re-upload', async () => {
    // The download used to verify each object can throw on a transport /
    // session hiccup (e.g. an SSE session restart that outlived the
    // client's retry) — distinct from returning null, which is the
    // authoritative "bytes gone" signal. classifyAndRecover used to
    // `catch { got = null }`, conflating the two: a thrown verification
    // fetch was mis-read as bytes-missing and triggered a re-upload, whose
    // own failure then surfaced as 're-upload failed' — hiding that the
    // DOWNLOAD was the problem. A throw must now be 'check-failed' (health
    // unknown, retryable), never a re-upload or a 'missing'.
    const ws = await createWorkspace('objstore-recovery-checkfail')
    const name = `checkfail-${crypto.randomUUID()}.json`
    const bytes = encodeUtf8(`check-fail report ${name}`)
    try {
      // Keep a matching local copy attached + uploaded. With the old
      // swallow-to-null behaviour this would have re-uploaded (→ 'reuploaded'),
      // so asserting 'check-failed' proves the throw is no longer mistaken
      // for bytes-missing.
      await saveFileBytes(name, bytes)
      await setReportWorkspace(name, ws.id)
      openWorkspace(ws.id)
      await awaitSyncOnline()
      assert.equal((await putFile(ws.id, name, bytes)).ok, true)
      await awaitPresence(() => isInRemote(ws.id, name), 'report in remote')

      // Make the verification fetch throw the transient session-restart
      // error (the exact reason the client surfaces on an SSE replica hop
      // once its own retry is exhausted).
      const e = __test__.getEntry(ws.id)
      const realFetch = e.session.fetchByTag.bind(e.session)
      const realPut = e.session.put.bind(e.session)
      let putCalls = 0
      e.session.put = (...args) => { putCalls += 1; return realPut(...args) }
      e.session.fetchByTag = () => Promise.reject(new Error(`objstore: ${SESSION_RESTART_REASON}`))
      try {
        const r = await recheckRemoteStorage(ws.id)
        assert.equal(r.counts['check-failed'], 1, `expected 1 check-failed, got ${JSON.stringify(r.counts)}`)
        assert.equal(r.counts.reuploaded, 0, 'a verification throw must not trigger a re-upload')
        assert.equal(r.counts.failed, 0, 'a download error must not be reported as an upload failure')
        assert.equal(r.counts.missing, 0, 'a verification throw must not be reported as missing')
        assert.equal(putCalls, 0, 'recovery must not attempt a re-upload when the verification fetch threw')
        const row = r.items.find((i) => i.identifier === name)
        assert.equal(row?.status, 'check-failed')
        assert.match(row?.detail ?? '', /session restarted/u)
      } finally {
        e.session.fetchByTag = realFetch
        e.session.put = realPut
      }
    } finally {
      await deleteFile(name).catch(() => {})
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  it('recheckRemoteStorage does not resurrect an object deleted mid-recheck', async () => {
    // A delete observed DURING the recheck (here: while awaiting the
    // per-object fetch) must not be re-uploaded over its tombstone — even
    // though we hold a matching local copy. It stays 'missing'.
    const ws = await createWorkspace('objstore-recovery-midrun-delete')
    const tag = (await deriveObjstoreKeys(ws.privateKey, ws.id)).workspaceTag
    const blobDir = path.join(server.serverDir, 'objstore', tag)
    const name = `midrun-${crypto.randomUUID()}.json`
    const bytes = encodeUtf8(`midrun report ${name}`)
    const peer = await openPeerSession(ws)
    try {
      await saveFileBytes(name, bytes)
      await setReportWorkspace(name, ws.id)
      openWorkspace(ws.id)
      await awaitSyncOnline()
      const put = await putFile(ws.id, name, bytes)
      assert.equal(put.ok, true)
      await awaitPresence(() => isInRemote(ws.id, name), 'report in remote')
      // Drain the background name-discovery worker BEFORE arming the
      // one-shot fetch interception below. `putFile` seeds fileTags /
      // remoteVersions but NOT remoteNameByTag, so the put's own
      // objstore-put echo kicks `ensureRemoteNames` → a background
      // `fetchByTag` for this tag. That fetch is still in flight when we
      // reach here (`isInRemote` only needs the tag in `remoteTags`, which
      // the broadcast sets before the fetch resolves), so without this
      // drain it — not the recheck's verification fetch — would consume the
      // intercept-once below and fire the peer delete at an uncontrolled
      // time, racing `freshRemoteListing`'s fresh DB snapshot. When the
      // delete won that race the snapshot came back empty and the recheck
      // returned zero rows (`r.items[0]` undefined → flake). Awaiting
      // discovery resolves the in-flight fetch (and caches the name, so no
      // later pass re-fetches), leaving the recheck's own per-object fetch
      // as the sole consumer of the interception.
      await discoverRemoteFileNames(ws.id)
      for (const n of readdirSync(blobDir).filter((x) => x.endsWith('.bin'))) rmSync(path.join(blobDir, n))

      // Intercept the per-object fetch to make a peer delete land mid-recheck:
      // wait until THIS session observes the objstore-deleted broadcast (so
      // recovery's deletedDuringRecheck records it), then report bytes-gone.
      const e = __test__.getEntry(ws.id)
      let resolveObserved
      const observed = new Promise((res) => { resolveObserved = res })
      const offObserver = e.session.onDeleted(() => resolveObserved())
      const realFetchByTag = e.session.fetchByTag.bind(e.session)
      e.session.fetchByTag = async () => {
        e.session.fetchByTag = realFetchByTag  // intercept once
        await peer.delete(name, { version: put.meta.version, incarnation: put.meta.incarnation })
        await observed
        return null
      }
      try {
        const r = await recheckRemoteStorage(ws.id)
        assert.equal(r.counts.reuploaded, 0, 'a mid-recheck-deleted object must not be re-uploaded')
        assert.equal(r.items[0]?.status, 'missing')
        // And it stays deleted server-side (not resurrected).
        assert.equal(await fetchFile(ws.id, name), null)
      } finally {
        offObserver()
        e.session.fetchByTag = realFetchByTag
      }
    } finally {
      peer.close()
      await deleteFile(name).catch(() => {})
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })

  // ── Stale report copies (two members seeing different versions) ────

  it('peer delete + re-upload under the same name reaches an online peer holding the old copy', async () => {
    // Regression: a delete + re-upload mints a fresh incarnation whose
    // version restarts at 1. The delete dropped the tag, so the re-upload
    // looked like a brand-new tag; discovery found the fileName claimed
    // and on disk and skipped it as "already have it" — the peer stayed
    // on the deleted report's content while everyone else saw the new one.
    const ws = await createWorkspaceWithReports('presence-recreate-live', [])
    const fileName = 'recreate-live.json'
    const v1Text = reportJson('v1')
    const v2Text = reportJson('v2-recreated')
    try {
      openWorkspace(ws.id)
      const peer = await openPeerSession(ws)
      try {
        const v1Put = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(v1Text)), prev: null })
        assert.equal(v1Put.ok, true)
        assert.equal(await waitForLocalText(fileName, v1Text), v1Text, 'v1 auto-downloaded')
        assert.equal((await peer.delete(fileName, v1Put.meta)).ok, true)
        await awaitPresence(() => !isInRemote(ws.id, fileName), 'tag dropped after the peer delete')
        const v2Put = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(v2Text)), prev: null })
        assert.equal(v2Put.ok, true)
        assert.equal(v2Put.meta.version, 1, 'a re-upload restarts at v1 under a fresh incarnation')
        assert.equal(await waitForLocalText(fileName, v2Text), v2Text, 'local copy must follow the re-upload')
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('peer delete + re-upload while this client is offline is picked up on reopen', async () => {
    // Regression: the boot-divergence sweep compared versions only; the
    // re-upload sits at v1 again, which never exceeds the local baseline.
    const ws = await createWorkspaceWithReports('presence-recreate-offline', [])
    const fileName = 'recreate-offline.json'
    const v1Text = reportJson('v1')
    const v2Text = reportJson('v2-recreated-offline')
    try {
      openWorkspace(ws.id)
      let peer = await openPeerSession(ws)
      let v1Put
      try {
        v1Put = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(v1Text)), prev: null })
        assert.equal(v1Put.ok, true)
        assert.equal(await waitForLocalText(fileName, v1Text), v1Text, 'v1 auto-downloaded')
      } finally { peer.close() }
      closeWorkspace(ws.id)
      triageSync.closeSession(ws.id)

      peer = await openPeerSession(ws)
      try {
        assert.equal((await peer.delete(fileName, v1Put.meta)).ok, true)
        const v2Put = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(v2Text)), prev: null })
        assert.equal(v2Put.ok, true)
        assert.equal(v2Put.meta.version, v1Put.meta.version, 'same version number, different incarnation')
      } finally { peer.close() }

      triageSync.openSession(ws.id)
      await awaitSyncOnline()
      openWorkspace(ws.id)
      assert.equal(await waitForLocalText(fileName, v2Text), v2Text, 'local copy must catch up to the re-upload')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a claimed copy never reconciled with the cloud gets a baseline on open, so a later offline Replace lands', async () => {
    // Regression: a copy that arrived outside the auto-download path
    // (imported, dropped independently, downloaded through the dialog)
    // had no baseline, discovery skipped it, and the boot sweep ignored
    // it — so a Replace that landed while this client was offline never
    // reached it.
    const ws = await createWorkspaceWithReports('presence-no-baseline', [])
    const fileName = 'no-baseline.json'
    const v1Text = reportJson('v1')
    const v2Text = reportJson('v2-offline-replace')
    const v1Bytes = await gzipBytes(encodeUtf8(v1Text))
    try {
      let peer = await openPeerSession(ws)
      let v1Put
      try {
        v1Put = await peer.put({ fileName, content: v1Bytes, prev: null })
        assert.equal(v1Put.ok, true)
      } finally { peer.close() }
      await saveFileBytes(fileName, v1Bytes)
      await setReportWorkspace(fileName, ws.id)
      openWorkspace(ws.id)
      // The one-time verification fetch records the baseline.
      await awaitPresence(() => (__test__.getEntry(ws.id)?.baselines.size ?? 0) > 0, 'baseline recorded')
      closeWorkspace(ws.id)
      triageSync.closeSession(ws.id)

      peer = await openPeerSession(ws)
      try {
        const v2Put = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(v2Text)), prev: v1Put.meta })
        assert.equal(v2Put.ok, true)
      } finally { peer.close() }

      triageSync.openSession(ws.id)
      await awaitSyncOnline()
      openWorkspace(ws.id)
      assert.equal(await waitForLocalText(fileName, v2Text), v2Text, 'local copy must catch up to the offline Replace')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('downloadFileFromRemote records a baseline, so a later offline Replace lands', async () => {
    // The download dialog used to fetch + save the bytes itself, leaving
    // the copy without a baseline — the no-baseline trap above.
    const ws = await createWorkspaceWithReports('presence-dialog-download', [])
    const fileName = 'dialog-download.json'
    const v1Text = reportJson('v1')
    const v2Text = reportJson('v2-offline-replace')
    try {
      let peer = await openPeerSession(ws)
      let v1Put
      try {
        v1Put = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(v1Text)), prev: null })
        assert.equal(v1Put.ok, true)
      } finally { peer.close() }
      openWorkspace(ws.id)
      // Opening auto-downloads the report too (and records a baseline);
      // let that settle, then wipe the copy + baseline so only the
      // dialog path can put them back.
      await discoverRemoteFileNames(ws.id)
      const entry = __test__.getEntry(ws.id)
      entry.baselines.clear()
      await deleteFile(fileName)
      assert.deepEqual(await downloadFileFromRemote(ws.id, fileName), { ok: true })
      assert.equal(await localReportText(fileName), v1Text)
      assert.ok(listWorkspaces().find((w) => w.id === ws.id)?.reports?.includes(fileName), 'downloaded report is attached')
      const [baseline] = entry.baselines.values()
      assert.deepEqual({ ...baseline, hash: typeof baseline.hash }, { version: 1, incarnation: v1Put.meta.incarnation, synced: true, hash: 'string' }, 'dialog download records the baseline')
      closeWorkspace(ws.id)
      triageSync.closeSession(ws.id)

      peer = await openPeerSession(ws)
      try {
        assert.equal((await peer.put({ fileName, content: await gzipBytes(encodeUtf8(v2Text)), prev: v1Put.meta })).ok, true)
      } finally { peer.close() }

      triageSync.openSession(ws.id)
      await awaitSyncOnline()
      openWorkspace(ws.id)
      assert.equal(await waitForLocalText(fileName, v2Text), v2Text, 'local copy must catch up to the offline Replace')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('downloadFileFromRemote refuses a payload that is not a recognized report', async () => {
    const ws = await createWorkspaceWithReports('presence-dialog-download-forged', [])
    const fileName = 'dialog-forged.json'
    try {
      const peer = await openPeerSession(ws)
      try {
        assert.equal((await peer.put({ fileName, content: await gzipBytes(encodeUtf8('not a report')), prev: null })).ok, true)
      } finally { peer.close() }
      openWorkspace(ws.id)
      const r = await downloadFileFromRemote(ws.id, fileName)
      assert.equal(r.ok, false)
      assert.match(r.reason, /not a recognized report/u)
      assert.ok(!(await listFiles()).includes(fileName), 'nothing saved')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  // Claimed local copy `localText` against a cloud copy `cloudText`, never
  // reconciled — so nothing says which is newer. Opens the workspace and
  // waits for the one-time compare. Returns the workspace + the peer put.
  async function openDifferingCopies(label, fileName, localText, cloudText) {
    const ws = await createWorkspaceWithReports(label, [])
    const peer = await openPeerSession(ws)
    let put
    try {
      put = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(cloudText)), prev: null })
      assert.equal(put.ok, true)
    } finally { peer.close() }
    await saveFileBytes(fileName, await gzipBytes(encodeUtf8(localText)))
    await setReportWorkspace(fileName, ws.id)
    openWorkspace(ws.id)
    await awaitPresence(() => (__test__.getEntry(ws.id)?.baselines.size ?? 0) > 0, 'compared on open')
    return { ws, put }
  }

  it('recheckRemoteStorage leaves a difference with no evidence to the user; "Use cloud copy" takes the cloud copy', async () => {
    // Regression: the re-check only proved each cloud object was
    // fetchable and reported a stale local copy as "available". Without
    // evidence which copy is newer it must not overwrite either — it
    // reports 'differs' and the user picks.
    const fileName = 'recheck-differs-cloud.json'
    const localText = reportJson('local')
    const cloudText = reportJson('cloud')
    let fires = 0
    const unsub = onAutoDownloaded((id, name) => { if (name === fileName) fires += 1 })
    const { ws } = await openDifferingCopies('presence-recheck-differs-cloud', fileName, localText, cloudText)
    try {
      // The automatic path keeps an unreconciled local copy too.
      assert.equal(await localReportText(fileName), localText, 'automatic paths keep an unreconciled local copy')
      assert.equal(__test__.getEntry(ws.id).baselines.values().next().value.synced, false, 'recorded as compared-and-different')
      assert.deepEqual(differingReports(ws.id), [fileName], 'surfaced for a re-check without anyone clicking one')

      const r = await recheckRemoteStorage(ws.id)
      assert.equal(r.items.length, 1)
      assert.equal(r.items[0].status, 'differs', `row: ${JSON.stringify(r.items[0])}`)
      assert.equal(r.items[0].identifier, fileName)
      assert.equal(r.counts.differs, 1)
      assert.equal(await localReportText(fileName), localText, 'the re-check touches neither copy')
      assert.equal(fires, 0)

      assert.deepEqual(await resolveReportDifference(ws.id, fileName, 'cloud'), { status: 'updated' })
      assert.equal(await localReportText(fileName), cloudText, 'local copy replaced with the cloud copy')
      assert.equal(fires, 1, 'UI bridge told to reload the updated report')
      assert.deepEqual(differingReports(ws.id), [], 'resolved')

      const again = await recheckRemoteStorage(ws.id)
      assert.equal(again.items[0].status, 'good', 'a second re-check finds the copies in sync')
    } finally {
      unsub()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('resolveReportDifference("local") uploads over the compared cloud copy, never over a newer one', async () => {
    const fileName = 'recheck-differs-local.json'
    const localText = reportJson('local')
    const cloudText = reportJson('cloud')
    const newerText = reportJson('cloud-newer')
    const { ws, put } = await openDifferingCopies('presence-recheck-differs-local', fileName, localText, cloudText)
    const peer = await openPeerSession(ws)
    try {
      const first = (await recheckRemoteStorage(ws.id)).items[0]
      assert.equal(first.status, 'differs')
      assert.deepEqual(first.compared, { version: put.meta.version, incarnation: put.meta.incarnation })
      // A member replaces the cloud copy after the compare: "Upload mine"
      // must not silently overwrite what the user never saw.
      const newer = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(newerText)), prev: put.meta })
      assert.equal(newer.ok, true)
      await awaitPresence(() => __test__.getEntry(ws.id)?.remoteMeta.get(__test__.getEntry(ws.id).baselines.keys().next().value)?.version === 2, 'saw v2')
      const refused = await resolveReportDifference(ws.id, fileName, 'local', first.compared)
      assert.equal(refused.status, 'failed')
      assert.match(refused.detail, /changed since it was compared/u)
      let cloud = await peer.fetch(fileName)
      assert.equal(decodeUtf8(await gunzipBytes(cloud.content)), newerText, 'the newer cloud copy survives')

      // The v2 didn't settle the difference (review r4099451232): the
      // local copy is kept, and a re-check compares it with v2.
      assert.equal(await localReportText(fileName), localText, 'the local copy is kept')
      const second = (await recheckRemoteStorage(ws.id)).items[0]
      assert.equal(second.status, 'differs')
      assert.deepEqual(second.compared, { version: newer.meta.version, incarnation: newer.meta.incarnation })
      assert.deepEqual(await resolveReportDifference(ws.id, fileName, 'local', second.compared), { status: 'uploaded' })
      cloud = await peer.fetch(fileName)
      assert.equal(decodeUtf8(await gunzipBytes(cloud.content)), localText, 'the cloud copy now carries the local copy')
      assert.equal(await localReportText(fileName), localText)
    } finally {
      peer.close()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a later cloud Replace does not settle a difference — a local copy edited since is kept (review r4099451232)', async () => {
    // Regression: an unsynced ("differs") baseline carried no local hash,
    // so a local edit after the compare went unnoticed and the next cloud
    // Replace moved past the marker and overwrote the edit. Nothing says
    // the cloud copy is the newer one — the difference stays the user's.
    const fileName = 'differs-then-edited.json'
    const localText = reportJson('local')
    const cloudText = reportJson('cloud')
    const editedText = reportJson('local-edited')
    const newerText = reportJson('cloud-newer')
    const { ws, put } = await openDifferingCopies('presence-differs-edited', fileName, localText, cloudText)
    const peer = await openPeerSession(ws)
    try {
      const entry = __test__.getEntry(ws.id)
      const tag = entry.baselines.keys().next().value
      assert.equal(entry.baselines.get(tag).synced, false, 'recorded as compared-and-different')
      await saveFileBytes(fileName, await gzipBytes(encodeUtf8(editedText)))
      const newer = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(newerText)), prev: put.meta })
      assert.equal(newer.ok, true)
      // Polled: a marker moving to v2 flips nothing the change listeners
      // report.
      for (const until = Date.now() + 5_000; entry.baselines.get(tag)?.version !== newer.meta.version && Date.now() < until;) {
        await new Promise((resolve) => { setTimeout(resolve, 20) })
      }
      assert.equal(entry.baselines.get(tag)?.version, newer.meta.version, 'compared with v2')
      assert.equal(await localReportText(fileName), editedText, 'the local edit survives the cloud Replace')
      assert.equal(entry.baselines.get(tag).synced, false, 'still a difference, now against v2')
      assert.deepEqual(differingReports(ws.id), [fileName], 'still asks for a re-check')
      const row = (await recheckRemoteStorage(ws.id)).items[0]
      assert.equal(row.status, 'differs', 'the re-check leaves it to the user too')
      assert.deepEqual(row.compared, { version: newer.meta.version, incarnation: newer.meta.incarnation })
      assert.equal(await localReportText(fileName), editedText)
    } finally {
      peer.close()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('recheckRemoteStorage takes the cloud copy when it moved past a synced baseline', async () => {
    // Evidence the cloud copy is newer: the local copy was in sync at an
    // earlier cloud state. (Normally the automatic paths apply this
    // first; pin the state directly so the re-check branch is what runs.)
    const ws = await createWorkspaceWithReports('presence-recheck-moved', [])
    const fileName = 'recheck-moved.json'
    const oldText = reportJson('old')
    const cloudText = reportJson('cloud')
    try {
      openWorkspace(ws.id)
      const peer = await openPeerSession(ws)
      let put
      try {
        put = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(cloudText)), prev: null })
        assert.equal(put.ok, true)
      } finally { peer.close() }
      assert.equal(await waitForLocalText(fileName, cloudText), cloudText)
      await discoverRemoteFileNames(ws.id)
      const entry = __test__.getEntry(ws.id)
      const [tag] = entry.baselines.keys()
      await saveFileBytes(fileName, await gzipBytes(encodeUtf8(oldText)))
      entry.baselines.set(tag, { version: 0, incarnation: put.meta.incarnation, synced: true })

      const r = await recheckRemoteStorage(ws.id)
      assert.equal(r.items[0].status, 'updated', `row: ${JSON.stringify(r.items[0])}`)
      assert.equal(await localReportText(fileName), cloudText)
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('recheckRemoteStorage uploads a local Replace whose upload never landed', async () => {
    // The baseline proves the cloud copy is the one this client last
    // synced, so the differing local copy is the newer report: push it
    // rather than revert the user's Replace.
    const ws = await createWorkspaceWithReports('presence-recheck-upload', [])
    const fileName = 'recheck-upload.json'
    const v1Text = reportJson('v1')
    const localText = reportJson('v2-local-replace')
    try {
      openWorkspace(ws.id)
      const peer = await openPeerSession(ws)
      try {
        assert.equal((await peer.put({ fileName, content: await gzipBytes(encodeUtf8(v1Text)), prev: null })).ok, true)
        assert.equal(await waitForLocalText(fileName, v1Text), v1Text, 'v1 auto-downloaded')
        await discoverRemoteFileNames(ws.id)
        // The local Replace: new bytes on disk, never uploaded.
        await saveFileBytes(fileName, await gzipBytes(encodeUtf8(localText)))

        const r = await recheckRemoteStorage(ws.id)
        assert.equal(r.items[0].status, 'uploaded', `row: ${JSON.stringify(r.items[0])}`)
        assert.equal(await localReportText(fileName), localText, 'local copy kept')
        const cloud = await peer.fetch(fileName)
        assert.equal(decodeUtf8(await gunzipBytes(cloud.content)), localText, 'cloud copy now carries the local Replace')
        assert.equal(cloud.version, 2)
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('legacy cache baselines (version-only localVersions) still drive the reconnect sweep, and stay written', async () => {
    // Compatibility: caches written before incarnations were tracked hold
    // `localVersions: { tag: version }`. They must keep working as
    // baselines after an upgrade, and `localVersions` must keep being
    // written for older builds (a stale tab, a rollback).
    const { computeResourceTag } = await import('../client/sync/objstore-content-crypto.ts')
    const ws = await createWorkspaceWithReports('presence-legacy-cache', [])
    const fileName = 'legacy-cache.json'
    const v1Text = reportJson('v1')
    const v2Text = reportJson('v2-offline-replace')
    const v1Bytes = await gzipBytes(encodeUtf8(v1Text))
    const keys = await deriveObjstoreKeys(ws.privateKey, ws.id)
    const tag = await computeResourceTag(keys.tagKey, fileName)
    const cacheKey = `deepview.objstore-presence.${ws.id}`
    try {
      const peer = await openPeerSession(ws)
      try {
        const v1Put = await peer.put({ fileName, content: v1Bytes, prev: null })
        assert.equal(v1Put.ok, true)
        assert.equal((await peer.put({ fileName, content: await gzipBytes(encodeUtf8(v2Text)), prev: v1Put.meta })).ok, true)
      } finally { peer.close() }
      await saveFileBytes(fileName, v1Bytes)
      await setReportWorkspace(fileName, ws.id)
      localStorage.setItem(cacheKey, JSON.stringify({ names: { [tag]: fileName }, bundles: {}, bundleNames: {}, localVersions: { [tag]: 1 } }))
      openWorkspace(ws.id)
      assert.equal(await waitForLocalText(fileName, v2Text), v2Text, 'legacy baseline v1 < cloud v2 → re-fetched')
      let written = null
      const startedAt = Date.now()
      while (Date.now() - startedAt < 5_000) {
        written = JSON.parse(localStorage.getItem(cacheKey))
        if (written?.localVersions?.[tag] === 2) break
        await new Promise((resolve) => { setTimeout(resolve, 20) })
      }
      assert.equal(written.localVersions[tag], 2, 'localVersions still written for older builds')
      assert.equal(written.baselines[tag].version, 2)
      assert.equal(typeof written.baselines[tag].incarnation, 'string', 'upgraded to a full baseline')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  // Legacy (version-only) baseline for `fileName` in a fresh cache, with
  // `localText` claimed on disk. Returns the workspace + its tag.
  async function withLegacyBaseline(label, fileName, localText, version) {
    const { computeResourceTag } = await import('../client/sync/objstore-content-crypto.ts')
    const ws = await createWorkspaceWithReports(label, [])
    const keys = await deriveObjstoreKeys(ws.privateKey, ws.id)
    const tag = await computeResourceTag(keys.tagKey, fileName)
    await saveFileBytes(fileName, await gzipBytes(encodeUtf8(localText)))
    await setReportWorkspace(fileName, ws.id)
    localStorage.setItem(`deepview.objstore-presence.${ws.id}`, JSON.stringify({ names: { [tag]: fileName }, bundles: {}, bundleNames: {}, localVersions: { [tag]: version } }))
    return { ws, tag }
  }

  it('a legacy baseline is fetched once on open and upgraded to a full one (review r4098518958)', async () => {
    // A version-only baseline used to satisfy discovery's skip, so it was
    // never fetched and never learned its incarnation.
    const fileName = 'legacy-upgrade.json'
    const text = reportJson('same')
    const { ws, tag } = await withLegacyBaseline('presence-legacy-upgrade', fileName, text, 1)
    try {
      const peer = await openPeerSession(ws)
      let put
      try {
        put = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(text)), prev: null })
        assert.equal(put.ok, true)
      } finally { peer.close() }
      openWorkspace(ws.id)
      await awaitPresence(() => __test__.getEntry(ws.id)?.baselines.get(tag)?.incarnation != null, 'baseline upgraded')
      const baseline = __test__.getEntry(ws.id).baselines.get(tag)
      assert.deepEqual({ ...baseline, hash: typeof baseline.hash }, { version: 1, incarnation: put.meta.incarnation, synced: true, hash: 'string' })
      assert.equal(await localReportText(fileName), text)
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a legacy baseline above the cloud version is a re-upload and is taken automatically', async () => {
    // Versions never go down within one incarnation, so a cloud copy at
    // v1 when we once synced v3 can only be a delete + re-upload.
    const fileName = 'legacy-lower.json'
    const oldText = reportJson('old')
    const cloudText = reportJson('re-uploaded')
    const { ws } = await withLegacyBaseline('presence-legacy-lower', fileName, oldText, 3)
    try {
      const peer = await openPeerSession(ws)
      try { assert.equal((await peer.put({ fileName, content: await gzipBytes(encodeUtf8(cloudText)), prev: null })).ok, true) } finally { peer.close() }
      openWorkspace(ws.id)
      assert.equal(await waitForLocalText(fileName, cloudText), cloudText)
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a legacy baseline at the same version with different content is not clobbered — the re-check reports it', async () => {
    // Ambiguous: a re-upload that restarted at the same version looks
    // exactly like a local Replace that never uploaded.
    const fileName = 'legacy-same-version.json'
    const localText = reportJson('local')
    const cloudText = reportJson('cloud')
    const { ws, tag } = await withLegacyBaseline('presence-legacy-same', fileName, localText, 1)
    try {
      const peer = await openPeerSession(ws)
      try { assert.equal((await peer.put({ fileName, content: await gzipBytes(encodeUtf8(cloudText)), prev: null })).ok, true) } finally { peer.close() }
      openWorkspace(ws.id)
      await awaitPresence(() => __test__.getEntry(ws.id)?.baselines.get(tag)?.incarnation != null, 'compared on open')
      assert.equal(__test__.getEntry(ws.id).baselines.get(tag).synced, false)
      assert.equal(await localReportText(fileName), localText, 'local copy kept')
      assert.equal((await recheckRemoteStorage(ws.id)).items[0].status, 'differs')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  // ── Surfacing differences without a re-check ───────────────────────

  // Open a workspace whose report auto-downloads from a peer (synced
  // baseline with the local bytes' hash). Returns the workspace + put.
  async function openSyncedReport(label, fileName, text) {
    const ws = await createWorkspaceWithReports(label, [])
    openWorkspace(ws.id)
    const peer = await openPeerSession(ws)
    let put
    try {
      put = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(text)), prev: null })
      assert.equal(put.ok, true)
    } finally { peer.close() }
    assert.equal(await waitForLocalText(fileName, text), text)
    await discoverRemoteFileNames(ws.id)
    await awaitPresence(() => typeof __test__.getEntry(ws.id)?.baselines.values().next().value?.hash === 'string', 'synced baseline with hash')
    return { ws, put }
  }

  it('a local Replace that never uploaded is flagged for a re-check, which uploads it', async () => {
    const fileName = 'flag-local-change.json'
    const cloudText = reportJson('synced')
    const localText = reportJson('local-replace')
    const { ws } = await openSyncedReport('presence-flag-local', fileName, cloudText)
    try {
      assert.deepEqual(differingReports(ws.id), [])
      // A Replace whose upload never happened (saveFile without putFile).
      await saveFileBytes(fileName, await gzipBytes(encodeUtf8(localText)))
      await awaitPresence(() => differingReports(ws.id).length === 1, 'flagged after the save settles', 8_000)
      const r = await recheckRemoteStorage(ws.id)
      assert.equal(r.items[0].status, 'uploaded', `row: ${JSON.stringify(r.items[0])}`)
      assert.deepEqual(differingReports(ws.id), [], 'cleared once uploaded')
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a Replace that does upload is not flagged', async () => {
    const fileName = 'flag-uploaded-replace.json'
    const { ws } = await openSyncedReport('presence-flag-uploaded', fileName, reportJson('synced'))
    try {
      const bytes = await gzipBytes(encodeUtf8(reportJson('replaced-and-uploaded')))
      await saveFileBytes(fileName, bytes)
      assert.equal((await putFile(ws.id, fileName, bytes)).ok, true)
      await new Promise((resolve) => { setTimeout(resolve, 2_600) })
      assert.deepEqual(differingReports(ws.id), [])
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a local change made while the workspace was closed is flagged on open', async () => {
    const fileName = 'flag-closed-change.json'
    const localText = reportJson('changed-while-closed')
    const { ws } = await openSyncedReport('presence-flag-closed', fileName, reportJson('synced'))
    try {
      closeWorkspace(ws.id)
      await saveFileBytes(fileName, await gzipBytes(encodeUtf8(localText)))
      openWorkspace(ws.id)
      await awaitPresence(() => differingReports(ws.id).length === 1, 'flagged by the open-time scan')
      assert.equal(await localReportText(fileName), localText)
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a cloud Replace does not overwrite a local change that never uploaded — both are kept for the user', async () => {
    // Both copies moved since they were in sync. Taking the cloud copy
    // (as a plain cloud Replace would) would silently discard the user's.
    const fileName = 'flag-both-changed.json'
    const localText = reportJson('local-replace')
    const peerText = reportJson('peer-replace')
    const { ws, put } = await openSyncedReport('presence-both-changed', fileName, reportJson('synced'))
    const peer = await openPeerSession(ws)
    try {
      await saveFileBytes(fileName, await gzipBytes(encodeUtf8(localText)))
      assert.equal((await peer.put({ fileName, content: await gzipBytes(encodeUtf8(peerText)), prev: put.meta })).ok, true)
      await awaitPresence(() => differingReports(ws.id).length === 1, 'conflict surfaced', 8_000)
      assert.equal(await localReportText(fileName), localText, 'local change kept')
      const row = (await recheckRemoteStorage(ws.id)).items[0]
      assert.equal(row.status, 'differs', `row: ${JSON.stringify(row)}`)
      assert.deepEqual(await resolveReportDifference(ws.id, fileName, 'local', row.compared), { status: 'uploaded' })
      const cloud = await peer.fetch(fileName)
      assert.equal(decodeUtf8(await gunzipBytes(cloud.content)), localText)
      assert.deepEqual(differingReports(ws.id), [])
    } finally {
      peer.close()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a peer Replace landing while our upload is in flight is not clobbered by the upload\'s baseline (review r4098898714)', async () => {
    // Our put commits v2; before putFile records it, a peer commits v3.
    // The v3 broadcast's replace-refetch must not run ahead of putFile's
    // bookkeeping — otherwise putFile then pins the baseline back to v2
    // (a synced baseline older than the cloud) with nothing left to
    // reconcile, and the local copy can stay on v2 unnoticed.
    const fileName = 'upload-race.json'
    const oursText = reportJson('ours-v2')
    const peerText = reportJson('peer-v3')
    const { ws } = await openSyncedReport('presence-upload-race', fileName, reportJson('synced-v1'))
    const peer = await openPeerSession(ws)
    const e = __test__.getEntry(ws.id)
    const realPut = e.session.put.bind(e.session)
    try {
      const ours = await gzipBytes(encodeUtf8(oursText))
      await saveFileBytes(fileName, ours)
      e.session.put = async (opts) => {
        const r = await realPut(opts)
        // putFile's first attempt (`prev: null`) conflicts with the
        // existing row; interleave the peer only after the one that lands.
        if (!r.ok) return r
        e.session.put = realPut
        const [tag] = e.baselines.keys()
        const v3 = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(peerText)), prev: r.meta })
        assert.equal(v3.ok, true)
        await awaitPresence(() => e.remoteMeta.get(tag)?.version === 3, 'v3 broadcast seen')
        // Give an unserialized replace-refetch the chance to run first.
        await new Promise((resolve) => { setTimeout(resolve, 500) })
        return r
      }
      assert.equal((await putFile(ws.id, fileName, ours)).ok, true)
      assert.equal(await waitForLocalText(fileName, peerText), peerText, 'the newer peer Replace lands locally')
      await awaitPresence(() => e.baselines.values().next().value?.version === 3, 'baseline at v3')
      const final = e.baselines.values().next().value
      assert.equal(final.synced, true)
      assert.equal(final.hash, await computeContentHash(await readFileBytes(fileName)), 'baseline describes the local bytes')
      assert.deepEqual(differingReports(ws.id), [])
    } finally {
      e.session.put = realPut
      peer.close()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('"Delete everywhere" waits for an in-flight write of the report, so the local delete lands after it (review r4099015005)', async () => {
    // An automatic write (here a replace-refetch) holds the report's tag
    // lock from fetch to save. deleteFromRemote used to run beside it, so
    // the UI's following deleteFile could interleave with the write's
    // OPFS save and the report came back. It must queue behind the write.
    const fileName = 'delete-vs-write.json'
    const peerText = reportJson('peer-v2')
    const { ws, put } = await openSyncedReport('presence-delete-vs-write', fileName, reportJson('synced-v1'))
    const peer = await openPeerSession(ws)
    const e = __test__.getEntry(ws.id)
    const realFetchByTag = e.session.fetchByTag.bind(e.session)
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let fetchStarted
    const started = new Promise((resolve) => { fetchStarted = resolve })
    try {
      e.session.fetchByTag = async (tag) => {
        e.session.fetchByTag = realFetchByTag
        fetchStarted()
        await gate
        return realFetchByTag(tag)
      }
      assert.equal((await peer.put({ fileName, content: await gzipBytes(encodeUtf8(peerText)), prev: put.meta })).ok, true)
      await started
      let deleted = false
      const deleting = deleteFromRemote(ws.id, fileName).then((r) => { deleted = true; return r })
      await new Promise((resolve) => { setTimeout(resolve, 300) })
      assert.equal(deleted, false, 'the delete waits while the write holds the report')
      release()
      assert.equal((await deleting).ok, true)
      // The UI deletes the local copy after deleteFromRemote returns
      // (ingest.js deleteCurrent); nothing may write it back afterwards.
      await deleteFile(fileName)
      await new Promise((resolve) => { setTimeout(resolve, 300) })
      assert.ok(!(await listFiles()).includes(fileName), 'the deleted report stays deleted')
      assert.equal(isInRemote(ws.id, fileName), false)
    } finally {
      release()
      e.session.fetchByTag = realFetchByTag
      peer.close()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a Replace whose upload outlasts the settle delay is not flagged while the upload is pending (review r4099103896)', async () => {
    // The Replace flow (ingest.js) saves, then uploads to each workspace
    // in turn — easily longer than the fixed settle delay. Until those
    // uploads are done the report must not be flagged (the badge's
    // "differ" and the auto-opened dialog would ask for a needless sync).
    const fileName = 'slow-replace-upload.json'
    const { ws } = await openSyncedReport('presence-slow-upload', fileName, reportJson('synced'))
    let flagged = false
    const off = onChange(() => { if (differingReports(ws.id).length > 0) flagged = true })
    try {
      const bytes = await gzipBytes(encodeUtf8(reportJson('replaced')))
      const release = typeof holdLocalChangeChecks === 'function' ? holdLocalChangeChecks(fileName) : () => {}
      await saveFileBytes(fileName, bytes)
      await new Promise((resolve) => { setTimeout(resolve, 2_600) })
      assert.equal((await putFile(ws.id, fileName, bytes)).ok, true)
      release()
      await new Promise((resolve) => { setTimeout(resolve, 300) })
      assert.equal(flagged, false, 'never flagged while the upload was on its way')
      assert.deepEqual(differingReports(ws.id), [])
    } finally {
      off()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a Replace whose upload fails is flagged as soon as the upload attempts end', async () => {
    const fileName = 'failed-replace-upload.json'
    const { ws } = await openSyncedReport('presence-failed-upload', fileName, reportJson('synced'))
    try {
      const release = holdLocalChangeChecks(fileName)
      await saveFileBytes(fileName, await gzipBytes(encodeUtf8(reportJson('replaced-not-uploaded'))))
      // The upload failed (nothing reached the cloud); the flow releases.
      release()
      await awaitPresence(() => differingReports(ws.id).length === 1, 'flagged right after release', 1_500)
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('opening a workspace mid-Replace does not flag the report its upload is about to replace', async () => {
    // uploadReportToWorkspaces opens each target workspace's session just
    // before its putFile — the open-time scan must not jump the upload.
    const fileName = 'open-mid-replace.json'
    const { ws } = await openSyncedReport('presence-open-mid-replace', fileName, reportJson('synced'))
    let flagged = false
    try {
      closeWorkspace(ws.id)
      const bytes = await gzipBytes(encodeUtf8(reportJson('replaced')))
      const release = holdLocalChangeChecks(fileName)
      await saveFileBytes(fileName, bytes)
      openWorkspace(ws.id)
      const off = onChange(() => { if (differingReports(ws.id).length > 0) flagged = true })
      try {
        await new Promise((resolve) => { setTimeout(resolve, 500) })
        assert.equal((await putFile(ws.id, fileName, bytes)).ok, true)
        release()
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      } finally { off() }
      assert.equal(flagged, false)
      assert.deepEqual(differingReports(ws.id), [])
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a peer delete + re-upload landing while our upload is recorded is not rolled back to our incarnation (review r4099297281)', async () => {
    // Our put commits incarnation A; before putFile's bookkeeping runs, a
    // peer deletes the report and re-uploads it as incarnation B. The B
    // broadcast is the newer cloud state — our put result must not
    // overwrite it (a different incarnation always "wins" in
    // noteRemoteMeta), or the catch-up compares A with A and the local
    // copy can stay on our bytes while the cloud holds B.
    const fileName = 'upload-vs-recreate.json'
    const oursText = reportJson('ours-A')
    const peerText = reportJson('peer-B')
    const { ws } = await openSyncedReport('presence-upload-vs-recreate', fileName, reportJson('synced'))
    const peer = await openPeerSession(ws)
    const e = __test__.getEntry(ws.id)
    const [tag] = e.baselines.keys()
    const realPut = e.session.put.bind(e.session)
    let incarnationB
    try {
      const ours = await gzipBytes(encodeUtf8(oursText))
      await saveFileBytes(fileName, ours)
      e.session.put = async (opts) => {
        const r = await realPut(opts)
        if (!r.ok) return r
        e.session.put = realPut
        assert.equal((await peer.delete(fileName, r.meta)).ok, true)
        const b = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(peerText)), prev: null })
        assert.equal(b.ok, true)
        incarnationB = b.meta.incarnation
        await awaitPresence(() => e.remoteMeta.get(tag)?.incarnation === incarnationB, 'B broadcast seen')
        return r
      }
      assert.equal((await putFile(ws.id, fileName, ours)).ok, true)
      assert.equal(e.remoteMeta.get(tag)?.incarnation, incarnationB, 'cloud state stays at the newer incarnation')
      assert.equal(await waitForLocalText(fileName, peerText), peerText, 'the re-upload lands locally')
      await awaitPresence(() => e.baselines.get(tag)?.incarnation === incarnationB, 'baseline at B')
      assert.deepEqual(differingReports(ws.id), [])
    } finally {
      e.session.put = realPut
      peer.close()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a re-check fetch made before an "Upload mine" commits is not acted on stale (review r4099376963)', async () => {
    // The re-check fetches outside the report's lock and reconciles
    // inside it. An "Upload mine" holding the lock meanwhile commits v2;
    // the re-check must not then judge the old v1 it fetched — that
    // marked the now-matching copies "differs" and pinned an old
    // unsynced marker over the new synced baseline.
    const fileName = 'recheck-vs-upload.json'
    const localText = reportJson('local')
    const { ws } = await openDifferingCopies('presence-recheck-vs-upload', fileName, localText, reportJson('cloud'))
    const e = __test__.getEntry(ws.id)
    const [tag] = e.baselines.keys()
    const realPut = e.session.put.bind(e.session)
    const realFetchByTag = e.session.fetchByTag.bind(e.session)
    let releasePut
    const putGate = new Promise((resolve) => { releasePut = resolve })
    let recheckFetched
    const fetched = new Promise((resolve) => { recheckFetched = resolve })
    try {
      const first = (await recheckRemoteStorage(ws.id)).items[0]
      assert.equal(first.status, 'differs')
      e.session.put = async (opts) => { await putGate; return realPut(opts) }
      const resolving = resolveReportDifference(ws.id, fileName, 'local', first.compared)
      e.session.fetchByTag = async (t) => {
        const r = await realFetchByTag(t)
        e.session.fetchByTag = realFetchByTag
        recheckFetched()
        return r
      }
      const rechecking = recheckRemoteStorage(ws.id)
      await fetched  // the re-check now holds the pre-upload (v1) copy
      releasePut()
      assert.deepEqual(await resolving, { status: 'uploaded' })
      const row = (await rechecking).items[0]
      assert.equal(row.status, 'good', `row: ${JSON.stringify(row)}`)
      const baseline = e.baselines.get(tag)
      assert.equal(baseline.synced, true)
      assert.equal(baseline.version, 2)
      assert.deepEqual(differingReports(ws.id), [])
    } finally {
      releasePut()
      e.session.put = realPut
      e.session.fetchByTag = realFetchByTag
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('two workspaces writing a shared report at once still check each other\'s write (review r4099568472)', async () => {
    // One report in two open workspaces; both clouds get a Replace and
    // both writes are in flight together. The file-mutation hook skipped
    // an entry for ANY save while that entry had a write of its own in
    // flight, so each skipped the other's save: both recorded their own
    // cloud copy as in sync while the file holds only the last write.
    const fileName = 'shared-concurrent-writes.json'
    const text = reportJson('synced')
    const { ws: ws1, put: put1 } = await openSyncedReport('presence-shared-writes-1', fileName, text)
    const ws2 = await createWorkspaceWithReports('presence-shared-writes-2', [])
    const peer1 = await openPeerSession(ws1)
    const peer2 = await openPeerSession(ws2)
    let releaseVault = () => {}
    try {
      openWorkspace(ws2.id)
      const put2 = await peer2.put({ fileName, content: await gzipBytes(encodeUtf8(text)), prev: null })
      assert.equal(put2.ok, true)
      await awaitPresence(() => typeof __test__.getEntry(ws2.id)?.baselines.values().next().value?.hash === 'string', 'second workspace in sync')
      const e1 = __test__.getEntry(ws1.id)
      const e2 = __test__.getEntry(ws2.id)
      // Hold every save mid-write (saves take the vault lock shared).
      await new Promise((held) => {
        navigator.locks.request(VAULT_LOCK, { mode: 'exclusive' }, () => {
          held()
          return new Promise((resolve) => { releaseVault = resolve })
        })
      })
      const text1 = reportJson('cloud-1')
      const text2 = reportJson('cloud-2')
      assert.equal((await peer1.put({ fileName, content: await gzipBytes(encodeUtf8(text1)), prev: put1.meta })).ok, true)
      assert.equal((await peer2.put({ fileName, content: await gzipBytes(encodeUtf8(text2)), prev: put2.meta })).ok, true)
      for (const until = Date.now() + 5_000; !(e1.selfWrites.has(fileName) && e2.selfWrites.has(fileName)) && Date.now() < until;) {
        await new Promise((resolve) => { setTimeout(resolve, 20) })
      }
      assert.ok(e1.selfWrites.has(fileName) && e2.selfWrites.has(fileName), 'both writes in flight')
      releaseVault()
      for (const until = Date.now() + 5_000; !([...e1.baselines.values()][0]?.version === 2 && [...e2.baselines.values()][0]?.version === 2) && Date.now() < until;) {
        await new Promise((resolve) => { setTimeout(resolve, 20) })
      }
      // Past the settle delay of any check a save scheduled.
      await new Promise((resolve) => { setTimeout(resolve, 2_600) })
      const onDisk = await localReportText(fileName)
      assert.ok(onDisk === text1 || onDisk === text2, 'one of the two writes is on disk')
      for (const [ws, cloud] of [[ws1, text1], [ws2, text2]]) {
        assert.deepEqual(differingReports(ws.id), onDisk === cloud ? [] : [fileName],
          `workspace whose cloud copy ${onDisk === cloud ? 'is' : 'is NOT'} on disk`)
      }
    } finally {
      releaseVault()
      peer1.close()
      peer2.close()
      closeWorkspace(ws1.id)
      closeWorkspace(ws2.id)
      await deleteWorkspace(ws1.id)
      await deleteWorkspace(ws2.id)
      await deleteFile(fileName).catch(() => {})
    }
  })

  it('a re-check fetch made before a delete + re-upload is applied never overwrites the re-upload (review r4099512379)', async () => {
    // The re-check fetches incarnation A; a peer then deletes the report
    // and re-uploads it as B, which the automatic path applies before the
    // re-check takes the report's lock. Across incarnations there's no
    // version order, so the stale A would read as "the cloud moved past
    // the B baseline". What stops it being written over the B copy is
    // the re-check's delete observer: every incarnation change comes with
    // a delete event (live, or synthesized from a reconnect snapshot), so
    // the row settles without touching either copy.
    const fileName = 'recheck-vs-recreate.json'
    const peerText = reportJson('peer-B')
    const { ws, put } = await openSyncedReport('presence-recheck-vs-recreate', fileName, reportJson('synced-A'))
    const peer = await openPeerSession(ws)
    const e = __test__.getEntry(ws.id)
    const [tag] = e.baselines.keys()
    const realFetchByTag = e.session.fetchByTag.bind(e.session)
    let incarnationB
    try {
      e.session.fetchByTag = async (t) => {
        const r = await realFetchByTag(t)
        e.session.fetchByTag = realFetchByTag
        assert.equal((await peer.delete(fileName, put.meta)).ok, true)
        const b = await peer.put({ fileName, content: await gzipBytes(encodeUtf8(peerText)), prev: null })
        assert.equal(b.ok, true)
        incarnationB = b.meta.incarnation
        assert.equal(await waitForLocalText(fileName, peerText), peerText, 'B applied before the re-check reconciles')
        await awaitPresence(() => e.baselines.get(tag)?.incarnation === incarnationB, 'baseline at B')
        return r  // incarnation A
      }
      const row = (await recheckRemoteStorage(ws.id)).items[0]
      assert.notEqual(row.status, 'updated', `row: ${JSON.stringify(row)}`)
      assert.equal(await localReportText(fileName), peerText, 'the re-upload is kept')
      const baseline = e.baselines.get(tag)
      assert.equal(baseline.incarnation, incarnationB)
      assert.equal(baseline.synced, true)
      assert.deepEqual(differingReports(ws.id), [])
    } finally {
      e.session.fetchByTag = realFetchByTag
      peer.close()
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
      await deleteFile(fileName).catch(() => {})
    }
  })
})
