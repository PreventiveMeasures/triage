import { type TriageBucket, state } from './state.ts'
import { saveTriage } from './triage.js'
import { listWorkspaces, onReportMembershipChanged, onWorkspaceDeleted, onWorkspacePrivateKeyChanged } from './workspaces.js'
import { RECOVERABLE_SAVE_ERROR_REASONS } from '../common/save-error-reason.ts'
import {
  type SavePayload,
  buildAad,
  computeRevisionId,
  decryptJson,
  deriveSessionKey,
  deriveSigningKeypair,
  encryptJson,
  signSavePayload,
  signSubscribePayload,
  verifySavePayload,
} from './sync-crypto.ts'

// Triage sync — per-workspace WebSocket protocol with revision-tracked
// changesets. Disabled by default. `setServerUrl(url)` enables; the
// saved URL also persists in localStorage for next page-load. With
// no URL the session machinery still tracks state internally but no
// message is ever sent — flipping the URL on later resumes from the
// live local state.
//
// Layered design
// --------------
// `notify()` is the only public mutation hook. It's called at the
// tail of `saveTriage()` (so every UI / API mutation routes through
// it) and reads the current `state.markers` / `.triageState` /
// `.comments` / `.fixes` / `.ignoredIds` for the workspace's id
// scope to derive `localState`.
//
// The session keeps two triage state objects (each a plain
// `{ id: { color?, triage?, comment?, fix?, ignoredReports? } }`
// map):
//   baseState     last server-acknowledged state.
//   localState    user's current view (= baseState + their edits
//                 since the last ack).
// A changeset between two states is `{ id: entry | null }` where
// `null` means "drop this id". `applyChangeset` and `computeChangeset`
// are pure helpers that translate between state form and changeset
// form; the wire layer never sees a full state, only changesets.
//
// Wire shape
// ----------
//   client → server  workspace-save       { workspaceTag, base,
//                                            keyframe?, nonce,
//                                            ciphertext, signature }
//   client → server  workspace-subscribe  { workspaceTag, from, signature }
//   server → client  workspace-subscribed { workspaceTag }
//   server → client  workspace-save-ack   { workspaceTag, base, id }
//   server → client  workspace-state      { workspaceTag, revisions:
//                                            [{ base, id, keyframe,
//                                               nonce, ciphertext,
//                                               signature }, ...] }
//
// The `keyframe` flag promotes a save's ciphertext from "delta
// against base" to "full state" — the client emits one every
// `keyframeInterval` non-keyframe revisions, and the server uses
// it as the catch-up root for `from=null` subscribers. Bound into
// the signed canonical bytes (see sync-crypto.ts's
// `canonicalSavePayload`), so the wire flag MUST match the signed
// flag — the server can't relabel a normal save as a keyframe.
//
// `workspace-subscribed` is sent right after the server registers
// the client as a peer for the workspace; `workspace-state` (with
// the catch-up chain) follows. The ack lets the client distinguish
// "WS open" from "subscribe accepted" — the latter is what
// determines whether broadcasts will actually reach us.
//
// `workspaceTag` is the base64url-encoded Ed25519 public key derived
// from the workspace's private key + UUID — see sync-crypto.ts's
// `deriveSigningKeypair`. The server uses it to route messages and
// to verify each save's `signature` before accepting it as a
// revision. Receivers verify the same way. Holders of the workspace's
// private key are the authorized writers; everyone else fails the
// signature check.
//
// `workspace-save-ack` confirms that the client's pending save with
// `base` was accepted as revision `id`. The client already holds the
// changeset (it's `pending.changeset`), so the ack only carries
// metadata.
//
// `workspace-state` is a chain the client applies in order — used for
// initial sync (the first server response when client base=null),
// broadcasts of other clients' changes, and stale-base catch-ups
// after a rejected save. Each revision carries `base` so the client
// can verify continuity. If the client has a `pending` save when a
// chain arrives, that save is treated as rejected: pending.changeset
// is recomputed against the new baseState (preserving the user's
// intent) and re-sent.
//
// Race protocol
// -------------
// One in-flight request per session. Local edits during inFlight
// raise `pendingSave` and flush on the next reply. Every chain /
// ack rebases: the user's overlay (= localState - baseState) is
// captured before swapping baseState, and re-applied after, so
// unsynced edits survive any server push.

// ─────────── types ───────────

export type ConflictProperty = 'color' | 'triage' | 'comment' | 'fix'

export type Conflict = {
  id: string
  property: ConflictProperty
  local: string
  imported: string
}

// One persisted triage value for a single finding-id. The shape on
// the wire and in baseState matches what `state.markers` /
// `state.triageState` / `state.comments` / `state.fixes` /
// `state.ignoredIds` collectively encode for that id.
export type TriageEntry = {
  color?: string
  triage?: TriageBucket
  comment?: string
  fix?: string
  ignoredReports?: string[]
  // Legacy boolean form — older peers / pre-bucket persisted blobs.
  // Migrated to `triage: 'deleted'` on apply / load.
  deleted?: boolean
}

export type TriageStateMap = { [id: string]: TriageEntry | undefined }
export type Changeset = { [id: string]: TriageEntry | null | undefined }

type PendingSave = {
  base: string | null
  id: string
  changeset: Changeset
  keyframe: boolean
}

// One workspace's per-tab sync state. All session mutations happen
// on the singleton entries in the `sessions` map; handlers that
// await across boundaries `sessionIsLive(session)` before mutating
// world state.
type Session = {
  workspaceId: string
  workspaceTag: string | null
  signingKey: CryptoKey | null
  verifyingKey: Uint8Array<ArrayBuffer> | null
  ids: Set<string>
  baseRevision: string | null
  baseState: TriageStateMap
  savesSinceKeyframe: number
  localState: TriageStateMap
  pending: PendingSave | null
  pendingSave: boolean
  key: Uint8Array<ArrayBuffer> | null
  encrypting: boolean
  subscribed: boolean
  subscribeAcked: boolean
  resyncAttempted: boolean
  consecutiveFailures: number
  error: string | null
  keyDerivationGen?: number
}

// Per-workspace-id persisted blob — what `loadAllSessions` hands
// out and `mutateAllSessions`'s mutator manipulates. Untrusted
// (loaded from localStorage / cross-tab writes), so every reader
// re-validates the shape it cares about.
type PersistedSession = {
  serverUrl?: unknown
  baseRevision?: unknown
  baseState?: unknown
  savesSinceKeyframe?: unknown
}
type PersistedSessionsMap = { [workspaceId: string]: PersistedSession | undefined }

type StatusListener = (status: SyncStatus) => void

// Context tag the resolver receives so the dialog wiring can vary
// the title / intro between the two callers:
//   * 'attach' — onReportMembershipChanged (report dragged into a
//                workspace whose chain already had triage for the
//                report's findings)
//   * 'chain'  — handleChain (a peer's broadcast — or our own
//                first-sync catch-up — disagrees per-property with
//                the user's unsynced overlay)
export type ConflictResolverContext = 'attach' | 'chain'
type ConflictResolver = (
  conflicts: Conflict[],
  baseState: TriageStateMap,
  context: ConflictResolverContext,
) => Promise<{ [key: string]: 'local' | 'imported' } | null | undefined>

export type SyncStatus = 'off' | 'offline' | 'connecting' | 'online' | 'error'

// Wire-message shapes that arrive via the `message` event. JSON-
// parsed payload comes in as `unknown`; every consumer narrows
// before reading fields.
type WireRevision = {
  base?: unknown
  id?: unknown
  keyframe?: unknown
  nonce?: unknown
  ciphertext?: unknown
  signature?: unknown
}
type WireMessage = {
  type?: unknown
  workspaceTag?: unknown
  base?: unknown
  id?: unknown
  nonce?: unknown
  revisions?: unknown
  reason?: unknown
}

// Public sessionInfo shape — read-only inspection used by the UI
// status bar / debug consoles.
export type SessionInfo = {
  workspaceId: string
  workspaceTag: string | null
  baseRevision: string | null
  pending: { base: string | null, keyframe: boolean } | null
  pendingSave: boolean
  keyReady: boolean
  encrypting: boolean
  tracked: number
  savesSinceKeyframe: number
  error: string | null
}

// Legacy key for the user-configured server URL. The URL is no
// longer persisted — only the per-origin detected default + an
// optional console override are used — so this key only exists here
// for one-shot cleanup at module load (see the load block below).
const LEGACY_URL_KEY = 'deepview.triageSyncUrl'
// Persisted user toggle — flips between true / false when the user
// clicks the sidebar status button (or via the public API). Default
// true: an unconfigured user starts "ready to sync the moment a URL
// exists".
const USER_ENABLED_KEY = 'deepview.sync.userEnabled'
// Per-workspace sync state — `{ [workspaceId]: { serverUrl,
// baseRevision, baseState } }`. Scoped by `serverUrl` because
// revision IDs are per-server: switching to a different relay
// invalidates whatever revision history the previous one assigned.
// Stored as one JSON blob (single localStorage key) for simplicity;
// per-workspace keys would scale better at the cost of enumeration.
const SESSION_STATE_KEY = 'deepview.sync.sessions'
const SESSION_ID_RE = /^\d+$/u

// UI redraw hook — installed once at app boot by ui/view.js so this
// module doesn't need to import from the rendering layer (would be
// the wrong direction: client → ui). Defaults to a no-op so a
// triage-sync update outside a UI context (tests, console scripts)
// doesn't blow up.
let redraw: () => void = () => {}

// Hydration conflict resolver — installed once at app boot via
// `setHydrationConflictResolver(...)`. Called from the
// `onReportMembershipChanged` listener when attaching a report to
// a workspace surfaces a conflict between the local state.* value
// and the chain's baseState value for an in-scope id. Receives
// `(conflicts, baseState)`; returns a Promise of the per-conflict
// decisions (`{ '<id>:<property>': 'local' | 'imported' }`) or
// `null` to keep all locals (cancel). Defaults to null → no dialog,
// gap-only hydration (local-wins).
let hydrationConflictResolver: ConflictResolver | null = null

let serverUrl = ''
// User-driven enable/disable, persisted. The sidebar status button
// flips this on click. Distinct from `serverUrl` so toggling doesn't
// drop the configured endpoint; the user can turn sync off and back
// on without re-typing.
let userEnabled = true
// Runtime gate driven by the sidebar's visibility logic — when the
// status button can't be seen (no usable URL or no non-empty
// workspace), the sidebar sets this so the underlying socket stops
// without touching `serverUrl` or `userEnabled`. Re-shown button
// flips it back. Not persisted: visibility recomputes on every
// load, so the runtime state can rebuild itself from scratch.
let forcedOff = false
let socket: WebSocket | null = null
// Per-connection challenge nonce issued by the server in a
// `challenge` frame on socket open (round-9 H2). The client signs
// this nonce into every subscribe so a captured subscribe frame
// can't be replayed from a different connection. `null` until the
// frame arrives; `trySendSubscribe` bails when null and is re-kicked
// from the `challenge` handler. Reset on every socket close /
// teardown so a new connection picks up the new nonce.
let connectionNonce: string | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelayMs = 1_000
const MAX_RECONNECT_DELAY = 30_000

// Application-level heartbeat. The browser WebSocket API doesn't
// expose protocol-level ping/pong, and a server that ack'd our
// subscribe but then silently dropped the route (or a half-open TCP
// connection that hasn't fired a FIN yet) would leave us stuck on
// `online` until the next save attempt or TCP keepalive kicked in.
// We send `{ type: 'ping' }` periodically; the server replies
// `{ type: 'pong' }`. A missing pong within `pongTimeoutMs` closes
// the socket — `close` fires immediately, which the existing
// reconnect path picks up.
//
// Mutable so tests can shorten the windows; production timings give
// dead-connection detection within ~20 s without spamming the wire.
let pingIntervalMs = 15_000
let pongTimeoutMs = 5_000
let pingIntervalId: ReturnType<typeof setInterval> | null = null
let pongTimeoutId: ReturnType<typeof setTimeout> | null = null

// Keyframe cadence. Client decides — server can't fake the flag
// because it's bound into the signed canonical bytes (see
// sync-crypto.ts's `canonicalSavePayload`). A keyframe carries the
// FULL state instead of a delta; a `from=null` subscribe returns
// the chain from the most recent keyframe (inclusive), so a fresh
// client catches up by applying just the keyframe + everything
// after.
//
// `session.savesSinceKeyframe` increments on every applied
// non-keyframe revision (own ack or peer broadcast); resets to 0
// on a keyframe. When the counter reaches `keyframeInterval` AND
// there's something to send AND we're about to send, the next save
// is emitted as a keyframe. Persisted alongside baseRevision /
// baseState so a reload doesn't double-trigger.
//
// Mutable so tests can lower the interval without staging 100
// saves; the production threshold is 100.
let keyframeInterval = 100

// Non-recoverable failure threshold. After this many consecutive
// encrypt/sign failures on a session — typically a corrupt or
// otherwise unusable key — we stop retrying, set the session's
// `error` field, and aggregate that into the public `status`
// listener as `'error'` so the UI can show a visible warning.
// Mutable so a test can drop it to 1.
let maxConsecutiveFailures = 5

// True only when all gates align: a URL exists, the user hasn't
// flipped off, and the sidebar isn't suppressing.
function isActive(): boolean {
  return userEnabled && !forcedOff && Boolean(serverUrl)
}

// `off` | `offline` | `connecting` | `online`. Public via the API
// for status-bar indicators; emitted via `onStatusChange` whenever
// the value transitions so consumers don't have to poll.
//
// `connecting` covers the window between socket-open and the
// server's `workspace-subscribed` ack landing — useful because a
// dangling open socket without a registered subscription means
// no broadcasts will reach the client even though the WS layer
// looks fine. `online` requires the ack OR no active session
// (the empty state, where there's nothing to subscribe to).
const statusListeners = new Set<StatusListener>()
function currentStatus(): SyncStatus {
  if (!isActive()) return 'off'
  // Any session in a non-recoverable error state (key derivation
  // failed; encrypt/sign repeatedly threw) takes precedence — the
  // user needs to see this even if the socket is otherwise healthy,
  // because no save under that workspace will ever land.
  for (const session of sessions.values()) {
    if (session.error) return 'error'
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) return 'offline'
  // Any session that has sent its subscribe but hasn't received the
  // `workspace-subscribed` ack from the server stays in `connecting`.
  // Sessions still deriving keys (`subscribed === false`) don't
  // contribute to the gate — they pass through `connecting` only as
  // they actually attempt to subscribe.
  for (const session of sessions.values()) {
    if (session.subscribed && !session.subscribeAcked) return 'connecting'
  }
  return 'online'
}
let lastEmittedStatus: SyncStatus = 'off'
function emitStatusIfChanged(): void {
  const status = currentStatus()
  if (status === lastEmittedStatus) return
  lastEmittedStatus = status
  for (const fn of statusListeners) {
    try { fn(status) } catch (err) { console.warn('Triage sync status listener:', err) }
  }
}
// Re-entrancy guard. Bumped while we're applying remote state so
// the saveTriage at the tail doesn't trigger a notify and bounce
// the same change back at the server.
let suppressNotify = 0
// Active per-workspace sessions, keyed by `workspaceId`. The single
// WebSocket connection multiplexes them — every wire message carries
// `workspaceTag`, which routes inbound messages to the right session
// (`getSessionByTag`). Each session has its own keys, baseState,
// baseRevision, savesSinceKeyframe, pending save, etc.; nothing is
// shared between them except the socket and the heartbeat. Sessions
// are added by `openSession(id)` and removed by `closeSession(id)`;
// `openSession` is additive, not replace-the-current.
const sessions = new Map<string, Session>()

