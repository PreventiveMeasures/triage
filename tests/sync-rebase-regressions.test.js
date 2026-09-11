import './_polyfills.js'
import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { WebSocketServer } from 'ws'
import { awaitListening, bootServer, closeWebSocketServer } from './_helpers.js'
import { rebaseLocalState } from '../client/sync/triage-changeset.ts'
import { createHub } from '../server-e2e/hub.ts'
import { createBusReceiver } from '../server-e2e/bus-receiver.ts'
import { getSharedTransport } from '../client/sync/sync-transport.ts'

const { triageSync, setHydrationConflictResolver } = await import('../client/sync/triage-sync.ts')
const { state } = await import('../client/state.ts')
const { upsertWorkspace, deleteWorkspace } = await import('../client/workspaces.js')
const { patchEntry } = await import('../client/triage-entry.ts')
const cryptoMod = await import('../client/sync/sync-crypto.ts')

const cleanups = []
afterEach(async () => {
  setHydrationConflictResolver(null)
  triageSync.closeSession()
  triageSync.setServerUrl('')
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  assert.fail(`timed out: ${label}`)
}

async function fixture() {
  state.triage.clear()
  state.reports.length = 0
  state.reports.push({ fileName: 'regression.md', groups: [[{ id: 'A' }, { id: 'B' }]] })
  const workspaceId = crypto.randomUUID()
  const seed = crypto.getRandomValues(new Uint8Array(32)).toBase64()
  await upsertWorkspace({ id: workspaceId, name: 'regression', privateKey: seed, reports: ['regression.md'] })
  cleanups.push(() => deleteWorkspace(workspaceId))
  const key = await cryptoMod.deriveSessionKey(seed)
  const kp = await cryptoMod.deriveSigningKeypair(seed, workspaceId)
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await awaitListening(wss)
  cleanups.push(() => closeWebSocketServer(wss))
  const messages = []
  let socket
  wss.on('connection', (sock) => {
    socket = sock
    sock.send(JSON.stringify({ type: 'challenge', nonce: 'regression-challenge' }))
    sock.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      messages.push(msg)
      if (msg.type === 'workspace-subscribe') {
        sock.send(JSON.stringify({ type: 'workspace-subscribed', workspaceTag: msg.workspaceTag, resources: [] }))
      }
    })
  })
  triageSync.setServerUrl(`ws://127.0.0.1:${wss.address().port}/api/sync`)
  triageSync.openSession(workspaceId)
  await waitFor(() => triageSync.status === 'online', 'subscribe')
  return {
    workspaceId, messages,
    send: (msg) => socket.send(JSON.stringify({ workspaceTag: kp.publicKeyB64, ...msg })),
    async reconnect() {
      const previous = socket
      previous.terminate()
      await waitFor(() => socket !== previous && triageSync.status === 'online', 'reconnected')
    },
    info: () => triageSync.sessionInfo(workspaceId),
    decryptSave(msg) {
      return cryptoMod.decryptJson(key, msg.nonce, msg.ciphertext, cryptoMod.buildAad(kp.publicKeyB64, msg.base))
    },
    async revision(base, changeset, keyframe = false) {
      const { nonce, ciphertext } = await cryptoMod.encryptJson(key, changeset, cryptoMod.buildAad(kp.publicKeyB64, base))
      const payload = { publicKeyB64: kp.publicKeyB64, base, keyframe, nonceB64: nonce, ciphertextB64: ciphertext }
      return { base, keyframe, nonce, ciphertext, id: await cryptoMod.computeRevisionId(payload), signature: await cryptoMod.signSavePayload(kp.privateKey, payload) }
    },
  }
}

it('rebases independent fields on the same finding without deleting the peer edit', async () => {
  const f = await fixture()
  const root = await f.revision(null, { A: { color: 'red' } })
  f.send({ type: 'workspace-state', revisions: [root] })
  await waitFor(() => state.triage.get('A')?.color === 'red', 'root applied')
  patchEntry(state.triage, 'A', { color: 'amber' })
  const remote = await f.revision(root.id, { A: { color: 'red', comment: 'peer comment' } })
  f.send({ type: 'workspace-state', revisions: [remote] })
  await waitFor(() => f.messages.some((m) => m.type === 'workspace-save' && m.base === remote.id), 'rebased save')
  assert.equal(state.triage.get('A')?.color, 'amber')
  assert.equal(state.triage.get('A')?.comment, 'peer comment')
})

it('merges independent per-report ignore changes on the same finding', async () => {
  const f = await fixture()
  const root = await f.revision(null, { A: { ignoredReports: ['original.md'] } })
  f.send({ type: 'workspace-state', revisions: [root] })
  await waitFor(() => state.triage.get('A')?.ignoredReports?.includes('original.md'), 'root applied')
  patchEntry(state.triage, 'A', { ignoredReports: ['local.md'] })
  const remote = await f.revision(root.id, { A: { ignoredReports: ['original.md', 'remote.md'] } })
  f.send({ type: 'workspace-state', revisions: [remote] })
  await waitFor(() => f.messages.some((m) => m.type === 'workspace-save' && m.base === remote.id), 'rebased save')
  assert.deepEqual(new Set(state.triage.get('A')?.ignoredReports), new Set(['local.md', 'remote.md']))
})

