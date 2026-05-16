// End-to-end tests for `ui/view/objstore-presence.js` against a
// spawned `server/index.ts` relay. Validates the cache wiring:
// openWorkspace opens an encrypted objstore session, snapshots
// `list()`, decodes each remote tag back to a fileName via
// `fetchByTag` in the background, and re-renders the badge via
// `onChange` for every state transition.

import './_polyfills.js'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createObjstoreSession, deriveObjstoreKeys } from '../client/objstore.ts'
import { triageSync } from '../client/triage-sync.ts'
import { createWorkspace, deleteWorkspace, setReportWorkspace } from '../client/workspaces.js'

const {
  closeWorkspace, deleteFromRemote, discoverRemoteFileNames, fetchFile, isInRemote, onChange,
  openWorkspace, putFile, remoteCount, remoteFileNames,
} = await import('../ui/view/objstore-presence.js')

async function createWorkspaceWithReports(name, reports) {
  const ws = await createWorkspace(name)
  for (const r of reports) await setReportWorkspace(r, ws.id)
  return ws
}

function awaitListeningPort(proc, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let stderrBuf = ''
    let settled = false
    function onData(d) {
      buf += String(d)
      const m = /ws:\/\/[^:]+:(\d+)\//u.exec(buf)
      if (m) finish(null, Number(m[1]))
    }
    function onErrData(d) { stderrBuf += String(d) }
    function onExit(code, signal) {
      const detail = stderrBuf.slice(0, 400).trim() || `exit ${code}, signal ${signal}`
      finish(new Error(`server exited during boot: ${detail}`))
    }
    function onError(err) { finish(err) }
    function finish(err, port) {
      if (settled) return
      settled = true
      clearTimeout(t)
      proc.stdout.removeListener('data', onData)
      proc.stderr.removeListener('data', onErrData)
      proc.removeListener('exit', onExit)
      proc.removeListener('error', onError)
      if (err) reject(err); else resolve(port)
    }
    const t = setTimeout(() => finish(new Error('server boot timeout')), timeoutMs)
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onErrData)
    proc.once('exit', onExit)
    proc.once('error', onError)
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

describe('ui/view/objstore-presence', () => {
  let httpOrigin, serverDir, serverProc, serverUrl

  before(async () => {
    serverDir = mkdtempSync(path.join(tmpdir(), 'deepview-presence-'))
    serverProc = spawn(process.execPath, ['server/index.ts'], {
      env: {
        ...process.env, PORT: '0', HOST: '127.0.0.1',
        DB_PATH: path.join(serverDir, 'data.db'),
        OBJSTORE_DIR: path.join(serverDir, 'objstore'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const port = await awaitListeningPort(serverProc)
    serverUrl = `ws://127.0.0.1:${port}/api/sync`
    httpOrigin = `http://127.0.0.1:${port}`
    triageSync.setServerUrl(serverUrl)
  })

  after(async () => {
    triageSync.setServerUrl('')
    if (!serverProc) return
    serverProc.kill('SIGTERM')
    await new Promise((resolve) => { serverProc.once('exit', resolve) })
    rmSync(serverDir, { recursive: true, force: true })
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
        const put = await peer.put({ fileName: 'live-report.json', content: Buffer.from('payload-bytes'), prevVersion: null })
        assert.equal(put.ok, true)
        await awaitPresence(() => isInRemote(ws.id, 'live-report.json'), 'cloud after PUT')
        await peer.delete('live-report.json', put.meta.version)
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
          const r = await peer.put({ fileName: name, content: Buffer.from(`payload-${name}`), prevVersion: null })
          assert.equal(r.ok, true)
        }
        // Tag count reflects immediately on broadcast.
        await awaitPresence(() => remoteCount(ws.id) === 2, 'two tags broadcast')
        // Decoded names land asynchronously via the background
        // fetchByTag worker.
        await awaitPresence(() => remoteFileNames(ws.id).length === 2, 'two names decoded')
        const names = remoteFileNames(ws.id).sort()
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
        await peer.put({ fileName: 'discover-me.json', content: Buffer.from('payload'), prevVersion: null })
        openWorkspace(ws.id)
        const names = await discoverRemoteFileNames(ws.id)
        assert.deepEqual(names.sort(), ['discover-me.json'])
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
        const put = await peer.put({ fileName: 'to-fetch.json', content: Buffer.from('round-tripped-bytes'), prevVersion: null })
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
    // dialog path goes through `prevVersion: null` so that case
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
        await peer.put({ fileName: 'on-demand.json', content: Buffer.from('payload'), prevVersion: null })
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
        await peer.put({ fileName: 'race-target.json', content: Buffer.from('payload'), prevVersion: null })
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
        const { listWorkspaces: lw } = await import('../client/workspaces.js')
        const reattached = lw().find((w) => w.id === ws.id)
        assert.deepEqual(reattached?.reports ?? [], [],
          'auto-download must not re-attach a file whose remote row was deleted while fetchByTag was in flight')
      } finally { peer.close() }
    } finally {
      closeWorkspace(ws.id)
      await deleteWorkspace(ws.id)
    }
  })
})
