// End-to-end tests for the operator-side password gate on the
// triage-sync relay. Each test boots its own server child process so
// the `server/config.json` (or absence) is scoped per-case — the
// shared-server pattern other suites use doesn't fit here because
// the password is read once at process start.
//
// Gate semantics under test:
//   * `password: null` / missing config.json → no gating (current
//     no-config behaviour preserved). Save against a fresh tag
//     proceeds without `authenticate`.
//   * `password: "..."` configured + connection NOT authenticated +
//     workspace tag not on the server → server emits `unauthorized
//     { workspaceTag, base }`, drops the save.
//   * Subsequent `authenticate { password }` with the right password
//     → `authenticated {}`; the same socket now bypasses the gate
//     for ANY first action it issues (including objstore-put-begin
//     for an unrelated tag).
//   * Wrong password → `unauthorized { kind: 'auth-failed' }` (the
//     explicit discriminator distinguishes it from the
//     `kind: 'gated'` frame), socket stays open, retry permitted.
//   * Already-existing workspace (any row in workspace_revision OR
//     workspace_object) → no gating, even on a fresh connection.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { encodeUtf8 } from '../common/utf8.js'
import { bootServer as bootSharedServer } from './_helpers.js'

const SAVE_DOMAIN = 'deepview-triage-sync.v1.save'
const SUBSCRIBE_DOMAIN = 'deepview-triage-sync.v1.subscribe'
const OBJSTORE_PUT_DOMAIN = 'deepview-objstore.v1.put'

function b64url(bytes) { return Buffer.from(bytes).toString('base64url') }

async function makeKp() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { sk: kp.privateKey, tag: b64url(Buffer.from(jwk.x, 'base64url')) }
}

async function buildSave(sk, tag, base, plaintext) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)))
  const ciphertext = b64url(new TextEncoder().encode(plaintext))
  const payload = encodeUtf8([SAVE_DOMAIN, tag, base == null ? '' : String(base), '', nonce, ciphertext].join('\n'))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, payload))
  return { type: 'workspace-save', workspaceTag: tag, base, nonce, ciphertext, signature: b64url(sig) }
}

async function signSubscribe(sk, tag, from, connectionNonce) {
  const payload = encodeUtf8([SUBSCRIBE_DOMAIN, tag, from == null ? '' : String(from), connectionNonce].join('\n'))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, payload))
  return b64url(sig)
}

async function buildObjstorePut(sk, tag, resourceTag, prevVersion, prevIncarnation, expectedLength, contentHash, connectionNonce) {
  // Canonical encoding mirrors server/objstore/sign.ts:canonicalObjstorePut
  // (fields positional newline-joined; null prev_version → empty
  // string via `intOrEmpty`; null prev_incarnation → empty string via
  // `strOrEmpty`; the per-connection challenge nonce is the LAST field
  // — binds the signature to this TCP connection so a captured frame
  // can't replay from elsewhere). Field ORDER:
  //   domain, tag, resourceTag, prevVersion, prevIncarnation,
  //   contentHash, expectedLength, connectionNonce
  // (yes — contentHash precedes expectedLength here, and prevIncarnation
  // rides between prevVersion and contentHash; the order is load-bearing
  // and a swap silently fails verify.)
  const payload = encodeUtf8([
    OBJSTORE_PUT_DOMAIN,
    tag,
    resourceTag,
    prevVersion == null ? '' : String(prevVersion),
    prevIncarnation == null ? '' : String(prevIncarnation),
    contentHash,
    String(expectedLength),
    connectionNonce,
  ].join('\n'))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, payload))
  return b64url(sig)
}

// Per-connection helper. Collects every inbound frame in a queue so
// the test can pull it out by predicate without races against frames
// that arrived earlier (the server's `challenge` lands the moment
// the socket opens, before any test code can call `recv`).
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
      recv((m) => m.type === 'challenge', 5_000).then((challenge) => {
        resolve({ ws, recv, expectSilent, connectionNonce: challenge.nonce })
        return null
      }).catch((err) => reject(err))
    }, { once: true })
    ws.addEventListener('error', (event) => reject(event.error ?? new Error('websocket error')), { once: true })
  })
}