it('keeps asynchronous state changes during a chain conflict dialog and defers saves until it resolves', async () => {
  const f = await fixture()
  const root = await f.revision(null, { A: { color: 'red' } })
  f.send({ type: 'workspace-state', revisions: [root] })
  await waitFor(() => state.triage.get('A')?.color === 'red', 'root applied')
  patchEntry(state.triage, 'A', { color: 'amber' })
  let resolveDialog
  setHydrationConflictResolver(() => new Promise((resolve) => { resolveDialog = resolve }))
  const remote = await f.revision(root.id, { A: { color: 'blue' } })
  f.send({ type: 'workspace-state', revisions: [remote] })
  await waitFor(() => resolveDialog != null, 'dialog open')
  // The modal blocks typing behind it. Async writers (such as an import
  // completing) can still mutate shared state and notify while it is open.
  patchEntry(state.triage, 'A', { color: 'cyan' })
  patchEntry(state.triage, 'B', { comment: 'import completed while resolving' })
  triageSync.notify()
  // A macrotask lets crypto complete if the save incorrectly bypasses the dialog.
  await new Promise((resolve) => { setTimeout(resolve, 75) })
  const earlySaves = f.messages.filter((m) => m.type === 'workspace-save')
  resolveDialog({ 'A:color': 'imported' })
  await waitFor(() => f.messages.some((m) => m.type === 'workspace-save'), 'follow-up save')
  assert.equal(earlySaves.length, 0, 'no save based on unresolved remote state')
  assert.equal(state.triage.get('A')?.color, 'cyan', 'new edit supersedes old dialog choice')
  assert.equal(state.triage.get('B')?.comment, 'import completed while resolving')
})

it('flushes an edit made while a remote update is waiting for local persistence', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const lock = navigator.locks.request('deepview.triage.save', () => { entered.resolve(); return release.promise })
  await entered.promise
  const root = await f.revision(null, { A: { color: 'red' } })
  try {
    f.send({ type: 'workspace-state', revisions: [root] })
    await waitFor(() => state.triage.get('A')?.color === 'red', 'remote projected while disk save is blocked')
    patchEntry(state.triage, 'B', { comment: 'edited during disk write' })
    triageSync.notify()
  } finally { release.resolve(); await lock }
  await waitFor(() => f.messages.some((m) => m.type === 'workspace-save'), 'deferred edit flushed')
  const save = f.messages.find((m) => m.type === 'workspace-save')
  assert.deepEqual(await f.decryptSave(save), { B: { comment: 'edited during disk write' } })
})

it('projects a verified chain prefix before recovering from a later gap', async () => {
  const f = await fixture()
  const first = await f.revision(null, { A: { color: 'red' } })
  const second = await f.revision(first.id, { B: { comment: 'second' } })
  const initialSubs = f.messages.filter((m) => m.type === 'workspace-subscribe').length
  f.send({ type: 'workspace-state', revisions: [first, { base: 'missing', id: 'gap' }] })
  await waitFor(() => f.messages.filter((m) => m.type === 'workspace-subscribe').length > initialSubs, 'gap resubscribe')
  f.send({ type: 'workspace-state', revisions: [second] })
  await waitFor(() => state.triage.get('B')?.comment === 'second', 'remaining chain applied')
  assert.equal(state.triage.get('A')?.color, 'red', 'verified prefix was not mistaken for a local deletion')
  assert.equal(f.messages.filter((m) => m.type === 'workspace-save').length, 0, 'no phantom undo sent')
})

it('resumes a deferred edit when gap recovery returns an empty catch-up', async () => {
  const f = await fixture()
  const first = await f.revision(null, { A: { color: 'red' } })
  patchEntry(state.triage, 'B', { comment: 'still needs saving' })
  const initialSubs = f.messages.filter((m) => m.type === 'workspace-subscribe').length
  f.send({ type: 'workspace-state', revisions: [first, { base: 'missing', id: 'gap' }] })
  await waitFor(() => f.messages.filter((m) => m.type === 'workspace-subscribe').length > initialSubs, 'gap resubscribe')
  f.send({ type: 'workspace-state', revisions: [] })
  await waitFor(() => f.messages.some((m) => m.type === 'workspace-save'), 'deferred edit resumed')
  const save = f.messages.find((m) => m.type === 'workspace-save')
  assert.equal(save.base, first.id)
  assert.deepEqual(await f.decryptSave(save), { B: { comment: 'still needs saving' } })
})

it('ignores overlapping broadcasts of revisions already verified in a catch-up', async () => {
  const f = await fixture()
  const first = await f.revision(null, { A: { color: 'red' } })
  const second = await f.revision(first.id, { A: { color: 'blue' } })
  const third = await f.revision(second.id, { B: { comment: 'latest' } })
  f.send({ type: 'workspace-state', revisions: [first, second, third] })
  await waitFor(() => state.triage.get('B')?.comment === 'latest', 'catch-up applied')
  const before = f.messages.length
  f.send({ type: 'workspace-state', revisions: [first] })
  f.send({ type: 'workspace-state', revisions: [second] })
  await new Promise((resolve) => { setTimeout(resolve, 75) })
  assert.equal(f.info().baseRevision, third.id)
  assert.equal(f.messages.length, before, 'no resubscribe or full-state reset for duplicate delivery')
})