// Find the session whose derived public key matches an inbound
// message's `workspaceTag`. Returns null if no session has finished
// key derivation under that tag yet (the wire never sees the UUID,
// so the tag is the only routing identifier we have for inbound).
function getSessionByTag(tag: string): Session | null {
  for (const session of sessions.values()) {
    if (session.workspaceTag === tag) return session
  }
  return null
}

// True iff `session` is still the live entry for its workspaceId in
// the session map. Handlers that await across boundaries (decrypt,
// saveTriage, persistence) must re-check before mutating world state
// — `closeSession(id)` removes the entry, but the handler still
// holds a reference and would otherwise keep writing to state.* /
// localStorage / the socket on behalf of a workspace the user has
// already torn down.
function sessionIsLive(session: Session): boolean {
  return sessions.get(session.workspaceId) === session
}

// Drop session's content-encryption key material before releasing the
// session. `session.key` is the raw 32-byte HKDF output from
// `deriveSessionKey`; zeroing the buffer mirrors `objstore.ts`'s
// explicit `contentKey.fill(0)` so the workspace's content key isn't
// recoverable from a post-close heap snapshot. The CryptoKey at
// `session.signingKey` is non-extractable — the runtime owns its
// erasure when the reference drops, so dropping it is best-effort.
function wipeSessionKey(session: Session): void {
  if (session.key) {
    try { session.key.fill(0) } catch {}
    session.key = null
  }
  session.signingKey = null
  session.verifyingKey = null
}

// ─────────── pure state / changeset helpers ───────────

// Collect every per-report ignore key matching `id`, returned as
// the wire-shaped `[reportName, ...]` array. One-off callers
// (snapshotEntry without a pre-built index) pay O(|state.ignoredIds|)
// per call. Loop callers that snapshot many ids (effectiveLocalState)
// build a per-id bucket once via `bucketIgnoredByid` and pass it
// in via `ignoredByid` to drop the per-call cost to O(1) — closes
// the symmetric L1 round-4 perf gap that round-3 fixed for the
// apply side.
function snapshotEntry(id: string, ignoredByid: Map<string, string[]> | null = null): TriageEntry {
  const entry: TriageEntry = {}
  const color = state.markers.get(id)
  if (color !== undefined) entry.color = color
  const triage = state.triageState.get(id)
  if (triage) entry.triage = triage
  const ignoredReports = ignoredByid == null
    ? ignoredReportsForId(id)
    : (ignoredByid.get(id) ?? [])
  if (ignoredReports.length > 0) entry.ignoredReports = ignoredReports
  const comment = state.comments.get(id)
  if (comment) entry.comment = comment
  const fix = state.fixes.get(id)
  if (fix) entry.fix = fix
  return entry
}

function ignoredReportsForId(id: string): string[] {
  const out: string[] = []
  for (const key of state.ignoredIds) {
    const sep = key.indexOf('\0')
    if (sep < 0) continue
    if (key.slice(sep + 1) !== id) continue
    out.push(key.slice(0, sep))
  }
  return out
}

// Pre-bucket `state.ignoredIds` by id, optionally filtered to a set
// of ids of interest. Used by `effectiveLocalState` (and any future
// many-id snapshotter) so per-id `ignoredReports` lookup is O(1).
function bucketIgnoredByid(idsScope: Set<string> | null = null): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const key of state.ignoredIds) {
    const sep = key.indexOf('\0')
    if (sep < 0) continue
    const id = key.slice(sep + 1)
    if (idsScope && !idsScope.has(id)) continue
    const list = map.get(id)
    if (list) list.push(key.slice(0, sep))
    else map.set(id, [key.slice(0, sep)])
  }
  return map
}

// Collect the finding ids that belong to a workspace's reports,
// scoped by the workspace's `reports` filename list (set by
// drag-into-workspace in the sidebar). With multiple workspaces
// open simultaneously, an unscoped iteration over `state.reports`
// would let any session sync changes for ids in another
// workspace's reports — narrowing here is what keeps each
// session's chain to its own findings.
function buildWorkspaceIds(workspaceId: string): Set<string> {
  const ids = new Set<string>()
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) return ids
  const memberFiles = new Set(ws.reports ?? [])
  for (const r of state.reports as Array<{ fileName: string, groups: Array<Array<{ id?: string, _id?: string | number }>> }>) {
    if (!memberFiles.has(r.fileName)) continue
    for (const g of r.groups) {
      for (const f of g) {
        const k = f.id ?? String(f._id)
        if (!SESSION_ID_RE.test(k)) ids.add(k)
      }
    }
  }
  return ids
}

// The session's "effective" local state — what the next save
// represents as the workspace's full triage. Starts from
// `baseState` (= the chain we've applied so far, including
// entries for finding-ids belonging to reports the user doesn't
// have loaded — a peer triaged them), then overlays the live
// state.* values for ids the workspace DOES know about. Without
// preserving the unknown-id half, the next save's changeset
// against `baseState` would emit `<unknown>: null` (delete),
// destroying the triage on the server for clients that DO have
// that report. Mirrors the keyframe-emit case as well: the full
// state we sign and ship under `compute({}, localState)` must
// carry every id we've ever seen in the chain, not just the ones
// in our current session.ids scope.
function effectiveLocalState(baseState: TriageStateMap, ids: Set<string> | Iterable<string>): TriageStateMap {
  // `Object.create(null)` so a `__proto__` own key on the incoming
  // baseState (via prior `applyChangeset` of a peer-controlled
  // changeset) doesn't trigger the Object.prototype setter when
  // spread into a normal `{}` — that path would re-pollute out's
  // prototype chain and propagate attacker entries into localState
  // → computeChangeset's `target[id]` lookups → emitted changesets.
  // Audit round-12 H6.
  const out: TriageStateMap = Object.assign(Object.create(null), baseState)
  const idsSet: Set<string> = ids instanceof Set ? ids : new Set(ids)
  const ignoredByid = bucketIgnoredByid(idsSet)
  for (const id of idsSet) {
    const entry = snapshotEntry(id, ignoredByid)
    if (Object.keys(entry).length > 0) out[id] = entry
    else delete out[id]
  }
  return out
}

// Gap-only hydration: for each id in `ids`, fill missing state.*
// fields from `baseState[id]`. Existing state.* values are NEVER
// overwritten (local-wins on conflict), so a finding the user
// already triaged in another open workspace (state.* is global,
// chains are per-workspace) keeps its local value.
//
// Used when ids enter session scope (a report attached mid-session
// — see `onReportMembershipChanged` listener at module init). Without
// this, the next `effectiveLocalState` would call `snapshotEntry`
// on each newly-in-scope id, get an empty entry (state.* not
// populated for OOS ids), and emit a delete that wipes the chain's
// view for that id. The `ignoredReports` mutex with triage is
// honored — skipped when the entry already carries any triage
// state, mirroring `applyToReactiveState`'s rule.
function hydrateStateFromBaseState(baseState: TriageStateMap, ids: Iterable<string>): Conflict[] {
  const conflicts: Conflict[] = []
  for (const id of ids) {
    const entry = baseState[id]
    if (!entry || typeof entry !== 'object') continue

    if (entry.color) {
      const local = state.markers.get(id)
      if (local === undefined) state.markers.set(id, entry.color)
      else if (local !== entry.color) conflicts.push({ id, property: 'color', local, imported: entry.color })
    }

    let triageNext: TriageBucket | null = null
    if (entry.triage === 'fixed' || entry.triage === 'invalid' || entry.triage === 'deleted') triageNext = entry.triage
    else if (entry.deleted) triageNext = 'deleted'
    if (triageNext) {
      const local = state.triageState.get(id)
      if (local === undefined) state.triageState.set(id, triageNext)
      else if (local !== triageNext) conflicts.push({ id, property: 'triage', local, imported: triageNext })
    }

    if (entry.comment) {
      const local = state.comments.get(id)
      if (local === undefined) state.comments.set(id, entry.comment)
      else if (local !== entry.comment) conflicts.push({ id, property: 'comment', local, imported: entry.comment })
    }

    if (entry.fix) {
      const local = state.fixes.get(id)
      if (local === undefined) state.fixes.set(id, entry.fix)
      else if (local !== entry.fix) conflicts.push({ id, property: 'fix', local, imported: entry.fix })
    }

    // Per-report ignore: skipped when triage is set (mutex), and
    // when state.ignoredIds already has any entry for this id
    // (local-wins on conflict, same shape as the field-by-field
    // checks above). No conflict path for ignoredReports — the
    // mutex makes a "user picks ignored over triage" resolution
    // require dropping triage too, which the dialog doesn't model.
    const triageEffectivelySet = triageNext || state.triageState.has(id)
    if (triageEffectivelySet || !Array.isArray(entry.ignoredReports)) continue
    let alreadyHasAny = false
    for (const key of state.ignoredIds) {
      const sep = key.indexOf('\0')
      if (sep >= 0 && key.slice(sep + 1) === id) { alreadyHasAny = true; break }
    }
    if (alreadyHasAny) continue
    for (const r of entry.ignoredReports) {
      if (typeof r === 'string') state.ignoredIds.add(`${r}\0${id}`)
    }
  }
  return conflicts
}

// Apply the user's per-conflict decisions returned by the
// hydration conflict resolver. `decisions` is a map keyed by
// `${id}:${property}` with `'local'` / `'imported'`. Triage's
// 'imported' branch also clears the per-report ignored entries
// for the id (mutex).
//
// The dialog is async (user time) so state.* may have changed
// while it was open — a chain that landed via `applyChainToBase`
// or a saveTriage from an action handler. Re-read each property's
// current local value at apply-time and SKIP any 'imported'
// decision whose `local` no longer matches: the user (or another
// peer's chain) has effectively voted "local" again. Without this
// guard the dialog's `imported` choice would silently overwrite
// fresh local edits made during the dialog window. Audit M-2.
function dropIgnoredEntriesFor(id: string): void {
  for (const k of [...state.ignoredIds]) {
    const sep = k.indexOf('\0')
    if (sep >= 0 && k.slice(sep + 1) === id) state.ignoredIds.delete(k)
  }
}

function applyHydrationDecisions(
  conflicts: Conflict[],
  decisions: { [key: string]: 'local' | 'imported' },
): void {
  for (const c of conflicts) {
    const key = `${c.id}:${c.property}`
    if (decisions[key] !== 'imported') continue
    if (currentLocalValue(c.id, c.property) !== c.local) continue
    if (c.property === 'color') {
      if (c.imported) state.markers.set(c.id, c.imported)
      else state.markers.delete(c.id)
    } else if (c.property === 'comment') {
      if (c.imported) state.comments.set(c.id, c.imported)
      else state.comments.delete(c.id)
    } else if (c.property === 'fix') {
      if (c.imported) state.fixes.set(c.id, c.imported)
      else state.fixes.delete(c.id)
    } else if (c.property === 'triage') {
      if (c.imported === 'fixed' || c.imported === 'invalid' || c.imported === 'deleted') {
        state.triageState.set(c.id, c.imported)
        dropIgnoredEntriesFor(c.id)
      } else {
        state.triageState.delete(c.id)
      }
    }
  }
}

// Per-property normalisers — collapse "no value" of any shape
// (missing entry, empty string, legacy `deleted: true` for triage)
// to the empty string '' so the conflict-detection three-way
// compare (oldBase / local / chain) doesn't get tricked into
// reporting `'red'` vs `undefined` as a conflict when one side
// just doesn't carry the property at all.
function normColor(entry: TriageEntry | null | undefined): string {
  return typeof entry?.color === 'string' ? entry.color : ''
}
function normTriage(entry: TriageEntry | null | undefined): string {
  if (entry?.triage === 'fixed' || entry?.triage === 'invalid' || entry?.triage === 'deleted') return entry.triage
  if (entry?.deleted) return 'deleted'
  return ''
}
function normComment(entry: TriageEntry | null | undefined): string {
  return typeof entry?.comment === 'string' ? entry.comment : ''
}
function normFix(entry: TriageEntry | null | undefined): string {
  return typeof entry?.fix === 'string' ? entry.fix : ''
}

// Per-property comparison between the user's pre-rebase overlay
// (= unsynced state.* edits captured before the chain landed) and
// the chain's new baseState. Surfaced to the resolver so a peer's
// view that a chain just changed doesn't silently flip — and
// symmetrically, the joining client's local-wins overlay doesn't
// silently overwrite an already-agreed chain value when the user
// might prefer to accept it. Mirrors the per-property semantics
// `hydrateStateFromBaseState` uses on the report-attach path.
//
// Three-way compare against `oldBaseState` so an "unset" intent
// (overlay = null OR overlay's entry omits a property the user
// previously had) is detected as a conflict against a chain that
// re-assigned the property — and vice versa, when the user set a
// value and a peer deleted it. Without the three-way, both
// silent-loss directions sail past:
//   * we disconnect, peer changes color, we unset, reconnect →
//     overlay says `{X: null}`, chain says `{X: {color: blue}}`,
//     two-way (overlay vs chain) sees no per-property
//     disagreement, applyChangeset replays the delete and the
//     peer's blue is lost.
//   * we disconnect, peer unsets color, we change ours, reconnect →
//     overlay has color, chain doesn't, two-way again sees no
//     disagreement, the user's set wins and the peer's delete is
//     lost.
// The three-way says "both sides changed FROM oldBase, both
// changes disagree, surface a conflict". `local` / `imported`
// values are the empty string '' for the unset side; the dialog
// renders that as `<em>none</em>`.
function collectChainConflicts(
  overlay: Changeset,
  oldBaseState: TriageStateMap,
  newBaseState: TriageStateMap,
): Conflict[] {
  const conflicts: Conflict[] = []
  // Only check ids the user touched (= ids in overlay). Chain-only
  // changes for ids the user didn't touch are gap-fills handled
  // automatically by `applyChangeset(newBaseState, overlay)` —
  // ids missing from the overlay get the chain's value through.
  for (const id of Object.keys(overlay)) {
    const overlayValue = overlay[id]
    const oldEntry = oldBaseState[id]
    const chainEntry = newBaseState[id]
    // `overlay[id] === null` is the explicit "user deleted" signal;
    // the effective local entry is then null (every property reads
    // as ''). Otherwise the overlay's entry IS the user's view.
    const localEntry = overlayValue ?? null

    const props = [
      { name: 'color' as const, norm: normColor },
      { name: 'triage' as const, norm: normTriage },
      { name: 'comment' as const, norm: normComment },
      { name: 'fix' as const, norm: normFix },
    ]
    for (const { name, norm } of props) {
      const oldVal = norm(oldEntry)
      const localVal = norm(localEntry)
      const chainVal = norm(chainEntry)
      const localChanged = localVal !== oldVal
      const chainChanged = chainVal !== oldVal
      if (localChanged && chainChanged && localVal !== chainVal) {
        conflicts.push({ id, property: name, local: localVal, imported: chainVal })
      }
    }
  }
  return conflicts
}

