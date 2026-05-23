// Cross-instance pub/sub for real-time WS broadcasts. The triage-sync
// fan-out is an in-memory subscriber map (server/hub.ts) by design — it
// routes a commit only to peers on the SAME instance. A multi-instance
// deployment behind a load balancer needs commit-landed-on-A to reach
// peers-on-B with the same latency the hub gives same-instance peers.
//
// SQLite mode is single-process by construction (the local FS objstore
// can't back two writers), so it ships a no-op PubSub.
//
// Neon mode uses Postgres LISTEN/NOTIFY on a dedicated long-lived
// WebSocket connection (the `Client` form of `@neondatabase/serverless`,
// session-bound and notification-aware — the HTTP `neon()` callable used
// for normal queries is stateless and can't LISTEN). Each instance:
//   - At start: opens a Client, LISTENs on the bus channel, dispatches
//     notifications. Reconnects on transport failure with backoff.
//   - On publish*: fire-and-forget `SELECT pg_notify(channel, payload)`.
//   - Filters its own notifications by a per-process random sender id —
//     Postgres delivers NOTIFY back to publishers that LISTEN on the
//     same channel, and a local broadcast already happened before the
//     bus publish, so re-broadcasting our own would echo.
//
// Postgres NOTIFY caps the payload at ~8 KB by default (NAMEDATALEN-
// derived; can't be raised on a managed endpoint). The triage
// `workspace-state` envelope carries a ciphertext up to MAX_CIPHERTEXT_LEN
// (2 MiB), so the workspace-revision channel ships only `(tag, revisionId)`
// and the receiver re-fetches the row from the shared workspace_revision
// table to construct the wire broadcast. Objstore-put broadcasts likewise
// ship `(tag, resourceTag)` and the receiver re-fetches from
// workspace_object. Objstore-deleted broadcasts inline the (tag,
// resourceTag, version) tuple — the row is gone from the DB, so the
// payload IS the wire data.

import { randomBytes } from 'node:crypto'
import { errStack } from './util.ts'

// One bus channel for all three message kinds; the receiver discriminates
// on the `kind` field. Single LISTEN keeps the Client wiring trivial and
// avoids a `kind`-per-channel decision tree. Channel name doubles as the
// SQL identifier we LISTEN on, so it MUST stay a valid Postgres
// identifier (no quoting / special chars).
const CHANNEL = 'triage_bus'

// Sender id is a per-process random value stamped into every outbound
// payload so the LISTENing connection on the SAME process can skip its
// own notifications. 12 bytes / 16 chars base64url — collision odds
// across any realistic cluster size are astronomical.
function newSenderId(): string {
  return randomBytes(12).toString('base64url')
}

// JSON-encoded NOTIFY payloads. Each kind documents the minimum info
// the receiver needs:
//   - 'rev': workspace-state broadcast. `id` is the revision id; the
//     receiver SELECTs the full row by (tag, id) — the payload size
//     budget can't carry the ciphertext.
//   - 'objput': objstore-put broadcast. `res` is the resource tag; the
//     receiver SELECTs the live row by (tag, res) for the rest of the
//     metadata fields.
//   - 'objdel': objstore-deleted broadcast. `ver` is the deleted version
//     — inline because the row is gone from workspace_object after the
//     delete commit.
export type BusMessage =
  | { kind: 'rev'; tag: string; id: string }
  | { kind: 'objput'; tag: string; res: string }
  | { kind: 'objdel'; tag: string; res: string; ver: number }

// Receiver wired up by the hub layer (see server/index.ts). Each handler
// runs once per remote message; failures are logged but don't crash the
// LISTEN loop — a missed broadcast surfaces to clients on reconnect
// (chain re-pull). Async because the workspace-revision handler does a
// DB lookup before broadcasting.
export type BusHandler = (msg: BusMessage) => Promise<void>

export type PubSub = {
  // Resolves once LISTEN is active (Client connected + LISTEN
  // acknowledged). Implementations should auto-reconnect on transport
  // failure — publishes during the down window drop on the floor.
  start: (onMessage: BusHandler) => Promise<void>
  publish: (msg: BusMessage) => void
  stop: () => Promise<void>
}

export function createNoopPubSub(): PubSub {
  return {
    // eslint-disable-next-line require-await
    start: async () => {},
    publish: () => {},
    // eslint-disable-next-line require-await
    stop: async () => {},
  }
}