// Spin up a server with an optional `config.json` and return the URL +
// teardown hook. `configBody` of `undefined` means "no config.json"
// — exercises the no-config default (gate disabled). Each call gets
// its own temp dir so DB / config files don't leak between tests.
//
// Pre-writes the config file before calling the shared `bootServer`
// (which defaults CONFIG_PATH to `<dir>/config.json`); the shared
// helper handles spawn + listen + teardown + dir cleanup.
async function bootServer(configBody) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deepview-sync-auth-'))
  if (configBody !== undefined) {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify(configBody))
  }
  const server = await bootSharedServer({ dir })
  return {
    url: server.serverUrl,
    httpOrigin: server.httpOrigin,
    teardown: async () => {
      await server.teardown()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

// POST a save frame to the session-independent REST save plane.
async function postSave(httpOrigin, msg) {
  const res = await fetch(`${httpOrigin}/api/sync/save`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg),
  })
  let body = null
  try { body = await res.json() } catch {}
  return { status: res.status, body }
}

describe('triage-sync server: first-action password gate (no config)', () => {
  let server
  before(async () => { server = await bootServer(undefined) })
  after(async () => { await server.teardown() })

  it('save against a fresh tag succeeds without authenticate when no password is configured', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(server.url)
    const save = await buildSave(sk, tag, null, 'no-gate')
    c.ws.send(JSON.stringify(save))
    const ack = await c.recv((m) => m.type === 'workspace-save-ack' && m.workspaceTag === tag)
    assert.equal(ack.base, null)
    c.ws.close()
  })

  it('authenticate against an un-gated server still acks (so clients can replay a cached password idempotently)', async () => {
    const c = await connect(server.url)
    c.ws.send(JSON.stringify({ type: 'authenticate', password: 'anything' }))
    const ack = await c.recv((m) => m.type === 'authenticated')
    assert.deepEqual(ack, { type: 'authenticated' })
    c.ws.close()
  })
})