function currentLocalValue(id: string, property: ConflictProperty): string {
  if (property === 'color') return state.markers.get(id) ?? ''
  if (property === 'triage') return state.triageState.get(id) ?? ''
  if (property === 'comment') return state.comments.get(id) ?? ''
  if (property === 'fix') return state.fixes.get(id) ?? ''
  return ''
}

// Recompute `session.ids` from current workspace membership and
// hydrate state.* from baseState for ids that JUST entered scope.
// Returns `{ conflicts, hydrated }` so the caller can decide to
// surface a dialog (eager listener path) or fall back to local-
// wins (lazy paths in trySendSave / captureOverlay).
function refreshSessionIds(session: Session): { conflicts: Conflict[], hydrated: boolean } {
  const newIds = buildWorkspaceIds(session.workspaceId)
  const newlyAdded: string[] = []
  for (const id of newIds) {
    if (!session.ids.has(id)) newlyAdded.push(id)
  }
  let conflicts: Conflict[] = []
  if (newlyAdded.length > 0) conflicts = hydrateStateFromBaseState(session.baseState, newlyAdded)
  session.ids = newIds
  return { conflicts, hydrated: newlyAdded.length > 0 }
}

// Set-equal comparison for `ignoredReports`. Each list is an
// unordered collection of report names; a peer's snapshot may
// produce them in iteration order of state.ignoredIds (insertion
// order), and an applied chain may produce them in a different
// order, so a positional compare would falsely report changes
// and produce empty-but-nonzero changesets.
function ignoredReportsEqual(a: unknown, b: unknown): boolean {
  const la: string[] = Array.isArray(a) ? a : []
  const lb: string[] = Array.isArray(b) ? b : []
  if (la.length !== lb.length) return false
  if (la.length === 0) return true
  const seen = new Set(la)
  for (const r of lb) if (!seen.has(r)) return false
  return true
}

function entriesEqual(a: TriageEntry, b: TriageEntry): boolean {
  // `triage` is the current shape (`'fixed' | 'invalid' | 'deleted'`
  // or absent). Legacy `deleted: true` from older peers / stored
  // chains is treated as 'deleted' for comparison purposes — the
  // receive-side migrates on apply, but a local state still
  // carrying the legacy boolean shouldn't false-equal a remote
  // entry that already moved to the new field.
  const triageA = a.triage ?? (a.deleted ? 'deleted' : '')
  const triageB = b.triage ?? (b.deleted ? 'deleted' : '')
  return a.color === b.color
    && triageA === triageB
    && (a.comment ?? '') === (b.comment ?? '')
    && (a.fix ?? '') === (b.fix ?? '')
    && ignoredReportsEqual(a.ignoredReports, b.ignoredReports)
}

function statesEqual(a: TriageStateMap, b: TriageStateMap): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const id of ids) {
    if (!entriesEqual(a[id] ?? {}, b[id] ?? {})) return false
  }
  return true
}

// Walk a state through a changeset, producing a new state. `null`
// in the changeset means "delete this id from the state".
// Exported for unit-test access (round-12 H6 prototype-pollution
// regression). Pure function — no module state, no side effects.
export function applyChangeset(baseState: TriageStateMap, changeset: Changeset): TriageStateMap {
  // `Object.create(null)` (not `{}`) so a peer-controlled changeset
  // can't pollute the prototype chain. JSON.parse turns `{"__proto__":
  // …}` into an OWN property; `out[id] = entry` for id='__proto__' on
  // a normal `{}` would trigger Object.prototype's `__proto__` setter
  // and mutate out's prototype to the attacker-supplied entry. Every
  // subsequent `baseState[id]` lookup (hydrateStateFromBaseState,
  // statesEqual, etc.) would then walk the polluted chain and return
  // attacker-controlled triage values. Null-prototype out has no
  // setter to trigger; the key just becomes an inert own property.
  // Audit round-12 H6.
  const out: TriageStateMap = Object.assign(Object.create(null), baseState)
  for (const [id, entry] of Object.entries(changeset)) {
    if (entry === null) delete out[id]
    else if (entry !== undefined) out[id] = entry
  }
  return out
}

// Compute the changeset that turns `base` into `target`. Mirrors
// `applyChangeset` — `null` entries clear, present entries overwrite.
function computeChangeset(base: TriageStateMap, target: TriageStateMap): Changeset {
  // `Object.create(null)` mirrors `applyChangeset` / `effectiveLocalState`.
  // Without this, `changeset['__proto__'] = entry` (when an id of
  // `__proto__` shows up in base.keys / target.keys) would trigger
  // the Object.prototype setter on changeset and pollute the
  // outbound payload's prototype chain. Audit round-12 H6.
  const changeset: Changeset = Object.create(null)
  const ids = new Set([...Object.keys(base), ...Object.keys(target)])
  for (const id of ids) {
    const b = base[id] ?? {}
    const t = target[id] ?? {}
    if (!entriesEqual(b, t)) changeset[id] = target[id] ?? null
  }
  return changeset
}

function changesetEmpty(cs: Changeset): boolean {
  for (const _ in cs) return false
  return true
}

// ─────────── per-workspace session persistence ───────────

// The sessions blob is keyed per-workspace inside one JSON object,
// so two tabs writing entries for DIFFERENT workspaces still race on
// the read-modify-write of the outer object. Serialize every RMW
// behind a same-origin Web Lock so concurrent writers see each
// other's updates instead of clobbering them. The lock name is the
// storage key — Web Locks are namespaced per-origin, which is the
// scope that matters here (every tab on the same origin shares the
// localStorage instance and the lock manager).
const SESSION_STATE_LOCK = SESSION_STATE_KEY

// Persisted shape (round-10 — pre-v1 freeze):
//   { version: 1, sessions: { [workspaceId]: { serverUrl, ... } } }
//
// Pre-version blobs were a bare object keyed by workspaceId;
// `loadAllSessions` accepts both shapes so a user upgrading from a
// pre-version build doesn't lose their persisted bases. The next
// `writeAllSessionsRaw` rewrites in the versioned form.
const SESSIONS_VERSION = 1

// Latch — flipped true when `mutateAllSessions` finds an
// `unknown-version` blob on disk and skips its write. Stays sticky
// for the rest of the page-load so UI consumers can show a
// degraded-persistence hint (the user's in-memory state isn't
// being written through). Reset on next page-load. Audit follow-up
// to round-15.
let persistenceDegradedLatch = false
const persistenceDegradedListeners = new Set<() => void>()
function markPersistenceDegraded(): void {
  if (persistenceDegradedLatch) return
  persistenceDegradedLatch = true
  console.warn(
    'triage-sync: persisted-sessions blob has an unrecognised version; skipping writes to avoid clobbering a future build\'s data. ' +
    'Your in-memory triage state still works this session but will not persist across reload. ' +
    'Clear localStorage[deepview.sync.sessions] to recover.',
  )
  for (const cb of persistenceDegradedListeners) {
    try { cb() } catch (err) { console.warn('persistenceDegraded listener:', err) }
  }
}

// Discriminated load result so `mutateAllSessions` can distinguish
// "blob doesn't exist / is unparseable / is legacy / is current"
// from "blob is a future version we don't understand". The latter
// MUST skip the write — overwriting with a v1 shape would silently
// destroy whatever a future build persisted under the same key.
// Open-ended audit `client/triage-sync.ts:884`.
type LoadAllSessionsResult =
  | { kind: 'v1' | 'legacy'; map: PersistedSessionsMap }
  | { kind: 'empty' }
  | { kind: 'unknown-version' }

function loadAllSessionsResult(): LoadAllSessionsResult {
  try {
    const raw = localStorage.getItem(SESSION_STATE_KEY)
    if (!raw) return { kind: 'empty' }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { kind: 'empty' }
    const obj = parsed as { version?: unknown, sessions?: unknown }
    // Versioned shape we understand: { version === SESSIONS_VERSION,
    // sessions: map }. The `version === SESSIONS_VERSION` check is
    // the gate that distinguishes "current build" from "future
    // version we don't know how to read" — the previous shape
    // returned `{}` for any unrecognised `version`, which let
    // `mutateAllSessions` overwrite a v2 blob with v1 entries.
    if (obj.version === SESSIONS_VERSION
      && obj.sessions && typeof obj.sessions === 'object' && !Array.isArray(obj.sessions)) {
      return { kind: 'v1', map: obj.sessions as PersistedSessionsMap }
    }
    // Matching version but malformed/missing `sessions` (e.g. crashed
    // mid-write, hand-edited corruption). Don't quarantine the
    // localStorage entry — the version says "this is for our build",
    // so an empty start + clean rewrite on next save is the right
    // recovery. `'unknown-version'` is reserved for blobs whose
    // version we don't recognise (future build's data we mustn't
    // overwrite). Audit follow-up to round-15.
    if (obj.version === SESSIONS_VERSION) return { kind: 'empty' }
    if ('version' in obj) return { kind: 'unknown-version' }
    // Pre-version legacy shape: bare object keyed by workspaceId.
    // The legacy entries had a `serverUrl` field on each value, so
    // a flat object without a `version` key is the v0 shape.
    return { kind: 'legacy', map: obj as PersistedSessionsMap }
  } catch { return { kind: 'empty' } }
}

function loadAllSessions(): PersistedSessionsMap {
  const r = loadAllSessionsResult()
  return (r.kind === 'v1' || r.kind === 'legacy') ? r.map : {}
}

function writeAllSessionsRaw(map: PersistedSessionsMap): void {
  try {
    localStorage.setItem(SESSION_STATE_KEY, JSON.stringify({
      version: SESSIONS_VERSION,
      sessions: map,
    }))
  } catch (err) {
    // Likely QuotaExceededError — sync just falls back to the
    // "always start from null base" path on next reload.
    console.warn('Triage sync: could not persist session state:', err)
  }
}

type RestoredSession = {
  baseRevision: string | null
  baseState: TriageStateMap
  savesSinceKeyframe: number
}

// Read-only — used by `openSession` to restore on module load /
// re-open. No lock: the read alone can't corrupt anything, and a
// concurrent writer's blob is whatever it serialized atomically
// anyway. Callers that read-then-write go through `mutateAllSessions`.
function loadPersistedSession(workspaceId: string, currentServerUrl: string): RestoredSession | null {
  if (!currentServerUrl) return null
  const all = loadAllSessions()
  const entry = all[workspaceId]
  if (!entry || entry.serverUrl !== currentServerUrl) return null
  return {
    baseRevision: typeof entry.baseRevision === 'string' ? entry.baseRevision : null,
    // Round-12 H6 defense-in-depth: normalise the persisted blob's
    // baseState into a null-prototype object so a `__proto__` own
    // key (from a prior version's polluted save) doesn't trigger
    // the Object.prototype setter when downstream code spreads or
    // assigns from it. JSON.parse always returns Object.prototype-
    // having objects; convert here at the trust boundary.
    baseState: (entry.baseState && typeof entry.baseState === 'object')
      ? Object.assign(Object.create(null), entry.baseState)
      : Object.create(null),
    savesSinceKeyframe: typeof entry.savesSinceKeyframe === 'number' ? entry.savesSinceKeyframe : 0,
  }
}

type SessionsMutator = (all: PersistedSessionsMap) => Promise<unknown> | unknown

// Apply `mutator(map)` to the persisted-sessions blob under the
// SESSION_STATE_LOCK Web Lock. The mutator runs on a freshly-read
// copy so a concurrent tab's writes are visible. Setting `false` as
// the mutator's return value skips the write (no-op when the mutator
// didn't actually change anything).
export async function mutateAllSessions(mutator: SessionsMutator): Promise<void> {
  await navigator.locks.request(SESSION_STATE_LOCK, async () => {
    const r = loadAllSessionsResult()
    if (r.kind === 'unknown-version') {
      // The persisted blob is from a future build we don't recognize.
      // Writing v1 over it would silently destroy the future shape;
      // skip the mutation. In-memory session state still updates via
      // the caller's other paths, but on next page-load it's lost
      // (the future blob is read again, sees no entries for our
      // workspaceId, returns null → fresh session, re-fetches
      // keyframe from server). Flip `persistenceDegraded` so the UI
      // can surface a hint to the user; `triageSync.persistenceDegraded`
      // exposes it. Audit follow-up to round-15.
      markPersistenceDegraded()
      return
    }
    const all = (r.kind === 'v1' || r.kind === 'legacy') ? r.map : {}
    const result = await mutator(all)
    if (result === false) return
    writeAllSessionsRaw(all)
  })
}

function persistSession(target: Session): void {
  if (!target || !serverUrl) return
  // Capture serverUrl by value — the mutator runs inside the Web
  // Locks callback (potentially after a few microtasks of queueing)
  // and a `setServerUrl(...)` call landing in between would
  // otherwise stamp the persisted entry with the wrong server's
  // URL, hiding it from `loadPersistedSession` on next page load.
  // Audit M3 (round 1).
  const url = serverUrl
  // Fire-and-forget — callers don't await. The lock serializes the
  // RMW; ordering between back-to-back persistSession calls follows
  // Web Locks FIFO semantics, so the most-recent state for any one
  // workspace wins. Catch any rejection (Web Locks rejects on tab
  // teardown / browser quirks) so this fire-and-forget can't leak
  // an unhandledrejection — audit M-3 (round 2).
  mutateAllSessions((all) => {
    all[target.workspaceId] = {
      serverUrl: url,
      baseRevision: target.baseRevision,
      savesSinceKeyframe: target.savesSinceKeyframe ?? 0,
      baseState: target.baseState,
    }
  }).catch((err) => { console.warn('Triage sync: persistSession lock failed:', err) })
}