it('keeps the client on its chain when a subscription buffers more than 256 duplicate revisions', async () => {
  const f = await fixture()
  const tag = f.info().workspaceTag
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (s) => f.send(JSON.parse(s)) }
  const hub = createHub({ peers: new WeakMap(), maxBufferedBytes: 1_000_000, debug: false })
  hub.subscribe(socket, tag)
  const release = hub.pauseBroadcasts(socket)
  const revisions = []
  for (let i = 0; i < 258; i++) {
    const revision = await f.revision(revisions.at(-1)?.id ?? null, { A: { comment: `edit ${i}` } })
    revisions.push(revision)
    hub.broadcast(tag, { type: 'workspace-state', workspaceTag: tag, revisions: [revision] }, null)
  }
  const before = f.messages.length
  hub.send(socket, { type: 'workspace-state', workspaceTag: tag, revisions })
  await waitFor(() => f.info().baseRevision === revisions.at(-1).id, 'large catch-up applied')
  release()
  const next = await f.revision(revisions.at(-1).id, { A: { comment: 'live successor' } })
  hub.broadcast(tag, { type: 'workspace-state', workspaceTag: tag, revisions: [next] }, null)
  await waitFor(() => f.info().baseRevision === next.id, 'live successor applied after the buffer flush')
  assert.equal(state.triage.get('A')?.comment, 'live successor')
  assert.equal(f.messages.length, before, 'no continuity recovery, resubscribe, or full-state reset')
})

it('ignores delayed bus notifications after a large subscription has completely resumed', async () => {
  const f = await fixture()
  const tag = f.info().workspaceTag
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (s) => f.send(JSON.parse(s)) }
  const hub = createHub({ peers: new WeakMap(), maxBufferedBytes: 1_000_000, debug: false })
  hub.subscribe(socket, tag)
  const release = hub.pauseBroadcasts(socket)
  const revisions = []
  for (let i = 0; i < 258; i++) revisions.push(await f.revision(revisions.at(-1)?.id ?? null, { A: { comment: `edit ${i}` } }))
  const onBusMessage = createBusReceiver({
    handle: { revisionById: { get: (_tag, id) => Promise.resolve({ ...revisions.find((rev) => rev.id === id), keyframe: 0 }) } },
    objstoreHandle: {}, broadcastLocalRaw: hub.broadcastLocalRaw, debug: false,
  })
  const before = f.messages.length
  hub.send(socket, { type: 'workspace-state', workspaceTag: tag, revisions })
  release()
  await waitFor(() => f.info().baseRevision === revisions.at(-1).id, 'large catch-up applied after final release')
  // The DB snapshot includes these revisions before their cross-instance
  // notifications arrive. No unrelated subscription holds a nested pause.
  for (const { id } of revisions.slice(0, 2)) await onBusMessage({ kind: 'rev', tag, id })
  const next = await f.revision(revisions.at(-1).id, { A: { comment: 'live successor' } })
  hub.broadcast(tag, { type: 'workspace-state', workspaceTag: tag, revisions: [next] }, null)
  await waitFor(() => f.info().baseRevision === next.id, 'live successor applied after delayed notifications')
  assert.equal(state.triage.get('A')?.comment, 'live successor')
  assert.equal(f.messages.length, before, 'no recovery subscription or full-state save for delayed duplicates')
})

it('the client retains complete catch-ups through live traffic, later subscriptions, and reconnects', async () => {
  const f = await fixture()
  const revisions = []
  for (let i = 0; i < 258; i++) revisions.push(await f.revision(revisions.at(-1)?.id ?? null, { A: { comment: `edit ${i}` } }))
  // Direct client delivery: the relay must not hide its duplicates.
  f.send({ type: 'workspace-state', revisions })
  await waitFor(() => f.info().baseRevision === revisions.at(-1).id, 'large catch-up applied')
  let head = revisions.at(-1).id
  for (let i = 0; i < 260; i++) {
    const live = await f.revision(head, { A: { comment: `live ${i}` } })
    head = live.id
    f.send({ type: 'workspace-state', revisions: [live] })
  }
  await waitFor(() => f.info().baseRevision === head, 'live traffic applied')
  await triageSync.ensureSubscription(f.workspaceId).resources
  const later = await f.revision(head, { B: { comment: 'later catch-up' } })
  // A real keyframe also resets the normal reconnect-compaction counter.
  const last = await f.revision(later.id, { A: { comment: 'live 259' }, B: { comment: 'caught up again' } }, true)
  f.send({ type: 'workspace-state', revisions: [later, last] })
  await waitFor(() => f.info().baseRevision === last.id, 'later catch-up applied')
  await f.reconnect()
  const before = f.messages.length
  f.send({ type: 'workspace-state', revisions: [revisions[0]] })
  f.send({ type: 'workspace-state', revisions: [revisions[1]] })
  const next = await f.revision(last.id, { B: { comment: 'fresh successor' } })
  f.send({ type: 'workspace-state', revisions: [revisions[2], later, next] })
  await waitFor(() => f.info().baseRevision === next.id, 'fresh successor after delayed duplicates')
  assert.equal(state.triage.get('B')?.comment, 'fresh successor')
  assert.deepEqual(f.messages.slice(before), [], 'no recovery request or full-state save')
})

