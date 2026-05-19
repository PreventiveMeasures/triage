// End-to-end protocol tests for the triage-sync relay. Boots the
// real server in a child process against a temp DB; drives it from
// `ws` clients with real Ed25519 signatures (WebCrypto) and
// synthetic ciphertext (the server treats nonce/ciphertext as
// opaque, so encryption isn't part of these tests — sync-crypto.js
// has its own coverage).
//
// Each test uses a fresh keypair (= fresh workspaceTag) so the
// server's per-tag chain is isolated even though the server
// instance is shared across the suite.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { encodeUtf8 } from '../common/utf8.js'
import { bootServer } from './_helpers.js'

// Native WebSocket is the same constructor the browser uses, so the
// tests exercise the exact API surface the production client lives
// against. The `ws` package's WebSocket is EventEmitter-shaped and
// drifts slightly (`.on(...)` vs `addEventListener`, frame buffers vs
// `event.data`), so we keep it strictly to the server side.

const SAVE_DOMAIN = 'deepview-triage-sync.v1.save'
const SUBSCRIBE_DOMAIN = 'deepview-triage-sync.v1.subscribe'

function b64url(bytes) { return Buffer.from(bytes).toString('base64url') }

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

// One persistent WS message listener per connection + a queue.
// Tests pull matches via `recv(predicate)`; messages that arrive
// before the matching call lands in the queue rather than being
// dropped (the duplicate-save ack on a fast CI server, for
// instance, can come in between two recv calls — under the old
// per-call-listener helper that message would vanish).
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
          rej(new Error(`recv: timeout (queue=${queue.length})`))
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
      // Drain the per-socket challenge frame the server emits on
      // connect (round-9 H2). The nonce is needed to sign every
      // subscribe; expose it on the returned object so test helpers
      // (`subscribe`, ad-hoc subscribe builders) can grab it. Drain
      // BEFORE resolving so per-test queues start clean — the
      // `expectSilent` helper would otherwise spuriously fail when
      // the challenge frame lands during its measurement window.
      recv((m) => m.type === 'challenge', 5_000).then((challenge) => {
        resolve({ ws, recv, expectSilent, connectionNonce: challenge.nonce })
        return null
      }).catch((err) => reject(err))
    }, { once: true })
    ws.addEventListener('error', (event) => reject(event.error ?? new Error('websocket error')), { once: true })
  })
}

// Subscribe + drain the initial workspace-subscribed +
// workspace-state pair. `from` is the last revision id the client
// claims to have applied (null on first connect).
async function subscribe(c, sk, tag, from = null) {
  // The per-connection challenge nonce comes off the `c.connectionNonce`
  // field set by `connect()`. Round-9 H2 binds every subscribe sig
  // to this nonce so the server can reject cross-connection replays.
  const sig = await signSubscribe(sk, tag, from, c.connectionNonce)
  c.ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from, signature: sig }))
  const ack = await c.recv((m) => m.type === 'workspace-subscribed' && m.workspaceTag === tag)
  const chain = await c.recv((m) => m.type === 'workspace-state' && m.workspaceTag === tag)
  return { ack, chain }
}