// Drop persisted entries that can no longer be applied. Two
// classes:
//   1. Workspace was deleted while we were away. (Live deletions go
//      through the `onWorkspaceDeleted` listener; this handles the
//      offline-tab case.)
//   2. The entry's `serverUrl` doesn't match the relay we're about
//      to use. Revision IDs are per-server, so `loadPersistedSession`
//      already refuses to apply such an entry (returns null on
//      `entry.serverUrl !== currentServerUrl`) — pruning here just
//      stops the dead bytes from sitting in localStorage forever.
//      Older builds with a different WS path (e.g. pre-`/api/sync`)
//      are the typical source.
//
// Pass `currentUrl=null` (default) to skip the URL check — module
// load runs before the sidebar primes the URL, so a null check
// there would nuke every entry. `setServerUrl` re-runs this with
// the new URL once it's known.
function prunePersistedSessions(currentUrl: string | null = null): void {
  mutateAllSessions((all) => {
    const ids = Object.keys(all)
    if (ids.length === 0) return false
    const live = new Set(listWorkspaces().map((w) => w.id))
    let changed = false
    for (const id of ids) {
      const entry = all[id]
      const stale = !live.has(id)
        || (currentUrl != null && entry?.serverUrl !== currentUrl)
      if (stale) {
        delete all[id]
        changed = true
      }
    }
    return changed ? undefined : false
  }).catch((err) => { console.warn('Triage sync: prunePersistedSessions lock failed:', err) })
}

// Drop the persisted-session entry for one workspace id (if any).
// Used by the workspace-deleted listener so the live persistence
// blob doesn't survive the deletion until the next page-load prune.
// Returns the underlying lock-RMW promise so callers that need to
// observe the wipe before they read the blob (e.g. the privateKey-
// rotation listener, before reopening the session — audit H2)
// can `await` it. Other callers can fire-and-forget.
function dropPersistedSession(workspaceId: string): Promise<void> {
  return mutateAllSessions((all) => {
    if (!(workspaceId in all)) return false
    delete all[workspaceId]
    return undefined
  })
}

// Derive content-encryption key + Ed25519 signing keypair in parallel.
// Both come off the same private key via HKDF with different
// domain-separating info strings. If the session gets removed or
// replaced before derivation finishes, the identity check drops the
// result. Used by `openSession` (initial derivation) and by
// `dismissError` (retry path when derivation failed and the user
// asked to retry — without this the no-keys session would clear its
// error but stay silently keyless forever).
function kickKeyDerivation(session: Session): void {
  // Re-look-up the workspace each time so a re-import (same id, fresh
  // privateKey) on retry actually picks up the corrected key. The
  // initial-derivation caller already validated the workspace exists,
  // so this is mostly belt-and-suspenders for the retry path.
  const ws = listWorkspaces().find((w) => w.id === session.workspaceId)
  if (!ws) {
    session.error = 'workspace no longer exists'
    emitStatusIfChanged()
    return
  }
  // Generation token: openSession + dismissError can both invoke
  // kickKeyDerivation. If the user rotates the workspace privateKey
  // (or otherwise causes a second kick) while the first IIFE is
  // still awaiting derivation, both runs would race to write the
  // session's key/signingKey. The OLDER IIFE could clobber the
  // NEWER's keys, leaving the session pinned to a stale identity.
  // Bump on every kick; the IIFE only commits when the token it
  // captured at start is still the current one. Audit L2 round-4.
  const gen = (session.keyDerivationGen ?? 0) + 1
  session.keyDerivationGen = gen
  ;(async () => {
    try {
      const [key, kp] = await Promise.all([
        deriveSessionKey(ws.privateKey),
        deriveSigningKeypair(ws.privateKey, session.workspaceId),
      ])
      if (sessions.get(session.workspaceId) !== session) return
      if (session.keyDerivationGen !== gen) return
      session.key = key
      session.signingKey = kp.privateKey
      session.verifyingKey = kp.publicKey
      session.workspaceTag = kp.publicKeyB64
      // Subscribe + flush any pending save now that we have keys.
      // Subscribe gets us broadcast-eligibility regardless of
      // whether there's anything to push.
      if (socket?.readyState !== WebSocket.OPEN) {
        // Socket isn't open yet — open it lazily so the very first
        // openSession of the page-load brings the connection up.
        // Subsequent openSessions reuse it.
        if (isActive() && !socket) openSocket()
        return
      }
      trySendSubscribe(session)
      trySendSave(session)
      emitStatusIfChanged()
    } catch (err) {
      console.warn('Triage sync: key derivation failed:', err)
      // Non-recoverable from the sync layer's POV — without signing
      // keys we can't sign any save or subscribe under this
      // workspace. Surface it so the UI can warn the user (typical
      // cause: a corrupt / wrong-length privateKey on the workspace
      // record).
      //
      // The `'key derivation failed:'` prefix is the contract the
      // F1-regression tests in tests/sync-client.test.js pin via
      // `startsWith` to verify the lifecycle handlers re-kick. If
      // this prefix changes, update those tests too.
      if (sessions.get(session.workspaceId) === session && session.keyDerivationGen === gen) {
        session.error = `key derivation failed: ${err instanceof Error ? err.message : String(err)}`
        emitStatusIfChanged()
      }
    }
  })()
}

// Reflect `targetState` into the in-memory state.* containers,
// scoped to `ids`. Entries outside the workspace's scope are left
// alone so single-file triage isn't clobbered.
//
// Per-report ignore is rebuilt scoped to `ids`. The naive form —
// a `[...state.ignoredIds]` scan inside the per-id loop — is
// O(|state.ignoredIds| · |ids|); pre-bucket once per call so the
// total cost is O(|state.ignoredIds| + |ids|). Audit M5 round-3.
function applyToReactiveState(targetState: TriageStateMap, ids: Set<string> | Iterable<string>): void {
  const idsSet: Set<string> = ids instanceof Set ? ids : new Set(ids)
  const existingIgnoredByid = new Map<string, string[]>()
  for (const key of state.ignoredIds) {
    const sep = key.indexOf('\0')
    if (sep < 0) continue
    const id = key.slice(sep + 1)
    if (!idsSet.has(id)) continue
    const list = existingIgnoredByid.get(id)
    if (list) list.push(key)
    else existingIgnoredByid.set(id, [key])
  }
  for (const id of idsSet) {
    const entry: TriageEntry = targetState[id] ?? {}
    if (entry.color) state.markers.set(id, entry.color)
    else state.markers.delete(id)
    // Triage state — preferred form `triage: 'fixed'|'invalid'|'deleted'`.
    // Legacy `deleted: true` from older peers maps to 'deleted'.
    if (entry.triage === 'fixed' || entry.triage === 'invalid' || entry.triage === 'deleted') {
      state.triageState.set(id, entry.triage)
    } else if (entry.deleted) {
      state.triageState.set(id, 'deleted')
    } else {
      state.triageState.delete(id)
    }
    // Per-report ignore replaces the local set for this id with
    // whatever the wire entry carries. Drop existing keys for the
    // id first so a remote that cleared all reports for an id
    // resets us; then re-add from the entry. Mutual exclusion
    // with triage: if the wire entry carries a triage state we
    // skip its ignoredReports — the action-level invariant says
    // triage and ignore can't coexist on a tab, and a stale chain
    // that carries both should resolve in favor of triage (matches
    // the action handler, which clears ignore when setting triage).
    const oldKeys = existingIgnoredByid.get(id)
    if (oldKeys) {
      for (const k of oldKeys) state.ignoredIds.delete(k)
    }
    const triageWasSet = entry.triage === 'fixed' || entry.triage === 'invalid' || entry.triage === 'deleted' || entry.deleted
    if (!triageWasSet && Array.isArray(entry.ignoredReports)) {
      for (const r of entry.ignoredReports) {
        if (typeof r === 'string') state.ignoredIds.add(`${r}\0${id}`)
      }
    }
    if (entry.comment) state.comments.set(id, entry.comment)
    else state.comments.delete(id)
    if (entry.fix) state.fixes.set(id, entry.fix)
    else state.fixes.delete(id)
  }
}

// ─────────── transport / wire ───────────

function send(msg: unknown): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(msg))
    return true
  } catch (err) {
    console.warn('Triage sync send failed:', err)
    return false
  }
}

// Send a `workspace-subscribe` once per session-on-this-socket. The
// server uses this to register the connection as a subscriber for
// the workspace's broadcasts even when there's no local change to
// push (e.g. a fresh client opening a workspace whose triage is
// already in sync with the server). Idempotent on the client:
// `session.subscribed` flips true on send and resets on socket
// close so a reconnect re-subscribes.
// `force = true` re-sends a subscribe even when `session.subscribed`
// is already true. Used by the continuity-break recovery path:
// re-asking with the current `baseRevision` returns the gap-filling
// catch-up chain, which is the same primitive the initial subscribe
// uses.
function trySendSubscribe(session: Session, force = false): void {
  if (!session) return
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  if (!force && session.subscribed) return
  if (!session.signingKey || !session.workspaceTag) return
  // The server-issued challenge nonce binds the subscribe sig to
  // this connection; we can't sign until it arrives (round-9 H2).
  // The `challenge` message handler re-kicks every session's
  // subscribe attempt the moment the nonce lands, so bailing here
  // is safe — the legit client always sends `challenge` first.
  if (connectionNonce == null) return
  // Capture both `from` and the connection nonce BEFORE the await —
  // chain handlers running during the sign promise could otherwise
  // advance baseRevision out from under us, and a socket teardown +
  // reconnect could swap the nonce.
  const fromBase = session.baseRevision
  const nonce = connectionNonce
  const signingKey = session.signingKey
  const workspaceTag = session.workspaceTag
  ;(async () => {
    try {
      const signature = await signSubscribePayload(signingKey, workspaceTag, fromBase, nonce)
      // Bail if the session was removed (closeSession) during the
      // sign await. Looking it up by id again is cheap and
      // forgery-proof — workspaceId only resolves to one entry.
      if (sessions.get(session.workspaceId) !== session) return
      // Bail if the captured workspaceTag no longer matches the
      // session's — the privateKey-rotation handler nulls signing
      // material synchronously to poison concurrent IIFEs (audit
      // L2 round-6). Capture-into-locals (forced by TS narrowing
      // across the await boundary) bypasses that null-poisoning,
      // so re-check the tag identity here to keep the original
      // safety property.
      if (session.workspaceTag !== workspaceTag) return
      // Bail if the connection nonce moved while we were signing
      // (socket close + reconnect during the sign await). The
      // signed canonical is bound to the OLD nonce; sending it now
      // would fail server-side verify against the NEW nonce. The
      // post-reconnect 'challenge' handler will re-kick this session.
      if (connectionNonce !== nonce) return
      // Mark subscribed BEFORE sending so re-entrant calls (the
      // ws 'open' handler firing twice during a flaky reconnect,
      // or trySendSave running back-to-back) don't double up.
      session.subscribed = true
      send({
        type: 'workspace-subscribe',
        workspaceTag,
        from: fromBase,
        signature,
      })
    } catch (err) {
      console.warn('Triage sync: subscribe sign failed:', err)
    }
  })()
}