// Minimal structural shape of the `Client` form of
// `@neondatabase/serverless` — pg-compatible, with `notification` events
// and a connect/end lifecycle. We declare only the surface we touch so
// the optional peer dep stays optional (no top-level static type
// imports). The full driver type set is much larger; this slice is what
// the LISTEN loop relies on.
export type NeonClient = {
  connect: () => Promise<void>
  query: (text: string, params?: readonly unknown[]) => Promise<unknown>
  end: () => Promise<void>
  on: (event: 'notification', listener: (msg: { channel: string; payload?: string }) => void) => void
  // The driver also emits 'error' on transport failures we need to
  // observe to drive reconnection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once?: (event: string, listener: (...args: any[]) => void) => void
}

export type NeonClientCtor = new (connectionString: string) => NeonClient

export type NeonPubSubDeps = {
  // Factory returning a fresh Client. Pulled out as a dep so:
  //   (a) the optional peer dep stays optional (callers import lazily),
  //   (b) tests can swap in a PGlite-backed shim that exercises the
  //       publish + LISTEN loop on a single connection.
  newClient: () => NeonClient
  debug: boolean
  // Initial-connect backoff seed and cap. Defaults are reasonable for
  // production; tests override with small values to keep the suite fast.
  reconnectBaseMs?: number
  reconnectCapMs?: number
}

// Mutable state of one `createNeonPubSub` instance. Held in a single
// object so the LISTEN-loop helpers (`tryConnect` / `connectAndListen` /
// `reconnect`) can be defined at module scope rather than nested inside
// the factory — keeps `createNeonPubSub` itself under the 80-line cap.
type NeonState = {
  newClient: () => NeonClient
  debug: boolean
  baseMs: number
  capMs: number
  senderId: string
  client: NeonClient | null
  handler: BusHandler | null
  stopped: boolean
  // Tracks the in-flight (re)connect attempt so `stop()` can await it —
  // otherwise a SIGTERM mid-reconnect would race the Client teardown
  // and leak the underlying WebSocket.
  connectAttempt: Promise<void> | null
  // Reconnect retry counter, reset to 0 after a successful LISTEN.
  attempt: number
}

// Notification dispatch — closes over `state.senderId` and
// `state.handler`. Filters foreign channels (defensive) and our own
// publish round-trip (Postgres NOTIFY delivers to publishers too).
function dispatchNotification(state: NeonState, n: { channel: string; payload?: string }): void {
  if (n.channel !== CHANNEL) return
  if (typeof n.payload !== 'string') return
  let parsed: { sender?: unknown; kind?: unknown } & Record<string, unknown>
  try { parsed = JSON.parse(n.payload) as typeof parsed }
  catch { return }
  if (parsed.sender === state.senderId) return
  const msg = parseBusMessage(parsed)
  if (!msg) return
  const fn = state.handler
  if (!fn) return
  // Fire-and-forget: a slow handler can't block the Client's
  // notification dispatch (which would queue further notifications
  // behind it). Errors are logged but don't kill the loop — a missed
  // broadcast surfaces to clients on reconnect via the chain re-pull.
  void fn(msg).catch((err) => { console.warn('pubsub: handler error:', errStack(err)) })
}

// Single connect attempt. Resolves with the connected+listening Client
// or rejects on transport / LISTEN failure (the half-connected client
// is `end()`-ed before the rejection escapes).
async function tryConnect(state: NeonState): Promise<NeonClient> {
  const c = state.newClient()
  try {
    await c.connect()
    c.on('notification', (n) => dispatchNotification(state, n))
    // Transport-level error → reconnect trigger. Defer to a microtask
    // so the current notification (if any) finishes before we replace
    // the client.
    c.once?.('error', (err: Error) => {
      if (state.debug) console.warn('pubsub: client error:', errStack(err))
      queueMicrotask(() => { if (state.client === c) void reconnect(state) })
    })
    await c.query(`LISTEN ${CHANNEL}`)
    return c
  } catch (err) {
    try { await c.end() } catch {}
    throw err
  }
}

// Outer (re)connect loop. Exits silently on `state.stopped`; otherwise
// retries with exponential backoff after a connect / LISTEN failure.
async function connectAndListen(state: NeonState): Promise<void> {
  // oxlint-disable-next-line no-unmodified-loop-condition
  while (!state.stopped) {
    try {
      state.client = await tryConnect(state)
      state.attempt = 0
      if (state.debug) console.log(`pubsub: LISTEN ${CHANNEL} (sender ${state.senderId})`)
      return
    } catch (err) {
      if (state.stopped) return
      state.attempt += 1
      const delay = Math.min(state.capMs, state.baseMs * 2 ** Math.min(state.attempt - 1, 8))
      console.warn(`pubsub: connect failed (attempt ${state.attempt}), retrying in ${delay}ms:`, errStack(err))
      await sleep(delay)
    }
  }
}

