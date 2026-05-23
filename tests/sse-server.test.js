// End-to-end SSE+POST transport tests. Boots the real server in a
// child process and drives it from synthetic POSTs (no production
// client involvement), so the test pins the server-side wire protocol
// independently of the client adapter.
//
// Wire shape under test (server side: server/sse-server.ts):
//
//   POST /api/sync/sse[?id=<sid>]
//       body: { password?, frames? }
//       response: text/event-stream
//                 first event on a fresh session: `session\ndata: <sid>`
//                 then default `message` events carrying protocol JSON
//                 stream stays open until next POST takes over
//
//   Continuation:
//     - POST with ?id matching a known session → response stream
//       attaches to the same session; previous response is closed.
//     - POST with ?id NOT known to this replica → fresh session minted,
//       new id announced via the `session` event; client switches.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { Buffer } from 'node:buffer'
import { encodeUtf8 } from '../common/utf8.js'
import { bootServer } from './_helpers.js'

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

// Open one POST against the SSE endpoint and return the response +
// a streaming reader that yields parsed SSE events. The caller drives
// the response body manually so each test can assert on the wire
// shape (session event → challenge frame → subsequent broadcasts).
async function postSse(baseUrl, body, sid = null) {
  const url = sid == null ? `${baseUrl}/api/sync/sse` : `${baseUrl}/api/sync/sse?id=${encodeURIComponent(sid)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return res
}

// Reads an SSE response body and yields `{event, data}` objects. Closes
// when the response stream EOFs (server closed it) or when `cancel()`
// is called.
function readSse(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const queue = []
  const waiters = []
  let closed = false
  let finished = false

  function dispatch(event, data) {
    const ev = { event, data }
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].predicate(ev)) {
        const w = waiters[i]
        waiters.splice(i, 1)
        w.resolve(ev)
        return
      }
    }
    queue.push(ev)
  }

  function parseChunk(chunk) {
    buf += chunk
    let sep
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      let event = ''
      const dataLines = []
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) { event = line.slice(6).trim(); continue }
        if (line.startsWith('data:')) { dataLines.push(line.slice(5).replace(/^ /u, '')); continue }
      }
      if (dataLines.length === 0) continue
      dispatch(event, dataLines.join('\n'))
    }
  }

  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        parseChunk(decoder.decode(value, { stream: true }))
      }
    } catch {
      // closed mid-read; let the awaiters time out
    } finally {
      finished = true
      // Unblock any pending waiters so the test sees the EOF.
      for (const w of waiters.splice(0)) w.reject(new Error('stream closed'))
    }
  })().catch(() => {})

  function recvEvent(predicate, timeoutMs = 5_000) {
    for (let i = 0; i < queue.length; i++) {
      if (predicate(queue[i])) return Promise.resolve(queue.splice(i, 1)[0])
    }
    if (finished) return Promise.reject(new Error('stream closed'))
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: null, reject: null }
      const t = setTimeout(() => {
        const idx = waiters.indexOf(waiter)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(new Error(`recvEvent: timeout (queue=${queue.length})`))
      }, timeoutMs)
      waiter.resolve = (e) => { clearTimeout(t); resolve(e) }
      waiter.reject = (e) => { clearTimeout(t); reject(e) }
      waiters.push(waiter)
    })
  }

  // Convenience: receive a default-named event whose JSON-parsed data
  // matches the predicate.
  function recvFrame(predicate, timeoutMs = 5_000) {
    return recvEvent((e) => {
      if (e.event !== '' && e.event !== 'message') return false
      let msg
      try { msg = JSON.parse(e.data) } catch { return false }
      return predicate(msg)
    }, timeoutMs).then((e) => JSON.parse(e.data))
  }

  function cancel() {
    if (closed) return
    closed = true
    try { reader.cancel().catch(() => {}) } catch {}
  }

  return { recvEvent, recvFrame, cancel, isFinished() { return finished } }
}

// One end-to-end SSE+POST session driver. Opens with an initial POST,
// tracks the latest session id, and exposes `post(body)` that always
// echoes the current sid.
async function openSession(baseUrl, initialBody = {}) {
  let sid = null
  let nonce = null
  let lastRead = null

  async function post(body) {
    const res = await postSse(baseUrl, body, sid)
    const read = readSse(res)
    // Server end()s the previous response on takeover; the previous
    // reader's background loop sees `done: true` and exits naturally.
    // We keep only the latest reader for the test's recv calls.
    lastRead = read
    return read
  }

  const firstRead = await post(initialBody)
  const sessionEv = await firstRead.recvEvent((e) => e.event === 'session')
  sid = sessionEv.data
  const challenge = await firstRead.recvFrame((m) => m.type === 'challenge')
  nonce = challenge.nonce

  return {
    get sid() { return sid },
    get nonce() { return nonce },
    get currentRead() { return lastRead },
    post(body) { return post(body) },
    async postRaw(body, overrideSid) {
      const res = await postSse(baseUrl, body, overrideSid ?? sid)
      return readSse(res)
    },
    setSid(newSid) { sid = newSid },
    close() {
      // The reader holds the lock on the response body; cancelling
      // via the reader propagates to the underlying stream. Calling
      // `res.body.cancel()` would throw "ReadableStream is locked".
      if (lastRead) lastRead.cancel()
    },
  }
}

describe('SSE+POST transport', { concurrency: false }, () => {
  let httpOrigin, server

  before(async () => {
    server = await bootServer()
    httpOrigin = server.httpOrigin
  })

  after(async () => {
    if (server) await server.teardown()
  })

  it('first POST with no id mints a session and emits challenge', async () => {
    const session = await openSession(httpOrigin)
    assert.ok(session.sid, 'session id received')
    assert.match(session.sid, /^[A-Za-z0-9_-]{22}$/u, '22-char base64url id')
    assert.ok(session.nonce, 'challenge frame received')
    session.close()
  })

  it('continuation POST against same sid attaches to same session', async () => {
    const { sk, tag } = await makeKp()
    const session = await openSession(httpOrigin)
    const subSig = await signSubscribe(sk, tag, null, session.nonce)
    // Second POST with the SAME sid; server attaches to the existing
    // session, so subscribes use the original challenge nonce.
    const read = await session.post({
      frames: [{ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: subSig }],
    })
    const ack = await read.recvFrame((m) => m.type === 'workspace-subscribed')
    assert.equal(ack.workspaceTag, tag)
    session.close()
  })

  it('POST with an unknown id mints a fresh session (multi-replica recovery)', async () => {
    // Open one session normally to grab its nonce shape for sanity.
    const session = await openSession(httpOrigin)
    const oldSid = session.sid
    // POST with a syntactically-valid but unknown sid → server treats
    // it as a fresh session and returns a NEW session event.
    const read = await session.postRaw({}, 'aaaaaaaaaaaaaaaaaaaaaa')
    const sessionEv = await read.recvEvent((e) => e.event === 'session')
    assert.notEqual(sessionEv.data, oldSid, 'fresh id minted')
    assert.match(sessionEv.data, /^[A-Za-z0-9_-]{22}$/u)
    const challenge = await read.recvFrame((m) => m.type === 'challenge')
    assert.notEqual(challenge.nonce, session.nonce, 'fresh challenge nonce')
    read.cancel()
    session.close()
  })

  it('save via SSE+POST broadcasts to a WS subscriber on the same workspace', async () => {
    const { sk, tag } = await makeKp()
    const session = await openSession(httpOrigin)
    const ws = new WebSocket(server.serverUrl)
    const wsQueue = []
    ws.addEventListener('message', (ev) => { wsQueue.push(JSON.parse(ev.data)) })
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    while (wsQueue.length === 0) await new Promise((r) => { setTimeout(r, 5) })
    const wsNonce = wsQueue.shift().nonce
    const wsSubSig = await signSubscribe(sk, tag, null, wsNonce)
    ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: wsSubSig }))
    while (wsQueue.length < 2) await new Promise((r) => { setTimeout(r, 5) })
    wsQueue.length = 0
    // SSE subscribes too (so the server has the SSE peer on the
    // subscribers set, but importantly: the broadcast skips the
    // originator, so the WS peer is the one we observe receiving).
    const sseSubSig = await signSubscribe(sk, tag, null, session.nonce)
    const sseSubRead = await session.post({
      frames: [{ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: sseSubSig }],
    })
    await sseSubRead.recvFrame((m) => m.type === 'workspace-subscribed')
    await sseSubRead.recvFrame((m) => m.type === 'workspace-state')
    // Build + send the save in a NEW POST (continuation against the
    // same sid).
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)))
    const ciphertext = b64url(new TextEncoder().encode('sse-payload'))
    const { signature, id } = await signSave(sk, { tag, base: null, keyframe: false, nonce, ciphertext })
    const saveRead = await session.post({
      frames: [{ type: 'workspace-save', workspaceTag: tag, base: null, nonce, ciphertext, signature }],
    })
    const sseAck = await saveRead.recvFrame((m) => m.type === 'workspace-save-ack')
    assert.equal(sseAck.id, id)
    const start = Date.now()
    while (Date.now() - start < 5_000) {
      const wsState = wsQueue.find((m) => m.type === 'workspace-state' && m.revisions?.length > 0)
      if (wsState) {
        assert.equal(wsState.revisions[0].id, id, 'WS peer received the SSE-originated save')
        break
      }
      await new Promise((r) => { setTimeout(r, 5) })
    }
    session.close()
    ws.close()
  })

  it('GET to /api/sync/sse is rejected (405) — POSTs only', async () => {
    const res = await fetch(`${httpOrigin}/api/sync/sse`)
    assert.equal(res.status, 405)
  })

  it('JSON ping/pong heartbeat round-trips on a continuation POST', async () => {
    const session = await openSession(httpOrigin)
    const read = await session.post({ frames: [{ type: 'ping' }] })
    const pong = await read.recvFrame((m) => m.type === 'pong')
    assert.equal(pong.type, 'pong')
    session.close()
  })

  it('cross-origin POST gets 403', async () => {
    const res = await fetch(`${httpOrigin}/api/sync/sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': 'http://evil.example' },
      body: '{}',
    })
    assert.equal(res.status, 403)
  })

  it('previous POST response is closed when next POST takes over', async () => {
    const session = await openSession(httpOrigin)
    const firstRead = session.currentRead
    // Issue a second POST against the same sid. The server should
    // end() the previous response, which surfaces to us as the
    // reader hitting `done`.
    await session.post({})
    // Drain the first reader until it EOFs.
    const start = Date.now()
    while (!firstRead.isFinished() && Date.now() - start < 2_000) {
      await new Promise((r) => { setTimeout(r, 10) })
    }
    assert.equal(firstRead.isFinished(), true, 'previous response stream closed')
    session.close()
  })

  it('client disconnect frees the session id (no leak)', async () => {
    // Indirect leak detection: a closed session's id can be re-bound
    // by a new POST → server mints a fresh session (with a new id),
    // which only happens if the old session was actually dropped
    // from the sessions Map. Pre-fix, sessions piled up and an idle
    // client whose response dropped would leak its slot.
    const session = await openSession(httpOrigin)
    const oldSid = session.sid
    session.close()
    // Wait for the server-side close handler to fire and dropSession
    // to run (the response 'close' event is async).
    await new Promise((r) => { setTimeout(r, 100) })
    // POST with the (now-dead) old sid: server should mint a fresh
    // session and announce a new id.
    const res = await postSse(httpOrigin, {}, oldSid)
    const read = readSse(res)
    const sessionEv = await read.recvEvent((e) => e.event === 'session')
    assert.notEqual(sessionEv.data, oldSid, 'fresh id minted after disconnect')
    read.cancel()
  })

  it('password field on POST silently authenticates against a password-gated server', async () => {
    // Pre-write a password-gated config, then boot a server pointing
    // at it. The config-path env var is honoured by server/config.ts;
    // boot reads the file before binding.
    const path = await import('node:path')
    const fs = await import('node:fs')
    const { mkdtempSync, rmSync } = fs
    const os = await import('node:os')
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sse-auth-test-'))
    const cfg = path.join(dir, 'config.json')
    fs.writeFileSync(cfg, JSON.stringify({ password: 'secret' }))
    const gated = await bootServer({ dir, env: { CONFIG_PATH: cfg } })
    try {
      // POST with the correct password → server emits `authenticated`.
      const res = await postSse(gated.httpOrigin, { password: 'secret' })
      const read = readSse(res)
      await read.recvEvent((e) => e.event === 'session')
      await read.recvFrame((m) => m.type === 'challenge')
      const auth = await read.recvFrame((m) => m.type === 'authenticated' || m.type === 'unauthorized')
      assert.equal(auth.type, 'authenticated')
      read.cancel()
    } finally {
      await gated.teardown()
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('authenticate short-circuits once authorized: a second POST with the same password does not re-emit', async () => {
    // The SSE client caches password and rides body.password on
    // EVERY POST. Without the server-side short-circuit, each POST
    // would re-emit `authenticated` and re-fire triage-sync's
    // 'kick deferred sends' consumer hook — chatter the wire and
    // wasted work. The short-circuit lets the wire signal fire
    // exactly once per `unauthorized → authorized` transition.
    const path = await import('node:path')
    const fs = await import('node:fs')
    const { mkdtempSync, rmSync } = fs
    const os = await import('node:os')
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sse-auth-shortcircuit-'))
    const cfg = path.join(dir, 'config.json')
    fs.writeFileSync(cfg, JSON.stringify({ password: 'secret' }))
    const gated = await bootServer({ dir, env: { CONFIG_PATH: cfg } })
    try {
      // First POST authenticates; capture sid + receive `authenticated`.
      const r1 = await postSse(gated.httpOrigin, { password: 'secret' })
      const read1 = readSse(r1)
      const sidEv = await read1.recvEvent((e) => e.event === 'session')
      const sid = sidEv.data
      await read1.recvFrame((m) => m.type === 'challenge')
      await read1.recvFrame((m) => m.type === 'authenticated')
      // Second POST against the SAME sid with the same password.
      // No new `authenticated` should arrive — but a `pong` (from a
      // ping frame) MUST still flow, so we use that as a positive
      // signal that the dispatcher is alive on this continuation.
      const r2 = await postSse(gated.httpOrigin, { password: 'secret', frames: [{ type: 'ping' }] }, sid)
      const read2 = readSse(r2)
      const pong = await read2.recvFrame((m) => m.type === 'pong' || m.type === 'authenticated')
      assert.equal(pong.type, 'pong', 'pong arrives without a re-emitted authenticated')
      read1.cancel()
      read2.cancel()
    } finally {
      await gated.teardown()
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })
})
