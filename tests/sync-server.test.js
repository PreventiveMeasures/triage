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
import { WebSocket } from 'ws'
import { encodeUtf8 } from '../common/utf8.js'

const SAVE_DOMAIN = 'deepview-triage-sync.v1.save'
const SUBSCRIBE_DOMAIN = 'deepview-triage-sync.v1.subscribe'

function b64url(bytes) { return Buffer.from(bytes).toString('base64url') }

async function makeKp() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { sk: kp.privateKey, tag: b64url(Buffer.from(jwk.x, 'base64url')) }
}

async function signSave(sk, { tag, base, nonce, ciphertext }) {
  const payload = encodeUtf8([
    SAVE_DOMAIN, tag, base == null ? '' : String(base), nonce, ciphertext,
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

async function buildSave(sk, tag, base, plaintext) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)))
  const ciphertext = b64url(new TextEncoder().encode(plaintext))
  const { signature, id } = await signSave(sk, { tag, base, nonce, ciphertext })
  return {
    msg: { type: 'workspace-save', workspaceTag: tag, base, nonce, ciphertext, signature },
    id,
  }
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

// Wait for a message satisfying `predicate`. Listener attaches
// immediately; messages that arrive before the predicate matches
// are skipped (not buffered for the next call). Time out fast so a
// missing reply doesn't hang the suite.
function recv(ws, predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error('recv: timeout'))
    }, timeoutMs)
    function onMessage(buf) {
      let msg
      try { msg = JSON.parse(buf.toString()) } catch { return }
      if (!predicate(msg)) return
      clearTimeout(t)
      ws.off('message', onMessage)
      resolve(msg)
    }
    ws.on('message', onMessage)
  })
}

// Assert no message arrives within `ms`. Used after sending a
// malformed / bad-sig message — protocol drops silently, which is
// observable only as the absence of a reply.
function expectSilent(ws, ms = 200) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', onMessage)
      resolve()
    }, ms)
    function onMessage(buf) {
      clearTimeout(t)
      ws.off('message', onMessage)
      reject(new Error(`expectSilent: got ${buf.toString().slice(0, 200)}`))
    }
    ws.on('message', onMessage)
  })
}