// Encryption inserts an `await` between "decided to send" and
// "actually sent", so a re-entrancy flag (`encrypting`) keeps a
// second trySendSave from ALSO building a save while the first is
// still cooking its ciphertext. Subsequent calls during that
// window raise pendingSave just like in-flight; the first call's
// completion drains the queue.
function trySendSave(session: Session): void {
  if (!session) return
  // A session in `error` state must not auto-retry — a deterministic
  // server reject (e.g. `workspace-save-error: too-large`) would
  // otherwise re-encrypt + re-send on every keystroke, burning CPU
  // and bandwidth while the status flickers `error → online → error`.
  // Recovery is explicit via `dismissError()` (presumably after the
  // user reduces state size or the operator lifts the cap).
  if (session.error) return
  if (session.pending || session.encrypting) {
    session.pendingSave = true
    return
  }
  if (!session.key || !session.signingKey || !session.workspaceTag) {
    // Key / keypair derivation hasn't finished yet (or it failed).
    // Mark the intent so when keys arrive we send.
    session.pendingSave = true
    return
  }
  // Refresh `session.ids` against the current workspace membership
  // and hydrate state.* from baseState for ids that JUST entered
  // scope. The membership listener (`onReportMembershipChanged`)
  // catches the eager case; this lazy refresh covers anything that
  // bypassed the listener (console-driven mutation, etc.).
  refreshSessionIds(session)
  // Refresh localState from the live state.* containers in case
  // saveTriage just persisted edits we haven't snapshotted yet.
  // Done BEFORE the socket-open gate so an offline notify() still
  // syncs `session.localState` to state.* — the close handler's
  // `pendingSave = !statesEqual(localState, baseState)` then sees
  // coherent data instead of relying on the reconnect path to paper
  // over the staleness. Audit M4 round-6.
  session.localState = effectiveLocalState(session.baseState, session.ids)
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  // Once `keyframeInterval` non-keyframe revisions have piled up
  // since the last keyframe, the next save we'd emit anyway is
  // promoted to a keyframe — its changeset is the diff against an
  // EMPTY base, so the receiver can apply it standalone (the
  // server uses this to answer `from=null` subscribers without
  // replaying the whole chain). Falsy => regular delta save.
  const isKeyframe = (session.savesSinceKeyframe ?? 0) >= keyframeInterval
  const sourceBase: TriageStateMap = isKeyframe ? Object.create(null) : session.baseState
  const changeset = computeChangeset(sourceBase, session.localState)
  // Skip the wire round-trip when there's nothing to send — UNLESS
  // we're in a keyframe slot. The skip-bumped keyframe (audit M5
  // round-3) heals peers who applied a bad rev that we rejected;
  // even an empty-content keyframe has signal because receivers
  // wholesale-replace baseState with `{}` (clearing divergent
  // content). Emitting it is necessary when the local user has no
  // overlay to push but peer divergence still needs healing —
  // closes the empty-local gap audit M1 round-5 called out.
  if (changesetEmpty(changeset) && !isKeyframe) return
  const sentBase = session.baseRevision
  const sessionKey = session.key
  const signingKey = session.signingKey
  const workspaceTag = session.workspaceTag
  session.encrypting = true
  ;(async () => {
    try {
      const aad = buildAad(workspaceTag, sentBase)
      const { nonce, ciphertext } = await encryptJson(sessionKey, changeset, aad)
      // Sign the (workspaceTag, base, keyframe, nonce, ciphertext)
      // tuple — the same canonical bytes any verifier (server or
      // peer) will reconstruct from the wire fields. Holding the
      // signature proves the sender derived the workspace's
      // signing key, i.e. they know the workspace's private key.
      // Including keyframe in the signed payload binds the wire
      // flag to the signature so the server can't promote /
      // demote a revision after the fact.
      const payload: SavePayload = {
        publicKeyB64: workspaceTag,
        base: sentBase,
        keyframe: isKeyframe,
        nonceB64: nonce,
        ciphertextB64: ciphertext,
      }
      const signature = await signSavePayload(signingKey, payload)
      // Pre-compute the content-addressed revision id (SHA-256 of
      // the canonical bytes). The server derives the same id from
      // received content; the ack carries it back, and we use it
      // to a) match this pending save against its ack, and b)
      // verify the server didn't relabel the revision.
      const revisionId = await computeRevisionId(payload)
      // Session may have been removed (closeSession) during the
      // await chain — drop the result if so. baseRevision may
      // have moved if a chain landed during encryption; in that
      // case the ciphertext is bound to a stale base, so requeue.
      //
      // Also bail when the workspaceTag we captured at IIFE entry
      // no longer matches `session.workspaceTag` — the privateKey-
      // rotation handler synchronously nulls signing material to
      // poison concurrent IIFEs (audit L2 round-6); the JS version
      // got that for free by reading session.key/signingKey at the
      // crypto call site, but capturing-into-locals (forced by
      // strict TS narrowing across the await boundary) bypasses
      // that protection. Re-checking the captured tag against the
      // current value catches the rotation case without re-reading
      // the signing material at every use site.
      if (sessions.get(session.workspaceId) !== session) return
      if (session.workspaceTag !== workspaceTag) return
      if (session.baseRevision !== sentBase) {
        session.pendingSave = true
        return
      }
      session.pending = { base: sentBase, id: revisionId, changeset, keyframe: isKeyframe }
      session.pendingSave = false
      const wireMsg: { [k: string]: unknown } = {
        type: 'workspace-save',
        workspaceTag,
        base: sentBase,
        nonce,
        ciphertext,
        signature,
      }
      // Only set the wire flag when truthy — the server treats
      // missing/false the same way, and keeping the message
      // minimal in the common case keeps the wire trace cleaner.
      if (isKeyframe) wireMsg['keyframe'] = true
      send(wireMsg)
      // Crypto round-trip succeeded — clear any prior error /
      // failure-counter state so the UI moves out of `error` once
      // things are working again.
      session.consecutiveFailures = 0
      if (session.error) {
        session.error = null
        emitStatusIfChanged()
      }
    } catch (err) {
      console.warn('Triage sync: encrypt/sign failed:', err)
      // Persistent encrypt/sign failures are typically a corrupt
      // session.key or signingKey — non-recoverable from inside
      // this loop. Bump the counter and, after the threshold,
      // surface an error so the UI can warn the user instead of
      // silently retrying forever.
      if (sessions.get(session.workspaceId) === session) {
        session.consecutiveFailures = (session.consecutiveFailures ?? 0) + 1
        if (session.consecutiveFailures >= maxConsecutiveFailures) {
          session.error = `encrypt/sign failed: ${err instanceof Error ? err.message : String(err)}`
          emitStatusIfChanged()
        }
      }
    } finally {
      if (sessions.get(session.workspaceId) === session) {
        session.encrypting = false
        // If something queued during encrypt (or our own logic
        // bumped pendingSave because base moved), kick it — but
        // not if we've given up on this session via `error`,
        // otherwise a flaky-key state would just keep looping.
        if (!session.error && session.pendingSave && !session.pending) {
          session.pendingSave = false
          trySendSave(session)
        }
      }
    }
  })()
}

// Apply a chain of revisions (each `{ base, id, nonce,
// ciphertext, signature }`) to baseState. Three checks per
// revision:
//   1. continuity — `base` must equal the current baseRevision so
//      out-of-order or gappy chains don't silently corrupt state.
//      A break here triggers a resync (clear baseRevision; next
//      save resends the full state).
//   2. signature — the Ed25519 sig must verify against the
//      session's public key (= workspaceTag). A revision with a
//      bad sig is dropped and skipped; baseState stays where it
//      is for the next revision in the chain.
//   3. decrypt — AEAD tag check on the ciphertext using AAD
//      derived from (workspaceTag, base). A decrypt failure is
//      similarly skipped, not fatal.
// Skipping malformed individual revisions keeps a single bad
// message from poisoning every reconnecting client; only an
// explicit continuity break (which signature-verified attackers
// can't cause) can request a full resync.
//
// Each skip path bumps `savesSinceKeyframe` to the threshold so
// the NEXT save this session emits is a keyframe (full state,
// diff against {}). This heals the cluster for the case where
// some peers DID apply the bad rev (different verify versions,
// older clients, etc.) and ended up with a divergent baseState
// — receiving the keyframe overwrites their baseState wholesale,
// pulling everyone back into agreement. Audit M5.
async function applyChainToBase(session: Session, revisions: WireRevision[]): Promise<boolean> {
  for (const rev of revisions) {
    if (!rev || typeof rev !== 'object') continue
    // Idempotent skip — the chain from a re-subscribe might begin
    // with a revision we already applied (e.g. our reconnect's
    // `from` was the predecessor, so the first rev returned IS our
    // current baseRevision). Without this we'd fail the continuity
    // check below and trigger an unnecessary resync.
    if (typeof rev.id === 'string' && rev.id === session.baseRevision) continue
    // Continuity check: each revision's `base` must equal our
    // current baseRevision. The very first chain we receive (after
    // init, baseRevision === null) accepts a `null` base.
    const expected = session.baseRevision
    const isKeyframe = Boolean(rev.keyframe)
    // Continuity check. A keyframe arriving against a `null` local
    // baseRevision is the catch-up entry-point used by `from=null`
    // subscribes — its `base` points at some older revision the
    // client doesn't have, but the keyframe's content IS the full
    // state, so we accept it and replace baseState wholesale below.
    const ok = expected == null
      ? (rev.base == null || isKeyframe)
      : rev.base === expected
    if (!ok) {
      console.warn(`Triage sync: chain base mismatch (expected ${expected}, got ${rev.base})`)
      // Do NOT mutate baseRevision / baseState here — the caller
      // (handleChain) will first try to fill the gap by
      // re-subscribing from the current baseRevision; only if THAT
      // chain also breaks does the full reset run.
      return false
    }
    // Signature / id / decrypt failures: a malicious or buggy relay
    // could feed us a revision with arbitrary `id` (or even no id),
    // signed-but-not-verifiable, or undecryptable. We refuse to
    // advance `baseRevision` to a server-claimed id we couldn't
    // independently authenticate — that would let the relay drive
    // our chain cursor for short windows. Instead, return false so
    // `handleChain` fires the continuity-break recovery path
    // (re-subscribe from current baseRevision, then full reset on a
    // second break). Audit M1 round-4.
    //
    // We also bump `savesSinceKeyframe` so that whenever we DO
    // emit our next save, it goes out as a keyframe — peers that
    // applied the bad rev (different verify versions, future
    // protocol bug) get a wholesale replace. Audit M5 round-3.
    if (typeof rev.signature !== 'string' || typeof rev.nonce !== 'string'
      || typeof rev.ciphertext !== 'string' || typeof rev.id !== 'string') {
      console.warn('Triage sync: revision missing signature/nonce/ciphertext/id; resyncing')
      session.savesSinceKeyframe = keyframeInterval
      return false
    }
    if (!session.workspaceTag || !session.verifyingKey || !session.key) return false
    const revBase = typeof rev.base === 'string' ? rev.base : null
    const payload: SavePayload = {
      publicKeyB64: session.workspaceTag,
      base: revBase,
      keyframe: isKeyframe,
      nonceB64: rev.nonce,
      ciphertextB64: rev.ciphertext,
    }
    // Verify the signature FIRST (cheap reject for forgeries) and
    // only then compute the content-addressed id (a SHA-256 round-
    // trip we don't need to do for invalid sigs). Audit L5 round-4.
    const ok2 = await verifySavePayload(
      session.verifyingKey,
      payload,
      rev.signature,
    )
    if (!sessionIsLive(session)) return false
    if (!ok2) {
      console.warn('Triage sync: revision signature did not verify; resyncing')
      session.savesSinceKeyframe = keyframeInterval
      return false
    }
    // Recompute the content-addressed id from the same canonical
    // bytes. A server-claimed id that doesn't match the content
    // hash is the protocol's signal that the server is trying to
    // relabel / re-attribute a revision — drop the rev. The
    // keyframe flag is part of the canonical bytes, so a server
    // that flipped it on/off would also fail this check.
    const expectedId = await computeRevisionId(payload)
    if (!sessionIsLive(session)) return false
    if (rev.id !== expectedId) {
      console.warn('Triage sync: revision id does not match content hash; resyncing')
      session.savesSinceKeyframe = keyframeInterval
      return false
    }
    let changeset: Changeset
    try {
      const aad = buildAad(session.workspaceTag, revBase)
      changeset = (await decryptJson(session.key, rev.nonce, rev.ciphertext, aad)) as Changeset
    } catch (err) {
      console.warn('Triage sync: decrypt failed; resyncing', err)
      session.savesSinceKeyframe = keyframeInterval
      return false
    }
    if (!sessionIsLive(session)) return false
    // Keyframes carry a changeset computed against an EMPTY base,
    // so applying them is a wholesale replace. Reset the
    // since-last-keyframe counter; bump it on regular revs.
    const applyTo: TriageStateMap = isKeyframe ? Object.create(null) : session.baseState
    session.baseState = applyChangeset(applyTo, changeset ?? {})
    session.baseRevision = rev.id
    if (isKeyframe) session.savesSinceKeyframe = 0
    // Cap at keyframeInterval: once we cross the threshold the next
    // save we emit is a keyframe regardless of how many further
    // peer revisions land before that emit, so growing the counter
    // unbounded just bloats the persisted-sessions blob (and shows
    // up confusingly in the debug `sessionInfo` view). Audit L3
    // round-6.
    else session.savesSinceKeyframe = Math.min((session.savesSinceKeyframe ?? 0) + 1, keyframeInterval)
  }
  return true
}

// Replay a captured user overlay on top of the (already-mutated)
// baseState and sync state.* / persistence. The caller MUST capture
// the overlay BEFORE mutating baseState — `overlay = state.* −
// oldBaseState` — so non-conflicting remote changes from the new
// baseState end up in the resulting localState while the user's
// unsynced edits override on the same id (local-wins merge).
//
// Computing the overlay against a `baseState` that's already been
// mutated would collapse to identity (apply(B, compute(B, T)) ≡ T)
// and silently discard every remote change. See the bug discussion
// in the rebase audit.
//
// Conflict resolution: when the chain advances and the user's
// overlay disagrees per-property with the new baseState, the
// caller passes pre-computed `decisions` (from the
// hydrationConflictResolver) so the user's "imported" picks
// override the local-wins overlay merge. Without this, a peer's
// view silently flips when another tab joins with conflicting
// unsynced edits.
async function applyOverlayAndPersist(
  session: Session,
  overlay: Changeset,
  conflicts: Conflict[] = [],
  decisions: { [key: string]: 'local' | 'imported' } | null = null,
): Promise<void> {
  // Bail if the session was closed before we got here — applying a
  // chain to a torn-down workspace would write to the global state.*
  // / localStorage on its behalf.
  if (!sessionIsLive(session)) return
  session.localState = applyChangeset(session.baseState, overlay)
  suppressNotify++
  try {
    applyToReactiveState(session.localState, session.ids)
    // Apply the user's per-property "imported" picks AFTER the
    // overlay-wins merge landed in state.*. applyHydrationDecisions
    // writes per-property to the state.* containers, so the chain
    // value selectively replaces the user's local on the picked
    // properties without losing the user's local on properties the
    // user kept (per-property merge). The M-2 round-4 stale-check
    // inside applyHydrationDecisions also skips writes whose
    // captured `local` no longer matches the live value (a
    // saveTriage / action that landed during the dialog window).
    if (decisions && conflicts.length > 0) {
      applyHydrationDecisions(conflicts, decisions)
      // Re-derive localState from the freshly-updated state.* so
      // the changeset diff the next save computes reflects the
      // merged result.
      session.localState = effectiveLocalState(session.baseState, session.ids)
    }
    // Kick persistSession (lock-RMW, fire-and-forget) BEFORE the
    // saveTriage await. Both writes land under separate localStorage
    // keys and there's no atomic cross-key write available, but
    // scheduling the lock acquire first gives the new baseRevision a
    // head start over saveTriage's compressBrotli await — narrows the
    // crash window during which a tab teardown leaves state.* fresh
    // but the persisted base stale (which on next reload would
    // recompute the changeset against an old baseState and replay
    // already-applied content as a fresh save). Audit M2 round-6.
    persistSession(session)
    await saveTriage()
  } finally {
    suppressNotify--
  }
  // saveTriage's await may have crossed a closeSession; re-check.
  if (!sessionIsLive(session)) return
  redraw()
  // Cross-session propagation: a finding-id can belong to more than
  // one open workspace. If this session's apply touched state.* for
  // a shared id, every OTHER session whose `ids` set covers that id
  // now has unsynced state.* relative to its own baseState. Kick
  // them so they push the change under their own tag. trySendSave's
  // empty-changeset short-circuit makes the no-overlap case cheap
  // (each session's baseState already matched state.*).
  // The caller (handleAck / handleChain) takes care of the *current*
  // session's follow-up, so we skip it here to avoid double work.
  for (const other of sessions.values()) {
    if (other !== session) trySendSave(other)
  }
}

// Read state.* into `session.localState` and return the overlay
// (= state.* − current baseState). Call this BEFORE mutating
// baseState; the returned overlay is stable across the mutation
// and gets re-applied via `applyOverlayAndPersist` afterwards.
function captureOverlay(session: Session): Changeset {
  // Refresh `session.ids` so a chain landing AFTER a new report was
  // dragged in pulls the right scope when reading state.* — without
  // this, the new report's findings would be invisible to the
  // overlay/apply round-trip until the session is reopened.
  refreshSessionIds(session)
  session.localState = effectiveLocalState(session.baseState, session.ids)
  return computeChangeset(session.baseState, session.localState)
}

