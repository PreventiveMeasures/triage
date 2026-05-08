// DeepView triage-sync relay server. WebSocket front-end, SQLite
// backing store. Implements the protocol described in
// `ui/view/triage-sync.js` (and `server/sign.js` for the canonical
// signature payloads):
//
//   client → server  workspace-save      { workspaceTag, base,
//                                          nonce, ciphertext, signature }
//   client → server  workspace-subscribe { workspaceTag, signature }
//   server → client  workspace-save-ack  { workspaceTag, base, id }
//   server → client  workspace-state     { workspaceTag, revisions:
//                                          [{ base, id, nonce,
//                                             ciphertext, signature }, ...] }
//
// Authentication: every signed message is checked against the
// `workspaceTag` (= base64url Ed25519 public key) before any
// state mutation. Unsigned / bad-sig messages are dropped silently
// — the legitimate signer will retry, and an attacker who learns
// the tag without holding the seed can't get past the verify.
//
// Content opacity: `nonce` and `ciphertext` are opaque to the
// server. We store and forward them; we never inspect.
//
// Subscriber tracking: `subscribers: Map<workspaceTag, Set<socket>>`.
// A socket joins the set when it sends any signed message for the
// tag (save or subscribe). It leaves on disconnect. Broadcasts go
// to every subscriber for the workspaceTag except the originator.

import { WebSocketServer } from 'ws'
import { argv, env } from 'node:process'
import { openDb, headFor, chainFrom, insertRevision } from './db.js'
import { verifySaveSig, verifySubscribeSig } from './sign.js'

const PORT = Number(env.PORT ?? 8765)
const HOST = env.HOST ?? '127.0.0.1'
const DB_PATH = env.DB_PATH ?? new URL('./data.db', import.meta.url).pathname
const DEBUG = env.DEBUG === '1'

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: node server/index.js
Environment:
  PORT     listen port (default 8765)
  HOST     bind host (default 127.0.0.1)
  DB_PATH  sqlite file (default server/data.db)
  DEBUG=1  log every message`)
  process.exit(0)
}

const handle = openDb(DB_PATH)

// workspaceTag → Set<WebSocket>
const subscribers = new Map()
// WebSocket → Set<workspaceTag> — for cleanup on disconnect
const socketTags = new WeakMap()

function subscribe(socket, tag) {
  let set = subscribers.get(tag)
  if (!set) {
    set = new Set()
    subscribers.set(tag, set)
  }
  set.add(socket)
  let tags = socketTags.get(socket)
  if (!tags) {
    tags = new Set()
    socketTags.set(socket, tags)
  }
  tags.add(tag)
}

function unsubscribeAll(socket) {
  const tags = socketTags.get(socket)
  if (!tags) return
  for (const tag of tags) {
    const set = subscribers.get(tag)
    if (!set) continue
    set.delete(socket)
    if (set.size === 0) subscribers.delete(tag)
  }
}

function send(socket, msg) {
  if (socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify(msg))
}

function broadcast(tag, msg, except) {
  const set = subscribers.get(tag)
  if (!set) return
  for (const s of set) {
    if (s === except) continue
    send(s, msg)
  }
}

async function handleSave(socket, msg) {
  if (typeof msg.workspaceTag !== 'string') return
  if (typeof msg.nonce !== 'string') return
  if (typeof msg.ciphertext !== 'string') return
  const ok = await verifySaveSig(msg)
  if (!ok) {
    if (DEBUG) console.warn('reject save: bad signature', msg.workspaceTag.slice(0, 12) + '…')
    return
  }
  const tag = msg.workspaceTag
  // Sender is now an authenticated subscriber for this tag.
  subscribe(socket, tag)
  const head = headFor(handle, tag)
  const baseNorm = msg.base ?? null
  const matches = baseNorm == null ? head == null : baseNorm === head
  if (!matches) {
    // Stale base — send catch-up chain. Client rebases and
    // retries with the fresh head.
    const revisions = chainFrom(handle, tag, baseNorm)
    if (DEBUG) console.log(`save (stale base ${baseNorm} vs head ${head}) → chain ${revisions.length}`)
    send(socket, { type: 'workspace-state', workspaceTag: tag, revisions })
    return
  }
  // Append a new revision. id is monotonic per tag.
  const newId = (head ?? 0) + 1
  insertRevision(handle, {
    tag,
    id: newId,
    base: baseNorm,
    nonce: msg.nonce,
    ciphertext: msg.ciphertext,
    signature: msg.signature,
  })
  if (DEBUG) console.log(`save → revision ${newId} for ${tag.slice(0, 12)}…`)
  send(socket, {
    type: 'workspace-save-ack',
    workspaceTag: tag,
    base: baseNorm,
    id: newId,
  })
  broadcast(tag, {
    type: 'workspace-state',
    workspaceTag: tag,
    revisions: [{
      base: baseNorm,
      id: newId,
      nonce: msg.nonce,
      ciphertext: msg.ciphertext,
      signature: msg.signature,
    }],
  }, socket)
}

async function handleSubscribe(socket, msg) {
  if (typeof msg.workspaceTag !== 'string') return
  const ok = await verifySubscribeSig(msg)
  if (!ok) {
    if (DEBUG) console.warn('reject subscribe: bad signature', msg.workspaceTag.slice(0, 12) + '…')
    return
  }
  const tag = msg.workspaceTag
  subscribe(socket, tag)
  // `from` is the last revision id the client claims to have
  // applied; we send only revisions newer than that. Client lying
  // about `from` just means they get a smaller catch-up — their
  // subsequent saves will reveal stale state on the usual
  // base-mismatch path. Null / missing → send the full chain.
  const fromBase = typeof msg.from === 'number' ? msg.from : null
  const revisions = chainFrom(handle, tag, fromBase)
  if (DEBUG) console.log(`subscribe ${tag.slice(0, 12)}… from=${fromBase} → chain ${revisions.length}`)
  send(socket, { type: 'workspace-state', workspaceTag: tag, revisions })
}

const wss = new WebSocketServer({ port: PORT, host: HOST })

wss.on('connection', (socket, req) => {
  if (DEBUG) console.log(`connect from ${req.socket.remoteAddress}`)
  socket.on('message', async (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (!msg || typeof msg !== 'object') return
    try {
      if (msg.type === 'workspace-save') await handleSave(socket, msg)
      else if (msg.type === 'workspace-subscribe') await handleSubscribe(socket, msg)
    } catch (err) {
      console.warn('Handler error:', err)
    }
  })
  socket.on('close', () => unsubscribeAll(socket))
  socket.on('error', () => {})
})

wss.on('listening', () => {
  console.log(`DeepView triage-sync server: ws://${HOST}:${PORT} (db: ${DB_PATH})`)
})

function shutdown() {
  console.log('Shutting down…')
  wss.close()
  try { handle.close() } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