describe('triage-sync server', () => {
  let server, serverUrl

  before(async () => {
    server = await bootServer()
    serverUrl = server.serverUrl
  })

  after(async () => {
    if (server) await server.teardown()
  })

  it('subscribe responds with workspace-subscribed + empty chain for a fresh tag', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    const { ack, chain } = await subscribe(c, sk, tag)
    assert.equal(ack.workspaceTag, tag)
    assert.deepEqual(chain.revisions, [])
    c.ws.close()
  })

  it('save returns a content-addressed id and grows the chain', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribe(c, sk, tag)
    const { msg, id } = await buildSave(sk, tag, null, 'hello-1')
    c.ws.send(JSON.stringify(msg))
    const ack = await c.recv((m) => m.type === 'workspace-save-ack')
    assert.equal(ack.workspaceTag, tag)
    assert.equal(ack.base, null)
    assert.equal(ack.id, id, 'server-derived id matches client SHA-256(canonical bytes)')
    c.ws.close()
  })

  it('broadcasts a save to other subscribers without echoing to the sender', async () => {
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl)
    const c2 = await connect(serverUrl)
    await subscribe(c1, sk, tag)
    await subscribe(c2, sk, tag)
    const { msg, id } = await buildSave(sk, tag, null, 'broadcast-payload')
    c1.ws.send(JSON.stringify(msg))
    const [ack, state] = await Promise.all([
      c1.recv((m) => m.type === 'workspace-save-ack'),
      c2.recv((m) => m.type === 'workspace-state' && m.revisions.length > 0),
    ])
    assert.equal(ack.id, id)
    assert.equal(state.revisions.length, 1)
    assert.equal(state.revisions[0].id, id)
    assert.equal(state.revisions[0].base, null)
    // Sender doesn't see its own save echoed back.
    await c1.expectSilent(150)
    c1.ws.close(); c2.ws.close()
  })

  it('broadcast stringify-once: every subscriber receives byte-equal frame', async () => {
    // Pins the `sendRaw(socket, payload)` path in server/index.ts's
    // `broadcast()`: stringify ONCE, send the same string N times.
    // A regression that calls `send(s, msg)` per subscriber would
    // still parse-equal but could differ in key order or whitespace
    // under a future V8 change; a regression that re-serialises
    // would have a meaningful CPU + GC cost on a large catch-up
    // broadcast. Direct byte equality is the cheap pin.
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl)
    // 3 raw subscribers — attach the queue listener IMMEDIATELY after
    // `new WebSocket()` (same pattern as `connect()` above), since
    // the challenge frame can arrive concurrently with 'open' and a
    // listener attached after `await open` may miss it.
    const subs = [new WebSocket(serverUrl), new WebSocket(serverUrl), new WebSocket(serverUrl)]
    const queues = subs.map((w) => {
      const q = []
      w.addEventListener('message', (event) => { q.push(event.data) })
      return q
    })
    await Promise.all(subs.map((w) => new Promise((res, rej) => {
      w.addEventListener('open', res, { once: true })
      w.addEventListener('error', (e) => rej(e.error ?? new Error('ws error')), { once: true })
    })))
    async function awaitFrame(qi, predicate, timeoutMs = 5_000) {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        for (let i = 0; i < queues[qi].length; i++) {
          const data = queues[qi][i]
          if (predicate(JSON.parse(data))) { queues[qi].splice(i, 1); return data }
        }
        await new Promise((r) => { setTimeout(r, 5) })
      }
      throw new Error(`awaitFrame[${qi}] timeout`)
    }
    // Grab each subscriber's per-connection challenge nonce.
    const nonces = await Promise.all(queues.map(async (_, i) => {
      const data = await awaitFrame(i, (m) => m.type === 'challenge')
      return JSON.parse(data).nonce
    }))
    for (let i = 0; i < subs.length; i++) {
      const sig = await signSubscribe(sk, tag, null, nonces[i])
      subs[i].send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: sig }))
    }
    // Drive a save on c1 (a 4th connection, not in `subs`).
    await subscribe(c1, sk, tag)
    const { msg } = await buildSave(sk, tag, null, 'broadcast-byte-equal')
    c1.ws.send(JSON.stringify(msg))
    // Wait for the non-empty workspace-state broadcast on each
    // subscriber. The initial empty `workspace-state` after their
    // own subscribe is filtered out by `revisions.length > 0`.
    const [aData, bData, cData] = await Promise.all([0, 1, 2].map(
      (i) => awaitFrame(i, (m) => m.type === 'workspace-state' && m.revisions && m.revisions.length > 0),
    ))
    // The critical assertion: byte-equal across all three subscribers.
    assert.strictEqual(aData, bData, 'subscriber A and B receive byte-equal broadcast')
    assert.strictEqual(bData, cData, 'subscriber B and C receive byte-equal broadcast')
    c1.ws.close(); subs.forEach((w) => w.close())
  })

  it('stale base triggers a catch-up chain + typed save-error, not an ack', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribe(c, sk, tag)
    const first = await buildSave(sk, tag, null, 'first')
    c.ws.send(JSON.stringify(first.msg))
    await c.recv((m) => m.type === 'workspace-save-ack')
    // Now send a save built on the WRONG base (null instead of first.id).
    const stale = await buildSave(sk, tag, null, 'second-stale')
    c.ws.send(JSON.stringify(stale.msg))
    const catchup = await c.recv((m) => m.type === 'workspace-state')
    assert.equal(catchup.revisions.length, 1)
    assert.equal(catchup.revisions[0].id, first.id)
    // The catch-up is followed by a typed `workspace-save-error
    // { reason: 'stale-base' }` so a debug surface / explicit-
    // rejection-aware client gets the signal. The client's
    // handleChain clears `session.pending` BEFORE the error
    // frame is processed, so handleSaveError early-returns and
    // the session does NOT enter error state — the typed frame
    // is purely protocol clarity. Sibling test in
    // sync-server-races.test.js pins both frames + their order.
    const err = await c.recv((m) => m.type === 'workspace-save-error' && m.reason === 'stale-base')
    assert.equal(err.workspaceTag, tag)
    assert.equal(err.base, null, 'echoes the stale base')
    // No ack should follow.
    await c.expectSilent(150)
    c.ws.close()
  })

  it('idempotent retransmit returns the same id without an extra chain entry', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribe(c, sk, tag)
    const save = await buildSave(sk, tag, null, 'idempotent')
    c.ws.send(JSON.stringify(save.msg))
    const ack1 = await c.recv((m) => m.type === 'workspace-save-ack')
    c.ws.send(JSON.stringify(save.msg))
    const ack2 = await c.recv((m) => m.type === 'workspace-save-ack')
    assert.equal(ack1.id, save.id)
    assert.equal(ack2.id, save.id)
    // Verify chain has exactly one entry by re-subscribing on a
    // fresh socket with `from = null`.
    const c2 = await connect(serverUrl)
    const { chain } = await subscribe(c2, sk, tag)
    assert.equal(chain.revisions.length, 1)
    assert.equal(chain.revisions[0].id, save.id)
    c.ws.close(); c2.ws.close()
  })

  it('subscribe with `from = previous-id` returns only newer revisions', async () => {
    const { sk, tag } = await makeKp()
    const writer = await connect(serverUrl)
    await subscribe(writer, sk, tag)
    const a = await buildSave(sk, tag, null, 'A')
    writer.ws.send(JSON.stringify(a.msg))
    await writer.recv((m) => m.type === 'workspace-save-ack')
    const b = await buildSave(sk, tag, a.id, 'B')
    writer.ws.send(JSON.stringify(b.msg))
    await writer.recv((m) => m.type === 'workspace-save-ack')

    const reader = await connect(serverUrl)
    const { chain } = await subscribe(reader, sk, tag, a.id)
    assert.equal(chain.revisions.length, 1, 'only the post-A revision is sent')
    assert.equal(chain.revisions[0].id, b.id)
    writer.ws.close(); reader.ws.close()
  })

  it('drops a save with a bad signature silently', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribe(c, sk, tag)
    const save = await buildSave(sk, tag, null, 'will-fail')
    // Valid length but garbage bytes — passes the length precheck
    // but Ed25519 verify rejects.
    save.msg.signature = b64url(new Uint8Array(64))
    c.ws.send(JSON.stringify(save.msg))
    await c.expectSilent(200)
    c.ws.close()
  })

  it('drops a save signed by the wrong keypair (foreign tag in the save)', async () => {
    // Attacker holds their own keypair and tries to forge a save
    // under the victim's workspaceTag — the signature is over the
    // victim's tag, so verification against the victim's pubkey
    // fails.
    const victim = await makeKp()
    const attacker = await makeKp()
    const c = await connect(serverUrl)
    await subscribe(c, victim.sk, victim.tag)
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)))
    const ciphertext = b64url(new TextEncoder().encode('forged'))
    // Sign with the attacker's key but claim the victim's tag.
    const { signature } = await signSave(attacker.sk, { tag: victim.tag, base: null, nonce, ciphertext })
    c.ws.send(JSON.stringify({
      type: 'workspace-save', workspaceTag: victim.tag, base: null, nonce, ciphertext, signature,
    }))
    await c.expectSilent(200)
    c.ws.close()
  })

  it('drops a save whose nonce contains a newline (canonical-collision guard)', async () => {
    // canonicalSave newline-joins fields. Without an alphabet gate,
    // `nonce = "AAA\nBBB"` + `ciphertext = "CCC"` produces the same
    // canonical bytes (and thus the same revision id + signature) as
    // `nonce = "AAA"` + `ciphertext = "BBB\nCCC"`. Two distinct
    // stored revisions could share the same id; the duplicate-id
    // dedup path would accept whichever landed first and silently
    // desync the other client's local state. The gate restricts to
    // base64-or-base64url alphabet (no newlines).
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribe(c, sk, tag)
    // Structurally valid frame whose nonce has a \n. Server drops
    // silently at the wire-gate BEFORE the signature check (so the
    // sig doesn't need to validate).
    const newlineNonce = 'AAA\nBBB'
    c.ws.send(JSON.stringify({
      type: 'workspace-save', workspaceTag: tag, base: null,
      nonce: newlineNonce, ciphertext: b64url(new Uint8Array(16)),
      signature: b64url(new Uint8Array(64)),
    }))
    await c.expectSilent(200)
    c.ws.close()
  })

  it('drops a save with `+/=` in workspaceTag (base64url-no-padding gate)', async () => {
    // Audit round-9: workspaceTag is shared between triage-sync and
    // objstore. objstore's TAG_RE accepts only base64url-no-padding
    // (`[\w-]`). The save gate was accepting standard-base64 chars
    // (`+/=`) too — a buggy or hostile client emitting a tag like
    // `"AAA+BBB"` would pass the save gate, store its data under
    // that exact string, but then be unable to use objstore for the
    // same workspace (TAG_RE rejects `+`). Server now drops at the
    // wire gate before the sig check, forcing clients onto the
    // documented base64url-no-padding shape.
    const c = await connect(serverUrl)
    c.ws.send(JSON.stringify({
      type: 'workspace-save', workspaceTag: 'AAA+BBB', base: null,
      nonce: b64url(new Uint8Array(12)), ciphertext: b64url(new Uint8Array(16)),
      signature: b64url(new Uint8Array(64)),
    }))
    await c.expectSilent(200)
    c.ws.close()
  })

  it('drops an UNSIGNED oversize save silently (sig check runs before the size cap)', async () => {
    // The size check sits AFTER sig verify so the explicit error
    // response doesn't leak the cap to unauthenticated probes. A
    // bad-sig oversize frame is a probe / DoS attempt — silent drop.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribe(c, sk, tag)
    const huge = 'A'.repeat(3 * 1024 * 1024)
    c.ws.send(JSON.stringify({
      type: 'workspace-save', workspaceTag: tag, base: null,
      nonce: b64url(new Uint8Array(12)), ciphertext: huge,
      signature: b64url(new Uint8Array(64)),
    }))
    await c.expectSilent(500)
    c.ws.close()
  })

  it('rejects a SIGNED oversize save with workspace-save-error { reason: "too-large" }', async () => {
    // Legit signer path: the client has the seed and produced a
    // valid signature over an oversize ciphertext. Without an
    // explicit error response the client's `pending` slot stalls
    // forever (no ack, no rebase) and the UI looks online while
    // edits silently fail. Server emits the error post-sig so the
    // client can clear pending + surface the failure to the user.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribe(c, sk, tag)
    // 3 MiB ciphertext, well past MAX_CIPHERTEXT_LEN (2 MiB) but
    // under the WSS maxPayload (4 MiB) so the frame reaches the
    // handler.
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)))
    const ciphertext = 'A'.repeat(3 * 1024 * 1024)
    const { signature } = await signSave(sk, { tag, base: null, keyframe: false, nonce, ciphertext })
    c.ws.send(JSON.stringify({
      type: 'workspace-save', workspaceTag: tag, base: null,
      nonce, ciphertext, signature,
    }))
    const err = await c.recv((m) => m.type === 'workspace-save-error' && m.workspaceTag === tag)
    assert.equal(err.reason, 'too-large')
    assert.equal(err.base, null)
    c.ws.close()
  })

  it('drops a save with a non-string nonce / ciphertext silently', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribe(c, sk, tag)
    // Bad shape: ciphertext is a number. encodeUtf8 inside the
    // server's canonical-payload path throws, which the verify
    // wrapper turns into "bad sig" → silent drop.
    c.ws.send(JSON.stringify({
      type: 'workspace-save', workspaceTag: tag, base: null,
      nonce: b64url(new Uint8Array(12)), ciphertext: 42, signature: b64url(new Uint8Array(64)),
    }))
    await c.expectSilent(200)
    c.ws.close()
  })

  it('drops a subscribe with a bad signature silently', async () => {
    const { tag } = await makeKp()
    const c = await connect(serverUrl)
    // Right length, garbage bytes — verify rejects.
    const signature = b64url(new Uint8Array(64))
    c.ws.send(JSON.stringify({
      type: 'workspace-subscribe', workspaceTag: tag, from: null, signature,
    }))
    await c.expectSilent(200)
    c.ws.close()
  })

  it('replay of a captured subscribe from a different socket is rejected (audit round-9 H2)', async () => {
    // Round-9 H2: subscribe canonical now includes the per-connection
    // challenge nonce the server emitted on socket open. A captured
    // subscribe frame replayed from a fresh connection (different
    // nonce) fails verify and the replayer never attaches as a peer.
    const { sk, tag } = await makeKp()
    const a = await connect(serverUrl)
    const replayer = await connect(serverUrl)
    // A subscribes legitimately under A's nonce.
    const aSig = await signSubscribe(sk, tag, null, a.connectionNonce)
    const aFrame = { type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: aSig }
    a.ws.send(JSON.stringify(aFrame))
    await a.recv((m) => m.type === 'workspace-subscribed')
    await a.recv((m) => m.type === 'workspace-state')
    // Replayer captures A's frame off the wire and re-sends it on
    // its OWN socket. The server checks the sig against THIS
    // socket's challenge nonce — different from A's — verify fails,
    // and the replayer's socket never enters the subscribers set.
    replayer.ws.send(JSON.stringify(aFrame))
    await replayer.expectSilent(200)
    a.ws.close(); replayer.ws.close()
  })

  it('replayer does NOT receive subsequent broadcasts (round-9 H2)', async () => {
    // Same scenario as above, but verifies the broadcast-set
    // membership directly: A's save broadcasts to all subscribers;
    // the replayer (which the server rejected) doesn't get it.
    const { sk, tag } = await makeKp()
    const a = await connect(serverUrl)
    const subscriber = await connect(serverUrl)
    const replayer = await connect(serverUrl)
    await subscribe(subscriber, sk, tag) // legitimate witness
    const aSig = await signSubscribe(sk, tag, null, a.connectionNonce)
    const aFrame = { type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: aSig }
    a.ws.send(JSON.stringify(aFrame))
    await a.recv((m) => m.type === 'workspace-subscribed')
    await a.recv((m) => m.type === 'workspace-state')
    // Replayer attempts to attach via captured A frame.
    replayer.ws.send(JSON.stringify(aFrame))
    await replayer.expectSilent(150)
    // A pushes a save. Subscriber receives broadcast; replayer doesn't.
    const save = await buildSave(sk, tag, null, 'after-replay')
    a.ws.send(JSON.stringify(save.msg))
    await subscriber.recv((m) => m.type === 'workspace-state' && m.revisions.length > 0)
    await replayer.expectSilent(200)
    a.ws.close(); subscriber.ws.close(); replayer.ws.close()
  })

  it('drops a save with a non-string non-null base silently', async () => {
    // `base` is `string | null` per the wire contract. The server's
    // signed-canonical path coerces with `String(base)` while the
    // storage path uses the raw value — a non-string non-null base
    // from a legit signer (here we forge the canonical ourselves to
    // make the sig pass) would canonicalise to one shape but fail
    // the SQLite STRICT TEXT insert. The wire-level type check now
    // rejects up front so the symptom is silent-drop, not a swallowed
    // handler exception.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribe(c, sk, tag)
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)))
    const ciphertext = b64url(new TextEncoder().encode('payload'))
    // Sign a canonical that uses `String({})` → '[object Object]'
    // so a buggy peer couldn't have its signed canonical accepted by
    // verify (no use here — we want to confirm even a valid sig is
    // dropped at the wire gate before verify runs).
    const canon = encodeUtf8([
      SAVE_DOMAIN, tag, '[object Object]', '', nonce, ciphertext,
    ].join('\n'))
    const sig = b64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, canon)))
    c.ws.send(JSON.stringify({
      type: 'workspace-save', workspaceTag: tag, base: {}, nonce, ciphertext, signature: sig,
    }))
    await c.expectSilent(200)
    c.ws.close()
  })

  it('drops a subscribe with a non-string non-null from silently', async () => {
    // Same `string | null` contract as `base`. The signed canonical
    // uses `String(from)` but the chain-lookup path treats every
    // non-string as null, so a legit signer sending `from: { … }`
    // would silently take the keyframe-fallback path. The wire-level
    // type check now rejects up front.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    const canon = encodeUtf8([SUBSCRIBE_DOMAIN, tag, '[object Object]'].join('\n'))
    const sig = b64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, canon)))
    c.ws.send(JSON.stringify({
      type: 'workspace-subscribe', workspaceTag: tag, from: {}, signature: sig,
    }))
    await c.expectSilent(200)
    c.ws.close()
  })

  it('persists revisions across reconnects (same DB, same tag, fresh socket)', async () => {
    const { sk, tag } = await makeKp()
    const writer = await connect(serverUrl)
    await subscribe(writer, sk, tag)
    const save = await buildSave(sk, tag, null, 'persisted')
    writer.ws.send(JSON.stringify(save.msg))
    await writer.recv((m) => m.type === 'workspace-save-ack')
    writer.ws.close()

    // Brand-new socket; same DB. Subscribe with from=null → the
    // previously-acked revision must reappear in the chain.
    const reader = await connect(serverUrl)
    const { chain } = await subscribe(reader, sk, tag)
    assert.equal(chain.revisions.length, 1)
    assert.equal(chain.revisions[0].id, save.id)
    reader.ws.close()
  })

  it('responds to a ping with a pong (heartbeat)', async () => {
    const c = await connect(serverUrl)
    c.ws.send(JSON.stringify({ type: 'ping' }))
    const pong = await c.recv((m) => m.type === 'pong')
    assert.equal(pong.type, 'pong')
    c.ws.close()
  })

  it('keyframe save round-trips with the keyframe flag preserved on broadcast', async () => {
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl)
    const c2 = await connect(serverUrl)
    await subscribe(c1, sk, tag)
    await subscribe(c2, sk, tag)
    const save = await buildSave(sk, tag, null, 'kf-payload', { keyframe: true })
    c1.ws.send(JSON.stringify(save.msg))
    const [ack, state] = await Promise.all([
      c1.recv((m) => m.type === 'workspace-save-ack'),
      c2.recv((m) => m.type === 'workspace-state' && m.revisions.length > 0),
    ])
    assert.equal(ack.id, save.id)
    assert.equal(state.revisions.length, 1)
    assert.equal(state.revisions[0].id, save.id)
    // Wire flag is a STRICT boolean — matches the canonical-payload
    // contract which uses `=== true`. Server stores 1 in SQLite but
    // normalises on send so peers don't depend on `Boolean()`
    // coercion at receive time.
    assert.strictEqual(state.revisions[0].keyframe, true, 'broadcast keyframe is strict true')
    c1.ws.close(); c2.ws.close()
  })

  it('chain catch-up emits keyframe as a strict boolean', async () => {
    // The chain-fetch path reads SQLite which stores keyframe as
    // INTEGER (0/1). The server normalises every wire-out path
    // through `chainForWire` so receivers see a boolean regardless
    // of whether the revision came from a fresh broadcast or a
    // catch-up read. Pin both shapes.
    const { sk, tag } = await makeKp()
    const a = await connect(serverUrl)
    await subscribe(a, sk, tag)
    const kf = await buildSave(sk, tag, null, 'kf', { keyframe: true })
    a.ws.send(JSON.stringify(kf.msg))
    await a.recv((m) => m.type === 'workspace-save-ack')
    const followup = await buildSave(sk, tag, kf.id, 'next', { keyframe: false })
    a.ws.send(JSON.stringify(followup.msg))
    await a.recv((m) => m.type === 'workspace-save-ack')
    // Fresh subscriber forces the chain-from-DB read path.
    const b = await connect(serverUrl)
    const subSig = b64url(new Uint8Array(
      await crypto.subtle.sign({ name: 'Ed25519' }, sk,
        encodeUtf8([SUBSCRIBE_DOMAIN, tag, '', b.connectionNonce].join('\n'))),
    ))
    b.ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: subSig }))
    await b.recv((m) => m.type === 'workspace-subscribed')
    const chain = await b.recv((m) => m.type === 'workspace-state' && m.revisions.length > 0)
    const kfRev = chain.revisions.find((r) => r.id === kf.id)
    const followupRev = chain.revisions.find((r) => r.id === followup.id)
    assert.strictEqual(kfRev.keyframe, true, 'chain keyframe is strict true')
    assert.strictEqual(followupRev.keyframe, false, 'chain non-keyframe is strict false')
    a.ws.close(); b.ws.close()
  })

  it('drops a save with a non-boolean truthy keyframe flag (signed under truthy canonical)', async () => {
    // Regression for the asymmetric-normalization bug: server
    // `canonicalSave` and `handleSave` storage must agree on what
    // counts as a keyframe. STRICT (`=== true`) on both sides
    // catches a malformed peer that sets `keyframe: 1` (number)
    // and signs over a TRUTHY canonical (so they hash `'1'`). The
    // server's strict canonical hashes `''` for that input — sig
    // verify fails, the save is dropped at the gate. Without the
    // fix, the row would land in storage with `keyframe = 0`,
    // broadcast as `keyframe: 0`, and become an unreadable chain
    // entry that breaks subsequent saves' continuity for peers.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribe(c, sk, tag)
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)))
    const ciphertext = b64url(new TextEncoder().encode('payload'))
    // Sign over the OLD truthy canonical: `keyframe ? '1' : ''`
    // with `keyframe = 1` (truthy non-bool) → `'1'`. The server
    // now hashes `''` instead, so this should fail.
    const truthyCanonical = encodeUtf8([
      SAVE_DOMAIN, tag, '', '1', nonce, ciphertext,
    ].join('\n'))
    const sig = b64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, truthyCanonical)))
    c.ws.send(JSON.stringify({
      type: 'workspace-save', workspaceTag: tag, base: null,
      keyframe: 1, nonce, ciphertext, signature: sig,
    }))
    await c.expectSilent(200)
    c.ws.close()
  })

  it('drops a save where the wire keyframe flag does not match the signed flag', async () => {
    // Sign as a non-keyframe save, then add `keyframe: true` to
    // the wire message. The server canonicalises with the wire
    // value (true) but sig was computed for false → verify fails,
    // silent drop. This is the security-relevant invariant: the
    // server can't promote a normal save to a keyframe (or vice
    // versa) without invalidating the signature.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribe(c, sk, tag)
    const save = await buildSave(sk, tag, null, 'oops', { keyframe: false })
    save.msg.keyframe = true
    c.ws.send(JSON.stringify(save.msg))
    await c.expectSilent(200)
    c.ws.close()
  })

  it('subscribe with from=null returns chain from the most recent keyframe', async () => {
    const { sk, tag } = await makeKp()
    const writer = await connect(serverUrl)
    await subscribe(writer, sk, tag)
    // Build a chain: rev_A (regular), kf (keyframe), rev_B (regular).
    const a = await buildSave(sk, tag, null, 'A')
    writer.ws.send(JSON.stringify(a.msg))
    await writer.recv((m) => m.type === 'workspace-save-ack')
    const kf = await buildSave(sk, tag, a.id, 'kf', { keyframe: true })
    writer.ws.send(JSON.stringify(kf.msg))
    await writer.recv((m) => m.type === 'workspace-save-ack')
    const b = await buildSave(sk, tag, kf.id, 'B')
    writer.ws.send(JSON.stringify(b.msg))
    await writer.recv((m) => m.type === 'workspace-save-ack')

    // Fresh subscriber with from=null should receive the chain
    // starting at the keyframe — rev_A is excluded.
    const reader = await connect(serverUrl)
    const { chain } = await subscribe(reader, sk, tag)
    assert.equal(chain.revisions.length, 2, 'chain trimmed to keyframe + everything after')
    assert.equal(chain.revisions[0].id, kf.id)
    assert.ok(chain.revisions[0].keyframe, 'first entry is the keyframe')
    assert.equal(chain.revisions[1].id, b.id)
    assert.ok(!chain.revisions[1].keyframe, 'subsequent entry is a regular delta')
    writer.ws.close(); reader.ws.close()
  })

  it('subscribe with an unknown `from` id falls back to the keyframe path', async () => {
    // Bug #4: an unknown `from` (db reset, compaction, malicious
    // peer) used to return the FULL chain. With keyframes in place,
    // the unknown-id case should land on the same path the
    // `from=null` case uses — return from the latest keyframe so
    // the catch-up cost stays O(keyframe interval).
    const { sk, tag } = await makeKp()
    const writer = await connect(serverUrl)
    await subscribe(writer, sk, tag)
    const a = await buildSave(sk, tag, null, 'A')
    writer.ws.send(JSON.stringify(a.msg))
    await writer.recv((m) => m.type === 'workspace-save-ack')
    const kf = await buildSave(sk, tag, a.id, 'kf', { keyframe: true })
    writer.ws.send(JSON.stringify(kf.msg))
    await writer.recv((m) => m.type === 'workspace-save-ack')
    const b = await buildSave(sk, tag, kf.id, 'B')
    writer.ws.send(JSON.stringify(b.msg))
    await writer.recv((m) => m.type === 'workspace-save-ack')

    // Subscribe with a fabricated `from` — same length / shape as
    // a real id, but never inserted. Server should not return
    // rev_A (which precedes the keyframe).
    const reader = await connect(serverUrl)
    const { chain } = await subscribe(reader, sk, tag, 'A'.repeat(43))
    assert.equal(chain.revisions.length, 2, 'unknown `from` trimmed to keyframe + after')
    assert.equal(chain.revisions[0].id, kf.id)
    assert.ok(chain.revisions[0].keyframe)
    assert.equal(chain.revisions[1].id, b.id)
    writer.ws.close(); reader.ws.close()
  })

  it('drops a malformed (non-JSON) frame silently', async () => {
    // The message handler's `try { JSON.parse } catch { return }`
    // path. Any text frame that isn't JSON is a no-op — no
    // disconnect, no error response, the socket stays usable.
    const c = await connect(serverUrl)
    c.ws.send('not-json {}{')
    await c.expectSilent(150)
    // Socket still works — heartbeat round-trip confirms.
    c.ws.send(JSON.stringify({ type: 'ping' }))
    const pong = await c.recv((m) => m.type === 'pong')
    assert.equal(pong.type, 'pong')
    c.ws.close()
  })

  it('drops a non-object JSON payload silently (string, number, array)', async () => {
    // The handler's `if (!msg || typeof msg !== 'object') return`
    // gate. JSON arrays are typeof 'object' so they pass the gate
    // but have no `type` field → fall through every branch
    // silently.
    const c = await connect(serverUrl)
    c.ws.send(JSON.stringify('hello'))
    c.ws.send(JSON.stringify(42))
    c.ws.send(JSON.stringify(null))
    await c.expectSilent(150)
    c.ws.close()
  })

  it('drops an unknown message type silently', async () => {
    // The dispatch is an `if / else if / else if` with no `else` —
    // anything that isn't save / subscribe / ping is a no-op.
    const c = await connect(serverUrl)
    c.ws.send(JSON.stringify({ type: 'workspace-pretend', whatever: 1 }))
    c.ws.send(JSON.stringify({ /* no type */ x: 1 }))
    await c.expectSilent(150)
    // Verify the socket is still alive afterwards.
    c.ws.send(JSON.stringify({ type: 'ping' }))
    const pong = await c.recv((m) => m.type === 'pong')
    assert.equal(pong.type, 'pong')
    c.ws.close()
  })

  it('socket closing mid-subscribe-verify does not register the dead socket (audit round-12)', async () => {
    // Race scenario: handleSubscribe awaits the Ed25519 verify, and
    // during that await the TCP closes. The close handler runs
    // `unsubscribeAll(socket)` (no-op — nothing to remove yet).
    // Without the post-await readyState recheck, the resumed handler
    // calls `subscribe(socket, tag)` and registers the closed socket
    // in `subscribers[tag]`, where it lives forever — broadcasts
    // no-op via `send`'s readyState gate but the Set entry holds a
    // strong ref to the socket.
    //
    // Indirect observable: after the race, the dead socket would be
    // a phantom subscriber. If a later peer subscribes to the same
    // tag and a third writer pushes a save, the broadcast loop
    // iterates over (1 phantom + 1 live). Both `send` calls are
    // safe (the phantom no-ops), so the live peer's receive is
    // unaffected. This test exercises the race path and verifies
    // the live peer still receives the broadcast — pinning that
    // the fix doesn't regress normal cleanup OR break the live
    // delivery path.
    const { sk, tag } = await makeKp()
    // Racer: subscribe, then immediately destroy the TCP without
    // sending a close frame. `_socket.destroy()` triggers a TCP RST,
    // which the server sees as a 'close' event; the timing of when
    // that event lands relative to the verify await's resolution is
    // exactly the race we're testing.
    const racer = await connect(serverUrl)
    const sig = await signSubscribe(sk, tag, null, racer.connectionNonce)
    racer.ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: sig }))
    racer.ws._socket?.destroy?.()
    // Give the server a moment to process the close event + the
    // queued subscribe handler in either order.
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    // Live peer + writer: standard happy-path subscribe + save.
    const live = await connect(serverUrl)
    await subscribe(live, sk, tag)
    const writer = await connect(serverUrl)
    await subscribe(writer, sk, tag)
    const save = await buildSave(sk, tag, null, 'after-race')
    writer.ws.send(JSON.stringify(save.msg))
    const state = await live.recv((m) => m.type === 'workspace-state' && m.revisions.length > 0)
    assert.equal(state.revisions[0].id, save.id, 'live peer received the broadcast')
    live.ws.close()
    writer.ws.close()
  })

  it('cleans up subscribers when a socket closes (broadcast survives the dead peer)', async () => {
    // Three subscribers; one closes. A subsequent save's broadcast
    // must reach the remaining two without throwing inside the
    // broadcast loop. Pre-`unsubscribeAll` shape would have left a
    // dead socket in the per-tag set; `send`'s try/catch swallows
    // the thrown EPIPE today, but the cleanest signal that the
    // close handler ran is "the broadcast still arrives at every
    // surviving peer in O(N), no skip".
    const { sk, tag } = await makeKp()
    const writer = await connect(serverUrl)
    const r1 = await connect(serverUrl)
    const r2 = await connect(serverUrl)
    await subscribe(writer, sk, tag)
    await subscribe(r1, sk, tag)
    await subscribe(r2, sk, tag)
    // Close r1 and wait for the server-side close handler to run.
    // A short wait is unavoidable — `socket.on('close', ...)` fires
    // asynchronously after the TCP FIN propagates.
    r1.ws.close()
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    const save = await buildSave(sk, tag, null, 'after-close')
    writer.ws.send(JSON.stringify(save.msg))
    const [ack, state] = await Promise.all([
      writer.recv((m) => m.type === 'workspace-save-ack'),
      r2.recv((m) => m.type === 'workspace-state' && m.revisions.length > 0),
    ])
    assert.equal(ack.id, save.id)
    assert.equal(state.revisions[0].id, save.id)
    writer.ws.close(); r2.ws.close()
  })

  it('demultiplexes by workspaceTag — one socket can subscribe to multiple workspaces', async () => {
    // The subscribers map keys on workspaceTag and a socket lives
    // in the set of every tag it subscribed to. A save on tag X
    // broadcasts only to X's subscribers, leaving Y untouched.
    const wsX = await makeKp()
    const wsY = await makeKp()
    const multi = await connect(serverUrl)
    await subscribe(multi, wsX.sk, wsX.tag)
    await subscribe(multi, wsY.sk, wsY.tag)
    // Writer for workspace X only.
    const writerX = await connect(serverUrl)
    await subscribe(writerX, wsX.sk, wsX.tag)
    const save = await buildSave(wsX.sk, wsX.tag, null, 'multi-tag')
    writerX.ws.send(JSON.stringify(save.msg))
    const state = await multi.recv((m) => m.type === 'workspace-state' && m.workspaceTag === wsX.tag && m.revisions.length > 0)
    assert.equal(state.revisions[0].id, save.id)
    // No broadcast on tag Y — multi shouldn't see anything for Y.
    await multi.expectSilent(150)
    multi.ws.close(); writerX.ws.close()
  })

  it('save without a prior subscribe does NOT register the sender as a subscriber (audit round-9 H1)', async () => {
    // Round-9 H1: earlier revisions auto-subscribed the sending
    // socket inside `handleSave`. That created a replay vector — a
    // passive observer who captured one valid save frame could
    // replay it from any TCP connection forever to silently attach
    // as a broadcast subscriber, mirroring all future ciphertext
    // for the workspace. The fix removes the auto-subscribe; the
    // legitimate client always sends an explicit
    // `workspace-subscribe`. Pin the new behavior: a save-only
    // client is NOT a broadcast subscriber.
    const { sk, tag } = await makeKp()
    const a = await connect(serverUrl)
    const b = await connect(serverUrl)
    // A sends a save WITHOUT subscribing first.
    const first = await buildSave(sk, tag, null, 'no-auto-sub-first')
    a.ws.send(JSON.stringify(first.msg))
    await a.recv((m) => m.type === 'workspace-save-ack')
    // B subscribes (gets the chain so far) and sends its own save.
    await subscribe(b, sk, tag)
    const second = await buildSave(sk, tag, first.id, 'no-auto-sub-second')
    b.ws.send(JSON.stringify(second.msg))
    await b.recv((m) => m.type === 'workspace-save-ack')
    // A — who never explicitly subscribed — must NOT receive B's
    // broadcast. expectSilent waits for any unexpected message
    // within the timeout; saving on A doesn't put A in the
    // subscribers set, so no broadcast should land.
    await a.expectSilent(200)
    a.ws.close(); b.ws.close()
  })

  it('drops a binary frame silently (wire protocol is text-only)', async () => {
    // A native `WebSocket.send(Uint8Array)` produces a binary frame.
    // The handler now gates on `isBinary` and skips before touching
    // the JSON path; the socket stays usable for subsequent text
    // frames (verified via a follow-up ping/pong).
    const c = await connect(serverUrl)
    c.ws.send(new Uint8Array([0x7b, 0x7d]))
    await c.expectSilent(150)
    c.ws.send(JSON.stringify({ type: 'ping' }))
    const pong = await c.recv((m) => m.type === 'pong')
    assert.equal(pong.type, 'pong')
    c.ws.close()
  })

  it('replay of a captured save from a third-party socket does NOT subscribe that socket (audit round-9 H1)', async () => {
    // The exact replay scenario: socket A sends a valid save. A
    // third party (socket C) captures the frame off the wire and
    // resends it from their own connection. The save is
    // signature-valid (frame is authentic) and would idempotently
    // ack on the server. The replayer must NOT become a subscriber.
    const { sk, tag } = await makeKp()
    const a = await connect(serverUrl)
    const c = await connect(serverUrl)
    const subscriber = await connect(serverUrl)
    await subscribe(subscriber, sk, tag) // legitimate subscriber so we have someone to broadcast to
    // A's first save (legitimately signed).
    const first = await buildSave(sk, tag, null, 'replay-target')
    a.ws.send(JSON.stringify(first.msg))
    await a.recv((m) => m.type === 'workspace-save-ack')
    await subscriber.recv((m) => m.type === 'workspace-state' && m.revisions.length > 0)
    // C captures and replays the same frame from a different socket.
    c.ws.send(JSON.stringify(first.msg))
    // The server returns ack-only (duplicate id). C is NOT now a
    // subscriber. Verify by sending another save and checking C
    // doesn't receive the broadcast.
    await c.recv((m) => m.type === 'workspace-save-ack')
    const followup = await buildSave(sk, tag, first.id, 'after-replay')
    a.ws.send(JSON.stringify(followup.msg))
    await subscriber.recv((m) => m.type === 'workspace-state' && m.revisions.length > 0)
    await c.expectSilent(200)
    a.ws.close(); c.ws.close(); subscriber.ws.close()
  })

  // URL routing — both rejection paths return the same 404 JSON
  // shape so a misconfigured client (e.g. one still pointed at
  // pre-PR `/sync`) sees something readable instead of ECONNRESET.
  it('plain HTTP outside /api/sync → 404 not-found JSON with Connection: close', async () => {
    const httpUrl = serverUrl.replace(/^ws:/u, 'http:').replace('/api/sync', '/random/path')
    const res = await fetch(httpUrl)
    assert.equal(res.status, 404)
    assert.equal(res.headers.get('content-type'), 'application/json')
    // Keep-alive on a WS-only relay would let an idle client hold
    // the socket open through SIGTERM; assert the header is set so
    // shutdown stays bounded.
    assert.equal(res.headers.get('connection'), 'close')
    assert.deepEqual(await res.json(), { error: 'not-found' })
  })

  it('WS upgrade outside /api/sync → 404 with JSON body (not just socket destroy)', async () => {
    // Raw HTTP/1.1 upgrade request to a non-sync path. Asserts the
    // full response writes BEFORE FIN — a regression to bare
    // `socket.destroy()` (or `write + destroy`) on a slow platform
    // would surface here as a truncated buffer.
    const { default: net } = await import('node:net')
    const port = Number(new URL(serverUrl).port)
    const tcp = net.connect({ host: '127.0.0.1', port })
    const chunks = []
    tcp.on('data', (b) => { chunks.push(b) })
    await new Promise((resolve, reject) => {
      tcp.once('connect', resolve)
      tcp.once('error', reject)
    })
    tcp.write(
      'GET /not-the-sync-path HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      'Sec-WebSocket-Key: AQIDBAUGBwgJCgsMDQ4PEA==\r\n' +
      '\r\n',
    )
    await new Promise((resolve) => { tcp.once('close', resolve) })
    const text = Buffer.concat(chunks).toString('utf8')
    assert.match(text, /^HTTP\/1\.1 404 Not Found\r\n/u)
    assert.match(text, /\r\nContent-Type: application\/json\r\n/u)
    assert.match(text, /\r\nConnection: close\r\n/u)
    assert.match(text, /\r\n\r\n\{"error":"not-found"\}$/u)
  })
})