// Subscribe + drain the initial workspace-subscribed + workspace-state
// pair so subsequent `recv` calls don't accidentally match them. `from`
// is the last revision id the client claims to have applied (null on
// first connect).
async function subscribe(ws, sk, tag, from = null) {
  const sig = await signSubscribe(sk, tag, from)
  ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from, signature: sig }))
  const ack = await recv(ws, (m) => m.type === 'workspace-subscribed' && m.workspaceTag === tag)
  const chain = await recv(ws, (m) => m.type === 'workspace-state' && m.workspaceTag === tag)
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
    const ws = await openWs(serverUrl)
    const { ack, chain } = await subscribe(ws, sk, tag)
    assert.equal(ack.workspaceTag, tag)
    assert.deepEqual(chain.revisions, [])
    ws.close()
  })

  it('save returns a content-addressed id and grows the chain', async () => {
    const { sk, tag } = await makeKp()
    const ws = await openWs(serverUrl)
    await subscribe(ws, sk, tag)
    const { msg, id } = await buildSave(sk, tag, null, 'hello-1')
    ws.send(JSON.stringify(msg))
    const ack = await recv(ws, (m) => m.type === 'workspace-save-ack')
    assert.equal(ack.workspaceTag, tag)
    assert.equal(ack.base, null)
    assert.equal(ack.id, id, 'server-derived id matches client SHA-256(canonical bytes)')
    ws.close()
  })

  it('broadcasts a save to other subscribers without echoing to the sender', async () => {
    const { sk, tag } = await makeKp()
    const ws1 = await openWs(serverUrl)
    const ws2 = await openWs(serverUrl)
    await subscribe(ws1, sk, tag)
    await subscribe(ws2, sk, tag)
    const { msg, id } = await buildSave(sk, tag, null, 'broadcast-payload')
    // Attach broadcast listener BEFORE sending — the server can ack
    // and broadcast in either order on the wire.
    const broadcast = recv(ws2, (m) => m.type === 'workspace-state' && m.revisions.length > 0)
    ws1.send(JSON.stringify(msg))
    const [ack, state] = await Promise.all([
      recv(ws1, (m) => m.type === 'workspace-save-ack'),
      broadcast,
    ])
    assert.equal(ack.id, id)
    assert.equal(state.revisions.length, 1)
    assert.equal(state.revisions[0].id, id)
    assert.equal(state.revisions[0].base, null)
    // Sender doesn't see its own save echoed back.
    await expectSilent(ws1, 150)
    ws1.close(); ws2.close()
  })

  it('stale base triggers a catch-up chain instead of an ack', async () => {
    const { sk, tag } = await makeKp()
    const ws = await openWs(serverUrl)
    await subscribe(ws, sk, tag)
    const first = await buildSave(sk, tag, null, 'first')
    ws.send(JSON.stringify(first.msg))
    await recv(ws, (m) => m.type === 'workspace-save-ack')
    // Now send a save built on the WRONG base (null instead of first.id).
    const stale = await buildSave(sk, tag, null, 'second-stale')
    ws.send(JSON.stringify(stale.msg))
    const catchup = await recv(ws, (m) => m.type === 'workspace-state')
    assert.equal(catchup.revisions.length, 1)
    assert.equal(catchup.revisions[0].id, first.id)
    // No ack should follow.
    await expectSilent(ws, 150)
    ws.close()
  })

  it('idempotent retransmit returns the same id without an extra chain entry', async () => {
    const { sk, tag } = await makeKp()
    const ws = await openWs(serverUrl)
    await subscribe(ws, sk, tag)
    const save = await buildSave(sk, tag, null, 'idempotent')
    ws.send(JSON.stringify(save.msg))
    const ack1 = await recv(ws, (m) => m.type === 'workspace-save-ack')
    ws.send(JSON.stringify(save.msg))
    const ack2 = await recv(ws, (m) => m.type === 'workspace-save-ack')
    assert.equal(ack1.id, save.id)
    assert.equal(ack2.id, save.id)
    // Verify chain has exactly one entry by re-subscribing on a
    // fresh socket with `from = null`.
    const ws2 = await openWs(serverUrl)
    const { chain } = await subscribe(ws2, sk, tag)
    assert.equal(chain.revisions.length, 1)
    assert.equal(chain.revisions[0].id, save.id)
    ws.close(); ws2.close()
  })

  it('subscribe with `from = previous-id` returns only newer revisions', async () => {
    const { sk, tag } = await makeKp()
    const writer = await openWs(serverUrl)
    await subscribe(writer, sk, tag)
    const a = await buildSave(sk, tag, null, 'A')
    writer.send(JSON.stringify(a.msg))
    await recv(writer, (m) => m.type === 'workspace-save-ack')
    const b = await buildSave(sk, tag, a.id, 'B')
    writer.send(JSON.stringify(b.msg))
    await recv(writer, (m) => m.type === 'workspace-save-ack')

    const reader = await openWs(serverUrl)
    const { chain } = await subscribe(reader, sk, tag, a.id)
    assert.equal(chain.revisions.length, 1, 'only the post-A revision is sent')
    assert.equal(chain.revisions[0].id, b.id)
    writer.close(); reader.close()
  })

  it('drops a save with a bad signature silently', async () => {
    const { sk, tag } = await makeKp()
    const ws = await openWs(serverUrl)
    await subscribe(ws, sk, tag)
    const save = await buildSave(sk, tag, null, 'will-fail')
    // Valid length but garbage bytes — passes the length precheck
    // but Ed25519 verify rejects.
    save.msg.signature = b64url(new Uint8Array(64))
    ws.send(JSON.stringify(save.msg))
    await expectSilent(ws, 200)
    ws.close()
  })

  it('drops a save signed by the wrong keypair (foreign tag in the save)', async () => {
    // Attacker holds their own keypair and tries to forge a save
    // under the victim's workspaceTag — the signature is over the
    // victim's tag, so verification against the victim's pubkey
    // fails.
    const victim = await makeKp()
    const attacker = await makeKp()
    const ws = await openWs(serverUrl)
    await subscribe(ws, victim.sk, victim.tag)
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)))
    const ciphertext = b64url(new TextEncoder().encode('forged'))
    // Sign with the attacker's key but claim the victim's tag.
    const { signature } = await signSave(attacker.sk, { tag: victim.tag, base: null, nonce, ciphertext })
    ws.send(JSON.stringify({
      type: 'workspace-save', workspaceTag: victim.tag, base: null, nonce, ciphertext, signature,
    }))
    await expectSilent(ws, 200)
    ws.close()
  })

  it('drops a save with a non-string nonce / ciphertext silently', async () => {
    const { sk, tag } = await makeKp()
    const ws = await openWs(serverUrl)
    await subscribe(ws, sk, tag)
    // Bad shape: ciphertext is a number. encodeUtf8 inside the
    // server's canonical-payload path throws, which the verify
    // wrapper turns into "bad sig" → silent drop.
    ws.send(JSON.stringify({
      type: 'workspace-save', workspaceTag: tag, base: null,
      nonce: b64url(new Uint8Array(12)), ciphertext: 42, signature: b64url(new Uint8Array(64)),
    }))
    await expectSilent(ws, 200)
    ws.close()
  })

  it('drops a subscribe with a bad signature silently', async () => {
    const { tag } = await makeKp()
    const ws = await openWs(serverUrl)
    // Right length, garbage bytes — verify rejects.
    const signature = b64url(new Uint8Array(64))
    ws.send(JSON.stringify({
      type: 'workspace-subscribe', workspaceTag: tag, from: null, signature,
    }))
    await expectSilent(ws, 200)
    ws.close()
  })

  it('persists revisions across reconnects (same DB, same tag, fresh socket)', async () => {
    const { sk, tag } = await makeKp()
    const writer = await openWs(serverUrl)
    await subscribe(writer, sk, tag)
    const save = await buildSave(sk, tag, null, 'persisted')
    writer.send(JSON.stringify(save.msg))
    await recv(writer, (m) => m.type === 'workspace-save-ack')
    writer.close()

    // Brand-new socket; same DB. Subscribe with from=null → the
    // previously-acked revision must reappear in the chain.
    const reader = await openWs(serverUrl)
    const { chain } = await subscribe(reader, sk, tag)
    assert.equal(chain.revisions.length, 1)
    assert.equal(chain.revisions[0].id, save.id)
    reader.close()
  })
})