it('the client recognizes duplicates within a large uncommitted chain candidate', async () => {
  const f = await fixture()
  const revisions = []
  for (let i = 0; i < 258; i++) revisions.push(await f.revision(revisions.at(-1)?.id ?? null, { A: { comment: `edit ${i}` } }))
  // Finish at a keyframe so normal compaction cannot add a maintenance save.
  const next = await f.revision(revisions.at(-1).id, { A: { comment: 'edit 257' }, B: { comment: 'valid suffix' } }, true)
  const before = f.messages.length
  f.send({ type: 'workspace-state', revisions: [...revisions, revisions[0], revisions[1], next] })
  await waitFor(() => f.info().baseRevision === next.id, 'candidate including its own duplicates applied')
  assert.deepEqual(f.messages.slice(before), [], 'duplicates within the candidate do not trigger recovery')
})

it('the client retains a large verified prefix when its suffix is rejected', async () => {
  const f = await fixture()
  const revisions = []
  for (let i = 0; i < 258; i++) revisions.push(await f.revision(revisions.at(-1)?.id ?? null, { A: { comment: `edit ${i}` } }))
  const next = await f.revision(revisions.at(-1).id, { B: { comment: 'authentic suffix' } })
  const initialSubs = f.messages.filter((m) => m.type === 'workspace-subscribe').length
  f.send({ type: 'workspace-state', revisions: [...revisions, { ...next, signature: 'forged' }] })
  await waitFor(() => f.messages.filter((m) => m.type === 'workspace-subscribe').length > initialSubs, 'invalid suffix rejected')
  assert.equal(f.info().baseRevision, revisions.at(-1).id)
  const before = f.messages.length
  f.send({ type: 'workspace-state', revisions: [revisions[0]] })
  f.send({ type: 'workspace-state', revisions: [revisions[1], next] })
  await waitFor(() => f.info().baseRevision === next.id, 'authentic suffix accepted after prefix duplicates')
  assert.equal(state.triage.get('B')?.comment, 'authentic suffix')
  assert.equal(f.messages.length, before, 'duplicates do not turn a recoverable rejection into a reset')
})

it('a discarded chain candidate cannot poison the retained revision IDs', async () => {
  const f = await fixture()
  const root = await f.revision(null, { A: { color: 'red' } })
  f.send({ type: 'workspace-state', revisions: [root] })
  await waitFor(() => f.info().baseRevision === root.id, 'root applied')
  patchEntry(state.triage, 'A', { color: 'amber' })
  let resolveDialog
  setHydrationConflictResolver(() => new Promise((resolve) => { resolveDialog = resolve }))
  const first = await f.revision(root.id, { A: { color: 'blue' } })
  const second = await f.revision(first.id, { B: { comment: 'verified but not committed' } })
  f.send({ type: 'workspace-state', revisions: [first, second] })
  await waitFor(() => resolveDialog != null, 'verified candidate awaiting dialog')
  try {
    triageSync.setEnabled(false)
    setHydrationConflictResolver(null)
    resolveDialog({ 'A:color': 'imported' })
    await new Promise((resolve) => { setImmediate(resolve) })
    assert.equal(f.info().baseRevision, root.id, 'stale candidate was not committed')
  } finally { triageSync.setEnabled(true) }
  await waitFor(() => triageSync.status === 'online', 'same workspace reconnected')
  f.send({ type: 'workspace-state', revisions: [first, second] })
  await waitFor(() => f.info().baseRevision === second.id, 'discarded IDs were reverified and applied')
  assert.equal(state.triage.get('B')?.comment, 'verified but not committed')
})

it('a frame received without a matching session cannot attach to a workspace opened while the queue is blocked', async () => {
  const f = await fixture()
  const workspaceId = crypto.randomUUID()
  const seed = crypto.getRandomValues(new Uint8Array(32)).toBase64()
  state.reports.push({ fileName: 'other.md', groups: [[{ id: 'C' }]] })
  await upsertWorkspace({ id: workspaceId, name: 'other', privateKey: seed, reports: ['other.md'] })
  cleanups.push(() => deleteWorkspace(workspaceId))
  const key = await cryptoMod.deriveSessionKey(seed)
  const kp = await cryptoMod.deriveSigningKeypair(seed, workspaceId)
  async function revision(comment) {
    const { nonce, ciphertext } = await cryptoMod.encryptJson(key, { C: { comment } }, cryptoMod.buildAad(kp.publicKeyB64, null))
    const payload = { publicKeyB64: kp.publicKeyB64, base: null, keyframe: false, nonceB64: nonce, ciphertextB64: ciphertext }
    return { base: null, keyframe: false, nonce, ciphertext, id: await cryptoMod.computeRevisionId(payload), signature: await cryptoMod.signSavePayload(kp.privateKey, payload) }
  }
  const stale = await revision('stale frame for an absent session')
  patchEntry(state.triage, 'A', { color: 'amber' })
  let resolveDialog
  setHydrationConflictResolver(() => new Promise((resolve) => { resolveDialog = resolve }))
  f.send({ type: 'workspace-state', revisions: [await f.revision(null, { A: { color: 'blue' } })] })
  await waitFor(() => resolveDialog != null, 'earlier handler blocked in a dialog')
  let observed = false
  const observer = getSharedTransport().addConsumer({
    onConnected() {}, onDisconnected() {},
    onMessage(msg) { if (msg.workspaceTag === kp.publicKeyB64) observed = true },
  })
  cleanups.push(() => observer.remove())
  f.send({ type: 'workspace-state', workspaceTag: kp.publicKeyB64, revisions: [stale] })
  await waitFor(() => observed, 'tagged frame received on the shared transport')
  assert.equal(triageSync.sessionInfo(workspaceId), null)
  const subscription = triageSync.ensureSubscription(workspaceId)
  await waitFor(() => triageSync.sessionInfo(workspaceId)?.keyReady, 'new session can decrypt before the old queue drains')
  setHydrationConflictResolver(null)
  resolveDialog({})
  await subscription.resources
  assert.equal(triageSync.sessionInfo(workspaceId).baseRevision, null)
  assert.equal(state.triage.get('C'), undefined, 'the absent-session frame was dropped at receipt')
  const fresh = await revision('fresh frame after the session opened')
  f.send({ type: 'workspace-state', workspaceTag: kp.publicKeyB64, revisions: [fresh] })
  await waitFor(() => triageSync.sessionInfo(workspaceId).baseRevision === fresh.id, 'fresh frame accepted')
  assert.equal(state.triage.get('C')?.comment, 'fresh frame after the session opened')
})

