// Race-condition + complex-scenario tests for the triage-sync
// relay (the WS plane in `server/index.ts` + `server/db.ts`).
//
// Sibling of tests/sync-server.test.js — that file pins single-
// client lifecycle + signature gates. This one targets:
//   - chain-fork prevention under concurrent saves on the same base,
//   - subscribe races (close-mid-verify, subscribe-before-key-arrive),
//   - per-workspace lock isolation across many sockets / tags,
//   - broadcast fan-out under contention,
//   - idempotent retransmit across sockets,
//   - chain-continuity invariants after a bursty workload.
//
// The relay's per-tag write lock (`writeLocks` in server/db.ts:141)
// is the only thing keeping `commitRevision` from forking a chain.
// Tests below exercise it under real WS contention rather than
// hand-acquiring the lock — production ordering is what matters,
// not a synthetic single-process invariant.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { encodeUtf8 } from '../common/utf8.js'

const SAVE_DOMAIN = 'deepview-triage-sync.v1.save'
const SUBSCRIBE_DOMAIN = 'deepview-triage-sync.v1.subscribe'

function b64url(bytes) { return Buffer.from(bytes).toString('base64url') }

// Boot a spawned `server/index.ts` and resolve the OS-assigned port
// from the listening banner. Same shape as the helper in
// tests/sync-server.test.js — kept inline so this file is self-
// contained and doesn't depend on a sibling helper module.
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

async function makeKp() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { sk: kp.privateKey, tag: b64url(Buffer.from(jwk.x, 'base64url')) }
}

async function signSave(sk, { tag, base, keyframe, nonce, ciphertext }) {
  const payload = encodeUtf8([
    SAVE_DOMAIN, tag, base == null ? '' : String(base), keyframe ? '1' : '', nonce, ciphertext,
  ].join('\n'))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, payload))
  const id = new Uint8Array(await crypto.subtle.digest('SHA-256', payload))
  return { signature: b64url(sig), id: b64url(id) }
}

async function signSubscribe(sk, tag, from, connectionNonce) {
  const payload = encodeUtf8([
    SUBSCRIBE_DOMAIN, tag, from == null ? '' : String(from), connectionNonce,
  ].join('\n'))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, payload))
  return b64url(sig)
}

async function buildSave(sk, tag, base, plaintext, { keyframe = false } = {}) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)))
  const ciphertext = b64url(new TextEncoder().encode(plaintext))
  const { signature, id } = await signSave(sk, { tag, base, keyframe, nonce, ciphertext })
  const msg = { type: 'workspace-save', workspaceTag: tag, base, nonce, ciphertext, signature }
  if (keyframe) msg.keyframe = true
  return { msg, id }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const queue = []
    const waiters = []
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].predicate(msg)) {
          const w = waiters[i]
          waiters.splice(i, 1)
          w.resolve(msg)
          return
        }
      }
      queue.push(msg)
    })
    function recv(predicate, timeoutMs = 5_000) {
      for (let i = 0; i < queue.length; i++) {
        if (predicate(queue[i])) return Promise.resolve(queue.splice(i, 1)[0])
      }
      return new Promise((res, rej) => {
        const waiter = { predicate, resolve: null }
        const t = setTimeout(() => {
          const idx = waiters.indexOf(waiter)
          if (idx >= 0) waiters.splice(idx, 1)
          rej(new Error(`recv: timeout (queue=${queue.length}, head=${JSON.stringify(queue[0] ?? null).slice(0, 200)})`))
        }, timeoutMs)
        waiter.resolve = (msg) => { clearTimeout(t); res(msg) }
        waiters.push(waiter)
      })
    }
    function expectSilent(ms = 200) {
      const start = queue.length
      return new Promise((res, rej) => {
        setTimeout(() => {
          if (queue.length === start) res()
          else rej(new Error(`expectSilent: got ${JSON.stringify(queue.slice(start)).slice(0, 200)}`))
        }, ms)
      })
    }
    ws.addEventListener('open', () => {
      recv((m) => m.type === 'challenge', 5_000).then((challenge) => {
        resolve({ ws, recv, expectSilent, connectionNonce: challenge.nonce })
        return null
      }).catch((err) => reject(err))
    }, { once: true })
    ws.addEventListener('error', (event) => reject(event.error ?? new Error('websocket error')), { once: true })
  })
}

async function subscribe(c, sk, tag, from = null) {
  const sig = await signSubscribe(sk, tag, from, c.connectionNonce)
  c.ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from, signature: sig }))
  const ack = await c.recv((m) => m.type === 'workspace-subscribed' && m.workspaceTag === tag)
  const chain = await c.recv((m) => m.type === 'workspace-state' && m.workspaceTag === tag)
  return { ack, chain }
}

// Walk a chain of `{ base, id, ... }` entries and confirm the
// id↔base links form a valid path (each base equals the previous
// id, the first base matches `from`). Returns the head id; throws
// AssertionError on any gap.
function assertContinuousChain(revisions, from = null) {
  let prevId = from
  for (let i = 0; i < revisions.length; i++) {
    const r = revisions[i]
    assert.equal(r.base, prevId, `chain[${i}]: base ${r.base} != expected previous id ${prevId}`)
    prevId = r.id
  }
  return prevId
}