describe('triage-sync server: first-action password gate (password configured)', () => {
  let server
  const password = 'correct horse battery staple'
  before(async () => { server = await bootServer({ password }) })
  after(async () => { await server.teardown() })

  it('save against a fresh tag is blocked with unauthorized { kind: "gated", workspaceTag, base }', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(server.url)
    const save = await buildSave(sk, tag, null, 'gated-first-save')
    c.ws.send(JSON.stringify(save))
    const rej = await c.recv((m) => m.type === 'unauthorized')
    assert.equal(rej.kind, 'gated', 'unauthorized uses the explicit kind discriminator')
    assert.equal(rej.workspaceTag, tag, 'unauthorized carries the workspaceTag context')
    assert.equal(rej.base, null, 'unauthorized echoes the save base so the client can match its pending slot')
    assert.equal(rej.resourceTag, undefined, 'save-gating frame omits resourceTag')
    // The save MUST NOT have been committed — a subscribe should
    // return an empty chain. Use the same socket; the gate is per-
    // socket but the workspace existence check is global.
    const sig = await signSubscribe(sk, tag, null, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: sig }))
    await c.recv((m) => m.type === 'workspace-subscribed' && m.workspaceTag === tag)
    const chain = await c.recv((m) => m.type === 'workspace-state' && m.workspaceTag === tag)
    assert.deepEqual(chain.revisions, [], 'gated save did not commit')
    c.ws.close()
  })

  it('REST save against a fresh tag is blocked with 401 (new-workspace gate), nothing committed', async () => {
    // The REST plane has no socket to read operator-auth state from, so the
    // gate collapses to "password set AND workspace new" → 401. The SSE
    // client falls back to the in-band frame (which runs the auth flow).
    const { sk, tag } = await makeKp()
    const save = await buildSave(sk, tag, null, 'rest-gated-first')
    const { status, body } = await postSave(server.httpOrigin, save)
    assert.equal(status, 401)
    assert.equal(body.reason, 'unauthorized')
    // Not committed — a fresh subscriber sees an empty chain.
    const c = await connect(server.url)
    const sig = await signSubscribe(sk, tag, null, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: sig }))
    await c.recv((m) => m.type === 'workspace-subscribed' && m.workspaceTag === tag)
    const chain = await c.recv((m) => m.type === 'workspace-state' && m.workspaceTag === tag)
    assert.deepEqual(chain.revisions, [], 'gated REST save did not commit')
    c.ws.close()
  })

  it('REST save to an ALREADY-established workspace is allowed (gate is new-workspace-only)', async () => {
    const { sk, tag } = await makeKp()
    // Establish the workspace via an authenticated WS save.
    const c = await connect(server.url)
    c.ws.send(JSON.stringify({ type: 'authenticate', password }))
    await c.recv((m) => m.type === 'authenticated')
    c.ws.send(JSON.stringify(await buildSave(sk, tag, null, 'rest-gate-establish')))
    const ack1 = await c.recv((m) => m.type === 'workspace-save-ack' && m.workspaceTag === tag)
    c.ws.close()
    // A REST save against the now-existing workspace passes the gate (200).
    const save2 = await buildSave(sk, tag, ack1.id, 'rest-gate-followup')
    const { status, body } = await postSave(server.httpOrigin, save2)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
  })

  it('authenticate with the right password unlocks subsequent saves on the same socket', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(server.url)
    c.ws.send(JSON.stringify({ type: 'authenticate', password }))
    await c.recv((m) => m.type === 'authenticated')
    const save = await buildSave(sk, tag, null, 'post-auth-save')
    c.ws.send(JSON.stringify(save))
    const ack = await c.recv((m) => m.type === 'workspace-save-ack' && m.workspaceTag === tag)
    assert.equal(ack.base, null)
    c.ws.close()
  })

  it('authenticate with the wrong password emits unauthorized { kind: "auth-failed" } and leaves the socket open', async () => {
    const c = await connect(server.url)
    c.ws.send(JSON.stringify({ type: 'authenticate', password: 'nope' }))
    const rej = await c.recv((m) => m.type === 'unauthorized')
    assert.equal(rej.kind, 'auth-failed', 'wrong-password reply uses the auth-failed discriminator')
    assert.equal(rej.workspaceTag, undefined, 'auth-failed carries no workspaceTag')
    assert.equal(rej.base, undefined, 'auth-failed carries no base')
    assert.equal(rej.resourceTag, undefined, 'auth-failed carries no resourceTag')
    // Socket must still be alive — the user gets to retry.
    assert.equal(c.ws.readyState, WebSocket.OPEN)
    // A subsequent authenticate with the right password works.
    c.ws.send(JSON.stringify({ type: 'authenticate', password }))
    await c.recv((m) => m.type === 'authenticated')
    c.ws.close()
  })

  it('authenticate with a megabyte-sized password drops silently (length cap)', async () => {
    // handleAuthenticate is fast-inlined outside the per-socket
    // inflight cap, so without MAX_AUTH_PASSWORD_LEN a peer could
    // spam multi-MB strings and dominate the event loop on
    // HMAC.update(). Anything past the cap drops silently — same
    // wire-shape gate behaviour as every other malformed-frame
    // path (no reply, socket stays open).
    const c = await connect(server.url)
    const huge = 'x'.repeat(1024 * 1024) // 1 MiB
    c.ws.send(JSON.stringify({ type: 'authenticate', password: huge }))
    await c.expectSilent(200)
    // Socket is still usable for a normal-sized authenticate.
    c.ws.send(JSON.stringify({ type: 'authenticate', password }))
    await c.recv((m) => m.type === 'authenticated')
    c.ws.close()
  })

  it('once a workspace exists, a NEW unauthenticated connection can save against it without authenticating', async () => {
    const { sk, tag } = await makeKp()
    // Connection 1 — authenticate + create the workspace.
    const c1 = await connect(server.url)
    c1.ws.send(JSON.stringify({ type: 'authenticate', password }))
    await c1.recv((m) => m.type === 'authenticated')
    const save1 = await buildSave(sk, tag, null, 'create-via-c1')
    c1.ws.send(JSON.stringify(save1))
    const ack1 = await c1.recv((m) => m.type === 'workspace-save-ack' && m.workspaceTag === tag)
    c1.ws.close()
    // Connection 2 — fresh socket, no authenticate. Save extends the
    // existing chain (`base = ack1.id`) → gate does not fire.
    const c2 = await connect(server.url)
    const save2 = await buildSave(sk, tag, ack1.id, 'extend-via-c2')
    c2.ws.send(JSON.stringify(save2))
    const ack2 = await c2.recv((m) => m.type === 'workspace-save-ack' && m.workspaceTag === tag)
    assert.equal(ack2.base, ack1.id, 'second connection extended the existing chain without authenticating')
    c2.ws.close()
  })

  it('subscribe to an empty (never-created) workspace is NOT gated — returns an empty chain', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(server.url)
    const sig = await signSubscribe(sk, tag, null, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: sig }))
    const ack = await c.recv((m) => m.type === 'workspace-subscribed' && m.workspaceTag === tag)
    assert.equal(ack.workspaceTag, tag)
    const chain = await c.recv((m) => m.type === 'workspace-state' && m.workspaceTag === tag)
    assert.deepEqual(chain.revisions, [], 'subscribe to a never-created workspace is allowed (returns empty)')
    await c.expectSilent(150)
    c.ws.close()
  })

  it('objstore-put-begin against a fresh tag is blocked with unauthorized { kind: "gated", workspaceTag, resourceTag }', async () => {
    const { sk, tag } = await makeKp()
    // resourceTag must match server/objstore/store.ts:TAG_RE (base64url alphabet).
    const resourceTag = b64url(crypto.getRandomValues(new Uint8Array(16)))
    const expectedLength = 64
    // Content hash is 43 base64url chars (SHA-256 of 32 bytes, no padding).
    const contentHash = b64url(crypto.getRandomValues(new Uint8Array(32)))
    const c = await connect(server.url)
    const sig = await buildObjstorePut(sk, tag, resourceTag, null, null, expectedLength, contentHash, c.connectionNonce)
    c.ws.send(JSON.stringify({
      type: 'objstore-put-begin',
      workspaceTag: tag, resourceTag, prevVersion: null, prevIncarnation: null,
      expectedLength, contentHash, signature: sig,
    }))
    const rej = await c.recv((m) => m.type === 'unauthorized')
    assert.equal(rej.kind, 'gated', 'put-begin gating uses the explicit kind discriminator')
    assert.equal(rej.workspaceTag, tag)
    assert.equal(rej.resourceTag, resourceTag, 'unauthorized echoes the resourceTag so the put-begin awaiter can match')
    assert.equal(rej.base, undefined, 'put-begin-gating frame omits base')
    c.ws.close()
  })

  it('save with a BAD signature on a gated server still drops silently (gate check runs AFTER sig verify)', async () => {
    // Hostile-fuzz path: an attacker who learned the workspaceTag but
    // not the seed sends a bogus signature. The server must drop
    // silently, not respond with `unauthorized` — that would leak
    // both "this tag is gated" AND "you found a real listening socket"
    // to an unauthenticated attacker. The gate is INSIDE the
    // post-sig-verify block in handleSave.
    const { tag } = await makeKp()
    const c = await connect(server.url)
    c.ws.send(JSON.stringify({
      type: 'workspace-save',
      workspaceTag: tag,
      base: null,
      nonce: b64url(crypto.getRandomValues(new Uint8Array(12))),
      ciphertext: b64url(new TextEncoder().encode('attacker-payload')),
      // 64-byte bogus signature in base64url alphabet (the wire-gate
      // accepts the shape; verifyEd25519 rejects the bytes).
      signature: b64url(new Uint8Array(64).fill(0xab)),
    }))
    await c.expectSilent(200)
    c.ws.close()
  })

  it('authenticate with non-string password drops silently (wire-shape gate)', async () => {
    const c = await connect(server.url)
    c.ws.send(JSON.stringify({ type: 'authenticate', password: 12345 }))
    await c.expectSilent(200)
    // Socket still usable.
    c.ws.send(JSON.stringify({ type: 'authenticate', password }))
    await c.recv((m) => m.type === 'authenticated')
    c.ws.close()
  })

  it('concurrent unauthenticated saves on a fresh tag both block (no commit slips through)', async () => {
    // Documented race: `workspaceExists` reads at a different moment
    // than the commit (a TOCTOU, no lock spanning the two), so under
    // concurrent saves a second unauthenticated socket COULD see
    // workspace=exists if an authenticated peer committed in between.
    // The mixed-auth race is acceptable
    // (worst case: two concurrent writes both authorising). But two
    // simultaneously UNAUTHENTICATED saves against the same fresh
    // tag must both be blocked — neither has any way to advance the
    // tag past `workspaceExists=false`. Pin that here.
    const { sk, tag } = await makeKp()
    const save = await buildSave(sk, tag, null, 'concurrent-unauth')
    const cA = await connect(server.url)
    const cB = await connect(server.url)
    cA.ws.send(JSON.stringify(save))
    cB.ws.send(JSON.stringify(save))
    const rejA = await cA.recv((m) => m.type === 'unauthorized')
    const rejB = await cB.recv((m) => m.type === 'unauthorized')
    assert.equal(rejA.kind, 'gated')
    assert.equal(rejB.kind, 'gated')
    // And neither commit landed: a fresh connection's subscribe
    // returns an empty chain.
    const cCheck = await connect(server.url)
    const sig = await signSubscribe(sk, tag, null, cCheck.connectionNonce)
    cCheck.ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: sig }))
    await cCheck.recv((m) => m.type === 'workspace-subscribed' && m.workspaceTag === tag)
    const chain = await cCheck.recv((m) => m.type === 'workspace-state' && m.workspaceTag === tag)
    assert.deepEqual(chain.revisions, [], 'two simultaneous unauth saves left the tag empty')
    cA.ws.close(); cB.ws.close(); cCheck.ws.close()
  })

  it('blocked objstore-put-begin does NOT establish workspace existence (no staging row, no committed row)', async () => {
    // The gate's `workspaceExists` check reads workspace_revision +
    // workspace_object (committed rows), NOT workspace_object_staging
    // (in-flight uploads) — see `countLive` SQL in
    // server/objstore/store.ts. Two separate invariants matter here:
    //   (a) a blocked put-begin inserts NO staging row at all (the
    //       sig-verify-then-gate ordering bails before beginPut), so
    //       even an attacker who could persuade `workspaceExists` to
    //       read staging would find nothing to bypass with;
    //   (b) even if a staging row existed, it would be invisible to
    //       the gate (`countLive` queries `workspace_object`).
    // Together: a blocked put-begin cannot be parlayed into a bypass
    // for a follow-up save on a different socket. Pin (a) directly.
    const { sk, tag } = await makeKp()
    const resourceTag = b64url(crypto.getRandomValues(new Uint8Array(16)))
    const contentHash = b64url(crypto.getRandomValues(new Uint8Array(32)))
    const c1 = await connect(server.url)
    const putSig = await buildObjstorePut(sk, tag, resourceTag, null, null, 64, contentHash, c1.connectionNonce)
    c1.ws.send(JSON.stringify({
      type: 'objstore-put-begin',
      workspaceTag: tag, resourceTag, prevVersion: null, prevIncarnation: null,
      expectedLength: 64, contentHash, signature: putSig,
    }))
    await c1.recv((m) => m.type === 'unauthorized' && m.kind === 'gated')
    c1.ws.close()
    // A separate fresh connection's save against the same tag must
    // still be gated — the put-begin landed nothing on disk.
    const c2 = await connect(server.url)
    const save = await buildSave(sk, tag, null, 'still-gated')
    c2.ws.send(JSON.stringify(save))
    const rej = await c2.recv((m) => m.type === 'unauthorized')
    assert.equal(rej.kind, 'gated', 'workspace is still considered new after a blocked put-begin')
    c2.ws.close()
  })
})

