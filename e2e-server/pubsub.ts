// Cross-instance pub/sub for real-time WS broadcasts. The triage-sync
// fan-out is an in-memory subscriber map (e2e-server/hub.ts) by design — it
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
// identifier (no quoting / special chars). Exported so tests stay in
// sync with the production channel name (one constant, one source).
export const CHANNEL = 'triage_bus'

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

// Receiver wired up by the hub layer (see e2e-server/index.ts). Each handler
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
  // The current Client. Assigned EARLY in `tryConnect` (before
  // `c.connect()` is awaited) so two invariants hold:
  //   (a) `c.once('error', ...)`'s `state.client === c` gate passes
  //       for errors that fire between `c.connect()` resolving and
  //       `c.query('LISTEN …')` resolving (the error listener can
  //       only attach AFTER connect returns, so errors strictly
  //       DURING connect are still observed via the connect Promise
  //       rejecting — the gate matters for the LISTEN window).
  //   (b) `stop()` can read `state.client` and call `c.end()` to abort
  //       an in-flight `await c.connect()` / `await c.query('LISTEN …')`
  //       — without this, a network blackhole during handshake makes
  //       SIGTERM hang indefinitely on the connect await.
  // Cleared by `tryConnect`'s catch on failure, and by `stop()` /
  // `reconnect()` when they replace the client.
  client: NeonClient | null
  handler: BusHandler | null
  stopped: boolean
  // Tracks the in-flight (re)connect attempt so `stop()` can await it —
  // otherwise a SIGTERM mid-reconnect would race the Client teardown
  // and leak the underlying WebSocket.
  connectAttempt: Promise<void> | null
  // Reconnect retry counter, reset to 0 after a successful LISTEN.
  attempt: number
  // Set while the loop is parked in `await sleep(delay)` during a
  // reconnect backoff. `stop()` calls it (if present) to kick the
  // loop out IMMEDIATELY rather than waiting up to `capMs` (30 s
  // default) for the timer to fire. Cleared when the sleep returns.
  cancelSleep: (() => void) | null
  // In-flight bus-message handler promises. `dispatchNotification`
  // fires handlers fire-and-forget, but `stop()` awaits this set before
  // returning so the lifecycle's `handle.close()` (which runs after
  // `pubsub.stop()` — see closeDb in e2e-server/index.ts) can't race a
  // handler mid-`handle.revisionById.get` / `getLive`.
  pendingHandlers: Set<Promise<void>>
}

// Notification dispatch. Filters foreign channels (defensive) and our
// own publish round-trip (Postgres NOTIFY delivers to publishers too).
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
  // Tracked in `state.pendingHandlers` so `stop()` drains in-flight
  // handlers before the lifecycle closes the DB handle (see that
  // field's doc).
  const promise: Promise<void> = fn(msg).catch((err) => {
    console.warn('pubsub: handler error:', errStack(err))
  }).finally(() => { state.pendingHandlers.delete(promise) })
  state.pendingHandlers.add(promise)
}

// Single connect attempt. Resolves once LISTEN is registered, rejects
// on transport / LISTEN failure. Assigns `state.client = c` EAGERLY
// (before awaiting `c.connect()`) for the invariants on
// `NeonState.client`.
async function tryConnect(state: NeonState): Promise<void> {
  const c = state.newClient()
  state.client = c
  try {
    await c.connect()
    c.on('notification', (n) => dispatchNotification(state, n))
    // Transport-level error → reconnect trigger. Defer to a microtask
    // so the current notification (if any) finishes before we replace
    // the client. The `state.client === c` gate skips stale error
    // events from PREVIOUS clients we've already torn down.
    c.once?.('error', (err: Error) => {
      if (state.debug) console.warn('pubsub: client error:', errStack(err))
      queueMicrotask(() => { if (state.client === c) void reconnect(state) })
    })
    await c.query(`LISTEN ${CHANNEL}`)
  } catch (err) {
    // Clear `state.client` only if it still points at OUR client — a
    // racing `stop()` may have already null'd it and ended the
    // half-connected socket; don't clobber that. The `c.end()` below
    // may then be a redundant second call, but pg-style Client.end()
    // is idempotent (and the try/catch absorbs any rejection).
    if (state.client === c) state.client = null
    try { await c.end() } catch {}
    throw err
  }
}

// Outer (re)connect loop. Exits silently on `state.stopped`; otherwise
// retries with exponential backoff after a connect / LISTEN failure.
// `tryConnect` owns `state.client`, so this loop only counts attempts
// and runs the backoff sleep.
async function connectAndListen(state: NeonState): Promise<void> {
  // oxlint-disable-next-line no-unmodified-loop-condition
  while (!state.stopped) {
    try {
      await tryConnect(state)
      state.attempt = 0
      if (state.debug) console.log(`pubsub: LISTEN ${CHANNEL} (sender ${state.senderId})`)
      return
    } catch (err) {
      if (state.stopped) return
      state.attempt += 1
      const delay = Math.min(state.capMs, state.baseMs * 2 ** Math.min(state.attempt - 1, 8))
      console.warn(`pubsub: connect failed (attempt ${state.attempt}), retrying in ${delay}ms:`, errStack(err))
      await cancellableSleep(state, delay)
    }
  }
}

// Sleep that `stop()` can wake up. Without the cancel hook, a SIGTERM
// landing mid-backoff would stall shutdown for up to `capMs` (30 s
// default) waiting on the timer. We stash the cancel callback on the
// shared state object so `stop()` can fire it; the loop's
// `if (state.stopped) return` then exits on the next turn. The
// `settled` flag guards the timer-vs-`stop()` wake-up race: resolves
// are idempotent at runtime, but it also satisfies oxlint's stricter
// `no-multiple-resolved` and documents the mutual exclusion.
function cancellableSleep(state: NeonState, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      state.cancelSleep = null
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    state.cancelSleep = () => { clearTimeout(timer); finish() }
  })
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
    connectAttempt: null, attempt: 0, cancelSleep: null,
    pendingHandlers: new Set(),
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
      // Null `handler` BEFORE the awaits so any notification that
      // sneaks in (between `c.end()` and the socket actually closing)
      // sees no handler and drops in `dispatchNotification`.
      state.handler = null
      // Kick the loop out of its backoff sleep IMMEDIATELY rather than
      // letting `stop()` block for up to `capMs` (30 s default) on the
      // timer. The loop's `if (state.stopped) return` runs on the next
      // turn and exits cleanly.
      state.cancelSleep?.()
      // End the current client to abort an in-flight handshake (cancels
      // a hung `await c.connect()` / `await c.query('LISTEN …')` so
      // `stop()` doesn't hang on a Neon WS blackhole) OR close an
      // established LISTEN session. With `tryConnect`'s eager assign,
      // `state.client` covers both cases via the same field.
      const c = state.client
      state.client = null
      if (c) { try { await c.end() } catch {} }
      // Now wait for the (now-aborted-if-applicable) connect attempt to
      // unwind through its catch and resolve.
      if (state.connectAttempt) { try { await state.connectAttempt } catch {} }
      // Drain in-flight bus-message handlers BEFORE returning. The
      // lifecycle teardown runs `pubsub.stop()` and THEN
      // `handle.close()` (see closeDb in e2e-server/index.ts); a handler
      // still in `handle.revisionById.get` / `getLive` would otherwise
      // throw against a closed DB. `allSettled` so one handler's
      // rejection doesn't abort the drain.
      if (state.pendingHandlers.size > 0) {
        await Promise.allSettled([...state.pendingHandlers])
      }
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