for (const field of ['color', 'triage', 'comment', 'fix', 'flagged', 'ignoredReports']) {
  it(`unanchored recovery preserves an acknowledged ${field} clear`, async () => {
    const f = await fixture()
    const value = { color: 'red', triage: 'fixed', comment: 'old comment', fix: 'old fix', flagged: true, ignoredReports: ['regression.md'] }[field]
    const remaining = field === 'comment' ? { fix: 'keep this fix' } : { comment: 'keep this comment' }
    const old = await f.revision(null, { A: { ...remaining, [field]: value } }, true)
    f.send({ type: 'workspace-state', revisions: [old] })
    await waitFor(() => f.info().baseRevision === old.id, 'older keyframe applied')
    patchEntry(state.triage, 'A', { [field]: undefined })
    triageSync.notify()
    await waitFor(() => f.messages.some((m) => m.type === 'workspace-save'), 'clear sent')
    const save = f.messages.find((m) => m.type === 'workspace-save')
    const id = await cryptoMod.computeRevisionId({ publicKeyB64: save.workspaceTag, base: save.base, keyframe: save.keyframe, nonceB64: save.nonce, ciphertextB64: save.ciphertext })
    f.send({ type: 'workspace-save-ack', base: save.base, id })
    await waitFor(() => f.info().baseRevision === id, 'clear acknowledged')
    const subscriptions = f.messages.filter((m) => m.type === 'workspace-subscribe').length
    f.send({ type: 'workspace-state', revisions: [{ base: 'missing', id: 'gap' }] })
    await waitFor(() => f.messages.filter((m) => m.type === 'workspace-subscribe').length > subscriptions, 'first recovery request')
    f.send({ type: 'workspace-state', revisions: [{ base: 'missing', id: 'gap' }] })
    await waitFor(() => f.messages.some((m) => m.type === 'workspace-save' && m.base === null), 'full recovery attempted')
    const conflicts = []
    setHydrationConflictResolver((rows) => { conflicts.push(...rows); return {} })
    const beforeReplay = f.messages.length
    f.send({ type: 'workspace-state', revisions: [old] })
    await waitFor(() => f.info().baseRevision === old.id, 'old keyframe processed during recovery')
    assert.equal(state.triage.get('A')?.[field], undefined, 'acknowledged absence must not be resurrected')
    await waitFor(() => f.messages.slice(beforeReplay).some((m) => m.type === 'workspace-save' && m.base === old.id), 'recovery save over old keyframe')
    const recovery = f.messages.slice(beforeReplay).find((m) => m.type === 'workspace-save' && m.base === old.id)
    assert.deepEqual(await f.decryptSave(recovery), { A: remaining })
    if (field !== 'ignoredReports') assert.equal(conflicts.some((c) => c.property === field && c.local === ''), true)
  })
}

for (const reopen of [false, true]) {
  it(`unanchored recovery preserves a fully cleared acknowledged finding${reopen ? ' after reopening' : ''}`, async () => {
    const f = await fixture()
    const old = await f.revision(null, { A: { color: 'red' } }, true)
    f.send({ type: 'workspace-state', revisions: [old] })
    await waitFor(() => f.info().baseRevision === old.id, 'old keyframe applied')
    state.triage.delete('A')
    triageSync.notify()
    await waitFor(() => f.messages.some((m) => m.type === 'workspace-save'), 'clear sent')
    const save = f.messages.find((m) => m.type === 'workspace-save')
    const id = await cryptoMod.computeRevisionId({ publicKeyB64: save.workspaceTag, base: save.base, keyframe: save.keyframe, nonceB64: save.nonce, ciphertextB64: save.ciphertext })
    f.send({ type: 'workspace-save-ack', base: save.base, id })
    await waitFor(() => f.info().baseRevision === id, 'full clear acknowledged')
    const subscriptions = f.messages.filter((m) => m.type === 'workspace-subscribe').length
    f.send({ type: 'workspace-state', revisions: [{ base: 'missing', id: 'gap' }] })
    await waitFor(() => f.messages.filter((m) => m.type === 'workspace-subscribe').length > subscriptions, 'recovery requested')
    f.send({ type: 'workspace-state', revisions: [{ base: 'missing', id: 'gap' }] })
    await waitFor(() => f.messages.some((m) => m.type === 'workspace-save' && m.base === null), 'full recovery attempted')
    if (reopen) {
      await navigator.locks.request('deepview.sync.sessions', () => {})
      const acquire = getSharedTransport().acquire()
      cleanups.push(() => acquire.release())
      triageSync.closeSession(f.workspaceId)
      await triageSync.ensureSubscription(f.workspaceId).resources
    }
    const beforeReplay = f.messages.length
    f.send({ type: 'workspace-state', revisions: [old] })
    await waitFor(() => f.info().baseRevision === old.id, 'old keyframe processed')
    assert.equal(state.triage.get('A'), undefined, 'a known empty finding stays empty')
    await waitFor(() => f.messages.slice(beforeReplay).some((m) => m.type === 'workspace-save' && m.base === old.id), 'clear republished')
    const recovery = f.messages.slice(beforeReplay).find((m) => m.type === 'workspace-save' && m.base === old.id)
    assert.deepEqual(await f.decryptSave(recovery), { A: null })
  })
}