describe('triage-sync server races', () => {
  let serverDir, serverProc, serverUrl

  before(async () => {
    serverDir = mkdtempSync(path.join(tmpdir(), 'deepview-sync-races-'))
    serverProc = spawn(process.execPath, ['server/index.ts'], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DB_PATH: path.join(serverDir, 'data.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const port = await awaitListeningPort(serverProc)
    serverUrl = `ws://127.0.0.1:${port}/api/sync`
  })

  after(async () => {
    if (!serverProc) return
    serverProc.kill('SIGTERM')
    await new Promise((resolve) => { serverProc.once('exit', resolve) })
    rmSync(serverDir, { recursive: true, force: true })
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 1: chain-fork prevention under concurrent saves
  // ──────────────────────────────────────────────────────────────
  //
  // The per-`workspace_tag` write lock in `commitRevision` is the
  // only thing keeping two saves with the SAME `base` from both
  // inserting and forking the chain. Without it, both pre-INSERT
  // base-match checks pass and both INSERTs land (UNIQUE is on
  // (workspace_tag, id), not on `base`). The tests below exercise
  // this under real WS contention.

  it('two sockets racing on the SAME base: exactly one ack, one stale-base; chain has exactly one revision', async () => {
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl)
    const c2 = await connect(serverUrl)
    await subscribe(c1, sk, tag)
    await subscribe(c2, sk, tag)
    // Both build a save with base=null (must-not-exist precondition).
    const { msg: m1, id: id1 } = await buildSave(sk, tag, null, 'from-c1')
    const { msg: m2, id: id2 } = await buildSave(sk, tag, null, 'from-c2')
    assert.notEqual(id1, id2, 'distinct ciphertext → distinct content-addressed ids')
    // Send both onto the wire as close together as the test driver
    // can. The lock serialises; one wins (ack), the other catches up
    // via workspace-state.
    c1.ws.send(JSON.stringify(m1))
    c2.ws.send(JSON.stringify(m2))
    // Collect each socket's first save-reply (either ack or
    // workspace-state).
    const r1 = await c1.recv((m) => m.type === 'workspace-save-ack' || (m.type === 'workspace-state' && m.revisions?.length > 0))
    const r2 = await c2.recv((m) => m.type === 'workspace-save-ack' || (m.type === 'workspace-state' && m.revisions?.length > 0))
    const acks = [r1, r2].filter((m) => m.type === 'workspace-save-ack')
    const catchups = [r1, r2].filter((m) => m.type === 'workspace-state')
    assert.equal(acks.length, 1, 'exactly one save wins the lock')
    assert.equal(catchups.length, 1, 'the other gets a stale-base catch-up')
    // The catch-up echoes the winner's revision so the loser can
    // rebase + retry.
    const winnerId = acks[0].id
    assert.equal(catchups[0].revisions[0].id, winnerId)
    // Final chain (via a fresh subscribe) has exactly one row.
    const c3 = await connect(serverUrl)
    const { chain } = await subscribe(c3, sk, tag)
    assert.equal(chain.revisions.length, 1, 'chain has exactly one revision — no fork')
    assert.equal(chain.revisions[0].id, winnerId)
    c1.ws.close(); c2.ws.close(); c3.ws.close()
  })

  it('10 sockets racing on the SAME base: exactly one ack, 9 stale-base; chain has exactly one revision', async () => {
    const { sk, tag } = await makeKp()
    const N = 10
    const sockets = await Promise.all(Array.from({ length: N }, () => connect(serverUrl)))
    try {
      // Subscribe every socket so they're all in the broadcast set.
      await Promise.all(sockets.map((c) => subscribe(c, sk, tag)))
      // Build N distinct saves with base=null.
      const saves = []
      for (let i = 0; i < N; i++) {
        saves.push(await buildSave(sk, tag, null, `racer-${i}`))
      }
      // Fire all sends in parallel.
      for (let i = 0; i < N; i++) sockets[i].ws.send(JSON.stringify(saves[i].msg))
      // Each socket gets either an ack (it won) or a workspace-state
      // catch-up (it lost the lock race). Don't await broadcasts here
      // — they're per-socket and a winner doesn't see its own.
      const replies = await Promise.all(sockets.map((c, i) =>
        c.recv((m) =>
          (m.type === 'workspace-save-ack' && m.id === saves[i].id) ||
          (m.type === 'workspace-state' && m.revisions?.length > 0),
        ),
      ))
      const acks = replies.filter((m) => m.type === 'workspace-save-ack')
      const catchups = replies.filter((m) => m.type === 'workspace-state')
      assert.equal(acks.length, 1, 'exactly one save inserts')
      assert.equal(catchups.length, N - 1, `${N - 1} losers get stale-base catch-up`)
      // The winner is one of the saves.
      const winnerId = acks[0].id
      const winnerIndex = saves.findIndex((s) => s.id === winnerId)
      assert.notEqual(winnerIndex, -1, 'ack id matches one of the racers')
      // Every catch-up echoes the SAME winner's revision id.
      for (const cu of catchups) {
        assert.equal(cu.revisions[0].id, winnerId, 'every loser sees the same winner')
      }
      // Fresh subscribe shows chain length 1.
      const observer = await connect(serverUrl)
      const { chain } = await subscribe(observer, sk, tag)
      assert.equal(chain.revisions.length, 1)
      assert.equal(chain.revisions[0].id, winnerId)
      observer.ws.close()
    } finally {
      for (const c of sockets) c.ws.close()
    }
  })

  it('chain has no fork even when racers commit, retry, race, retry — 5 generations', async () => {
    // Simulates real-client retry behaviour: a racer that gets a
    // stale-base re-bases against the new head and tries again.
    // Across 5 generations × 3 racers, the chain grows linearly with
    // no forks.
    //
    // Racers do NOT subscribe — a subscribed socket would receive
    // peer-broadcast workspace-state frames that are byte-identical
    // to its own stale-base catch-up, making them impossible to
    // distinguish on the recv predicate. Unsubscribed racers only
    // see ack / catch-up frames addressed to themselves.
    const { sk, tag } = await makeKp()
    const N = 3
    const generations = 5
    const sockets = await Promise.all(Array.from({ length: N }, () => connect(serverUrl)))
    try {
      let head = null
      for (let gen = 0; gen < generations; gen++) {
        // Each racer builds against the CURRENT head.
        const saves = []
        for (let i = 0; i < N; i++) saves.push(await buildSave(sk, tag, head, `gen-${gen}-racer-${i}`))
        for (let i = 0; i < N; i++) sockets[i].ws.send(JSON.stringify(saves[i].msg))
        // Wait for each socket's primary reply.
        const replies = await Promise.all(sockets.map((c, i) =>
          c.recv((m) =>
            (m.type === 'workspace-save-ack' && m.id === saves[i].id) ||
            (m.type === 'workspace-state' && m.revisions?.length > 0),
          ),
        ))
        const acks = replies.filter((m) => m.type === 'workspace-save-ack')
        assert.equal(acks.length, 1, `gen ${gen}: one winner`)
        head = acks[0].id
      }
      // Final chain via a fresh socket has exactly `generations`
      // revisions, all in a valid base-chain.
      const observer = await connect(serverUrl)
      const { chain } = await subscribe(observer, sk, tag)
      assert.equal(chain.revisions.length, generations)
      assertContinuousChain(chain.revisions, null)
      observer.ws.close()
    } finally {
      for (const c of sockets) c.ws.close()
    }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 2: idempotent retransmit
  // ──────────────────────────────────────────────────────────────

  it('same content from two sockets concurrently: both get ack, chain has exactly one revision', async () => {
    // Same plaintext + same nonce + same key = same canonical bytes
    // = same content-addressed id. The `revisionExists` recheck
    // inside the lock returns `duplicate` for the loser without
    // inserting a duplicate.
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl); const c2 = await connect(serverUrl)
    try {
      await subscribe(c1, sk, tag); await subscribe(c2, sk, tag)
      // Construct ONE save and send it from both sockets — identical
      // bytes, identical id.
      const { msg, id } = await buildSave(sk, tag, null, 'shared-content')
      c1.ws.send(JSON.stringify(msg))
      c2.ws.send(JSON.stringify(msg))
      const r1 = await c1.recv((m) => m.type === 'workspace-save-ack' && m.id === id)
      const r2 = await c2.recv((m) => m.type === 'workspace-save-ack' && m.id === id)
      assert.equal(r1.id, id); assert.equal(r2.id, id)
      // Chain has one row.
      const observer = await connect(serverUrl)
      const { chain } = await subscribe(observer, sk, tag)
      assert.equal(chain.revisions.length, 1)
      observer.ws.close()
    } finally { c1.ws.close(); c2.ws.close() }
  })

  it('20 retransmits of the same save from the same socket all ack; chain has exactly one revision', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    try {
      await subscribe(c, sk, tag)
      const { msg, id } = await buildSave(sk, tag, null, 'retransmit-storm')
      for (let i = 0; i < 20; i++) c.ws.send(JSON.stringify(msg))
      // Drain 20 acks (all carry the same id).
      for (let i = 0; i < 20; i++) {
        const ack = await c.recv((m) => m.type === 'workspace-save-ack')
        assert.equal(ack.id, id)
      }
      const observer = await connect(serverUrl)
      const { chain } = await subscribe(observer, sk, tag)
      assert.equal(chain.revisions.length, 1)
      observer.ws.close()
    } finally { c.ws.close() }
  })

  it('same plaintext + nonce but DIFFERENT keyframe flag = distinct ids; both land on the chain', async () => {
    // The `id` is content-addressed: SHA-256 over the canonical
    // bytes, which include `keyframe ? '1' : ''`. Same plaintext +
    // nonce but different keyframe values produce different
    // canonical bytes → different ids → not falsely dedup'd.
    //
    // Pins the `keyframe` field's participation in id-derivation
    // — a regression that dropped it from the canonical would make
    // two saves with byte-identical bodies collide on id even
    // though one is meant to be a keyframe (full-state) and the
    // other a delta.
    //
    // Order is keyframe FIRST then non-keyframe second so the
    // post-test catch-up subscribe (chainFrom with the keyframe
    // optimisation) sees BOTH rows: the keyframe anchors the
    // chain, the non-keyframe delta extends past it.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    try {
      await subscribe(c, sk, tag)
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)))
      const ciphertext = b64url(new TextEncoder().encode('shared-plaintext'))
      // First: keyframe save with base=null.
      const kf = await signSave(sk, { tag, base: null, keyframe: true, nonce, ciphertext })
      c.ws.send(JSON.stringify({
        type: 'workspace-save', workspaceTag: tag, base: null, keyframe: true, nonce, ciphertext,
        signature: kf.signature,
      }))
      const ack1 = await c.recv((m) => m.type === 'workspace-save-ack' && m.id === kf.id)
      assert.equal(ack1.id, kf.id)
      // Second: same bytes, but keyframe=false (no wire flag). The
      // canonical includes `keyframe='' ` (empty) — distinct from
      // the first's `keyframe='1'` — so the id differs.
      const noKf = await signSave(sk, { tag, base: kf.id, keyframe: false, nonce, ciphertext })
      assert.notEqual(noKf.id, kf.id, 'distinct keyframe flag → distinct canonical bytes → distinct id')
      c.ws.send(JSON.stringify({
        type: 'workspace-save', workspaceTag: tag, base: kf.id, nonce, ciphertext,
        signature: noKf.signature,
      }))
      const ack2 = await c.recv((m) => m.type === 'workspace-save-ack' && m.id === noKf.id)
      assert.equal(ack2.id, noKf.id)
      // Fresh subscribe returns the chain from the keyframe forward
      // — two revisions, both byte-identical inside the ciphertext
      // but with distinct ids and distinct keyframe flags.
      const observer = await connect(serverUrl)
      const { chain } = await subscribe(observer, sk, tag)
      assert.equal(chain.revisions.length, 2)
      assert.equal(chain.revisions[0].id, kf.id)
      assert.equal(chain.revisions[0].keyframe, true)
      assert.equal(chain.revisions[1].id, noKf.id)
      assert.equal(chain.revisions[1].keyframe, false)
      // The two ciphertexts on the wire ARE byte-identical — pin
      // that the only thing distinguishing them is the keyframe
      // flag (= the id-derivation participates in it).
      assert.equal(chain.revisions[0].ciphertext, chain.revisions[1].ciphertext)
      assert.equal(chain.revisions[0].nonce, chain.revisions[1].nonce)
      observer.ws.close()
    } finally { c.ws.close() }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 3: per-tag isolation across sockets / tags
  // ──────────────────────────────────────────────────────────────

  it('one socket subscribed to 5 tags: concurrent saves on each tag stay isolated', async () => {
    // The per-tag lock keys on `workspace_tag` (db.ts:379). Five
    // different tags should not contend with each other; concurrent
    // saves on each commit independently.
    const tagsAndKeys = await Promise.all(Array.from({ length: 5 }, () => makeKp()))
    const c = await connect(serverUrl)
    const observer = await connect(serverUrl)
    try {
      // Subscribe c + observer to all 5 tags.
      for (const { sk, tag } of tagsAndKeys) {
        await subscribe(c, sk, tag)
        await subscribe(observer, sk, tag)
      }
      // Build one save per tag, fire all in parallel.
      const saves = await Promise.all(tagsAndKeys.map(({ sk, tag }) => buildSave(sk, tag, null, `payload-for-${tag.slice(0, 8)}`)))
      for (let i = 0; i < 5; i++) c.ws.send(JSON.stringify(saves[i].msg))
      // Drain 5 acks; each ack identifies its workspaceTag.
      const ackIds = new Map()
      for (let i = 0; i < 5; i++) {
        const ack = await c.recv((m) => m.type === 'workspace-save-ack')
        ackIds.set(ack.workspaceTag, ack.id)
      }
      assert.equal(ackIds.size, 5, 'one ack per distinct tag')
      // Observer receives 5 broadcasts, each on its own tag.
      for (let i = 0; i < 5; i++) {
        const bc = await observer.recv((m) => m.type === 'workspace-state' && m.revisions?.length === 1 && !ackIds.has(m.workspaceTag) ? false : (m.type === 'workspace-state' && m.revisions?.length === 1))
        assert.equal(bc.revisions[0].id, ackIds.get(bc.workspaceTag), `broadcast for ${bc.workspaceTag.slice(0, 8)} matches its ack id`)
      }
      // Each tag's chain has exactly 1 row — cross-tag bleed would
      // surface as a longer chain or a mismatched id.
      for (const { sk, tag } of tagsAndKeys) {
        const fresh = await connect(serverUrl)
        const { chain } = await subscribe(fresh, sk, tag)
        assert.equal(chain.revisions.length, 1)
        assert.equal(chain.revisions[0].id, ackIds.get(tag))
        fresh.ws.close()
      }
    } finally { c.ws.close(); observer.ws.close() }
  })

  it('save on tag-A is NOT broadcast to a subscriber on tag-B (cross-tag isolation)', async () => {
    const a = await makeKp(); const b = await makeKp()
    const writer = await connect(serverUrl); const peer = await connect(serverUrl)
    try {
      await subscribe(writer, a.sk, a.tag)
      await subscribe(peer, b.sk, b.tag)
      const { msg } = await buildSave(a.sk, a.tag, null, 'tag-A-only')
      writer.ws.send(JSON.stringify(msg))
      await writer.recv((m) => m.type === 'workspace-save-ack')
      // Peer subscribed to tag B should NOT see tag A's broadcast.
      await peer.expectSilent(200)
    } finally { writer.ws.close(); peer.ws.close() }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 4: broadcast under load
  // ──────────────────────────────────────────────────────────────

  it('5 subscribers + one save: all 5 receive the broadcast', async () => {
    const { sk, tag } = await makeKp()
    const subscribers = await Promise.all(Array.from({ length: 5 }, () => connect(serverUrl)))
    const writer = await connect(serverUrl)
    try {
      await Promise.all(subscribers.map((c) => subscribe(c, sk, tag)))
      await subscribe(writer, sk, tag)
      const { msg, id } = await buildSave(sk, tag, null, 'fan-out')
      writer.ws.send(JSON.stringify(msg))
      await writer.recv((m) => m.type === 'workspace-save-ack')
      const broadcasts = await Promise.all(subscribers.map((c) =>
        c.recv((m) => m.type === 'workspace-state' && m.revisions?.length === 1),
      ))
      for (const b of broadcasts) {
        assert.equal(b.revisions[0].id, id)
      }
    } finally {
      writer.ws.close()
      for (const c of subscribers) c.ws.close()
    }
  })

  it('a subscriber that closes mid-broadcast does NOT abort the broadcast for remaining peers', async () => {
    // The broadcast loop in server/index.ts:277 snapshots subscribers
    // before iterating, and sendRaw try/catches per-subscriber. A
    // subscriber that's transitioning to CLOSED mid-broadcast must
    // not skip every subscriber after it in iteration order.
    const { sk, tag } = await makeKp()
    const dying = await connect(serverUrl)
    const survivors = await Promise.all(Array.from({ length: 3 }, () => connect(serverUrl)))
    const writer = await connect(serverUrl)
    try {
      await subscribe(dying, sk, tag)
      await Promise.all(survivors.map((c) => subscribe(c, sk, tag)))
      await subscribe(writer, sk, tag)
      // Close the dying subscriber's socket; give the server a tick
      // to register the close.
      dying.ws.close()
      await new Promise((r) => { setTimeout(r, 100) })
      const { msg, id } = await buildSave(sk, tag, null, 'survives-dead-peer')
      writer.ws.send(JSON.stringify(msg))
      await writer.recv((m) => m.type === 'workspace-save-ack')
      // All 3 survivors receive the broadcast.
      for (const c of survivors) {
        const bc = await c.recv((m) => m.type === 'workspace-state' && m.revisions?.length === 1)
        assert.equal(bc.revisions[0].id, id)
      }
    } finally {
      writer.ws.close()
      for (const c of survivors) c.ws.close()
    }
  })

  it('100 saves serialised on one socket reach all subscribers in chain order', async () => {
    // Same socket, base-chained sequence of 100 saves. The server's
    // per-tag lock serialises them; peers receive 100 broadcasts in
    // chain order.
    const { sk, tag } = await makeKp()
    const writer = await connect(serverUrl)
    const peer = await connect(serverUrl)
    try {
      await subscribe(writer, sk, tag)
      await subscribe(peer, sk, tag)
      let head = null
      const sent = []
      for (let i = 0; i < 100; i++) {
        const { msg, id } = await buildSave(sk, tag, head, `save-${i}`)
        writer.ws.send(JSON.stringify(msg))
        const ack = await writer.recv((m) => m.type === 'workspace-save-ack' && m.id === id)
        sent.push({ id, base: head })
        head = ack.id
      }
      // Peer receives 100 broadcasts. Drain in arrival order.
      const received = []
      for (let i = 0; i < 100; i++) {
        const bc = await peer.recv((m) => m.type === 'workspace-state' && m.revisions?.length === 1)
        received.push(bc.revisions[0])
      }
      assert.equal(received.length, 100)
      assertContinuousChain(received, null)
      for (let i = 0; i < 100; i++) {
        assert.equal(received[i].id, sent[i].id)
        assert.equal(received[i].base, sent[i].base)
      }
    } finally { writer.ws.close(); peer.ws.close() }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 5: subscribe ordering + ackpath races
  // ──────────────────────────────────────────────────────────────

  it('subscribe-then-rapid-saves on the same socket: subscriber receives all peer broadcasts', async () => {
    const { sk, tag } = await makeKp()
    const writer = await connect(serverUrl)
    const peer = await connect(serverUrl)
    try {
      await subscribe(peer, sk, tag)
      await subscribe(writer, sk, tag)
      // Pace writes via ack: the server's signature-verify is async,
      // so two saves sent back-to-back on the same socket can have
      // their `commitRevision` called in any order (whichever
      // verify finishes first). Without pacing, a chained save can
      // hit a stale-base catch-up because the prior save's commit
      // hasn't landed yet. The production client paces via ack;
      // mirror that here.
      let head = null
      const ids = []
      for (let i = 0; i < 5; i++) {
        const { msg, id } = await buildSave(sk, tag, head, `rapid-${i}`)
        writer.ws.send(JSON.stringify(msg))
        const ack = await writer.recv((m) => m.type === 'workspace-save-ack' && m.id === id)
        ids.push(id)
        head = ack.id
      }
      // Peer sees 5 broadcasts, in chain order.
      const seen = []
      for (let i = 0; i < 5; i++) {
        const bc = await peer.recv((m) => m.type === 'workspace-state' && m.revisions?.length === 1)
        seen.push(bc.revisions[0].id)
      }
      assert.deepEqual(seen, ids, 'broadcasts arrive in chain order')
    } finally { writer.ws.close(); peer.ws.close() }
  })

  it('unpaced rapid saves on the same socket can race the verify queue: server still serialises commits, no fork', async () => {
    // Companion to the paced test above: send 5 saves WITHOUT
    // awaiting acks between them, demonstrating the documented
    // race. Whatever the eventual outcome (some acks, some
    // stale-base catch-ups for the same socket's own retries),
    // the CHAIN never forks — every committed revision links to
    // a valid base, and the final chain length matches how many
    // acks the writer collected.
    const { sk, tag } = await makeKp()
    const writer = await connect(serverUrl)
    try {
      // Don't subscribe the writer — broadcasts are workspace-state
      // frames that would be indistinguishable from stale-base
      // catch-ups on the wire. Unsubscribed, the writer only sees
      // ack / catch-up frames addressed to itself.
      let head = null
      const sentIds = []
      for (let i = 0; i < 5; i++) {
        const { msg, id } = await buildSave(sk, tag, head, `unpaced-${i}`)
        writer.ws.send(JSON.stringify(msg))
        sentIds.push(id)
        // Client predicted head — server might not agree.
        head = id
      }
      // Drain 5 replies (ack or workspace-state).
      const replies = []
      for (let i = 0; i < 5; i++) {
        replies.push(await writer.recv((m) => m.type === 'workspace-save-ack' || m.type === 'workspace-state'))
      }
      const acked = replies.filter((m) => m.type === 'workspace-save-ack').map((m) => m.id)
      // Every acked id is one of the sent ids.
      for (const id of acked) assert.ok(sentIds.includes(id), `acked id ${id} matches a sent id`)
      // Final chain via fresh observer is continuous and contains
      // exactly the acked ids (no extras, no fork).
      const observer = await connect(serverUrl)
      try {
        const { chain } = await subscribe(observer, sk, tag)
        // The chain has exactly the acked ids in some order; they
        // form a continuous chain from null.
        assertContinuousChain(chain.revisions, null)
        const chainIds = chain.revisions.map((r) => r.id)
        assert.deepEqual([...chainIds].toSorted(), [...acked].toSorted(), 'chain matches the acked set exactly — no fork, no orphans')
      } finally { observer.ws.close() }
    } finally { writer.ws.close() }
  })

  it('subscribe arriving WHILE a save is mid-commit on another socket: subscriber\'s chain catches the commit', async () => {
    // Subscribe is a one-shot read; the chainFrom query runs after
    // the subscribe-sig verify. If a save on another socket commits
    // between subscribe-send and chainFrom, the response IS allowed
    // to include the just-committed revision. The invariant: the
    // returned chain is continuous, and any subsequent broadcasts
    // don't double-deliver the same revision.
    const { sk, tag } = await makeKp()
    const writer = await connect(serverUrl)
    try {
      await subscribe(writer, sk, tag)
      // Land one revision before the new subscriber connects.
      const { msg: seedMsg, id: seedId } = await buildSave(sk, tag, null, 'pre-subscribe')
      writer.ws.send(JSON.stringify(seedMsg))
      await writer.recv((m) => m.type === 'workspace-save-ack' && m.id === seedId)
      // Fire ANOTHER save concurrently with a new subscriber.
      const newPeer = await connect(serverUrl)
      try {
        const { msg: midMsg, id: midId } = await buildSave(sk, tag, seedId, 'concurrent-with-subscribe')
        writer.ws.send(JSON.stringify(midMsg))
        // Subscribe the new peer simultaneously.
        const peerChain = await subscribe(newPeer, sk, tag)
        await writer.recv((m) => m.type === 'workspace-save-ack' && m.id === midId)
        // Peer's chain is either [seed] or [seed, mid] depending on
        // ordering — both valid. If it's [seed], the next broadcast
        // delivers mid; if [seed, mid], silence + the broadcast is
        // dedup'd by the relay (since this socket was added to
        // subscribers only after the subscribe-sig verified).
        const revs = peerChain.chain.revisions
        assert.ok(revs.length === 1 || revs.length === 2, `chain length 1 or 2, got ${revs.length}`)
        assert.equal(revs[0].id, seedId)
        assertContinuousChain(revs, null)
        // If only seed was in the chain, mid arrives as a broadcast.
        if (revs.length === 1) {
          const bc = await newPeer.recv((m) => m.type === 'workspace-state' && m.revisions?.length === 1 && m.revisions[0].id === midId)
          assert.equal(bc.revisions[0].id, midId)
        }
      } finally { newPeer.ws.close() }
    } finally { writer.ws.close() }
  })

  it('subscribe from=`id-of-current-head`: chain is empty (no revisions newer than the cursor)', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    try {
      await subscribe(c, sk, tag)
      const { msg, id } = await buildSave(sk, tag, null, 'only-revision')
      c.ws.send(JSON.stringify(msg))
      await c.recv((m) => m.type === 'workspace-save-ack')
      const fresh = await connect(serverUrl)
      try {
        const { chain } = await subscribe(fresh, sk, tag, id)
        assert.deepEqual(chain.revisions, [], 'cursor at head → empty chain')
      } finally { fresh.ws.close() }
    } finally { c.ws.close() }
  })

  it('subscribe from=`ancient-or-unknown-id`: full chain via the keyframe fallback', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    try {
      await subscribe(c, sk, tag)
      // Land a keyframe + a few deltas.
      let head = null
      const { msg: kf, id: kfId } = await buildSave(sk, tag, null, 'keyframe-payload', { keyframe: true })
      c.ws.send(JSON.stringify(kf))
      await c.recv((m) => m.type === 'workspace-save-ack' && m.id === kfId)
      head = kfId
      for (let i = 0; i < 3; i++) {
        const { msg, id } = await buildSave(sk, tag, head, `delta-${i}`)
        c.ws.send(JSON.stringify(msg))
        await c.recv((m) => m.type === 'workspace-save-ack' && m.id === id)
        head = id
      }
      // Subscribe with an unknown `from` — server falls back to
      // returning chain from the most recent keyframe.
      const fresh = await connect(serverUrl)
      try {
        const unknownFrom = b64url(crypto.getRandomValues(new Uint8Array(32)))
        const { chain } = await subscribe(fresh, sk, tag, unknownFrom)
        // Should include the keyframe + 3 deltas = 4 revisions.
        assert.equal(chain.revisions.length, 4)
        assert.equal(chain.revisions[0].id, kfId)
        assert.equal(chain.revisions[0].keyframe, true)
        assertContinuousChain(chain.revisions, null)
      } finally { fresh.ws.close() }
    } finally { c.ws.close() }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 6: chain continuity invariants under racy workloads
  // ──────────────────────────────────────────────────────────────

  it('chain has no gaps after a burst of 30 saves from 3 racers retrying on stale-base', async () => {
    // 3 racers each try to append 10 saves; on stale-base they
    // rebase against the new head and retry. After the burst, the
    // chain is a continuous linked list with exactly 30 revisions.
    //
    // The racers do NOT subscribe — subscribed sockets receive
    // peer-broadcast workspace-state frames that are byte-identical
    // to their own stale-base catch-ups, so the racer can't tell
    // which is which. Unsubscribed racers only get acks +
    // catch-ups addressed to themselves.
    const { sk, tag } = await makeKp()
    const N = 3
    const perRacer = 10
    const sockets = await Promise.all(Array.from({ length: N }, () => connect(serverUrl)))
    try {
      // No subscribe — see comment above.
      let succeeded = 0
      const racer = async (c, idx) => {
        let attempts = 0
        let myHead = null
        for (let i = 0; i < perRacer; i++) {
          while (true) {
            const { msg, id } = await buildSave(sk, tag, myHead, `racer-${idx}-save-${i}-attempt-${attempts++}`)
            c.ws.send(JSON.stringify(msg))
            const reply = await c.recv((m) =>
              (m.type === 'workspace-save-ack' && m.id === id) ||
              (m.type === 'workspace-state' && m.revisions?.length > 0),
            )
            if (reply.type === 'workspace-save-ack') {
              myHead = id
              succeeded += 1
              break
            }
            // Stale-base catch-up: rebase against the chain's tail.
            const last = reply.revisions.at(-1)
            myHead = last.id
          }
        }
      }
      await Promise.all(sockets.map((c, i) => racer(c, i)))
      assert.equal(succeeded, N * perRacer, 'every save eventually landed')
      // Fresh subscribe to inspect the final chain.
      const observer = await connect(serverUrl)
      const { chain } = await subscribe(observer, sk, tag)
      assert.equal(chain.revisions.length, N * perRacer, `chain has exactly ${N * perRacer} revisions`)
      assertContinuousChain(chain.revisions, null)
      observer.ws.close()
    } finally {
      for (const c of sockets) c.ws.close()
    }
  })

  it('reconnect resumes from last seen id: no gaps, no duplicates', async () => {
    const { sk, tag } = await makeKp()
    const first = await connect(serverUrl)
    let lastSeen = null
    try {
      await subscribe(first, sk, tag)
      let head = null
      for (let i = 0; i < 5; i++) {
        const { msg, id } = await buildSave(sk, tag, head, `pre-${i}`)
        first.ws.send(JSON.stringify(msg))
        await first.recv((m) => m.type === 'workspace-save-ack' && m.id === id)
        head = id
      }
      lastSeen = head
    } finally { first.ws.close() }
    // While disconnected, add 3 more revisions from a different socket.
    const writer = await connect(serverUrl)
    let postHead = lastSeen
    try {
      await subscribe(writer, sk, tag)
      for (let i = 0; i < 3; i++) {
        const { msg, id } = await buildSave(sk, tag, postHead, `post-${i}`)
        writer.ws.send(JSON.stringify(msg))
        await writer.recv((m) => m.type === 'workspace-save-ack' && m.id === id)
        postHead = id
      }
    } finally { writer.ws.close() }
    // Reconnect and subscribe with `from = lastSeen` — should
    // receive exactly the 3 new revisions, no overlap with what we
    // already saw.
    const second = await connect(serverUrl)
    try {
      const { chain } = await subscribe(second, sk, tag, lastSeen)
      assert.equal(chain.revisions.length, 3)
      assertContinuousChain(chain.revisions, lastSeen)
    } finally { second.ws.close() }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 7: stale-base catch-up under contention
  // ──────────────────────────────────────────────────────────────

  it('a stale-base catch-up is delivered ONLY to the originator, NOT broadcast to peers', async () => {
    // Server: handleSave on stale-base does `send(socket, …)` (not
    // broadcast). Pin: a peer subscribed to the workspace should NOT
    // see another socket's stale-base catch-up; only the originating
    // socket gets the chain.
    const { sk, tag } = await makeKp()
    const racerA = await connect(serverUrl)
    const racerB = await connect(serverUrl)
    const observer = await connect(serverUrl)
    try {
      await subscribe(racerA, sk, tag)
      await subscribe(racerB, sk, tag)
      await subscribe(observer, sk, tag)
      // A wins, B gets stale-base.
      const { msg: msgA, id: idA } = await buildSave(sk, tag, null, 'A-wins')
      const { msg: msgB, id: idB } = await buildSave(sk, tag, null, 'B-loses')
      racerA.ws.send(JSON.stringify(msgA))
      racerB.ws.send(JSON.stringify(msgB))
      const rA = await racerA.recv((m) => m.type === 'workspace-save-ack' || (m.type === 'workspace-state' && m.revisions?.length))
      const rB = await racerB.recv((m) => m.type === 'workspace-save-ack' || (m.type === 'workspace-state' && m.revisions?.length))
      // One ack + one workspace-state (the catch-up).
      const ackHolder = [rA, rB].find((r) => r.type === 'workspace-save-ack')
      const catchHolder = [rA, rB].find((r) => r.type === 'workspace-state')
      assert.ok(ackHolder && catchHolder)
      // Observer receives ONE workspace-state — the broadcast of the
      // winning save. It does NOT see the catch-up sent to the loser.
      const obsBc = await observer.recv((m) => m.type === 'workspace-state' && m.revisions?.length === 1)
      assert.equal(obsBc.revisions[0].id, ackHolder.id, 'observer gets the winner broadcast')
      // No second workspace-state on observer.
      await observer.expectSilent(150)
      void idA; void idB
    } finally { racerA.ws.close(); racerB.ws.close(); observer.ws.close() }
  })

  it('stale-base PUT returns a continuous catch-up chain; racer can rebase + retry', async () => {
    // server/index.ts:402: chainFrom runs AFTER the per-tag lock
    // releases. The catch-up returned to a stale-base loser is
    // server-current at chainFrom-time (possibly fresher than the
    // commitRevision recheck saw). Whatever depth it has, the
    // catch-up MUST be continuous and the loser MUST be able to
    // rebase against its tail and retry successfully.
    //
    // Racer does NOT subscribe to avoid confusing peer broadcasts
    // with its own stale-base catch-up (both are workspace-state
    // frames with the same shape).
    const { sk, tag } = await makeKp()
    const writer = await connect(serverUrl)
    const racer = await connect(serverUrl)
    try {
      await subscribe(writer, sk, tag)
      // Land an initial revision via writer.
      const { msg: seed, id: seedId } = await buildSave(sk, tag, null, 'seed')
      writer.ws.send(JSON.stringify(seed))
      await writer.recv((m) => m.type === 'workspace-save-ack' && m.id === seedId)
      // Racer sends a save claiming base=null — stale.
      const { msg: stale } = await buildSave(sk, tag, null, 'stale-attempt')
      racer.ws.send(JSON.stringify(stale))
      // Racer expects a workspace-state catch-up sent to its own
      // socket (only path: stale-base reply; racer didn't subscribe).
      const catchup = await racer.recv((m) => m.type === 'workspace-state' && m.revisions?.length > 0)
      // Catch-up is continuous from null (or from a keyframe; we
      // accept either start since the chain has no keyframe yet but
      // a future audit could change that).
      const firstBase = catchup.revisions[0].base
      assertContinuousChain(catchup.revisions, firstBase)
      // Catch-up contains the seed revision somewhere.
      assert.ok(catchup.revisions.some((r) => r.id === seedId), 'catch-up includes the seed')
      // Racer rebases against the catch-up tail and retries.
      const newHead = catchup.revisions.at(-1).id
      const { msg: retry, id: retryId } = await buildSave(sk, tag, newHead, 'retry-after-rebase')
      racer.ws.send(JSON.stringify(retry))
      const retryAck = await racer.recv((m) => m.type === 'workspace-save-ack' && m.id === retryId)
      assert.equal(retryAck.id, retryId)
    } finally { racer.ws.close(); writer.ws.close() }
  })

  it('stale-base catch-up after a keyframe is bounded by the keyframe (chainFrom optimization)', async () => {
    // server/db.ts:285-292: chainFrom skips past the most recent
    // keyframe when the `from` cursor is null OR unknown. The
    // keyframe replaces the running baseState, so anything older
    // is redundant — sending it would waste bytes on a O(history)
    // catch-up for a workspace that just needs the most recent
    // keyframe-anchored window.
    //
    // Setup: 5 deltas + 1 keyframe + 5 deltas. A racer with a
    // stale base=null gets a catch-up bounded by the keyframe
    // (length = 6), not the full 11-revision chain.
    const { sk, tag } = await makeKp()
    const writer = await connect(serverUrl)
    const racer = await connect(serverUrl)
    try {
      await subscribe(writer, sk, tag)
      // Land 5 deltas.
      let head = null
      for (let i = 0; i < 5; i++) {
        const { msg, id } = await buildSave(sk, tag, head, `pre-kf-${i}`)
        writer.ws.send(JSON.stringify(msg))
        const ack = await writer.recv((m) => m.type === 'workspace-save-ack' && m.id === id)
        head = ack.id
      }
      // Land a keyframe.
      const { msg: kfMsg, id: kfId } = await buildSave(sk, tag, head, 'keyframe-payload', { keyframe: true })
      writer.ws.send(JSON.stringify(kfMsg))
      await writer.recv((m) => m.type === 'workspace-save-ack' && m.id === kfId)
      head = kfId
      // Land 5 more deltas.
      for (let i = 0; i < 5; i++) {
        const { msg, id } = await buildSave(sk, tag, head, `post-kf-${i}`)
        writer.ws.send(JSON.stringify(msg))
        const ack = await writer.recv((m) => m.type === 'workspace-save-ack' && m.id === id)
        head = ack.id
      }
      // Racer sends a stale-base save (base=null). Catch-up should
      // start from the keyframe, NOT the head's full chain.
      const { msg: stale } = await buildSave(sk, tag, null, 'stale-after-kf')
      racer.ws.send(JSON.stringify(stale))
      const catchup = await racer.recv((m) => m.type === 'workspace-state' && m.revisions?.length > 0)
      // Catch-up should be the keyframe + 5 post-kf deltas = 6 revs.
      // (NOT 11 — the 5 pre-kf revisions are skipped per the
      // chainFrom optimisation.)
      assert.equal(
        catchup.revisions.length, 6,
        `catch-up bounded by keyframe: expected 6 revisions (kf + 5 deltas), got ${catchup.revisions.length}`,
      )
      assert.equal(catchup.revisions[0].id, kfId, 'catch-up starts at the keyframe')
      assert.equal(catchup.revisions[0].keyframe, true)
      // Continuity holds from the keyframe forward.
      assertContinuousChain(catchup.revisions.slice(1), kfId)
    } finally { racer.ws.close(); writer.ws.close() }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 8: save vs subscribe ordering on same socket
  // ──────────────────────────────────────────────────────────────

  it('save BEFORE subscribe on the same socket: save commits but originator is NOT auto-subscribed (audit round-9 H1)', async () => {
    // A captured-and-replayed save frame mustn't attach a socket as
    // a subscriber. Test: a save lands on a socket that never sent
    // subscribe; subsequent peer broadcasts on that workspace must
    // NOT reach this socket.
    const { sk, tag } = await makeKp()
    const writeOnly = await connect(serverUrl)
    const peer = await connect(serverUrl)
    try {
      // Writer never subscribes; just sends a save.
      const { msg: first, id: firstId } = await buildSave(sk, tag, null, 'no-subscribe')
      writeOnly.ws.send(JSON.stringify(first))
      await writeOnly.recv((m) => m.type === 'workspace-save-ack' && m.id === firstId)
      // Now peer subscribes + sends another save.
      await subscribe(peer, sk, tag)
      const { msg: second, id: secondId } = await buildSave(sk, tag, firstId, 'second')
      peer.ws.send(JSON.stringify(second))
      await peer.recv((m) => m.type === 'workspace-save-ack' && m.id === secondId)
      // writeOnly socket must NOT receive the broadcast — it was
      // never added to subscribers[tag].
      await writeOnly.expectSilent(200)
    } finally { writeOnly.ws.close(); peer.ws.close() }
  })

  it('one socket subscribed to many workspaces: a save on workspace-A is broadcast only to subscribers of A', async () => {
    const a = await makeKp(); const b = await makeKp()
    // Multi-tag subscriber.
    const multi = await connect(serverUrl)
    // Workspace-A-only subscriber to confirm A's broadcast still
    // reaches subscribers of A (sanity).
    const aOnly = await connect(serverUrl)
    try {
      await subscribe(multi, a.sk, a.tag)
      await subscribe(multi, b.sk, b.tag)
      await subscribe(aOnly, a.sk, a.tag)
      // Save on tag A from multi.
      const { msg, id } = await buildSave(a.sk, a.tag, null, 'cross-tag-isolation')
      multi.ws.send(JSON.stringify(msg))
      await multi.recv((m) => m.type === 'workspace-save-ack' && m.id === id)
      // aOnly sees the broadcast on tag A.
      const bcOnA = await aOnly.recv((m) => m.type === 'workspace-state' && m.revisions?.length === 1 && m.workspaceTag === a.tag)
      assert.equal(bcOnA.revisions[0].id, id)
      // multi must NOT see a broadcast on tag B for the same content
      // (cross-tag bleed). The originator is excluded from the
      // workspace-A broadcast, so the socket should be silent.
      await multi.expectSilent(200)
    } finally { multi.ws.close(); aOnly.ws.close() }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 9: heartbeat ping/pong under load
  // ──────────────────────────────────────────────────────────────

  it('pings interspersed with rapid saves all get pongs without dropping any', async () => {
    // The production client paces saves via ack (one in-flight at
    // a time). Mirror that here so saves on the same socket don't
    // race the async verify queue and turn into stale-base
    // catch-ups (which would change the expected reply types).
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    try {
      await subscribe(c, sk, tag)
      let head = null
      let pongs = 0
      let acks = 0
      // Send ping + save + drain each iteration; saves are paced
      // by the ack await.
      for (let i = 0; i < 10; i++) {
        c.ws.send(JSON.stringify({ type: 'ping' }))
        const { msg } = await buildSave(sk, tag, head, `interleave-${i}`)
        c.ws.send(JSON.stringify(msg))
        // Drain pong + ack (order is arbitrary).
        for (let j = 0; j < 2; j++) {
          const reply = await c.recv((m) => m.type === 'pong' || m.type === 'workspace-save-ack')
          if (reply.type === 'pong') pongs++
          else { acks++; head = reply.id }
        }
      }
      assert.equal(pongs, 10)
      assert.equal(acks, 10)
    } finally { c.ws.close() }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 10: production hardening + suspected gaps
  // ──────────────────────────────────────────────────────────────
  //
  // An earlier draft had four it.todo cases here. An independent
  // review showed three were false positives — the production
  // code already handles the scenarios I'd documented as gaps:
  //
  //   - Forged `keyframe: 1` integer: already tested at
  //     tests/sync-server.test.js:687-718 as a SECURITY DEFENSE
  //     (silent drop on sig-canonical mismatch is intentional;
  //     a typed error would weaken the chain-poisoning defense).
  //   - Cross-workspace `from` id: by-design keyframe fallback per
  //     server/index.ts:583-588. The schema has no per-workspace
  //     id index by design; the comment is explicit that "client
  //     lying about `from` just means a smaller catch-up".
  //   - Per-socket in-flight cap: already implemented at
  //     server/index.ts:210 (`MAX_INFLIGHT_PER_SOCKET = 64`) and
  //     enforced at line 767 (silent drop above cap, with `ping`
  //     exempt so the heartbeat keeps responding under shed).
  //
  // The remaining genuine gap is the typed stale-base error frame.
  // Two positive tests pinning the existing protections replace
  // the removed todos so a regression in the documented defences
  // would surface here.

  it.todo('stale-base catch-up chain should carry workspace-save-error for the loser, not just workspace-state (clearer error signal)', async () => {
    // OBSERVATION: today, when a save loses the lock race, the
    // server emits a `workspace-state` with the current chain
    // (server/index.ts:502-512). The client interprets that as a
    // catch-up. But the LOSER doesn't get an explicit "your save
    // failed" signal — they get the catch-up and must infer their
    // save was rejected (their claimed `base` no longer matches
    // the chain head).
    //
    // For most clients this is fine because they're driving an
    // optimistic-concurrency loop. But for a debugging surface, a
    // typed error frame would be clearer. Specifically: when the
    // server returns `kind: 'stale-base'` from `commitRevision`, the
    // wire response is a `workspace-state` with the catch-up. There
    // is no field that says "your save id X was rejected" — the
    // client has to compute that from the absence of an `ack`.
    //
    // SHOULD-BE: a `workspace-save-error` frame with reason
    // 'stale-base' AND the catch-up chain. Today only the catch-up
    // is sent.
    //
    // IMPACT: medium — clients have to await both the ack AND any
    // workspace-state and disambiguate. A typed error frame would
    // make the protocol self-describing and reduce client-side
    // bookkeeping. Not a data-loss bug; this is a usability-todo.
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl)
    const c2 = await connect(serverUrl)
    try {
      await subscribe(c1, sk, tag); await subscribe(c2, sk, tag)
      const { msg: m1, id: id1 } = await buildSave(sk, tag, null, 'A')
      const { msg: m2, id: id2 } = await buildSave(sk, tag, null, 'B')
      c1.ws.send(JSON.stringify(m1))
      c2.ws.send(JSON.stringify(m2))
      const r1 = await c1.recv((m) => m.type === 'workspace-save-ack' || m.type === 'workspace-state' || m.type === 'workspace-save-error')
      const r2 = await c2.recv((m) => m.type === 'workspace-save-ack' || m.type === 'workspace-state' || m.type === 'workspace-save-error')
      const errs = [r1, r2].filter((m) => m.type === 'workspace-save-error')
      // SHOULD BE: one explicit save-error for the loser.
      assert.equal(errs.length, 1, 'the loser should receive an explicit workspace-save-error frame')
      assert.equal(errs[0].reason, 'stale-base')
      void id1; void id2
    } finally { c1.ws.close(); c2.ws.close() }
  })

  it('subscribe with `from = id-from-a-different-workspace` falls back to the target workspace\'s keyframe path (by-design, not an error)', async () => {
    // server/index.ts:583-588: "Client lying about `from` just means
    // they get a smaller catch-up — their subsequent saves will
    // reveal stale state on the usual base-mismatch path."
    //
    // The `seqOfId` query (server/db.ts:225-228) is keyed on
    // (workspace_tag, id). An id from another workspace doesn't
    // match for this workspace; the cursor falls through to the
    // keyframe-or-full-chain path. The client gets the workspace
    // they actually authenticated as, not their (possibly stale)
    // cross-workspace cursor. Pin this as correct by-design
    // behaviour so a future refactor that "tightens" it (turning
    // it into a typed error) would fail this test and prompt a
    // protocol-design discussion.
    const a = await makeKp(); const b = await makeKp()
    const writerA = await connect(serverUrl)
    try {
      await subscribe(writerA, a.sk, a.tag)
      // Land a revision in workspace A.
      const { msg, id: idInA } = await buildSave(a.sk, a.tag, null, 'in-workspace-A')
      writerA.ws.send(JSON.stringify(msg))
      await writerA.recv((m) => m.type === 'workspace-save-ack' && m.id === idInA)
      // Now subscribe to workspace B using A's id as the `from` cursor.
      // The signature is for B (correct workspace) — the `from` is
      // semantically wrong but cryptographically valid.
      const subscriber = await connect(serverUrl)
      try {
        const sig = await signSubscribe(b.sk, b.tag, idInA, subscriber.connectionNonce)
        subscriber.ws.send(JSON.stringify({
          type: 'workspace-subscribe', workspaceTag: b.tag, from: idInA, signature: sig,
        }))
        // The subscriber gets B's `workspace-subscribed` + B's chain
        // (empty, since nothing was saved in B). NOT a typed error.
        const ack = await subscriber.recv((m) => m.type === 'workspace-subscribed' && m.workspaceTag === b.tag)
        assert.equal(ack.workspaceTag, b.tag)
        const chain = await subscriber.recv((m) => m.type === 'workspace-state' && m.workspaceTag === b.tag)
        assert.deepEqual(chain.revisions, [], 'cross-workspace from id falls back to B\'s chain (empty)')
      } finally { subscriber.ws.close() }
    } finally { writerA.ws.close() }
  })

  it('per-socket in-flight cap exists (server/index.ts:210); ping responds even under flood (cap is per-CONCURRENT, not per-total)', async () => {
    // server/index.ts:210, 766-771: per-socket cap on CONCURRENT
    // async-handler count (MAX_INFLIGHT_PER_SOCKET = 64). Above
    // the cap, non-ping frames are silently dropped (consistent
    // with bad-shape paths). `ping` is explicitly exempt at line
    // 767 so the heartbeat keeps responding under shed —
    // otherwise a peer that genuinely needs to drain would get
    // its socket closed by the heartbeat-timeout path.
    //
    // The cap bounds CONCURRENT in-flight, not total processed
    // over time. As soon as handlers complete, new frames are
    // accepted again, so a flood of N >> 64 frames will mostly
    // succeed (each finishing handler makes room for the next).
    // The only observable invariant from a black-box client is:
    //   - some frames may be dropped at peak in-flight,
    //   - ping STILL responds even during the flood,
    //   - the socket isn't terminated (which would happen via
    //     the MAX_BUFFERED_BYTES path, not this cap).
    //
    // Pinned here is the ping-survives-flood property — the cap's
    // job is to bound memory while keeping the heartbeat alive.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    try {
      await subscribe(c, sk, tag)
      const N = 200 // well above any plausible burst-cap headroom
      const saves = []
      for (let i = 0; i < N; i++) {
        saves.push(await buildSave(sk, tag, null, `flood-${i}`))
      }
      // Fire all N saves in one tick.
      for (let i = 0; i < N; i++) c.ws.send(JSON.stringify(saves[i].msg))
      // Send a ping IMMEDIATELY after the burst, before any acks
      // have drained — the heartbeat must still respond even with
      // a backlog of N - 1 save frames behind it on the wire.
      c.ws.send(JSON.stringify({ type: 'ping' }))
      const pong = await c.recv((m) => m.type === 'pong', 2_000)
      assert.equal(pong.type, 'pong', 'ping STILL responds even under flood (heartbeat exempt from in-flight cap)')
      // Drain remaining replies (could be acks, stale-base
      // catch-ups, or pongs from later pings — we don't assert
      // an exact count since the cap is on concurrent, not total).
      const deadline = Date.now() + 1_500
      while (Date.now() < deadline) {
        const r = await c.recv((m) =>
          m.type === 'workspace-save-ack' ||
          m.type === 'workspace-state' ||
          m.type === 'pong',
          200,
        ).catch(() => null)
        if (!r) break
      }
      // The socket is still alive after the flood (not terminated
      // by the buffered-bytes cap, which is at 16 MiB — way above
      // 200 small save frames).
      assert.equal(c.ws.readyState, c.ws.OPEN, 'socket survives the flood')
    } finally { c.ws.close() }
  })
})