describe('triage-sync server: malformed config', () => {
  it('startup fails loud on a non-JSON config file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'deepview-sync-auth-bad-'))
    const configPath = path.join(dir, 'config.json')
    writeFileSync(configPath, 'not json {')
    const proc = spawn(process.execPath, ['server/index.ts'], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DB_PATH: path.join(dir, 'data.db'), CONFIG_PATH: configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      let stderr = ''
      proc.stderr.on('data', (d) => { stderr += String(d) })
      const code = await new Promise((resolve) => { proc.once('exit', resolve) })
      assert.notEqual(code, 0, 'server exits non-zero on malformed config')
      assert.match(stderr, /Failed to parse/u, 'stderr explains the parse failure')
    } finally {
      if (proc.exitCode == null) proc.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('startup fails loud when password is a non-string non-null value', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'deepview-sync-auth-typed-'))
    const configPath = path.join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ password: 1234 }))
    const proc = spawn(process.execPath, ['server/index.ts'], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DB_PATH: path.join(dir, 'data.db'), CONFIG_PATH: configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      let stderr = ''
      proc.stderr.on('data', (d) => { stderr += String(d) })
      const code = await new Promise((resolve) => { proc.once('exit', resolve) })
      assert.notEqual(code, 0, 'server exits non-zero on typed password')
      assert.match(stderr, /password.*string/iu, 'stderr explains the type requirement')
    } finally {
      if (proc.exitCode == null) proc.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