async function handleAck(session: Session, msg: WireMessage): Promise<void> {
  // The pending save was accepted as revision `msg.id`, built on
  // `msg.base`. Verify the base matches what we sent and fold the
  // pending changeset into baseState so it becomes the new agreed
  // floor.
  // Match both `base` and `id`: the server can't relabel a
  // revision (id is content-derived), but a stray /
  // out-of-protocol message claiming an id we didn't compute
  // shouldn't fold a phantom changeset into baseState.
  if (
    session.pending
    && msg.base === session.pending.base
    && typeof msg.id === 'string' && msg.id === session.pending.id
  ) {
    // Capture overlay BEFORE folding pending into baseState. The
    // overlay also catches edits the user made AFTER the pending
    // save was sent — they're in state.* but not in
    // pending.changeset, and would be lost otherwise.
    const overlay = captureOverlay(session)
    // Keyframes carry a changeset computed against an EMPTY base
    // (= full state); applying them is a wholesale replace.
    // Regular saves stack on the current baseState.
    const applyTo: TriageStateMap = session.pending.keyframe ? Object.create(null) : session.baseState
    session.baseState = applyChangeset(applyTo, session.pending.changeset)
    session.baseRevision = msg.id
    // Same cap as the chain-apply path — see audit L3 round-6.
    session.savesSinceKeyframe = session.pending.keyframe
      ? 0
      : Math.min((session.savesSinceKeyframe ?? 0) + 1, keyframeInterval)
    session.pending = null
    await applyOverlayAndPersist(session, overlay)
    // applyOverlayAndPersist self-bails if the session was closed
    // during its awaits, but a follow-up trySendSave on the orphan
    // would still fire — gate it.
    if (!sessionIsLive(session)) return
    // The user may have edited during the round-trip; if there's a
    // residual overlay (or pendingSave was raised), flush it.
    if (session.pendingSave || !statesEqual(session.localState, session.baseState)) {
      session.pendingSave = false
      trySendSave(session)
    }
    return
  }
  if (session.pending) {
    const ackIdHint = typeof msg.id === 'string' ? msg.id.slice(0, 8) : String(msg.id)
    console.warn(`Triage sync: ack mismatch (pending ${session.pending.base}/${session.pending.id.slice(0, 8)}, ack ${msg.base}/${ackIdHint})`)
    return
  }
  // Late ack — pending was already cleared by something else
  // (a chain that advanced baseRevision past us, a reconnect that
  // wiped pending, or an out-of-order delivery the queued
  // handler chain hasn't processed yet). The server believes the
  // save committed at `msg.id`; the changeset is no longer in
  // `pending`, so we can't fold it in. Trigger a fresh save —
  // the server's stale-base path returns the catch-up chain
  // including our committed revision, and we end up at the same
  // place via rebase.
  if (msg.id !== session.baseRevision) {
    const ackIdHint = typeof msg.id === 'string' ? msg.id.slice(0, 8) : String(msg.id)
    console.warn(`Triage sync: late ack for base=${msg.base} id=${ackIdHint}…; pending was already cleared`)
    session.pendingSave = true
    trySendSave(session)
  }
}

async function handleChain(session: Session, revisions: unknown): Promise<void> {
  // INVARIANT (load-bearing for the stale-base typed-error path):
  // empty `revisions` early-returns here WITHOUT clearing
  // `session.pending`. The stale-base server branch in
  // `server/index.ts handleSave` emits `workspace-state` (this
  // handler) THEN `workspace-save-error{stale-base}`, relying on
  // this handler to clear `session.pending` BEFORE the subsequent
  // save-error reaches `handleSaveError`. That works today because
  // `chainFrom` on a head-mismatched base ALWAYS returns ≥1 row —
  // a base mismatch by definition means at least one revision the
  // client hasn't seen. So `revisions.length === 0` is unreachable
  // on the stale-base path under the current protocol.
  //
  // If a future server change ever emits an empty `workspace-state`
  // ahead of a stale-base error frame, this early-return would let
  // `pending` survive, `handleSaveError` would find it set, take
  // the non-recoverable branch, and mark `session.error` on a
  // benign race. Either move `session.pending = null` above this
  // guard, or reaffirm the non-empty-chain server invariant.
  // Audit follow-up to PR #79 correctness review.
  if (!Array.isArray(revisions) || revisions.length === 0) return
  // Key not derived yet — bail; a future open will retry once
  // deriveSessionKey lands and trySendSave re-runs.
  if (!session.key) return
  // Capture overlay BEFORE applyChainToBase mutates baseState.
  // Also stash the OLD baseState reference (applyChainToBase
  // reassigns `session.baseState`, so this captures a stable
  // pre-rebase view for the three-way conflict-detection compare
  // below).
  const overlay = captureOverlay(session)
  const beforeBaseRevision = session.baseRevision
  const oldBaseState = session.baseState
  const ok = await applyChainToBase(session, revisions as WireRevision[])
  // applyChainToBase self-bails on a closed session (returns false
  // without mutating baseRevision); double-check before we touch
  // anything further.
  if (!sessionIsLive(session)) return
  if (!ok) {
    // Continuity break. First try to fill the gap by re-subscribing
    // with `from = current baseRevision`: in the typical case (a
    // broadcast that skipped intermediate revisions, a transient
    // out-of-order delivery), the server's subscribe response is
    // the catch-up chain we need and we keep our state.
    if (!session.resyncAttempted) {
      session.resyncAttempted = true
      console.warn('Triage sync: requesting catch-up from last known baseRevision')
      trySendSubscribe(session, true)
      return
    }
    // The re-subscribed chain also broke continuity — server has
    // either lost our base or is genuinely broken. Fall back to a
    // full state-push: reset baseRevision/baseState (state.* is
    // left alone — applying the empty overlay on top of {} would
    // clear unedited entries) and let the next save's stale-base
    // catch-up rebuild the chain.
    console.warn('Triage sync: catch-up also broke continuity; full state push')
    session.baseRevision = null
    session.baseState = Object.create(null)
    session.pending = null
    session.pendingSave = false
    session.resyncAttempted = false
    persistSession(session)
    redraw()
    trySendSave(session)
    return
  }
  session.resyncAttempted = false
  // If a save was in flight when the chain arrived, the server is
  // implicitly rejecting it (it brought us forward without acking).
  // Clear pending so the next save recomputes the changeset against
  // the freshly-rebased baseState.
  if (session.pending) {
    session.pending = null
    session.pendingSave = true
  }
  // Skip the conflict-check + apply pass when the chain didn't move
  // baseRevision (every revision was an idempotent skip via the
  // `rev.id === session.baseRevision` short-circuit in
  // applyChainToBase). Server stale-base catch-ups echo the
  // already-applied chain back when the open-handler trySendSave
  // fires before subscribe-ack — its save with `base = old
  // baseRevision` arrives at a server whose head moved past, the
  // server returns the gap chain, the client applies it, and the
  // SAME chain comes back as the stale-base catch-up after the
  // out-of-band save. Without this short-circuit, the user picks
  // "Keep current" on the first dialog and the second
  // (content-identical) chain re-fires the dialog with the same
  // conflicts even though nothing actually changed.
  if (session.baseRevision === beforeBaseRevision) {
    if (!sessionIsLive(session)) return
    if (session.pendingSave) {
      session.pendingSave = false
      trySendSave(session)
    }
    return
  }
  // Chain-conflict detection: if the user's pre-rebase overlay
  // disagrees per-property with the chain's new baseState, surface
  // the conflict so the user can pick "keep my local" (default —
  // the overlay-wins merge) or "apply from chain" (the imported
  // value overrides the local). Without this, a peer's view
  // silently flips when another tab joins with a conflicting
  // unsynced edit, and the joining client's local-wins overlay
  // silently propagates back through the chain.
  const conflicts = collectChainConflicts(overlay, oldBaseState, session.baseState)
  let decisions: { [key: string]: 'local' | 'imported' } | null = null
  if (conflicts.length > 0 && hydrationConflictResolver) {
    try {
      decisions = (await hydrationConflictResolver(conflicts, session.baseState, 'chain')) ?? null
    } catch (err) {
      console.warn('Triage sync: chain-conflict resolver failed:', err)
    }
    if (!sessionIsLive(session)) return
  }
  await applyOverlayAndPersist(session, overlay, conflicts, decisions)
  if (!sessionIsLive(session)) return
  if (session.pendingSave || !statesEqual(session.localState, session.baseState)) {
    session.pendingSave = false
    trySendSave(session)
  }
}

async function handleMessage(data: unknown): Promise<void> {
  let msg: unknown
  try { msg = JSON.parse(data as string) }
  catch (err) {
    // A persistent malformed-message storm (server bug, MITM, proxy
    // injecting HTML for an error page) is otherwise invisible to
    // operators since the previous catch was empty. Single console
    // line per malformed frame is acceptable; if it ever floods, a
    // future debounced surface can replace this. API-ergonomics
    // audit follow-up `client/triage-sync.ts:1805`.
    console.warn('Triage sync: dropping malformed wire frame:', err)
    return
  }
  if (!msg || typeof msg !== 'object') return
  const wire = msg as WireMessage
  // Heartbeat — stateless, no per-session match needed. Cancel the
  // outstanding pong-deadline timer; the next interval will start a
  // fresh round.
  if (wire.type === 'pong') {
    if (pongTimeoutId) { clearTimeout(pongTimeoutId); pongTimeoutId = null }
    return
  }
  // Server-issued challenge nonce (round-9 H2). Sent once per
  // socket, before any subscribes can be signed. Store and re-kick
  // every session's subscribe attempt so the queued subscribe-once-
  // keys-derived sessions can finally fire.
  if (wire.type === 'challenge') {
    if (typeof wire.nonce !== 'string') return
    connectionNonce = wire.nonce
    for (const session of sessions.values()) trySendSubscribe(session)
    return
  }
  // Demultiplex by `workspaceTag` — one socket carries traffic for
  // every open session. A tag we don't recognise means the message
  // is for a session we've already closed (or for a workspace this
  // client never opened); drop silently.
  if (typeof wire.workspaceTag !== 'string') return
  const session = getSessionByTag(wire.workspaceTag)
  if (!session) return
  if (wire.type === 'workspace-save-ack') {
    await handleAck(session, wire)
  } else if (wire.type === 'workspace-state') {
    await handleChain(session, wire.revisions)
  } else if (wire.type === 'workspace-save-error') {
    handleSaveError(session, wire)
  } else if (wire.type === 'workspace-subscribed') {
    // Server confirmed our subscribe was accepted — we're a
    // peer now and broadcasts will reach us. Flip the status
    // out of `connecting`. The chain that follows arrives as
    // a separate `workspace-state` message.
    session.subscribeAcked = true
    emitStatusIfChanged()
  }
}

// Server rejected a signed save after sig verify (e.g. ciphertext
// past the relay's size cap). Without this branch the save sits in
// `session.pending` forever — the server can never ack it, the
// client never rebases. Clear the pending slot and surface the
// reason via session.error so the UI can warn the user instead of
// looking online while edits silently fail to sync.
//
// Mirror `handleAck`'s base-match check so a STALE error response
// for a save that's already been rebased past doesn't clobber a
// fresh pending. Reason is sanitised to a short alphanumeric
// token — a compromised relay can't pump arbitrary bytes into
// `session.error`.
const SAVE_ERROR_REASON_RE = /^[\w-]+$/u
function handleSaveError(session: Session, wire: WireMessage): void {
  if (!session.pending) return
  if (typeof wire.base !== 'string' && wire.base !== null) return
  if (wire.base !== session.pending.base) return
  const rawReason = wire.reason
  const reason = typeof rawReason === 'string' && rawReason.length > 0 && rawReason.length <= 64 && SAVE_ERROR_REASON_RE.test(rawReason)
    ? rawReason
    : 'rejected'
  session.pending = null
  if ((RECOVERABLE_SAVE_ERROR_REASONS as ReadonlySet<string>).has(reason)) {
    // Recoverable — re-arm the save for the next natural trigger.
    // Don't bump consecutiveFailures or set error: that would push
    // the session into the explicit error state, and the user
    // would need to dismissError() to get saves flowing again.
    // The recoverable set is defined in `common/save-error-reason.ts`
    // and pinned by `tests/save-error-reason-taxonomy.test.js`;
    // note that `'stale-base'` is deliberately NOT recoverable —
    // see that module's docstring for why.
    session.pendingSave = true
    return
  }
  session.consecutiveFailures = (session.consecutiveFailures ?? 0) + 1
  session.error = `server rejected save: ${reason}`
  emitStatusIfChanged()
}

// ─────────── connection lifecycle ───────────

function startHeartbeat(): void {
  stopHeartbeat()
  pingIntervalId = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    // Don't double-arm: a previous ping is still awaiting its pong.
    // The existing pongTimeout will close the socket if that one
    // doesn't land.
    if (pongTimeoutId) return
    send({ type: 'ping' })
    pongTimeoutId = setTimeout(() => {
      pongTimeoutId = null
      console.warn('Triage sync: heartbeat timeout; closing socket')
      try { socket?.close() } catch {}
    }, pongTimeoutMs)
  }, pingIntervalMs)
}

function stopHeartbeat(): void {
  if (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = null }
  if (pongTimeoutId) { clearTimeout(pongTimeoutId); pongTimeoutId = null }
}

function clearReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect(): void {
  clearReconnect()
  if (!serverUrl) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    openSocket()
  }, reconnectDelayMs)
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY)
}