it('an initial catch-up still fills unknown fields beside an unsynced local edit', async () => {
  const f = await fixture()
  patchEntry(state.triage, 'A', { color: 'amber' })
  const first = await f.revision(null, { A: { comment: 'new peer field' }, B: { color: 'blue' } }, true)
  f.send({ type: 'workspace-state', revisions: [first] })
  await waitFor(() => f.info().baseRevision === first.id, 'initial catch-up applied')
  assert.equal(state.triage.get('A')?.color, 'amber')
  assert.equal(state.triage.get('A')?.comment, 'new peer field')
  assert.equal(state.triage.get('B')?.color, 'blue', 'no previous baseline means absence is unknown')
})

for (const tamper of ['signature', 'id', 'keyframe']) {
  it(`rejects a tampered ${tamper} after a verified chain prefix`, async () => {
    const f = await fixture()
    const first = await f.revision(null, { A: { color: 'red' } })
    const second = await f.revision(first.id, { A: { color: 'blue' } })
    const forged = { ...second, [tamper]: tamper === 'keyframe' ? true : 'forged' }
    const initialSubs = f.messages.filter((m) => m.type === 'workspace-subscribe').length
    f.send({ type: 'workspace-state', revisions: [first, forged] })
    await waitFor(() => f.messages.filter((m) => m.type === 'workspace-subscribe').length > initialSubs, 'invalid suffix rejected')
    assert.equal(f.info().baseRevision, first.id, 'cursor advances only through authenticated content')
    assert.equal(state.triage.get('A')?.color, 'red', 'forged content never reaches the UI')
    f.send({ type: 'workspace-state', revisions: [second] })
    await waitFor(() => state.triage.get('A')?.color === 'blue', 'authentic suffix accepted')
    assert.equal(f.info().baseRevision, second.id)
    assert.equal(f.messages.some((m) => m.type === 'workspace-save'), false, 'recovery never republishes a forged overlay')
  })
}

it('a forged duplicate id cannot replace state or authorize a fork', async () => {
  const f = await fixture()
  const first = await f.revision(null, { A: { color: 'red' } })
  const second = await f.revision(first.id, { A: { color: 'blue' } })
  f.send({ type: 'workspace-state', revisions: [first, second] })
  await waitFor(() => f.info().baseRevision === second.id, 'known chain applied')
  const initialSubs = f.messages.filter((m) => m.type === 'workspace-subscribe').length
  const fork = await f.revision(first.id, { A: { color: 'fork' } })
  f.send({ type: 'workspace-state', revisions: [{ ...first, ciphertext: 'forged' }, fork] })
  await waitFor(() => f.messages.filter((m) => m.type === 'workspace-subscribe').length > initialSubs, 'fork rejected')
  assert.equal(f.info().baseRevision, second.id)
  assert.equal(state.triage.get('A')?.color, 'blue')
})

it('recovery does not silently roll back known state when a relay replays an older signed root', async () => {
  const f = await fixture()
  const first = await f.revision(null, { A: { color: 'red' } })
  const second = await f.revision(first.id, { A: { color: 'blue' } })
  f.send({ type: 'workspace-state', revisions: [first, second] })
  await waitFor(() => f.info().baseRevision === second.id, 'current state applied')
  const initialSubs = f.messages.filter((m) => m.type === 'workspace-subscribe').length
  f.send({ type: 'workspace-state', revisions: [{ base: 'missing', id: 'gap' }] })
  await waitFor(() => f.messages.filter((m) => m.type === 'workspace-subscribe').length > initialSubs, 'first recovery request')
  f.send({ type: 'workspace-state', revisions: [{ base: 'missing', id: 'gap' }] })
  await waitFor(() => f.messages.some((m) => m.type === 'workspace-save' && m.base === null), 'full state recovery attempted')
  const conflicts = []
  setHydrationConflictResolver((rows) => { conflicts.push(...rows); return {} })
  f.send({ type: 'workspace-state', revisions: [first] })
  await waitFor(() => f.messages.some((m) => m.type === 'workspace-save' && m.base === first.id), 'known state republished over the replay')
  assert.equal(state.triage.get('A')?.color, 'blue', 'old authenticated data cannot silently replace newer local state')
  assert.deepEqual(conflicts.map((c) => [c.property, c.local, c.imported]), [['color', 'blue', 'red']])
})

