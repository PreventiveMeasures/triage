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
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { encodeUtf8 } from '../common/utf8.js'

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

async function signSubscribe(sk, tag, from) {
  const payload = encodeUtf8([
    SUBSCRIBE_DOMAIN, tag, from == null ? '' : String(from),
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
    ws.addEventListener('open', () => resolve({ ws, recv, expectSilent }), { once: true })
    ws.addEventListener('error', (event) => reject(event.error ?? new Error('websocket error')), { once: true })
  })
}

// Subscribe + drain the initial workspace-subscribed +
// workspace-state pair. `from` is the last revision id the client
// claims to have applied (null on first connect).
async function subscribe(c, sk, tag, from = null) {
  const sig = await signSubscribe(sk, tag, from)
  c.ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from, signature: sig }))
  const ack = await c.recv((m) => m.type === 'workspace-subscribed' && m.workspaceTag === tag)
  const chain = await c.recv((m) => m.type === 'workspace-state' && m.workspaceTag === tag)
  return { ack, chain }
}

describe('triage-sync server', () => {
  let serverDir, serverProc, serverUrl

  before(async () => {
    serverDir = mkdtempSync(path.join(tmpdir(), 'deepview-sync-'))
    const port = 19000 + Math.floor(Math.random() * 1_000)
    serverUrl = `ws://127.0.0.1:${port}`
    serverProc = spawn(process.execPath, ['server/index.js'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: path.join(serverDir, 'data.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server boot timeout')), 5_000)
      serverProc.stdout.on('data', (d) => {
        if (String(d).includes('triage-sync server')) { clearTimeout(t); resolve() }
      })
      serverProc.stderr.on('data', () => {})
    })
  })

  after(async () => {
    if (!serverProc) return
    serverProc.kill('SIGTERM')
    await new Promise((resolve) => { serverProc.once('exit', resolve) })
    rmSync(serverDir, { recursive: true, force: true })
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

  it('stale base triggers a catch-up chain instead of an ack', async () => {
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
    // Wire flag is truthy (server stores 1, sends 1 — peers treat
    // it as a boolean via `Boolean(rev.keyframe)`).
    assert.ok(state.revisions[0].keyframe, 'broadcast carries keyframe flag')
    c1.ws.close(); c2.ws.close()
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
})