function openSocket(): void {
  if (!serverUrl || socket) return
  let ws: WebSocket
  try {
    ws = new WebSocket(serverUrl)
  } catch (err) {
    console.warn('Triage sync: WebSocket constructor failed:', err)
    scheduleReconnect()
    return
  }
  socket = ws
  ws.addEventListener('open', () => {
    reconnectDelayMs = 1_000
    // Re-establish every open session against the freshly opened
    // socket. baseState / baseRevision survived the disconnect;
    // subscribed + subscribeAcked reset so we re-subscribe per
    // session on this fresh socket and walk through `connecting`
    // until each ack arrives; if there's an overlay (or we hadn't
    // sent the initial state yet), trySendSave pushes it.
    for (const session of sessions.values()) {
      session.pending = null
      session.pendingSave = false
      // NOTE: `session.encrypting` is intentionally NOT cleared
      // here. An IIFE running across the socket-close boundary
      // is still in flight; clearing the flag would let a fresh
      // `trySendSave` (which we kick below) start a parallel
      // encryption against the new socket. Let the old IIFE drain;
      // its `send()` will land on the new socket (or no-op if the
      // socket isn't ready yet) and `pendingSave` re-kicks via
      // handleAck.
      session.subscribed = false
      session.subscribeAcked = false
      session.resyncAttempted = false
      trySendSubscribe(session)
      trySendSave(session)
    }
    startHeartbeat()
    emitStatusIfChanged()
  })
  // Serialize handlers via a Promise chain — handleAck and
  // handleChain both contain awaits (decrypt, saveTriage,
  // persistSession), and the message-event listener fires a fresh
  // async invocation per message, so without the chain two
  // handlers can interleave: one's `rebaseAndPersist` running
  // while the other reads / mutates `session.localState`,
  // double-render(), persistSession with intermediate state, and
  // similar small horrors. The chain forces strictly serial
  // processing so each message sees a settled state before the
  // next runs. Errors are swallowed (logged) so one bad message
  // doesn't break the chain.
  let queue: Promise<void> = Promise.resolve()
  ws.addEventListener('message', (e: MessageEvent) => {
    queue = queue.then(() => handleMessage(e.data)).catch((err) => {
      console.warn('Triage sync handler error:', err)
    })
  })
  ws.addEventListener('close', () => {
    // STALE CLOSE GUARD. If `socket` already moved on to a new ws
    // (e.g. setServerUrl swapped servers and the OLD ws's close
    // event is firing late), every clear below would step on the
    // NEW ws's state — connectionNonce, subscribed, the reconnect
    // schedule. Without this guard, a late old-ws close could wipe
    // the new ws's just-installed challenge nonce, leaving every
    // session's `trySendSubscribe` bailing on `nonce == null` with
    // nothing left to re-kick. Audit round-11.
    if (socket !== ws) return
    socket = null
    // Drop the per-connection challenge nonce — a reconnect issues
    // a fresh one in the new socket's `challenge` frame, and any
    // session that tries to subscribe before that frame arrives
    // bails on `connectionNonce == null`. Audit round-9 H2.
    connectionNonce = null
    stopHeartbeat()
    // The pending requests are gone with the socket — mark every
    // session's slot free so the reconnect handler resends.
    // `subscribed` / `subscribeAcked` both clear so reconnect
    // re-subscribes and the status walks `offline → connecting →
    // online` again per session.
    // Always raise pendingSave on close so the reconnect-time
    // trySendSave runs its refreshSessionIds + effectiveLocalState
    // pass and decides whether to send. The previous
    // `!statesEqual(localState, baseState)` early-decide was a
    // microoptimization that depended on `localState` being
    // perfectly fresh at close-time — fragile across the M4 round-6
    // refresh-on-bail change, and wrong when state.* edits land
    // AFTER close (the close handler doesn't re-fire). The
    // empty-changeset short-circuit inside trySendSave makes the
    // no-op case cheap, so unconditional `true` here costs us
    // nothing.
    for (const session of sessions.values()) {
      session.pending = null
      session.subscribed = false
      session.subscribeAcked = false
      session.resyncAttempted = false
      session.pendingSave = true
    }
    emitStatusIfChanged()
    // Only auto-reconnect when sync is actively wanted — a
    // user-disabled or sidebar-forced-off socket should stay
    // closed once it's down.
    if (isActive()) scheduleReconnect()
  })
  ws.addEventListener('error', () => {
    // Close fires right after — let it own the reconnect schedule.
  })
}

function closeSocket(): void {
  clearReconnect()
  reconnectDelayMs = 1_000
  // Same reasoning as the close-event handler: drop the
  // per-connection challenge nonce so a fresh socket's challenge
  // frame doesn't race a stale-nonce subscribe attempt. Audit
  // round-9 H2.
  connectionNonce = null
  // The close-event handler bails when `socket !== ws` (audit
  // round-11 stale-close guard), so the heartbeat would otherwise
  // outlive a `closeSocket()` that isn't followed by `openSocket()`
  // (setEnabled(false), setForcedOff(true), setServerUrl('')).
  // Stop it here to keep the timer counts honest.
  stopHeartbeat()
  if (socket) {
    const ws = socket
    socket = null
    try { ws.close() } catch {}
  }
}

// ─────────── public API ───────────

// Wire up the UI's render() function as the post-rebase redraw.
// Called once from the app entry; using a setter (instead of an
// import from this file) keeps the dependency arrow pointing
// ui → client, not the other way.
export function setRedraw(fn: () => void): void {
  redraw = typeof fn === 'function' ? fn : () => {}
}

// Wire up the UI's report-attach conflict dialog. Called once at
// app boot. When a report is attached to a workspace and the
// chain's baseState has triage values that disagree with the
// local state.* for an in-scope id, the resolver is invoked
// asynchronously; the user's per-conflict choices are applied
// before the next save propagates them to the chain. Same shape
// as workspace-import's resolver. Defaults to "no dialog,
// local-wins" (gap-only hydration) when not set.
export function setHydrationConflictResolver(fn: ConflictResolver | null): void {
  hydrationConflictResolver = typeof fn === 'function' ? fn : null
}

// Test-only knob: shortens the heartbeat windows so a unit test
// doesn't have to wait the production 15s/5s. No-op for any field
// that isn't a positive number.
export function setHeartbeatTimings(opts: { pingMs?: number, pongMs?: number } = {}): void {
  const { pingMs, pongMs } = opts
  if (typeof pingMs === 'number' && pingMs > 0) pingIntervalMs = pingMs
  if (typeof pongMs === 'number' && pongMs > 0) pongTimeoutMs = pongMs
  // If a heartbeat is already running (i.e. the socket is open),
  // restart it so the new interval takes effect immediately.
  if (pingIntervalId) startHeartbeat()
}

// Test-only knob: lower the keyframe interval so a test can trigger
// the keyframe path with a handful of saves. Production stays at 100.
export function setKeyframeInterval(n: number): void {
  if (typeof n === 'number' && n >= 1) keyframeInterval = n
}

// Test-only knob: lower the consecutive-failure threshold so a test
// can drive a session into the `error` state with one fault rather
// than five. Production stays at 5.
export function setMaxConsecutiveFailures(n: number): void {
  if (typeof n === 'number' && n >= 1) maxConsecutiveFailures = n
}

export const triageSync = {
  setServerUrl(url: string | null | undefined): void {
    const next = (url ?? '').trim()
    // Same-URL re-apply is intentionally a no-op — this entry point
    // is "switch server", not "retry against current server". The
    // dedicated retry paths are `dismissError(wsId)` for a single
    // session, or the `setEnabled(false)` → `setEnabled(true)`
    // toggle for all sessions. (`setForcedOff(true)` →
    // `setForcedOff(false)` mirrors the same kick logic but is
    // sidebar-visibility driven, not user-triggerable.) Without this
    // guard, every UI re-render that passes the current URL would
    // pointlessly closeSocket + reset every session's `pending` /
    // `pendingSave` / `subscribed`.
    if (next === serverUrl) return
    serverUrl = next
    // Drop persisted entries whose `serverUrl` doesn't match the
    // new relay — they could never be applied (loadPersistedSession
    // rejects on URL mismatch) and otherwise sit in localStorage
    // indefinitely. Empty `next` (sync turning off) skips the prune
    // so a user toggling sync back on doesn't lose their bases.
    if (next) prunePersistedSessions(next)
    closeSocket()
    // Server changed — revision IDs are per-server, so every
    // active session's tracking is stale. Reset each one; if
    // there's persisted state for the NEW server (or null when
    // turning sync off), fold that in. localState rebuilds from
    // state.* per session so unsynced edits survive the reset and
    // replay onto the new base via the rebase path.
    for (const session of sessions.values()) {
      session.pending = null
      session.pendingSave = false
      // Mark any in-flight encryption as orphaned. The IIFE checks
      // `sessionIsLive` before mutating session state but doesn't
      // know about reset-without-close paths; an unreset
      // `encrypting=true` makes the next `trySendSave` redundantly
      // raise `pendingSave` even though no encryption is racing.
      // Audit M2 round-4.
      session.encrypting = false
      // Server-URL change is a user-initiated reconfiguration —
      // equivalent to a `dismissError()` call. Without this, a
      // session that hit `workspace-save-error: too-large` against
      // the old server stays wedged in `error` state, and
      // `trySendSave` bails at its error-gate even when the new
      // server might accept the same payload. Audit finding M1.
      //
      // The error string can carry FOUR classes: server-reject
      // (M1's motivating case), `'workspace no longer exists'`,
      // `'key derivation failed: …'`, `'encrypt/sign failed: …'`.
      // Classes 2–4 are LOCAL faults — clearing the error here
      // without re-attempting key derivation leaves the session in
      // the "looks online but silently fails to sync" state that
      // `dismissError`'s kickKeyDerivation guards against. Mirror
      // that branch so all four classes are handled symmetrically.
      // Audit round-5 F1.
      const hadError = session.error != null
      session.error = null
      session.consecutiveFailures = 0
      session.subscribed = false
      session.subscribeAcked = false
      session.resyncAttempted = false
      const restored = next ? loadPersistedSession(session.workspaceId, next) : null
      session.baseRevision = restored?.baseRevision ?? null
      session.baseState = restored?.baseState ?? Object.create(null)
      session.savesSinceKeyframe = restored?.savesSinceKeyframe ?? 0
      session.localState = effectiveLocalState(session.baseState, session.ids)
      if (hadError && (!session.key || !session.signingKey)) {
        kickKeyDerivation(session)
      }
    }
    if (isActive()) openSocket()
    emitStatusIfChanged()
  },

  // Persisted user-driven toggle. URL stays put — re-enabling
  // resumes against the same endpoint. closeSocket() bypasses
  // reconnect because `isActive()` is now false.
  setEnabled(value: boolean): void {
    const next = Boolean(value)
    if (next === userEnabled) return
    userEnabled = next
    try {
      localStorage.setItem(USER_ENABLED_KEY, next ? '1' : '0')
    } catch {}
    if (isActive()) {
      // Re-enabling sync is equivalent to a user-initiated retry —
      // clear any sticky `error` from a previous server reject so
      // `trySendSave` isn't wedged at its error-gate. Audit
      // finding M1. Local-error classes (key derivation, encrypt
      // failure) require kickKeyDerivation to actually recover —
      // see setServerUrl for the four error classes. Round-5 F1.
      for (const session of sessions.values()) {
        const hadError = session.error != null
        session.error = null
        session.consecutiveFailures = 0
        if (hadError && (!session.key || !session.signingKey)) {
          kickKeyDerivation(session)
        }
      }
      if (!socket) openSocket()
    } else {
      closeSocket()
      for (const session of sessions.values()) {
        session.pending = null
        session.pendingSave = false
        // Audit M2 round-4: clear `encrypting` on reset paths so
        // a stranded in-flight IIFE doesn't make the next
        // `trySendSave` (when sync is re-enabled) redundantly
        // raise `pendingSave`.
        session.encrypting = false
        session.subscribed = false
        session.subscribeAcked = false
        session.resyncAttempted = false
      }
    }
    emitStatusIfChanged()
  },

  isEnabled(): boolean { return userEnabled },

  // Runtime gate driven by the sidebar's visibility logic. Same
  // close-without-touching-URL semantics as setEnabled, but isn't
  // persisted — the sidebar re-derives visibility on every render
  // from workspace state, so on next load this resets to false
  // and `setForcedOff(true/false)` runs again as appropriate.
  setForcedOff(value: boolean): void {
    const next = Boolean(value)
    if (next === forcedOff) return
    forcedOff = next
    if (isActive()) {
      // Un-force-off is equivalent to a user-initiated retry —
      // clear any sticky `error` from a previous server reject.
      // Local-error classes require kickKeyDerivation to recover;
      // see setServerUrl. Audit findings M1 + round-5 F1.
      for (const session of sessions.values()) {
        const hadError = session.error != null
        session.error = null
        session.consecutiveFailures = 0
        if (hadError && (!session.key || !session.signingKey)) {
          kickKeyDerivation(session)
        }
      }
      if (!socket) openSocket()
    } else {
      closeSocket()
      for (const session of sessions.values()) {
        session.pending = null
        session.pendingSave = false
        // Audit M2 round-4 — see setEnabled.
        session.encrypting = false
        session.subscribed = false
        session.subscribeAcked = false
        session.resyncAttempted = false
      }
    }
    emitStatusIfChanged()
  },

  getServerUrl(): string { return serverUrl },

  get connected(): boolean { return socket?.readyState === WebSocket.OPEN },

  // Status flag for connection-state indicators. One of:
  //   'off'         no server URL / user disabled / no live workspace
  //   'offline'     URL set, socket isn't open (reconnecting / down)
  //   'connecting'  socket open, no session has acked subscribe yet
  //   'online'      socket open, at least one session subscribe-acked
  //   'error'       a session has a non-recoverable error (key
  //                 derivation, persistent crypto failure); cleared
  //                 by `dismissError()`
  get status(): SyncStatus { return currentStatus() },

  // Subscribe to status transitions. Returns an unsubscribe
  // function. Listeners only fire when the status string changes,
  // so transient open → close → open during a reconnect storm
  // doesn't replay the same value back-to-back.
  onStatusChange(listener: StatusListener): () => void {
    statusListeners.add(listener)
    return () => statusListeners.delete(listener)
  },

  // Called by triage.js at the tail of saveTriage(). When inside
  // applyChainToBase / handleAck (suppressNotify > 0), bail — that
  // path already owns persistence. Otherwise schedule a save for
  // every open session; trySendSave's empty-changeset short-circuit
  // means sessions with no local changes turn into a cheap no-op.
  notify(): void {
    if (suppressNotify > 0) return
    for (const session of sessions.values()) trySendSave(session)
  },

  // Open a per-workspace session. Additive — calling with a fresh
  // `workspaceId` adds a second session multiplexed over the same
  // socket; calling with an already-open id is idempotent. The
  // single-workspace UI's "switch workspaces" path explicitly calls
  // `closeSession(oldId)` before `openSession(newId)`.
  openSession(workspaceId: string): void {
    if (!workspaceId) return
    if (sessions.has(workspaceId)) return
    const ws = listWorkspaces().find((w) => w.id === workspaceId)
    if (!ws) return
    const ids = buildWorkspaceIds(workspaceId)
    // Persisted state-per-server scope: if we synced this
    // workspace against the current `serverUrl` before, restore
    // the last `baseRevision` + `baseState` so the first
    // round-trip is a delta, not a full replay. Mismatched
    // serverUrl returns null (revision IDs don't carry across
    // servers).
    const restored = loadPersistedSession(workspaceId, serverUrl)
    const restoredBaseState = restored?.baseState ?? Object.create(null)
    // Gap-fill state.* from the restored baseState for in-scope ids
    // BEFORE computing localState. Without this, an id whose chain
    // value was set by a peer (persisted in baseState) but whose
    // local state.* never received the value (boot ordering, or the
    // user simply never opened that finding) would snapshot as `{}`,
    // and `effectiveLocalState`'s empty-snapshot branch would
    // `delete out[id]` — the next save's changeset emits `{id:
    // null}`, wiping the peer's triage from the chain. The
    // membership listener already runs hydration when reports get
    // attached mid-session, but the openSession path bypassed it
    // for already-in-scope ids restored from persisted baseState.
    // Audit round-8 M1.
    //
    // Hydrate is gap-only (local-wins on conflict). Conflicts at
    // boot would be rare (state.* loaded from `deepview.triage`
    // differing from the persisted chain baseState) and we leave
    // them unresolved here — the conflict dialog drives only the
    // eager attach path; boot keeps local values.
    hydrateStateFromBaseState(restoredBaseState, ids)
    const newSession: Session = {
      // `workspaceId` is the local UUID — used inside the app
      // (state.currentWorkspace, etc.). `workspaceTag` is the
      // base64url Ed25519 public key derived from the workspace's
      // private key; it's the server-facing identifier AND the
      // verification key for every save signature, so a server
      // (or peer) can both route messages and authenticate that
      // they came from a holder of the workspace's secret.
      // `signingKey` is the matching CryptoKey with sign
      // capability, locked inside WebCrypto — never leaves the
      // module.
      workspaceId,
      workspaceTag: null,
      signingKey: null,
      verifyingKey: null,
      ids,
      // baseRevision / baseState / savesSinceKeyframe come from
      // per-server persistence when present; otherwise null / empty
      // / 0 and the first save sends the full local snapshot.
      baseRevision: restored?.baseRevision ?? null,
      baseState: restoredBaseState,
      savesSinceKeyframe: restored?.savesSinceKeyframe ?? 0,
      localState: effectiveLocalState(restoredBaseState, ids),
      pending: null,
      pendingSave: false,
      key: null,
      encrypting: false,
      // Flips true once we ship a `workspace-subscribe` over the
      // current socket; resets on socket close so reconnects
      // re-subscribe. Decoupled from `pending` (saves) because a
      // workspace whose state is in sync still wants broadcasts.
      subscribed: false,
      // Set when the server's `workspace-subscribed` ack lands.
      // Distinct from `subscribed` (which only means "we sent the
      // request"): the server can drop a request silently on
      // sig-fail / bad-tag, so without an explicit ack the client
      // can't tell registered-as-peer from sent-into-the-void.
      // Drives the `connecting` → `online` status transition.
      subscribeAcked: false,
      // True after the chain's continuity check failed once and
      // we've already issued a re-subscribe to fill the gap. The
      // next continuity break in the same session falls through to
      // the full state-push reset; otherwise a server that keeps
      // sending broken chains would loop us forever.
      resyncAttempted: false,
      // Consecutive crypto failures (encrypt/sign in trySendSave).
      // Reset on a successful round-trip; promoted to `error` once
      // it crosses `maxConsecutiveFailures`. Per-session because
      // the cause is typically the session's own keys.
      consecutiveFailures: 0,
      // Non-recoverable error message, or null. When set, this
      // session stops retrying and `currentStatus()` aggregates to
      // `'error'` so the UI can surface it. `dismissError()`
      // clears it and retries.
      error: null,
    }
    sessions.set(workspaceId, newSession)
    kickKeyDerivation(newSession)
    if (isActive() && !socket) openSocket()
    emitStatusIfChanged()
  },

  // Close one session (by id) or, with no argument, every open
  // session. The single-workspace UI's "switch workspace" path
  // calls `closeSession(oldId)` before `openSession(newId)`; the
  // page-unload / "log out of sync" paths call it with no arg.
  //
  // Zeros `session.key` (the raw 32-byte content-encryption key from
  // `deriveSessionKey`) before dropping the session — mirrors the
  // explicit `fill(0)` wipe in `client/objstore.ts`'s `session.close()`.
  // `signingKey` is a non-extractable CryptoKey, so the runtime owns
  // its erasure; dropping the reference is the best we can do.
  closeSession(workspaceId?: string | null): void {
    if (workspaceId == null) {
      for (const s of sessions.values()) wipeSessionKey(s)
      sessions.clear()
    } else {
      const s = sessions.get(workspaceId)
      if (s) wipeSessionKey(s)
      sessions.delete(workspaceId)
    }
    emitStatusIfChanged()
  },

  // Read-only inspector keyed by workspaceId. Returns the same
  // shape the single-session API used to expose, just one entry
  // per open session. `null` for a missing id keeps the test /
  // debug ergonomics that the old getter had.
  sessionInfo(workspaceId: string): SessionInfo | null {
    const session = sessions.get(workspaceId)
    if (!session) return null
    return {
      workspaceId: session.workspaceId,
      workspaceTag: session.workspaceTag,
      baseRevision: session.baseRevision,
      pending: session.pending && { base: session.pending.base, keyframe: session.pending.keyframe },
      pendingSave: session.pendingSave,
      keyReady: session.key !== null,
      encrypting: session.encrypting,
      tracked: session.ids.size,
      savesSinceKeyframe: session.savesSinceKeyframe ?? 0,
      error: session.error ?? null,
    }
  },

  // Snapshot of all open sessions — array of `sessionInfo`-shaped
  // entries. Useful for status bars / debug consoles that want to
  // surface the multi-session state at a glance.
  get openSessions(): SessionInfo[] {
    return [...sessions.keys()].map((id) => this.sessionInfo(id)).filter((info): info is SessionInfo => info !== null)
  },

  // User-driven retry after a non-recoverable failure. Clears the
  // session's error / failure-counter and kicks subscribe + save so
  // the next round-trip attempt happens. With no argument, clears
  // every session's error. The sidebar's sync button wires the
  // no-arg form to "click while in error state".
  //
  // If key derivation never succeeded for this session (the typical
  // path into `error` from `openSession`), we re-run derivation
  // before touching the wire — without that the session keeps
  // `key === null` / `signingKey === null` and `trySendSave` /
  // `trySendSubscribe` silently bail, leaving the user with a
  // "retried, looks fine" status that secretly never syncs again.
  dismissError(workspaceId?: string | null): void {
    const ids = workspaceId == null ? [...sessions.keys()] : [workspaceId]
    let changed = false
    for (const id of ids) {
      const session = sessions.get(id)
      if (!session || !session.error) continue
      session.error = null
      session.consecutiveFailures = 0
      changed = true
      if (!session.key || !session.signingKey) {
        kickKeyDerivation(session)
      } else if (socket?.readyState === WebSocket.OPEN) {
        trySendSubscribe(session)
        trySendSave(session)
      }
    }
    if (changed) emitStatusIfChanged()
  },

  // Becomes `true` (sticky for the page-load) when the persisted-
  // sessions blob is from a future build we don't recognise and
  // `mutateAllSessions` is therefore skipping its write. UI consumers
  // (sync-status badge) read this to surface a "persistence
  // degraded" hint — the in-memory state is fine for this session
  // but won't survive a reload.
  get persistenceDegraded(): boolean { return persistenceDegradedLatch },
  // Subscribe to the degraded→clean→degraded transitions. Sticky:
  // the latch is one-way per page-load (only ever flips off→on),
  // so each subscriber receives AT MOST one callback over the
  // session.
  //
  // Late subscribers — registered AFTER the latch has already
  // flipped — are fired SYNCHRONOUSLY-on-microtask on subscribe so
  // a lazily-mounted UI component (badge, toast) doesn't have to
  // separately poll `persistenceDegraded` to discover the existing
  // state. The unsubscribe function is still returned and works
  // identically; calling it before the queued microtask runs is
  // safe — the listener is removed before the dispatch and skipped.
  onPersistenceDegraded(cb: () => void): () => void {
    persistenceDegradedListeners.add(cb)
    if (persistenceDegradedLatch) {
      queueMicrotask(() => {
        if (!persistenceDegradedListeners.has(cb)) return
        try { cb() } catch (err) { console.warn('persistenceDegraded listener:', err) }
      })
    }
    return () => persistenceDegradedListeners.delete(cb)
  },
}