it('rebasing prototype-shaped finding ids keeps them as inert own properties', () => {
  const base = JSON.parse('{"__proto__":{"color":"red"},"constructor":{"comment":"before"}}')
  const local = JSON.parse('{"__proto__":{"color":"blue"},"constructor":{"comment":"after"}}')
  const remote = JSON.parse('{"__proto__":{"color":"red","comment":"remote"},"constructor":{"comment":"before","flagged":true}}')
  const result = rebaseLocalState(base, local, remote)
  assert.equal(Object.getPrototypeOf(result), null)
  assert.deepEqual(result.__proto__, { color: 'blue', comment: 'remote' })
  assert.deepEqual(result.constructor, { comment: 'after', flagged: true })
  assert.equal(({}).color, undefined)
  assert.equal(({}).constructor, Object)
})

it('an authenticated initial save echo followed by a peer edit accepts the newer value', async () => {
  const f = await fixture()
  patchEntry(state.triage, 'A', { color: 'red' })
  triageSync.notify()
  await waitFor(() => f.messages.some((m) => m.type === 'workspace-save'), 'initial save')
  const save = f.messages.find((m) => m.type === 'workspace-save')
  const id = await cryptoMod.computeRevisionId({ publicKeyB64: save.workspaceTag, base: save.base, keyframe: save.keyframe, nonceB64: save.nonce, ciphertextB64: save.ciphertext })
  const next = await f.revision(id, { A: { color: 'blue' } })
  f.send({ type: 'workspace-state', revisions: [{ ...save, id }, next] })
  await waitFor(() => f.info().baseRevision === next.id, 'peer successor applied')
  assert.equal(state.triage.get('A')?.color, 'blue', 'our echo establishes a fresh anchor for subsequent peer edits')
})

it('a server switch during a chain dialog discards the old chain and its queued messages', async () => {
  const f = await fixture()
  patchEntry(state.triage, 'A', { color: 'amber' })
  let resolveDialog
  setHydrationConflictResolver(() => new Promise((resolve) => { resolveDialog = resolve }))
  const remote = await f.revision(null, { A: { color: 'blue' } })
  f.send({ type: 'workspace-state', revisions: [remote] })
  await waitFor(() => resolveDialog != null, 'dialog open')
  const next = await f.revision(remote.id, { B: { comment: 'old relay' } })
  f.send({ type: 'workspace-state', revisions: [next] })
  await new Promise((resolve) => { setTimeout(resolve, 30) })
  triageSync.setServerUrl('')
  resolveDialog({ 'A:color': 'imported' })
  await new Promise((resolve) => { setTimeout(resolve, 75) })
  assert.equal(state.triage.get('A')?.color, 'amber')
  assert.equal(state.triage.get('B')?.comment, undefined)
  assert.equal(f.info().baseRevision, null)
})

it('a server switch invalidates a report-attach conflict dialog', async () => {
  const f = await fixture()
  const remote = await f.revision(null, { C: { color: 'blue' } })
  f.send({ type: 'workspace-state', revisions: [remote] })
  await waitFor(() => f.info().baseRevision === remote.id, 'out-of-scope finding received')
  patchEntry(state.triage, 'C', { color: 'amber' })
  state.reports[0].groups[0].push({ id: 'C' })
  let resolveDialog
  setHydrationConflictResolver(() => new Promise((resolve) => { resolveDialog = resolve }))
  triageSync.refreshSession(f.workspaceId)
  await waitFor(() => resolveDialog != null, 'attach dialog open')
  triageSync.setServerUrl('')
  resolveDialog({ 'C:color': 'imported' })
  await new Promise((resolve) => { setTimeout(resolve, 75) })
  assert.equal(state.triage.get('C')?.color, 'amber', 'an old relay dialog cannot write into the new session')
})

for (const confirmation of ['ack', 'echo']) {
  it(`preserves undoing an in-flight edit when its ${confirmation} arrives`, async () => {
    const f = await fixture()
    patchEntry(state.triage, 'A', { color: 'red' })
    triageSync.notify()
    await waitFor(() => f.messages.some((m) => m.type === 'workspace-save'), 'initial save')
    const save = f.messages.find((m) => m.type === 'workspace-save')
    const id = await cryptoMod.computeRevisionId({ publicKeyB64: save.workspaceTag, base: save.base, keyframe: save.keyframe, nonceB64: save.nonce, ciphertextB64: save.ciphertext })
    state.triage.delete('A')
    triageSync.notify()
    f.send(confirmation === 'ack'
      ? { type: 'workspace-save-ack', base: save.base, id }
      : { type: 'workspace-state', revisions: [{ ...save, id }] })
    await waitFor(() => f.messages.some((m) => m.type === 'workspace-save' && m.base === id), 'undo sent')
    const undo = f.messages.find((m) => m.type === 'workspace-save' && m.base === id)
    assert.equal(state.triage.get('A'), undefined)
    assert.equal((await f.decryptSave(undo)).A, null)
  })

  it(`keeps an in-flight save when its report is unloaded before ${confirmation}`, async () => {
    const f = await fixture()
    const root = await f.revision(null, { A: { color: 'red' } })
    f.send({ type: 'workspace-state', revisions: [root] })
    await waitFor(() => state.triage.get('A')?.color === 'red', 'root applied')
    patchEntry(state.triage, 'A', { color: 'blue' })
    triageSync.notify()
    await waitFor(() => f.messages.some((m) => m.type === 'workspace-save'), 'save in flight')
    const save = f.messages.find((m) => m.type === 'workspace-save')
    const id = await cryptoMod.computeRevisionId({ publicKeyB64: save.workspaceTag, base: save.base, keyframe: save.keyframe, nonceB64: save.nonce, ciphertextB64: save.ciphertext })
    state.reports.length = 0
    f.send(confirmation === 'ack'
      ? { type: 'workspace-save-ack', base: save.base, id }
      : { type: 'workspace-state', revisions: [{ ...save, id }] })
    await waitFor(() => f.info().baseRevision === id, 'save confirmed')
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    assert.equal(f.messages.filter((m) => m.type === 'workspace-save').length, 1, 'unloading must not emit an undo')
    assert.equal(state.triage.get('A')?.color, 'blue')
  })
}