async function reconnect(state: NeonState): Promise<void> {
  if (state.stopped) return
  const old = state.client
  state.client = null
  if (old) { try { await old.end() } catch {} }
  if (state.connectAttempt) return  // a connect is already running
  state.connectAttempt = connectAndListen(state).finally(() => { state.connectAttempt = null })
  await state.connectAttempt
}

// Neon-mode PubSub. Holds ONE Client for LISTEN (long-lived WebSocket)
// and reuses it for publish (`pg_notify` from the same session — no
// need for a separate write connection, and binds the publish-vs-notify
// ordering: a NOTIFY a peer publishes RIGHT AFTER a save commit is
// guaranteed to follow the commit in WAL order from the peer's POV).
//
// Reconnection: on transport error the loop retries with exponential
// backoff. Publishes during the down window are dropped — they're a
// best-effort fan-out, not a durability mechanism. The DB is the
// source of truth; a client whose peer missed a live broadcast catches
// up via the chain on its next subscribe.
export function createNeonPubSub(deps: NeonPubSubDeps): PubSub {
  const state: NeonState = {
    newClient: deps.newClient, debug: deps.debug,
    baseMs: deps.reconnectBaseMs ?? 1_000,
    capMs: deps.reconnectCapMs ?? 30_000,
    senderId: newSenderId(),
    client: null, handler: null, stopped: false,
    connectAttempt: null, attempt: 0,
  }
  return {
    start: async (onMessage) => {
      state.handler = onMessage
      state.connectAttempt = connectAndListen(state)
      await state.connectAttempt.finally(() => { state.connectAttempt = null })
    },
    publish: (msg) => publish(state, msg),
    stop: async () => {
      state.stopped = true
      state.handler = null
      // Wait for any in-flight (re)connect to settle so we don't end()
      // a client mid-handshake. The loop exits at its `if (stopped)`
      // check; we then close whatever client landed.
      if (state.connectAttempt) { try { await state.connectAttempt } catch {} }
      const c = state.client
      state.client = null
      if (c) { try { await c.end() } catch {} }
    },
  }
}

function publish(state: NeonState, msg: BusMessage): void {
  const c = state.client
  if (!c) {
    if (state.debug) console.warn('pubsub: publish dropped (no client):', msg.kind, msg.tag.slice(0, 12))
    return
  }
  // `pg_notify(text, text)` is the parameter-bound form of NOTIFY —
  // the bare `NOTIFY` statement doesn't accept params. The envelope
  // carries the sender id so the LISTENing connection on this same
  // process filters its own publishes (Postgres delivers NOTIFY back
  // to publishers too).
  const envelope = JSON.stringify({ sender: state.senderId, ...msg })
  // Fire-and-forget. A failed publish only means peers on OTHER
  // instances miss THIS event — local fan-out already happened before
  // this call. Log + continue (the bus is a best-effort accelerator,
  // not a durability layer).
  c.query(`SELECT pg_notify($1, $2)`, [CHANNEL, envelope]).catch((err) => {
    if (state.debug) console.warn('pubsub: publish error:', errStack(err))
  })
}

// Narrow a parsed JSON object into a typed BusMessage. Rejects anything
// missing required fields, with non-string tag/id/res, or a non-integer
// version. Defensive against bus poisoning by a peer running an older /
// custom build.
function parseBusMessage(raw: Record<string, unknown>): BusMessage | null {
  const tag = raw['tag']
  const kind = raw['kind']
  if (typeof tag !== 'string') return null
  if (kind === 'rev') {
    const id = raw['id']
    if (typeof id !== 'string') return null
    return { kind: 'rev', tag, id }
  }
  if (kind === 'objput') {
    const res = raw['res']
    if (typeof res !== 'string') return null
    return { kind: 'objput', tag, res }
  }
  if (kind === 'objdel') {
    const res = raw['res']
    const ver = raw['ver']
    if (typeof res !== 'string') return null
    if (typeof ver !== 'number' || !Number.isSafeInteger(ver)) return null
    return { kind: 'objdel', tag, res, ver }
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })
}