// Restore the user's persisted enable flag on module load. The
// server URL is NOT persisted — the per-origin detected default
// (see `DEFAULT_SYNC_URL` in ui/view/sidebar.js) primes `serverUrl`
// via `setServerUrl`, so any previously-stored URL is purged here
// to avoid resurrecting stale endpoints from older builds.
try {
  localStorage.removeItem(LEGACY_URL_KEY)
  const savedEnabled = localStorage.getItem(USER_ENABLED_KEY)
  if (savedEnabled === '0') userEnabled = false
  if (isActive()) openSocket()
} catch {}

// Live counterpart to the page-load prune below: the moment a
// workspace is deleted via `deleteWorkspace`, drop its in-memory
// session and its persisted-base entry. Without this the session
// keeps trying to encrypt / sign saves for an id the rest of the
// app considers gone, and the persistence blob carries the dead
// base around until the next page load. Registered BEFORE
// prunePersistedSessions so a deletion that lands between
// registration and the prune still has its handler wired up
// (audit L5; defensive against any future caller that synchronously
// deletes during init).
onWorkspaceDeleted((workspaceId) => {
  const removed = sessions.delete(workspaceId)
  // Fire-and-forget — guard the rejection (Web Locks can fail on
  // tab teardown) so it can't surface as an unhandledrejection.
  // Audit M-3 (round 2).
  dropPersistedSession(workspaceId).catch((err) => {
    console.warn('Triage sync: dropPersistedSession lock failed:', err)
  })
  if (removed) emitStatusIfChanged()
})

// Workspace privateKey rotation (re-import of a re-keyed bundle, or
// a future "rotate key" affordance): the live session has cached
// `signingKey` / `workspaceTag` / `key` derived from the OLD key.
// Continuing to use them would route saves to an orphan workspaceTag
// on the server and silently drop the user's edits on the floor.
// Tear the session down (in-memory + persisted base both — the
// persisted chain was content-addressed under the old workspaceTag,
// useless to the new identity) and re-open so kickKeyDerivation
// picks up the fresh key via listWorkspaces().
onWorkspacePrivateKeyChanged((workspaceId) => {
  const oldSession = sessions.get(workspaceId)
  if (!oldSession) {
    // No live session, but a stale persisted base for the OLD
    // identity would mislead a future openSession (see audit H2).
    // Drop fire-and-forget; the rejection guard below mirrors the
    // open-session branch.
    dropPersistedSession(workspaceId).catch((err) => {
      console.warn('Triage sync: dropPersistedSession lock failed:', err)
    })
    return
  }
  // Disarm the OLD session synchronously: clear the keys / tag so
  // any `notify()` landing during the dropPersistedSession await
  // routes through trySendSave's no-keys bail (raises pendingSave
  // and returns) instead of pushing a save under the now-orphan
  // OLD workspaceTag. Without this, an edit during the rotation
  // gap would land on a chain the new identity doesn't own —
  // not data loss (the new session re-emits state.* on first save
  // post-derivation) but cosmetic chain growth on a chain nobody
  // reads. The session entry stays in `sessions` so iteration
  // doesn't skip the workspace; it gets replaced atomically by
  // openSession after the drop completes. Audit L2 round-6.
  oldSession.signingKey = null
  oldSession.key = null
  oldSession.verifyingKey = null
  oldSession.workspaceTag = null
  // Await the persisted-base wipe BEFORE reopening — `openSession`
  // calls `loadPersistedSession` (a lock-free read of the same
  // blob), so without the await it would race the lock-scheduled
  // mutator and restore the OLD identity's `baseRevision` /
  // `baseState` into the new session. The new session's first
  // subscribe would then carry a `from` that the server doesn't
  // recognize under the new tag, and the next save could clobber
  // the (just-rotated) chain. Audit H2.
  ;(async () => {
    await dropPersistedSession(workspaceId)
    sessions.delete(workspaceId)
    triageSync.openSession(workspaceId)
    emitStatusIfChanged()
  })().catch((err) => {
    // Web Locks reject on tab teardown / abort signals; without
    // this catch the IIFE rejection escapes as an unhandledrejection
    // AND `sessions.delete` + `openSession` never run, leaving the
    // session entry stranded with `signingKey = key = workspaceTag
    // = null` (set synchronously above by the disarm step). Every
    // subsequent `notify()` would then short-circuit in
    // `trySendSave` and the workspace silently stops syncing. Log
    // and explicitly clean up so a later `dismissError` /
    // re-import has a coherent state to work from.
    console.warn('Triage sync: privateKey rotation IIFE failed:', err)
    sessions.delete(workspaceId)
    emitStatusIfChanged()
  })
})

// Workspace report-membership change (drag a report in/out of a
// workspace, import that adds reports). Refreshes the open
// session's `ids` AND hydrates state.* from baseState for the
// newly-in-scope ids — without the eager hydration, the next
// `effectiveLocalState` would emit a delete for every id whose
// triage was carried in baseState but never echoed into state.*
// (the previous applyToReactiveState was scoped to the OLD
// session.ids), wiping the chain's view for those ids. Then kicks
// a save so any local edits on the now-attached findings reach
// the server promptly. No-op when the workspace has no open
// session.
onReportMembershipChanged((workspaceId) => {
  const session = sessions.get(workspaceId)
  if (!session) return
  const { conflicts, hydrated } = refreshSessionIds(session)
  // Both branches run inside an async IIFE so saveTriage is
  // ordered (no parallel writes to the deepview.triage blob from
  // back-to-back attaches), the catch keeps a Web Locks rejection
  // from leaking as an unhandledrejection, and setReportWorkspace
  // still returns synchronously to its caller. Audit M-4.
  ;(async () => {
    if (conflicts.length === 0) {
      if (hydrated) await saveTriage()
      else trySendSave(session)
      return
    }
    // Conflicts surfaced. The resolver is async (UI dialog).
    let decisions: { [key: string]: 'local' | 'imported' } | null | undefined = null
    if (hydrationConflictResolver) {
      try {
        decisions = await hydrationConflictResolver(conflicts, session.baseState, 'attach')
      } catch (err) {
        console.warn('Triage sync: hydration conflict resolver failed:', err)
      }
    }
    if (!sessionIsLive(session)) return
    if (decisions) applyHydrationDecisions(conflicts, decisions)
    // Persist state.* (gap-fill + applied decisions) and let the
    // sync layer propagate via saveTriage's notify.
    await saveTriage()
  })().catch((err) => { console.warn('Triage sync: membership listener failed:', err) })
})

// Drop persisted session entries whose workspace was deleted
// while we were away. One-time pass on module load — workspaces
// are loaded synchronously from localStorage so `listWorkspaces()`
// is ready by now. Runs AFTER the lifecycle listeners are wired so
// any synchronous deletion during init wouldn't bypass the live
// handler (audit L5).
prunePersistedSessions()