it('a stale-base reset preserves triage for reports that are not loaded locally', async () => {
  const f = await fixture()
  const root = await f.revision(null, { A: { color: 'red' }, unloaded: { comment: 'keep remotely' } })
  f.send({ type: 'workspace-state', revisions: [root] })
  await waitFor(() => state.triage.get('A')?.color === 'red', 'root applied')
  state.triage.delete('A')
  triageSync.notify()
  await waitFor(() => f.messages.some((m) => m.type === 'workspace-save'), 'delete sent')
  f.send({ type: 'workspace-state', revisions: [] })
  f.send({ type: 'workspace-save-error', base: root.id, reason: 'stale-base' })
  await waitFor(() => f.messages.some((m) => m.type === 'workspace-save' && m.base === null), 'recovery save')
  const reset = f.messages.find((m) => m.type === 'workspace-save' && m.base === null)
  assert.equal(reset.keyframe, true)
  assert.deepEqual(await f.decryptSave(reset), { unloaded: { comment: 'keep remotely' } })
})

for (const [status, transition] of [[401, 'switching relays'], [413, 'switching relays'], [401, 'rotating keys']]) {
  it(`ignores an old REST ${status} response after ${transition}`, async () => {
    const realWS = globalThis.WebSocket
    const realFetch = globalThis.fetch
    const saves = []
    const inBandSaves = []
    globalThis.WebSocket = class {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
      constructor() { throw new Error('force SSE') }
    }
    globalThis.fetch = (input, init) => {
      const pathname = new URL(input).pathname
      const body = init?.body ? JSON.parse(init.body) : {}
      if (pathname === '/api/sync/save') {
        const deferred = Promise.withResolvers()
        saves.push({ ...deferred, body })
        return deferred.promise
      }
      if (pathname === '/api/sync/sse') inBandSaves.push(...(body.frames ?? []).filter((m) => m.type === 'workspace-save'))
      return realFetch(input, init)
    }
    cleanups.push(() => {
      globalThis.WebSocket = realWS
      globalThis.fetch = realFetch
      for (const save of saves) save.resolve(new Response('{}', { status: 200 }))
    })
    const server = await bootServer()
    cleanups.push(() => server.teardown())
    const workspaceId = crypto.randomUUID()
    state.triage.clear()
    state.reports.length = 0
    state.reports.push({ fileName: 'rest.md', groups: [[{ id: 'A' }]] })
    await upsertWorkspace({ id: workspaceId, name: 'REST race', privateKey: crypto.getRandomValues(new Uint8Array(32)).toBase64(), reports: ['rest.md'] })
    cleanups.push(() => deleteWorkspace(workspaceId))
    triageSync.setServerUrl(server.serverUrl)
    triageSync.openSession(workspaceId)
    await waitFor(() => triageSync.status === 'online', 'SSE online')
    patchEntry(state.triage, 'A', { color: 'red' })
    triageSync.notify()
    await waitFor(() => saves.length === 1, 'old HTTP save held')
    patchEntry(state.triage, 'A', { color: 'blue' })
    const release = Promise.withResolvers()
    let lock
    try {
      if (transition === 'rotating keys') {
        const entered = Promise.withResolvers()
        lock = navigator.locks.request('deepview.sync.sessions', () => { entered.resolve(); return release.promise })
        await entered.promise
        await upsertWorkspace({ id: workspaceId, name: 'REST race', privateKey: crypto.getRandomValues(new Uint8Array(32)).toBase64(), reports: ['rest.md'] })
        assert.equal(triageSync.sessionInfo(workspaceId).workspaceTag, null, 'rotation is waiting for the persisted-base wipe')
      } else {
        // A distinct URL creates a new relay generation. The same test
        // listener isolates the delayed-response race.
        triageSync.setServerUrl(`${server.serverUrl}?new-relay`)
        await waitFor(() => saves.length >= 2, 'new HTTP save held')
      }
      saves[0].resolve(new Response('{}', { status }))
      await new Promise((resolve) => { setTimeout(resolve, 200) })
      assert.equal(triageSync.sessionInfo(workspaceId).error, null)
      assert.equal(inBandSaves.some((m) => m.ciphertext === saves[0].body.ciphertext), false, 'obsolete save was not replayed in-band')
      assert.equal(state.triage.get('A')?.color, 'blue')
    } finally { release.resolve(); await lock }
    await waitFor(() => saves.length >= 2, 'new HTTP save held')
    assert.notEqual(triageSync.sessionInfo(workspaceId).pending, null)
  })
}