describe('triage-sync server CLI', () => {
  it('reports the default storage paths under server/data in --help', () => {
    const proc = spawnSync(process.execPath, ['server/index.ts', '--help'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
    })
    assert.equal(proc.status, 0)
    assert.match(proc.stdout, /DB_PATH\s+sqlite file \(default:\s+server\/data\/data\.db\)/u)
    assert.match(proc.stdout, /OBJSTORE_DIR\s+object store root \(default:\s+\.\/objstore/u)
    assert.match(proc.stdout, /next to DB_PATH/u)
  })
})

// Standalone shutdown test: spawns its own server so the SIGTERM
// doesn't take down the suite-wide instance the other tests share.
describe('triage-sync server: graceful shutdown', () => {
  it('sends close code 1001 (going away) to live clients on SIGTERM', async () => {
    const { proc, serverUrl, teardown } = await bootServer()
    try {
      const ws = new WebSocket(serverUrl)
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', (e) => reject(e.error ?? new Error('ws error')), { once: true })
      })
      // Capture the close event BEFORE issuing SIGTERM so the
      // 1001 frame the server sends doesn't race past us.
      const closePromise = new Promise((resolve) => {
        ws.addEventListener('close', resolve, { once: true })
      })
      proc.kill('SIGTERM')
      const closeEvent = await closePromise
      // 1001 = going away; the server's `socket.close(1001, …)`
      // path. A network drop would surface as 1006 (abnormal
      // closure) or 1005 (no status); pin the explicit 1001 so a
      // regression that drops the close-frame loop would surface
      // as a code mismatch here.
      assert.equal(closeEvent.code, 1001, 'graceful shutdown emits 1001')
      await new Promise((resolve) => { proc.once('exit', resolve) })
    } finally { await teardown() }
  })

  it('force-terminates an unresponsive client (audit round-11 F4)', async () => {
    // Without the explicit `socket.terminate()` fallback, a client
    // that doesn't ack the 1001 close frame holds `wss.close()` for
    // the `ws` library default `closeTimeout` of ~30 s — a single
    // dead/blackholed peer would stretch SIGTERM response by that
    // entire window. Simulate by hijacking the raw TCP socket: do
    // the WebSocket Upgrade handshake by hand and then never
    // respond to any frame the server sends (no close ack, no
    // pong). The server must still exit within a small grace.
    const { default: net } = await import('node:net')
    const { createHash } = await import('node:crypto')
    const { proc, port, teardown } = await bootServer()
    let tcp
    try {
      // Manual WebSocket handshake — `ws`-library client sockets
      // auto-respond to close frames, which is exactly what we need
      // to NOT do here.
      tcp = net.connect({ host: '127.0.0.1', port })
      tcp.on('error', () => {})  // a server-initiated TCP RST surfaces as 'error'; tolerate
      // Sink incoming bytes without responding — this is the whole
      // point: a peer that ignores the server's close frame.
      tcp.on('data', () => {})
      await new Promise((resolve, reject) => {
        tcp.once('connect', resolve)
        tcp.once('error', reject)
      })
      const wsKey = Buffer.from('0123456789abcdef').toString('base64')
      const accept = createHash('sha1')
        .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')
      void accept  // server doesn't echo this back to us; we just need the upgrade to succeed server-side
      // `/api/sync` — anywhere else is rejected by the upgrade
      // gate, so this test would pass vacuously.
      tcp.write(
        `GET /api/sync HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Key: ${wsKey}\r\n` +
        `\r\n`,
      )
      // Give the server a tick to upgrade and add the socket to
      // wss.clients before we SIGTERM it. Without this, the
      // shutdown's `for (socket of wss.clients)` loop runs before
      // our connection is in the set and the test no-ops.
      await new Promise((resolve) => { setTimeout(resolve, 200) })
      const sigtermAt = Date.now()
      proc.kill('SIGTERM')
      await new Promise((resolve) => { proc.once('exit', resolve) })
      const elapsed = Date.now() - sigtermAt
      // 1 s grace timer fires; bound both sides — < 5 s catches the
      // ws-library 30 s closeTimeout regression, ≥ 800 ms catches a
      // silent-bypass regression that skips wss.clients entirely.
      assert.ok(elapsed < 5_000, `expected shutdown < 5 s with fallback; got ${elapsed} ms`)
      assert.ok(elapsed >= 800, `expected shutdown ≥ 800 ms (grace fired); got ${elapsed} ms`)
    } finally {
      try { tcp?.destroy() } catch {}
      await teardown()
    }
  })

  it('idle keep-alive HTTP connection does not stall SIGTERM beyond the grace', async () => {
    // A misbehaving HTTP/1.1 client that ignores `Connection: close`
    // and holds the keep-alive socket open would otherwise pin
    // `httpServer.close()` on its slow OS-level timeout. Verify the
    // shutdown's `closeAllConnections()` fallback inside the
    // terminate timer kicks in within the same 1 s grace.
    const { default: net } = await import('node:net')
    const { proc, port, teardown } = await bootServer()
    let tcp
    try {
      tcp = net.connect({ host: '127.0.0.1', port })
      tcp.on('error', () => {})
      tcp.on('data', () => {})  // consume + ignore server response
      await new Promise((resolve, reject) => {
        tcp.once('connect', resolve)
        tcp.once('error', reject)
      })
      // Issue a plain HTTP/1.1 GET; the server replies 404 +
      // Connection: close, but pretend to be a buggy client that
      // ignores the header and keeps the socket open.
      tcp.write(`GET /idle-keep-alive HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
      await new Promise((resolve) => { setTimeout(resolve, 200) })
      const sigtermAt = Date.now()
      proc.kill('SIGTERM')
      await new Promise((resolve) => { proc.once('exit', resolve) })
      const elapsed = Date.now() - sigtermAt
      // Bounded by the WS terminate grace (1 s) + small overhead.
      // Without `closeAllConnections()` in the timer, this would
      // either stall on the OS-level keep-alive timeout (~60 s+).
      assert.ok(elapsed < 5_000, `expected shutdown < 5 s with HTTP fallback; got ${elapsed} ms`)
    } finally {
      try { tcp?.destroy() } catch {}
      await teardown()
    }
  })
})

// Same-origin gate on WS upgrade + REST plane (transport audit
// `server/index.ts:530` + `server/objstore/rest.ts:103`). The
// expected origin is derived from `req.headers.host` directly, or
// from `X-Forwarded-Host` / `X-Forwarded-Proto` when TRUST_PROXY is
// on. TRUST_PROXY defaults to ON for loopback binds (the typical
// "behind nginx on same host" deployment) and OFF for public binds
// (HOST=0.0.0.0 etc., where unconditional X-Forwarded-* trust would
// let an attacker page set its own forwarded headers + matching
// Origin to bypass the gate). Browser WS handshakes always send
// Origin (RFC 6455); non-browser clients omit it and are allowed.
describe('triage-sync server: same-origin gate', () => {
  async function withSpawnedServer(env, body) {
    const { default: net } = await import('node:net')
    const { port: serverPort, teardown } = await bootServer({ env })
    // Raw-TCP upgrade so we can set Origin / X-Forwarded-* freely
    // (undici's `fetch` refuses `Upgrade: websocket`; the `ws`
    // client only sets Origin from the constructor in some Node
    // versions).
    function rawUpgrade(port, originValue, hostHeader, xfHost, xfProto) {
      return new Promise((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port })
        let buf = ''
        sock.on('data', (d) => {
          buf += String(d)
          const m = /^HTTP\/1\.1 (\d+)/u.exec(buf)
          if (m) { try { sock.destroy() } catch {} ; resolve(Number(m[1])) }
        })
        sock.on('error', reject)
        sock.on('connect', () => {
          const key = Buffer.from('0123456789abcdef').toString('base64')
          const headers = [
            `GET /api/sync HTTP/1.1`,
            `Host: ${hostHeader ?? `127.0.0.1:${port}`}`,
            `Upgrade: websocket`,
            `Connection: Upgrade`,
            `Sec-WebSocket-Version: 13`,
            `Sec-WebSocket-Key: ${key}`,
          ]
          if (originValue != null) headers.push(`Origin: ${originValue}`)
          if (xfHost != null) headers.push(`X-Forwarded-Host: ${xfHost}`)
          if (xfProto != null) headers.push(`X-Forwarded-Proto: ${xfProto}`)
          sock.write(headers.join('\r\n') + '\r\n\r\n')
        })
      })
    }
    try {
      await body(serverPort, rawUpgrade)
    } finally { await teardown() }
  }

  it('HOST=127.0.0.1 (loopback): trusts X-Forwarded-* by default, gate accepts proxy-forwarded match', async () => {
    await withSpawnedServer({ HOST: '127.0.0.1' }, async (port, rawUpgrade) => {
      // Foreign Origin against direct Host → denied.
      assert.equal(await rawUpgrade(port, 'https://evil.example'), 403, 'foreign Origin denied')
      // Matching Origin (scheme + host) against direct Host → upgraded.
      assert.equal(await rawUpgrade(port, `http://127.0.0.1:${port}`), 101, 'matching Origin upgraded')
      // Missing Origin (non-browser client / same-origin fetch) → upgraded.
      assert.equal(await rawUpgrade(port, null), 101, 'missing Origin upgraded (non-browser)')
      // TRUST_PROXY=on (loopback default): X-Forwarded-Host takes
      // precedence; Origin matching the forwarded host → upgraded.
      assert.equal(
        await rawUpgrade(port, 'https://triage.space', `127.0.0.1:${port}`, 'triage.space', 'https'),
        101,
        'X-Forwarded-Host honoured (loopback default) + Origin match → upgraded',
      )
      // Same proxy setup but Origin says a different host → denied.
      assert.equal(
        await rawUpgrade(port, 'https://evil.example', `127.0.0.1:${port}`, 'triage.space', 'https'),
        403,
        'X-Forwarded-Host honoured + foreign Origin → denied',
      )
    })
  })

  it('HOST=0.0.0.0 (public): ignores X-Forwarded-* by default, closes the attacker-forged-forwarded-host bypass', async () => {
    await withSpawnedServer({ HOST: '0.0.0.0' }, async (port, rawUpgrade) => {
      // Without TRUST_PROXY (default off for public binds): an
      // attacker page that sets matching X-Forwarded-Host + Origin
      // CANNOT bypass the gate. Expected origin falls back to
      // req.headers.host, so Origin must match the literal Host
      // header. Audit `server/index.ts:171` regression.
      assert.equal(
        await rawUpgrade(port, 'https://triage.space', `127.0.0.1:${port}`, 'triage.space', 'https'),
        403,
        'attacker-forged X-Forwarded-* ignored; gate denies foreign Origin',
      )
      // Matching the actual Host still upgrades.
      assert.equal(
        await rawUpgrade(port, `http://127.0.0.1:${port}`),
        101,
        'Origin matching real Host upgrades on public bind',
      )
    })
  })

  it('TRUST_PROXY=1 explicit override: honours X-Forwarded-* even on public bind', async () => {
    await withSpawnedServer({ HOST: '0.0.0.0', TRUST_PROXY: '1' }, async (port, rawUpgrade) => {
      assert.equal(
        await rawUpgrade(port, 'https://triage.space', `127.0.0.1:${port}`, 'triage.space', 'https'),
        101,
        'TRUST_PROXY=1 opt-in honours X-Forwarded-*',
      )
    })
  })

  it('TRUST_PROXY=0 explicit override: ignores X-Forwarded-* even on loopback bind', async () => {
    await withSpawnedServer({ HOST: '127.0.0.1', TRUST_PROXY: '0' }, async (port, rawUpgrade) => {
      assert.equal(
        await rawUpgrade(port, 'https://triage.space', `127.0.0.1:${port}`, 'triage.space', 'https'),
        403,
        'TRUST_PROXY=0 opt-out ignores X-Forwarded-* even on loopback',
      )
    })
  })
})
