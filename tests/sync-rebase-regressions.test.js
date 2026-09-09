import './_polyfills.js'
import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { WebSocketServer } from 'ws'
import { awaitListening, bootServer, closeWebSocketServer } from './_helpers.js'
import { rebaseLocalState } from '../client/sync/triage-changeset.ts'

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
        sock.send(JSON.stringify({ type: 'workspace-subscribed', workspaceTag: kp.publicKeyB64, resources: [] }))
      }
    })
  })
  triageSync.setServerUrl(`ws://127.0.0.1:${wss.address().port}/api/sync`)
  triageSync.openSession(workspaceId)
  await waitFor(() => triageSync.status === 'online', 'subscribe')
  return {
    workspaceId, messages,
    send: (msg) => socket.send(JSON.stringify({ workspaceTag: kp.publicKeyB64, ...msg })),
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

it('keeps edits made during a chain conflict dialog and defers saves until it resolves', async () => {
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
  patchEntry(state.triage, 'A', { color: 'cyan' })
  patchEntry(state.triage, 'B', { comment: 'typed while resolving' })
  triageSync.notify()
  // A macrotask lets crypto complete if the save incorrectly bypasses the dialog.
  await new Promise((resolve) => { setTimeout(resolve, 75) })
  const earlySaves = f.messages.filter((m) => m.type === 'workspace-save')
  resolveDialog({ 'A:color': 'imported' })
  await waitFor(() => f.messages.some((m) => m.type === 'workspace-save'), 'follow-up save')
  assert.equal(earlySaves.length, 0, 'no save based on unresolved remote state')
  assert.equal(state.triage.get('A')?.color, 'cyan', 'new edit supersedes old dialog choice')
  assert.equal(state.triage.get('B')?.comment, 'typed while resolving')
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
