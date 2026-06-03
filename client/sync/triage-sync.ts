import type { State } from '../state.ts'
import { type SyncHostWorkspace, onSyncHostInstalled } from './host.ts'
import { RECOVERABLE_SAVE_ERROR_REASONS } from '../../common/save-error-reason.ts'
import { applyChangeset, changesetEmpty, collectChainConflicts, computeChangeset, statesEqual } from './triage-changeset.ts'
import type { Changeset, Conflict, TriageStateMap } from './triage-changeset.ts'
import { applyHydrationDecisions, applyToReactiveState, effectiveLocalState, hydrateStateFromBaseState } from './triage-state-projection.ts'
import { dropPersistedSession, loadAllSessionsResult, loadPersistedSession, mutateAllSessions, onPersistenceDegraded, persistenceDegraded, prunePersistedSessions, setPersistenceDegraded } from './triage-session-store.ts'

// The triage data model + the pure changeset algebra live in
// triage-changeset.ts; per-workspace session persistence + the
// persistence-degraded latch live in triage-session-store.ts.
// `applyChangeset` and `mutateAllSessions` are re-exported here so the
// existing test imports keep resolving from this module.
export { applyChangeset, mutateAllSessions }

// Late-bound host accessors. Populated by the `onSyncHostInstalled`
// hook at the bottom of this file before any entry point fires; until
// then the `triageSync` methods are reachable but inert (key
// derivation / open-session paths bail on missing host calls).
let state!: State
let listWorkspaces!: () => SyncHostWorkspace[]
let saveTriage!: () => Promise<unknown>
let getSecureItem!: (key: string) => string | null
let setSecureItem!: (key: string, value: string) => Promise<void>
import { loadCachedSyncPasswordFromStorage, setCachedSyncPassword } from './sync-auth-cache.ts'
import { type AcquireHandle } from './socket-transport.ts'
import { getSharedTransport, setSharedAuthResolver } from './sync-transport.ts'
import { wsUrlToSaveUrl } from './sse-transport.ts'
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
// it) and reads the current `state.triage` entries for the workspace's
// id scope to derive `localState`.
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
// `workspace-subscribed` lands right after the server registers the
// client as a peer; `workspace-state` (the catch-up chain) follows.
// The ack distinguishes "WS open" from "subscribe accepted" — only
// the latter means broadcasts will actually reach us.
//
// `workspaceTag` is the base64url Ed25519 public key derived from
// the workspace's private key + UUID (sync-crypto.ts's
// `deriveSigningKeypair`). Routes messages and verifies each save's
// `signature` (server and receivers alike). Holders of the private
// key are the authorized writers; everyone else fails the sig check.
//
// `workspace-save-ack` confirms the pending save with `base` landed
// as revision `id` — only metadata, since we still hold the
// changeset in `pending.changeset`.
//
// `workspace-state` is a chain applied in order — initial sync
// (client base=null), broadcasts of others' changes, and stale-base
// catch-ups after a rejected save. Each revision carries `base` for
// continuity. A `pending` save when a chain arrives is treated as
// rejected: its changeset is recomputed against the new baseState
// (preserving the user's intent) and re-sent.
//
// Race protocol
// -------------
// One in-flight request per session. Local edits during inFlight
// raise `pendingSave` and flush on the next reply. Every chain /
// ack rebases: the user's overlay (= localState - baseState) is
// captured before swapping baseState, and re-applied after, so
// unsynced edits survive any server push.

// ─────────── types ───────────

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
  // `ensureSubscription` callers awaiting the NEXT
  // `workspace-subscribed` ack's objstore inventory snapshot; each
  // resolved + cleared when that ack lands. Always a fresh ack
  // (forcing a re-subscribe on an already-open session) rather than
  // a cached one, so the objstore presence layer seeds from the
  // CURRENT server inventory — a peer may have changed it since.
  objstoreResourceWaiters: Array<(rows: object[]) => void>
}

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

// Password prompt for the operator-side first-action gate. The
// server emits `unauthorized` when the connection tries to create a
// brand-new workspace without having authenticated; the client
// invokes this resolver to obtain a password and posts the matching
// `authenticate { password }` frame. `retry: true` means a prior
// attempt on this socket failed the password check — the UI should
// surface "wrong password" rather than re-prompting cold.
//
// Returning `null` (or undefined) cancels the auth flow; the
// `pendingSave` slot remains armed so the user can re-trigger by
// editing again, or by calling `dismissError` after the dialog
// closes. Returning a string sends `authenticate { password }`; on
// success the server replies `authenticated` and queued sessions
// resume.
export type AuthenticationResolver = (context: { retry: boolean }) => Promise<string | null | undefined>

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
  // `unauthorized` carries an explicit `kind` discriminator
  // (`'gated'` = blocked first action, `'auth-failed'` = rejected
  // `authenticate`); the dispatcher switches on it rather than
  // inferring from field presence. May also carry a resourceTag for
  // the objstore-side gating path — objstore.ts acts on those, this
  // module just round-trips the field through the wire shape.
  kind?: unknown
  resourceTag?: unknown
  // `workspace-subscribed` carries the objstore inventory snapshot. We
  // pass it through to the objstore presence layer via
  // `ensureSubscription`; this module treats it as an opaque row array.
  resources?: unknown
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
const SESSION_ID_RE = /^\d+$/u

// UI redraw hook (installed at boot via setRedraw). Default no-op so
// a triage-sync update outside a UI context (tests, console scripts)
// doesn't blow up; see setRedraw for the dependency-direction reason.
let redraw: () => void = () => {}

// Hydration conflict resolver (installed at boot). Default null →
// no dialog, gap-only hydration (local-wins). See
// setHydrationConflictResolver for the full contract.
let hydrationConflictResolver: ConflictResolver | null = null

// Operator-side password prompt lives on the shared transport (see
// setAuthenticationResolver). Module-level state begins here.
let serverUrl = ''
// User-driven enable/disable, persisted. Distinct from `serverUrl`
// so toggling off/on keeps the configured endpoint (no re-typing).
let userEnabled = true
// Runtime gate from the sidebar's visibility logic — when the status
// button can't be seen (no usable URL or no non-empty workspace) the
// sidebar sets this to stop the socket without touching `serverUrl`
// or `userEnabled`. Not persisted: visibility recomputes every load.
let forcedOff = false

// Shared WebSocket transport (singleton from `./sync-transport.ts`,
// also used by production objstore via `objstore-presence.js`). Owns
// the socket lifecycle, reconnect backoff, per-connection challenge
// nonce, application-level heartbeat (15s ping / 5s pong default),
// and the operator-side `authenticate` flow. We hold ONE acquire
// while `isActive()` and release on transition to inactive; the
// transport's refcount keeps the socket alive while ANY consumer
// wants it (objstore sessions hold their own acquires — so toggling
// sync off without closing workspaces keeps the socket up for it).
//
// The cached password (`./sync-auth-cache.ts`, in-memory +
// secure-storage mirror) is shared with `client/objstore.ts` so both
// planes see one value — else objstore re-prompts for the password
// the triage-sync session just learned.
const transport = getSharedTransport()
let transportAcquire: AcquireHandle | null = null

// Keyframe cadence. A keyframe carries FULL state, not a delta; a
// `from=null` subscribe returns the chain from the most recent
// keyframe (inclusive), so a fresh client catches up by applying it
// + everything after.
//
// `session.savesSinceKeyframe` increments on every applied
// non-keyframe revision (own ack or peer broadcast), resets to 0 on
// a keyframe. When it reaches `keyframeInterval` AND there's
// something to send, the next save is emitted as a keyframe.
// Persisted alongside baseRevision/baseState so a reload doesn't
// double-trigger.
//
// Mutable so tests can lower the interval; production threshold 100.
let keyframeInterval = 100

// Non-recoverable failure threshold. After this many consecutive
// encrypt/sign failures on a session — typically a corrupt/unusable
// key — we stop retrying, set the session's `error`, and aggregate
// to status `'error'` so the UI can warn. Mutable so a test can
// drop it to 1.
let maxConsecutiveFailures = 5

// True only when all gates align: URL exists, user hasn't flipped
// off, sidebar isn't suppressing, AND ≥1 workspace exists. The
// workspace-count gate releases the shared-transport acquire when
// the LAST workspace is deleted — without it the socket stays open
// with nothing to sync, and disconnect would depend on the sidebar
// happening to call `setForcedOff(true)` (fragile UI coupling).
// Gated on workspace count, not open-session count, deliberately:
// `closeSession` keeps the socket warm across a workspace switch
// (close old + open new), which doesn't change the count. The
// workspace-deleted handler re-runs `applyActive()` so the acquire
// tracks deletions.
function isActive(): boolean {
  return userEnabled && !forcedOff && Boolean(serverUrl) && hasWorkspaces()
}

// Workspace presence, guarded for the pre-install window where the
// late-bound `listWorkspaces` host accessor isn't wired yet (no
// host ⇒ nothing to sync ⇒ inactive).
function hasWorkspaces(): boolean {
  try { return listWorkspaces().length > 0 } catch { return false }
}

// `connecting` covers the window between socket-open and the
// server's `workspace-subscribed` ack — a dangling open socket
// without a registered subscription receives no broadcasts even
// though the WS layer looks fine. `online` requires the ack OR no
// active session (the empty state, nothing to subscribe to).
const statusListeners = new Set<StatusListener>()
function currentStatus(): SyncStatus {
  if (!isActive()) return 'off'
  // A non-recoverable session error takes precedence — the user must
  // see it even with a healthy socket, since no save under that
  // workspace will ever land.
  for (const session of sessions.values()) {
    if (session.error) return 'error'
  }
  const sock = transport.getSocket()
  if (!sock || sock.readyState !== WebSocket.OPEN) return 'offline'
  // Subscribe sent but not yet acked → `connecting`. Sessions still
  // deriving keys (`subscribed === false`) don't gate; they reach
  // `connecting` only once they actually attempt to subscribe.
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
// WebSocket multiplexes them — every wire message carries
// `workspaceTag`, which routes inbound to the right session
// (`getSessionByTag`). Each owns its keys, baseState, baseRevision,
// savesSinceKeyframe, pending save, etc.; nothing is shared but the
// socket and heartbeat. Added by `openSession(id)` (additive, not
// replace-current) and removed by `closeSession(id)`.
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

// True iff `session` is still the live entry for its workspaceId.
// Handlers that await across boundaries (decrypt, saveTriage,
// persistence) must re-check before mutating world state:
// `closeSession(id)` drops the entry, but the handler still holds a
// reference and would otherwise keep writing to state.* /
// localStorage / the socket for a workspace the user already tore
// down.
function sessionIsLive(session: Session): boolean {
  return sessions.get(session.workspaceId) === session
}

// Drop session's content-encryption key material before releasing
// the session. `session.key` is the raw 32-byte HKDF output from
// `deriveSessionKey`; zeroing it mirrors `objstore.ts`'s
// `contentKey.fill(0)` so the content key isn't recoverable from a
// post-close heap snapshot. `session.signingKey` is a non-extractable
// CryptoKey — runtime owns its erasure when the ref drops, so that's
// best-effort.
function wipeSessionKey(session: Session): void {
  if (session.key) {
    try { session.key.fill(0) } catch {}
    session.key = null
  }
  session.signingKey = null
  session.verifyingKey = null
  // Resolve any `ensureSubscription` callers still awaiting this
  // session's inventory snapshot — no further ack is coming, so
  // resolve with [] rather than leaving the token's `resources`
  // promise (and the objstore `list()` awaiting it) to hang.
  if (session.objstoreResourceWaiters.length > 0) {
    const waiters = session.objstoreResourceWaiters.splice(0)
    for (const w of waiters) { try { w([]) } catch {} }
  }
}

// ─────────── pure state / changeset helpers ───────────

// Collect the finding ids belonging to a workspace's reports, scoped
// by the workspace's `reports` filename list (set by drag-into-
// workspace). With multiple workspaces open, an unscoped iteration
// over `state.reports` would let one session sync ids belonging to
// another's reports — this narrowing keeps each chain to its own
// findings.
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

// ─────────── per-workspace session persistence ───────────

// Cross-tab persistence recovery (audit follow-up to PR #61 latch-
// lifecycle review). When another tab clears the sessions blob
// (DevTools / unlock-link flow / "log out everywhere"), this tab's
// degraded latch must flip back so its UI hint disappears.
//
// Subscribes to secure-storage's `onAfterHydrate`, NOT the raw
// `storage` event: the blob is read through the secure-storage cache
// (encrypted at rest under the passkey vault), and `storage` fires
// synchronously on the sibling's enveloped base64 while
// secure-storage's hydrate is async — a sync read there sees the
// stale pre-hydrate cache and misses the clear. The after-hydrate
// hook fires post-decrypt, so `loadAllSessionsResult` sees the fresh
// cache. Same pattern `workspaces.js` / `state.ts` use.
//
// Asymmetric transitions: only the two unambiguous directions flip
// the latch — unknown-version ON, recognised-version OFF. The
// 'empty' case (blob removed entirely) does NOT touch it: a
// pre-existing ON from a failed write should survive until a
// SUCCESSFUL save proves the issue (quota, vault-locked) resolved.
// Registered from the `onSyncHostInstalled` block so module init
// doesn't reach for a host that isn't installed yet.
function handleSecureStorageHydrated(): void {
  const r = loadAllSessionsResult()
  if (r.kind === 'unknown-version') setPersistenceDegraded(true)
  else if (r.kind === 'v1' || r.kind === 'legacy') setPersistenceDegraded(false)
  // Hydrate the shared auth-password cache (./sync-auth-cache.ts)
  // alongside the sessions blob, surfacing the post-unlock plaintext
  // for the in-memory replay on the next `unauthorized`. Reset the
  // per-socket replay guard so the freshly-hydrated cache gets one
  // optimistic attempt on the live connection (boot-after-unlock:
  // socket opens → server gates first save → replay from cache).
  loadCachedSyncPasswordFromStorage()
  transport.resetCachedReplayGuard()
}

function persistSession(target: Session): void {
  if (!target || !serverUrl) return
  // Capture serverUrl by value: the mutator runs inside the Web Locks
  // callback (after queueing microtasks), and a `setServerUrl(...)`
  // landing in between would stamp the entry with the wrong server's
  // URL, hiding it from `loadPersistedSession` next load. Audit M3
  // (round 1).
  const url = serverUrl
  // Fire-and-forget — callers don't await. The lock serializes the
  // RMW; back-to-back calls follow Web Locks FIFO, so the most-recent
  // state for any one workspace wins. Catch the rejection (Web Locks
  // rejects on tab teardown / browser quirks) so this can't leak an
  // unhandledrejection — audit M-3 (round 2).
  mutateAllSessions((all) => {
    all[target.workspaceId] = {
      serverUrl: url,
      baseRevision: target.baseRevision,
      savesSinceKeyframe: target.savesSinceKeyframe ?? 0,
      baseState: target.baseState,
    }
  }).catch((err) => { console.warn('Triage sync: persistSession lock failed:', err) })
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
  // Generation token: a second kick (privateKey rotation, etc.) while
  // the first IIFE is still awaiting derivation races to write
  // key/signingKey — the OLDER IIFE could clobber the NEWER's keys,
  // pinning the session to a stale identity. Bump on every kick; an
  // IIFE commits only if its captured token is still current. Audit
  // L2 round-4.
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
      // Subscribe earns broadcast-eligibility even with nothing to push.
      if (transport.getSocket()?.readyState !== WebSocket.OPEN) {
        // Socket not open yet — applyActive() acquires (and the
        // transport's first acquire opens the socket), so the page's
        // first openSession brings the connection up; later ones reuse
        // the acquisition.
        applyActive()
        return
      }
      trySendSubscribe(session)
      trySendSave(session)
      emitStatusIfChanged()
    } catch (err) {
      console.warn('Triage sync: key derivation failed:', err)
      // Non-recoverable: without signing keys we can't sign any save
      // or subscribe under this workspace. Surface it so the UI can
      // warn (typical cause: a corrupt / wrong-length privateKey).
      //
      // The `'key derivation failed:'` prefix is a contract — the
      // F1-regression tests in tests/sync-client.test.js pin it via
      // `startsWith` to verify the lifecycle handlers re-kick. If it
      // changes, update those tests too.
      if (sessions.get(session.workspaceId) === session && session.keyDerivationGen === gen) {
        session.error = `key derivation failed: ${err instanceof Error ? err.message : String(err)}`
        emitStatusIfChanged()
      }
    }
  })()
}

// ─────────── transport / wire ───────────

function send(msg: unknown): boolean {
  return transport.send(msg as object)
}

// Dispatch a `workspace-save` frame. In SSE mode, POST it to the session-
// independent REST save plane (server SAVE_REST_PATH) so the save doesn't
// force an event-stream takeover (every in-band SSE POST reopens the stream).
// The JSON result is fed back through the normal message path so the existing
// ack / stale-base / too-large handlers run unchanged. Falls back to the
// in-band frame on the new-workspace gate (401) or any transport error —
// idempotent, since a committed save replays to a duplicate-id ack and a
// stale one to a rebase. WS mode sends in-band, unchanged.
function dispatchSave(wireMsg: { [k: string]: unknown }): void {
  if (!transport.isSse()) { send(wireMsg); return }
  postSaveRest(wireMsg).then((fallBack) => {
    if (fallBack) send(wireMsg)
    return null
  }).catch(() => { send(wireMsg) })
}

// POST the save frame to the REST save plane and map the response into the
// message path. Returns true when the caller should fall back to the in-band
// frame (401 new-workspace gate, transport error, or an unexpected status).
async function postSaveRest(wireMsg: { [k: string]: unknown }): Promise<boolean> {
  if (!serverUrl) return true
  let url: string
  try { url = wsUrlToSaveUrl(serverUrl) } catch { return true }
  let res: Response
  try {
    res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wireMsg),
    })
  } catch { return true }  // offline / network error → in-band (idempotent)
  const tag = wireMsg['workspaceTag']
  const base = (wireMsg['base'] ?? null) as string | null
  if (res.status === 401) return true  // new-workspace gate → in-band (runs the auth flow)
  if (res.ok) {
    let body: { id?: unknown } | null = null
    try { body = await res.json() as { id?: unknown } } catch { return true }
    if (!body || typeof body.id !== 'string') return true
    onTransportMessage({ type: 'workspace-save-ack', workspaceTag: tag, base, id: body.id })
    return false
  }
  if (res.status === 409) {
    let body: { revisions?: unknown } | null = null
    try { body = await res.json() as { revisions?: unknown } } catch { return true }
    const revisions = body && Array.isArray(body.revisions) ? body.revisions : []
    // State FIRST then the typed error — same wire order as the WS stale-base
    // path. A well-formed catch-up clears pending, so the error frame no-ops;
    // a malformed/empty `revisions` leaves pending set and the error marks
    // session.error — the intended safe-fail (don't silently swallow a
    // divergence), reachable identically via a hostile WS frame today.
    onTransportMessage({ type: 'workspace-state', workspaceTag: tag, revisions })
    onTransportMessage({ type: 'workspace-save-error', workspaceTag: tag, base, reason: 'stale-base' })
    return false
  }
  if (res.status === 413) {
    onTransportMessage({ type: 'workspace-save-error', workspaceTag: tag, base, reason: 'too-large' })
    return false
  }
  return true  // 400 / 5xx / unexpected → in-band fallback
}

// Send a `workspace-subscribe` once per session-on-this-socket,
// registering the connection as a broadcast subscriber even with no
// local change to push (e.g. a fresh client whose triage already
// matches the server). Idempotent: `session.subscribed` flips true
// on send, resets on socket close so a reconnect re-subscribes.
// `force = true` re-sends even when `subscribed` is true — used by
// the continuity-break recovery path: re-asking with the current
// `baseRevision` returns the gap-filling catch-up chain (same
// primitive the initial subscribe uses).
function trySendSubscribe(session: Session, force = false): void {
  if (!session) return
  const sock = transport.getSocket()
  if (!sock || sock.readyState !== WebSocket.OPEN) return
  if (!force && session.subscribed) return
  if (!session.signingKey || !session.workspaceTag) return
  // The server-issued challenge nonce binds the subscribe sig to this
  // connection; we can't sign until it arrives (round-9 H2). Bailing
  // is safe — the transport's `onConnected(nonce)` re-kicks every
  // session's subscribe the moment the nonce lands.
  const startNonce = transport.getNonce()
  if (startNonce == null) return
  // Capture `from`, socket and nonce BEFORE the await — chain
  // handlers could advance baseRevision out from under us during the
  // sign promise, and a teardown + reconnect could swap the nonce.
  const fromBase = session.baseRevision
  const startSocket = sock
  const signingKey = session.signingKey
  const workspaceTag = session.workspaceTag
  ;(async () => {
    try {
      const signature = await signSubscribePayload(signingKey, workspaceTag, fromBase, startNonce)
      // Bail if the session was removed (closeSession) during the
      // sign await — id lookup is forgery-proof (one entry per id).
      if (sessions.get(session.workspaceId) !== session) return
      // Bail if the captured workspaceTag no longer matches: the
      // privateKey-rotation handler synchronously nulls signing
      // material to poison concurrent IIFEs (audit L2 round-6), but
      // capture-into-locals (forced by TS narrowing across the await)
      // bypasses that poisoning — so re-check the tag identity.
      if (session.workspaceTag !== workspaceTag) return
      // Bail if socket or nonce moved while signing (close +
      // reconnect): the signed canonical is bound to the OLD nonce
      // and would fail verify against the NEW one. `onConnected`
      // re-kicks post-reconnect.
      if (transport.getSocket() !== startSocket || transport.getNonce() !== startNonce) return
      // Mark subscribed BEFORE sending so re-entrant calls (onConnected
      // firing twice on a flaky reconnect, or back-to-back trySendSave)
      // don't double up.
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
// "actually sent", so the `encrypting` flag keeps a second
// trySendSave from building a save while the first is still cooking
// its ciphertext. Calls during that window raise pendingSave (like
// in-flight); the first call's completion drains the queue.
function trySendSave(session: Session): void {
  if (!session) return
  // A session in `error` must not auto-retry — a deterministic server
  // reject (e.g. `too-large`) would re-encrypt + re-send on every
  // keystroke, burning CPU/bandwidth and flickering the status
  // `error → online → error`. Recovery is explicit via
  // `dismissError()` (after the user shrinks state or the operator
  // lifts the cap).
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
  // Refresh `session.ids` against current membership and hydrate
  // state.* from baseState for ids that JUST entered scope. The
  // membership listener (`onReportMembershipChanged`) catches the
  // eager case; this lazy refresh covers anything that bypassed it
  // (console-driven mutation, etc.).
  refreshSessionIds(session)
  // Refresh localState from the live state.* in case saveTriage just
  // persisted unsnapshotted edits. BEFORE the socket-open gate so an
  // offline notify() still syncs localState to state.* — the close
  // handler's pendingSave decision then sees coherent data instead of
  // relying on the reconnect path to paper over staleness. Audit M4
  // round-6.
  session.localState = effectiveLocalState(session.baseState, session.ids)
  const sock = transport.getSocket()
  if (!sock || sock.readyState !== WebSocket.OPEN) return
  // Once `keyframeInterval` non-keyframe revisions piled up, the next
  // save we'd emit anyway is promoted to a keyframe: its changeset is
  // the diff against an EMPTY base, so a receiver can apply it
  // standalone (the server answers `from=null` subscribers with it,
  // no full-chain replay). Falsy => regular delta save.
  const isKeyframe = (session.savesSinceKeyframe ?? 0) >= keyframeInterval
  const sourceBase: TriageStateMap = isKeyframe ? Object.create(null) : session.baseState
  const changeset = computeChangeset(sourceBase, session.localState)
  // Skip the round-trip when there's nothing to send — UNLESS we're
  // in a keyframe slot. Even an empty-content keyframe has signal:
  // receivers wholesale-replace baseState with `{}`, healing peers
  // who applied a bad rev we rejected (audit M5 round-3). Emitting it
  // when the local user has no overlay but peer divergence still
  // needs healing closes the empty-local gap from audit M1 round-5.
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
      // tuple — the canonical bytes any verifier (server or peer)
      // reconstructs from the wire fields. The signature proves the
      // sender holds the workspace's private key. Including keyframe
      // binds the wire flag to the sig, so the server can't
      // promote/demote a revision after the fact.
      const payload: SavePayload = {
        publicKeyB64: workspaceTag,
        base: sentBase,
        keyframe: isKeyframe,
        nonceB64: nonce,
        ciphertextB64: ciphertext,
      }
      const signature = await signSavePayload(signingKey, payload)
      // Pre-compute the content-addressed revision id (SHA-256 of the
      // canonical bytes). The server derives the same id and echoes it
      // in the ack; we use it to (a) match this pending save to its
      // ack and (b) verify the server didn't relabel the revision.
      const revisionId = await computeRevisionId(payload)
      // Session may have been removed (closeSession) during the await
      // chain — drop the result. The captured-tag check catches a
      // privateKey rotation that nulled signing material mid-flight
      // (audit L2 round-6; see trySendSubscribe for why capture-into-
      // locals needs an explicit re-check). And if baseRevision moved
      // (a chain landed during encryption) the ciphertext is bound to
      // a stale base, so requeue.
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
      // Set the wire flag only when truthy — server treats
      // missing/false alike, and a minimal message keeps the wire
      // trace cleaner in the common case.
      if (isKeyframe) wireMsg['keyframe'] = true
      dispatchSave(wireMsg)
      // Crypto round-trip succeeded — clear any prior error /
      // failure-counter so the UI moves out of `error`.
      session.consecutiveFailures = 0
      if (session.error) {
        session.error = null
        emitStatusIfChanged()
      }
    } catch (err) {
      console.warn('Triage sync: encrypt/sign failed:', err)
      // Persistent encrypt/sign failures are typically a corrupt
      // session.key/signingKey — non-recoverable here. Bump the
      // counter and, past the threshold, surface an error rather than
      // retrying forever.
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
        // If something queued during encrypt (or base moved), kick it
        // — but not when we've given up via `error`, else a flaky-key
        // state loops forever.
        if (!session.error && session.pendingSave && !session.pending) {
          session.pendingSave = false
          trySendSave(session)
        }
      }
    }
  })()
}

// Apply a chain of revisions (each `{ base, id, nonce, ciphertext,
// signature }`) to baseState. Three checks per revision:
//   1. continuity — `base` must equal the current baseRevision so
//      out-of-order/gappy chains can't silently corrupt state. A
//      break triggers a resync (clear baseRevision; next save
//      resends full state).
//   2. signature — Ed25519 sig must verify against the session's
//      public key (= workspaceTag). Bad-sig revs are skipped;
//      baseState holds for the next rev in the chain.
//   3. decrypt — AEAD tag check using AAD from (workspaceTag, base);
//      a failure is likewise skipped, not fatal.
// Skipping malformed individual revs keeps one bad message from
// poisoning every reconnecting client; only an explicit continuity
// break (which signature-verified attackers can't cause) requests a
// full resync.
//
// Each skip path bumps `savesSinceKeyframe` to the threshold so the
// NEXT save is a keyframe (full state, diff against {}). This heals
// peers who DID apply the bad rev (different verify versions, older
// clients) and diverged — the keyframe overwrites their baseState
// wholesale, pulling everyone back into agreement. Audit M5.
async function applyChainToBase(session: Session, revisions: WireRevision[]): Promise<boolean> {
  for (const rev of revisions) {
    if (!rev || typeof rev !== 'object') continue
    // Idempotent skip — the chain from a re-subscribe might begin
    // with a revision we already applied (e.g. our reconnect's
    // `from` was the predecessor, so the first rev returned IS our
    // current baseRevision). Without this we'd fail the continuity
    // check below and trigger an unnecessary resync.
    if (typeof rev.id === 'string' && rev.id === session.baseRevision) continue
    // Continuity check: `rev.base` must equal our current
    // baseRevision. With baseRevision === null (post-init), accept a
    // `null` base OR a keyframe — a keyframe against null is the
    // `from=null` catch-up entry-point: its `base` points at an older
    // rev we don't have, but its content IS full state, so we accept
    // and replace baseState wholesale below.
    const expected = session.baseRevision
    const isKeyframe = Boolean(rev.keyframe)
    const ok = expected == null
      ? (rev.base == null || isKeyframe)
      : rev.base === expected
    if (!ok) {
      console.warn(`Triage sync: chain base mismatch (expected ${expected}, got ${rev.base})`)
      // Do NOT mutate baseRevision/baseState — the caller
      // (handleChain) first tries to fill the gap by re-subscribing
      // from the current baseRevision; the full reset runs only if
      // THAT chain also breaks.
      return false
    }
    // Missing signature/nonce/ciphertext/id: a malicious/buggy relay
    // could feed an arbitrary, unverifiable, or undecryptable rev. We
    // refuse to advance `baseRevision` to a server-claimed id we
    // can't independently authenticate (that would let the relay
    // drive our chain cursor); return false so `handleChain` fires
    // the continuity-break recovery (re-subscribe, then full reset on
    // a second break). Audit M1 round-4. Bump savesSinceKeyframe so
    // our next save is a keyframe, wholesale-replacing for any peer
    // that applied the bad rev. Audit M5 round-3.
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
    // Verify the signature FIRST (cheap forgery reject), then compute
    // the content-addressed id — no SHA-256 round-trip for invalid
    // sigs. Audit L5 round-4.
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
    // bytes. A server-claimed id that doesn't match the content hash
    // signals the server is relabeling/re-attributing a revision —
    // drop it. The keyframe flag is in the canonical bytes, so a
    // flipped flag also fails here.
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
    // Keyframes carry a changeset against an EMPTY base, so applying
    // is a wholesale replace; reset the counter, bump on regular revs.
    const applyTo: TriageStateMap = isKeyframe ? Object.create(null) : session.baseState
    session.baseState = applyChangeset(applyTo, changeset ?? {})
    session.baseRevision = rev.id
    if (isKeyframe) session.savesSinceKeyframe = 0
    // Cap at keyframeInterval: once over the threshold the next save
    // is a keyframe regardless of how many more peer revs land first,
    // so growing unbounded only bloats the persisted blob (and the
    // debug `sessionInfo` view). Audit L3 round-6.
    else session.savesSinceKeyframe = Math.min((session.savesSinceKeyframe ?? 0) + 1, keyframeInterval)
  }
  return true
}

// Replay a captured user overlay on top of the (already-mutated)
// baseState and sync state.* / persistence. The caller MUST capture
// the overlay (= state.* − oldBaseState) BEFORE mutating baseState,
// so non-conflicting remote changes from the new baseState land in
// the resulting localState while the user's unsynced edits override
// on the same id (local-wins merge). Computing it against an
// already-mutated baseState collapses to identity
// (apply(B, compute(B, T)) ≡ T), silently discarding every remote
// change — see the rebase-audit bug discussion.
//
// Conflict resolution: when the user's overlay disagrees per-property
// with the new baseState, the caller passes pre-computed `decisions`
// (from the hydrationConflictResolver) so the user's "imported" picks
// override the local-wins merge. Without it, a peer's view silently
// flips when another tab joins with conflicting unsynced edits.
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
    // Apply the user's "imported" picks AFTER the overlay-wins merge
    // landed in state.*. applyHydrationDecisions writes per-property,
    // so the chain value replaces local only on the picked properties
    // and keeps local on the rest (per-property merge). Its M-2
    // round-4 stale-check also skips writes whose captured `local` no
    // longer matches the live value (a saveTriage/action during the
    // dialog window).
    if (decisions && conflicts.length > 0) {
      applyHydrationDecisions(conflicts, decisions)
      // Re-derive localState from the updated state.* so the next
      // save's changeset diff reflects the merged result.
      session.localState = effectiveLocalState(session.baseState, session.ids)
    }
    // Kick persistSession (lock-RMW, fire-and-forget) BEFORE the
    // saveTriage await. The two writes land under separate
    // localStorage keys with no atomic cross-key write, but scheduling
    // the lock acquire first gives the new baseRevision a head start
    // over saveTriage's compressDeflate await — narrowing the crash
    // window where a teardown leaves state.* fresh but the persisted
    // base stale (which on reload recomputes the changeset against the
    // old baseState and replays already-applied content as a fresh
    // save). Audit M2 round-6.
    persistSession(session)
    await saveTriage()
  } finally {
    suppressNotify--
  }
  // saveTriage's await may have crossed a closeSession; re-check.
  if (!sessionIsLive(session)) return
  redraw()
  // Cross-session propagation: a finding-id can belong to multiple
  // open workspaces. If this apply touched state.* for a shared id,
  // every OTHER session covering it now has unsynced state.* vs its
  // own baseState — kick them to push under their own tag.
  // trySendSave's empty-changeset short-circuit makes the no-overlap
  // case cheap. The caller (handleAck/handleChain) handles the
  // *current* session's follow-up, so skip it here.
  for (const other of sessions.values()) {
    if (other !== session) trySendSave(other)
  }
}

// Read state.* into `session.localState` and return the overlay
// (= state.* − current baseState). Call this BEFORE mutating
// baseState; the overlay is stable across the mutation and gets
// re-applied via `applyOverlayAndPersist` afterwards.
function captureOverlay(session: Session): Changeset {
  // Refresh `session.ids` so a chain landing AFTER a report was
  // dragged in reads the right scope — else the new report's
  // findings stay invisible to the overlay/apply round-trip until
  // the session is reopened.
  refreshSessionIds(session)
  session.localState = effectiveLocalState(session.baseState, session.ids)
  return computeChangeset(session.baseState, session.localState)
}

async function handleAck(session: Session, msg: WireMessage): Promise<void> {
  // Pending save accepted as `msg.id`, built on `msg.base`. Fold the
  // pending changeset into baseState so it becomes the new agreed
  // floor. Match both `base` and `id`: id is content-derived (server
  // can't relabel), but a stray/out-of-protocol message claiming an
  // id we didn't compute mustn't fold a phantom changeset in.
  if (
    session.pending
    && msg.base === session.pending.base
    && typeof msg.id === 'string' && msg.id === session.pending.id
  ) {
    // Capture overlay BEFORE folding pending into baseState — it also
    // catches edits made AFTER the pending save was sent (in state.*
    // but not in pending.changeset, else lost).
    const overlay = captureOverlay(session)
    // Keyframe changeset is against an EMPTY base (full state) →
    // wholesale replace; regular saves stack on the current baseState.
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
  // Late ack — pending was already cleared (a chain advanced
  // baseRevision past us, a reconnect wiped pending, or out-of-order
  // delivery the queue hasn't processed). The server thinks the save
  // committed at `msg.id` but the changeset is gone from `pending`,
  // so we can't fold it in. Trigger a fresh save — the server's
  // stale-base path returns the catch-up chain (incl. our committed
  // revision) and we rebase to the same place.
  if (msg.id !== session.baseRevision) {
    const ackIdHint = typeof msg.id === 'string' ? msg.id.slice(0, 8) : String(msg.id)
    console.warn(`Triage sync: late ack for base=${msg.base} id=${ackIdHint}…; pending was already cleared`)
    session.pendingSave = true
    trySendSave(session)
  }
}

async function handleChain(session: Session, revisions: unknown): Promise<void> {
  // INVARIANT (load-bearing for the stale-base typed-error path):
  // empty `revisions` early-returns WITHOUT clearing `pending`. The
  // stale-base branch in `server/index.ts handleSave` emits
  // `workspace-state` (here) THEN `workspace-save-error{stale-base}`,
  // relying on this handler to clear `pending` before the save-error
  // reaches `handleSaveError`. Safe today because `chainFrom` on a
  // head-mismatched base ALWAYS returns ≥1 row (a base mismatch means
  // ≥1 rev the client hasn't seen), so length===0 is unreachable on
  // the stale-base path.
  //
  // If a future server emits an empty `workspace-state` ahead of a
  // stale-base error, `pending` survives, `handleSaveError` finds it
  // set, takes the non-recoverable branch, and marks `error` on a
  // benign race. Preferred fix: reaffirm the non-empty-chain server
  // invariant. Hoisting `pending = null` above this guard is wider —
  // a no-op today, but would re-arm pendingSave on every empty chain
  // (changes behavior for malformed frames from a buggy/hostile
  // server). Audit follow-up to PR #79.
  if (!Array.isArray(revisions) || revisions.length === 0) return
  // Key not derived yet — bail; a future open retries once
  // deriveSessionKey lands and trySendSave re-runs. Also bypasses the
  // pending-clear, but safe: only reachable pre-key, and trySendSave
  // gates on `!session.key || !session.signingKey` before assigning
  // `pending`, so pending is provably null here. Parallel invariant
  // to the empty-revisions guard: loosening that gate wouldn't break
  // at runtime, just silently land here with pending set and take the
  // non-recoverable branch. Pinned by the sync-client pre-key
  // handleChain tests.
  if (!session.key) return
  // Capture overlay BEFORE applyChainToBase mutates baseState, and
  // stash the OLD baseState reference: applyChainToBase reassigns
  // `session.baseState`, so this pins a stable pre-rebase view for
  // the three-way conflict-detection compare below.
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
    // broadcast that skipped revisions, transient out-of-order
    // delivery) the subscribe response is the catch-up chain we need
    // and we keep our state.
    if (!session.resyncAttempted) {
      session.resyncAttempted = true
      console.warn('Triage sync: requesting catch-up from last known baseRevision')
      trySendSubscribe(session, true)
      return
    }
    // The re-subscribed chain also broke continuity — the server
    // lost our base or is broken. Fall back to a full state-push:
    // reset baseRevision/baseState (leave state.* alone — applying
    // the empty overlay on {} would clear unedited entries) and let
    // the next save's stale-base catch-up rebuild the chain.
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
  // baseRevision (every rev was an idempotent skip via applyChain-
  // ToBase's `rev.id === baseRevision` short-circuit). Server
  // stale-base catch-ups echo the already-applied chain back, so
  // without this the second (content-identical) chain re-fires the
  // conflict dialog with the same conflicts though nothing changed.
  if (session.baseRevision === beforeBaseRevision) {
    if (!sessionIsLive(session)) return
    if (session.pendingSave) {
      session.pendingSave = false
      trySendSave(session)
    }
    return
  }
  // Chain-conflict detection: if the pre-rebase overlay disagrees
  // per-property with the new baseState, surface it so the user picks
  // "keep my local" or "apply from chain" per conflict (no default;
  // dialog unavoidable, so null only when it can't be shown → keep
  // local). Without this a peer's view silently flips when another tab
  // joins with a conflicting unsynced edit, and the joiner's local-wins
  // overlay silently propagates back through the chain.
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

async function handleMessage(wire: WireMessage): Promise<void> {
  // Server accepted `authenticate { password }`. The transport
  // already resolved the auth round-trip; kick every session whose
  // `pendingSave`/`subscribed` was deferred by the gate. The socket
  // is now authorised for ANY future first-action on this connection
  // (covers one socket creating several new workspaces in a row).
  if (wire.type === 'authenticated') {
    for (const session of sessions.values()) {
      trySendSubscribe(session)
      trySendSave(session)
    }
    return
  }
  // `unauthorized.gated` — a per-action block needing the auth flow.
  // (`auth-failed` is consumed by the transport's authResponseResolver
  // and never reaches consumers.) Unknown/missing `kind` is dropped
  // silently (buggy server or future variant; safe = do nothing).
  if (wire.type === 'unauthorized') {
    if (wire.kind === 'gated') {
      // Scope the pending-save cleanup to the matching session, then
      // kick the auth flow. Objstore-side gating (resourceTag present)
      // is handled in client/objstore.ts — skip the save cleanup
      // there. An unrecognised tag just drops the gating context; the
      // auth flow still runs (authenticating now helps even though
      // THIS save was for a workspace we no longer track).
      if (typeof wire.workspaceTag === 'string') {
        const session = getSessionByTag(wire.workspaceTag)
        if (session && typeof wire.resourceTag !== 'string') handleUnauthorizedForSave(session, wire)
      }
      transport.runAuthFlow().catch((err) => { console.warn('Triage sync: auth flow failed:', err) })
    }
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
    // Subscribe accepted — we're a peer and broadcasts will reach us;
    // flip status out of `connecting`. The chain follows as a separate
    // `workspace-state`.
    session.subscribeAcked = true
    // The ack also carries the objstore inventory snapshot. Resolve
    // any `ensureSubscription` callers waiting for it so the objstore
    // presence layer seeds without observing this ack itself.
    const rows = Array.isArray(wire.resources) ? wire.resources as object[] : []
    const waiters = session.objstoreResourceWaiters.splice(0)
    for (const w of waiters) { try { w(rows) } catch {} }
    emitStatusIfChanged()
  }
}

// `unauthorized { workspaceTag, base }` — server blocked a
// `workspace-save` because the tag doesn't exist server-side yet AND
// this socket hasn't authenticated. Mirror `handleSaveError`'s
// base-match check so a stale unauthorized for an already-rebased
// save doesn't clobber a fresh pending. Cleanup is the recoverable-
// save-error branch (clear pending, re-arm pendingSave); the auth
// flow then runs once to lift the gate so the next trySendSave lands.
function handleUnauthorizedForSave(session: Session, wire: WireMessage): void {
  if (!session.pending) return
  if (typeof wire.base !== 'string' && wire.base !== null) return
  if (wire.base !== session.pending.base) return
  session.pending = null
  session.pendingSave = true
}

// Server rejected a signed save after sig verify (e.g. ciphertext
// past the relay's size cap). Without this branch the save sits in
// `pending` forever — never acked, never rebased. Clear pending and
// surface the reason via session.error so the UI warns instead of
// looking online while edits silently fail to sync.
//
// Mirror `handleAck`'s base-match check so a STALE error for an
// already-rebased save doesn't clobber a fresh pending. Reason is
// sanitised to a short alphanumeric token — a compromised relay
// can't pump arbitrary bytes into `session.error`.
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
    // Recoverable — re-arm for the next natural trigger. Don't bump
    // consecutiveFailures or set error (that forces the user to
    // dismissError() before saves flow again). The recoverable set
    // lives in `common/save-error-reason.ts`, pinned by
    // `tests/save-error-reason-taxonomy.test.js`; `'stale-base'` is
    // deliberately NOT recoverable — see that module's docstring.
    session.pendingSave = true
    return
  }
  session.consecutiveFailures = (session.consecutiveFailures ?? 0) + 1
  session.error = `server rejected save: ${reason}`
  emitStatusIfChanged()
}

// ─────────── connection lifecycle ───────────

// Serialize message handlers via a Promise chain — handleAck and
// handleChain await (decrypt, saveTriage, persistSession), and
// `onMessage` fires a fresh sync invocation per frame, so without
// the chain two handlers interleave: one's rebase+persist running
// while the other reads/mutates `session.localState`, double
// render(), persistSession with intermediate state. The chain forces
// strictly serial processing so each message sees settled state.
// Errors are swallowed (logged) so one bad message can't break the
// chain. (objstore's `onTransportMessage` is sync — its handlers
// don't await, so it needs no chain.)
let messageQueue: Promise<void> = Promise.resolve()

function onTransportMessage(msg: { type?: unknown; [k: string]: unknown }): void {
  messageQueue = messageQueue.then(() => handleMessage(msg as WireMessage)).catch((err) => {
    console.warn('Triage sync handler error:', err)
  })
}

function onTransportConnected(_nonce: string): void {
  // Re-establish every open session against the fresh socket.
  // baseState/baseRevision survived the disconnect; subscribed +
  // subscribeAcked were cleared by onTransportDisconnected and stay
  // false until each trySendSubscribe ack lands; trySendSave pushes
  // any overlay (or the not-yet-sent initial state). On first-ever
  // connect there's no preceding onDisconnected — openSession seeds
  // the same false values, so the contract holds either way.
  for (const session of sessions.values()) {
    session.pending = null
    session.pendingSave = false
    // `encrypting` is intentionally NOT cleared: an IIFE may still be
    // in flight across the close boundary, and clearing it would let
    // the trySendSave below start a parallel encryption against the
    // new socket. Let the old IIFE drain — its `send()` lands on the
    // new socket (or no-ops) and `pendingSave` re-kicks via handleAck.
    trySendSubscribe(session)
    trySendSave(session)
  }
  emitStatusIfChanged()
}

function onTransportDisconnected(_reason: string): void {
  // Pending requests died with the socket — free every slot so the
  // reconnect handler resends. `subscribed`/`subscribeAcked` both
  // clear so reconnect re-subscribes and status walks `offline →
  // connecting → online` per session. Always raise pendingSave so the
  // reconnect-time trySendSave runs its refreshSessionIds +
  // effectiveLocalState pass and decides whether to send. The old
  // `!statesEqual(localState, baseState)` early-decide depended on
  // localState being fresh at close-time — fragile post-M4-round-6,
  // and wrong when state.* edits land AFTER close (this handler
  // doesn't re-fire). The empty-changeset short-circuit makes the
  // no-op case cheap, so unconditional `true` costs nothing.
  for (const session of sessions.values()) {
    session.pending = null
    session.subscribed = false
    session.subscribeAcked = false
    session.resyncAttempted = false
    session.pendingSave = true
  }
  emitStatusIfChanged()
}

transport.addConsumer({
  onMessage: onTransportMessage,
  onConnected: onTransportConnected,
  onDisconnected: onTransportDisconnected,
})

// Reconcile the transport acquisition with `isActive()`. Acquires
// on transition true (opens the socket), releases on transition
// false (closes it, no reconnect scheduled). Idempotent — safe to
// call from any setServerUrl/setEnabled/setForcedOff path.
function applyActive(): void {
  if (isActive()) {
    if (!transportAcquire) transportAcquire = transport.acquire()
  } else if (transportAcquire) {
    transportAcquire.release()
    transportAcquire = null
  }
}

// ─────────── public API ───────────

// Wire up the UI's render() as the post-rebase redraw. A setter
// (not an import) keeps the dependency arrow ui → client, not the
// reverse.
export function setRedraw(fn: () => void): void {
  redraw = typeof fn === 'function' ? fn : () => {}
}

// Wire up the UI's report-attach conflict dialog (once at boot).
// When an attached report's chain baseState disagrees with local
// state.* for an in-scope id, the resolver is invoked async; the
// user's per-conflict choices apply before the next save propagates
// them to the chain. Returns `{ '<id>:<property>': 'local' |
// 'imported' }` or null to keep all locals. Same shape as
// workspace-import's resolver. Defaults to no dialog, local-wins
// (gap-only hydration).
export function setHydrationConflictResolver(fn: ConflictResolver | null): void {
  hydrationConflictResolver = typeof fn === 'function' ? fn : null
}

// Wire up the UI's password prompt for the operator-side first-
// action gate (once at boot). On `unauthorized` for a never-seen
// workspace tag, this resolver runs and its return is sent as
// `authenticate { password }`. Defaults to null — without it the
// auth flow is a no-op: the pending save sits in `pendingSave` with
// no path to authenticate (fine for tests/console drivers that don't
// exercise the gate).
export function setAuthenticationResolver(fn: AuthenticationResolver | null): void {
  setSharedAuthResolver(fn)
}

// Test-only knob: shortens the heartbeat windows so a unit test
// doesn't have to wait the production 15s/5s. Delegates to the
// shared transport (which owns the actual heartbeat).
export function setHeartbeatTimings(opts: { pingMs?: number, pongMs?: number } = {}): void {
  transport.setHeartbeatTimings(opts)
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

// Per-session reset helpers shared by the setServerUrl / setEnabled /
// setForcedOff toggles below.

// User-initiated retry (re-enable / un-force-off / server switch):
// clear a session's sticky `error` so `trySendSave` isn't wedged at
// its error-gate. The error has four classes — server-reject (e.g.
// `too-large`), `'workspace no longer exists'`, `'key derivation
// failed: …'`, `'encrypt/sign failed: …'`. The local-fault classes
// need key derivation re-kicked to actually recover (clearing alone
// leaves "looks online but silently fails to sync"), so re-kick when
// no keys are present. Audit M1 + round-5 F1.
function clearSessionErrorForRetry(session: Session): void {
  const hadError = session.error != null
  session.error = null
  session.consecutiveFailures = 0
  if (hadError && (!session.key || !session.signingKey)) {
    kickKeyDerivation(session)
  }
}

// Reset a session to its inactive baseline on deactivate (disable /
// force-off / server switch): free pending, drop subscribe state so a
// re-activate re-subscribes, and clear `encrypting` so a stranded
// in-flight IIFE doesn't make the next `trySendSave` redundantly raise
// `pendingSave` (audit M2 round-4). NB: `onTransportDisconnected`
// deliberately does NOT use this — it raises `pendingSave` and leaves
// `encrypting` to drain (reconnect contract), so it stays inline.
function deactivateSession(session: Session): void {
  session.pending = null
  session.pendingSave = false
  session.encrypting = false
  session.subscribed = false
  session.subscribeAcked = false
  session.resyncAttempted = false
}

export const triageSync = {
  setServerUrl(url: string | null | undefined): void {
    const next = (url ?? '').trim()
    // Same-URL re-apply is a no-op — this entry point is "switch
    // server", not "retry". Retry paths are `dismissError(wsId)` (one
    // session) or `setEnabled` off→on (all). Without this guard, every
    // re-render passing the current URL would pointlessly tear down
    // the transport and reset every session's pending/subscribed.
    if (next === serverUrl) return
    const prev = serverUrl
    serverUrl = next
    // Drop persisted entries whose `serverUrl` doesn't match the new
    // relay — they could never apply (loadPersistedSession rejects on
    // URL mismatch) and would sit in localStorage forever. Empty
    // `next` (sync off) skips the prune so toggling back on doesn't
    // lose the bases.
    if (next) prunePersistedSessions(next)
    // Invalidate the cached auth password only when actually SWITCHING
    // between two non-empty servers (different relays, different
    // gates). The initial set (`prev === ''`) and the off-toggle
    // (`next === ''`) MUST NOT wipe — that would nuke a freshly-
    // hydrated cache on every page load (boot calls setServerUrl after
    // hydrate to install the resolved URL) and on a momentary off→on
    // toggle. Audit follow-up to the "Password asked each time"
    // regression.
    if (prev && next && prev !== next) {
      setCachedSyncPassword(null).catch((err) => {
        console.warn('Triage sync: failed to drop cached auth password on server change:', err)
      })
    }
    // Swap URLs — the transport tears down the current socket and (if
    // still acquired against the new URL) re-opens. applyActive() below
    // reconciles the acquisition (valid → empty becomes a release).
    transport.setServerUrl(next)
    // Revision IDs are per-server, so every active session's tracking
    // is stale. Reset each; fold in persisted state for the NEW server
    // (or null when turning off). localState rebuilds from state.* so
    // unsynced edits survive and replay onto the new base via rebase.
    for (const session of sessions.values()) {
      deactivateSession(session)
      const restored = next ? loadPersistedSession(session.workspaceId, next) : null
      session.baseRevision = restored?.baseRevision ?? null
      session.baseState = restored?.baseState ?? Object.create(null)
      session.savesSinceKeyframe = restored?.savesSinceKeyframe ?? 0
      session.localState = effectiveLocalState(session.baseState, session.ids)
      clearSessionErrorForRetry(session)
    }
    applyActive()
    emitStatusIfChanged()
  },

  // Persisted user-driven toggle. URL stays put — re-enabling resumes
  // against the same endpoint. applyActive() releases the transport
  // acquisition when `isActive()` goes false (release tears down the
  // socket, no reconnect).
  setEnabled(value: boolean): void {
    const next = Boolean(value)
    if (next === userEnabled) return
    userEnabled = next
    // Best-effort persist via secure-storage (encrypted at rest for an
    // enabled-vault user). Failure logged, not surfaced — userEnabled
    // stays in-memory either way.
    setSecureItem(USER_ENABLED_KEY, next ? '1' : '0').catch((err: unknown) => {
      console.warn('Triage sync: could not persist user-enabled:', err)
    })
    if (isActive()) {
      for (const session of sessions.values()) clearSessionErrorForRetry(session)
    } else {
      for (const session of sessions.values()) deactivateSession(session)
    }
    applyActive()
    emitStatusIfChanged()
  },

  isEnabled(): boolean { return userEnabled },

  // Runtime gate from the sidebar's visibility logic. Same
  // close-without-touching-URL semantics as setEnabled, but not
  // persisted — the sidebar re-derives visibility every render, so
  // this resets to false on next load and re-runs as appropriate.
  setForcedOff(value: boolean): void {
    const next = Boolean(value)
    if (next === forcedOff) return
    forcedOff = next
    if (isActive()) {
      for (const session of sessions.values()) clearSessionErrorForRetry(session)
    } else {
      for (const session of sessions.values()) deactivateSession(session)
    }
    applyActive()
    emitStatusIfChanged()
  },

  getServerUrl(): string { return serverUrl },

  get connected(): boolean { return transport.getSocket()?.readyState === WebSocket.OPEN },

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

  // Called at the tail of saveTriage(). Inside applyChainToBase /
  // handleAck (suppressNotify > 0) bail — that path already owns
  // persistence. Otherwise schedule a save for every session;
  // trySendSave's empty-changeset short-circuit makes no-change
  // sessions a cheap no-op.
  notify(): void {
    if (suppressNotify > 0) return
    for (const session of sessions.values()) trySendSave(session)
  },

  // Ensure a sync session — and thus the single `workspace-subscribe`
  // for this tag on the shared socket — exists, returning a token the
  // objstore presence layer MUST pass into
  // `objstoreClient.openWorkspace`. This is the seam coupling every
  // objstore session to a backing sync subscribe: objstore never
  // subscribes itself, so it refuses to open (and send ops) without
  // this proof. Idempotent (delegates to `openSession`). Returns null
  // when the workspace is unknown, so the caller skips opening an
  // objstore session nothing would subscribe.
  //
  // The token's `resources` is the objstore inventory snapshot from
  // the next `workspace-subscribed` ack — always FRESH: a new
  // session's initial subscribe provides it, an already-open one is
  // forced to re-subscribe so the snapshot reflects CURRENT server
  // inventory (a peer may have put/deleted since our last ack).
  // Folding it in here lets objstore seed without racing to observe
  // the ack on the shared socket itself.
  ensureSubscription(workspaceId: string): { workspaceId: string; workspaceTag: string | null; resources: Promise<object[]> } | null {
    const existed = sessions.has(workspaceId)
    triageSync.openSession(workspaceId)
    const session = sessions.get(workspaceId)
    if (!session) return null
    const resources = new Promise<object[]>((resolve) => { session.objstoreResourceWaiters.push(resolve) })
    if (existed) trySendSubscribe(session, true)
    // `workspaceTag` binds the token to a workspace so objstore can
    // reject a mismatched one. Null only for a brand-new session whose
    // key derivation hasn't completed yet.
    return { workspaceId, workspaceTag: session.workspaceTag, resources }
  },

  // Open a per-workspace session. Additive — a fresh `workspaceId`
  // adds a session multiplexed over the same socket; an already-open
  // id is idempotent. The "switch workspaces" path explicitly
  // `closeSession(oldId)` before `openSession(newId)`.
  openSession(workspaceId: string): void {
    if (!workspaceId) return
    if (sessions.has(workspaceId)) return
    const ws = listWorkspaces().find((w) => w.id === workspaceId)
    if (!ws) return
    const ids = buildWorkspaceIds(workspaceId)
    // Per-server persisted state: if we synced this workspace against
    // the current `serverUrl` before, restore `baseRevision` +
    // `baseState` so the first round-trip is a delta, not a full
    // replay. Mismatched serverUrl returns null (revision IDs don't
    // carry across servers).
    const restored = loadPersistedSession(workspaceId, serverUrl)
    const restoredBaseState = restored?.baseState ?? Object.create(null)
    // Gap-fill state.* from the restored baseState for in-scope ids
    // BEFORE computing localState. Without this, an id whose chain
    // value a peer set (persisted in baseState) but whose local
    // state.* never received it (boot ordering, or the user never
    // opened that finding) would snapshot as `{}`, and
    // `effectiveLocalState`'s empty-snapshot branch would
    // `delete out[id]` — the next save emits `{id: null}`, wiping the
    // peer's triage from the chain. The membership listener hydrates
    // on mid-session attaches, but openSession bypassed it for
    // already-in-scope ids restored from persisted baseState. Audit
    // round-8 M1.
    //
    // Gap-only (local-wins on conflict). Boot conflicts (state.* from
    // `deepview.triage` differing from persisted baseState) are rare
    // and left unresolved — the conflict dialog drives only the eager
    // attach path; boot keeps local values.
    hydrateStateFromBaseState(restoredBaseState, ids)
    const newSession: Session = {
      // `workspaceId` is the local UUID (state.currentWorkspace etc.).
      // `workspaceTag` is the base64url Ed25519 public key — the
      // server-facing id AND the verification key for every save sig.
      // `signingKey` is the matching sign-capable CryptoKey, locked in
      // WebCrypto, never leaves the module.
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
      // True once we ship a `workspace-subscribe` on the current
      // socket; resets on close so reconnects re-subscribe. Decoupled
      // from `pending` — an in-sync workspace still wants broadcasts.
      subscribed: false,
      // Set when the `workspace-subscribed` ack lands. Distinct from
      // `subscribed` ("request sent"): the server can drop a request
      // silently on sig-fail / bad-tag, so without the ack we can't
      // tell registered-as-peer from sent-into-the-void. Drives
      // `connecting` → `online`.
      subscribeAcked: false,
      // True after one continuity-check failure for which we've
      // already issued a gap-filling re-subscribe. The next break
      // falls through to the full state-push reset; else a server
      // sending broken chains would loop us forever.
      resyncAttempted: false,
      // Consecutive crypto failures (encrypt/sign). Reset on a
      // successful round-trip; promoted to `error` past
      // `maxConsecutiveFailures`. Per-session — cause is typically the
      // session's own keys.
      consecutiveFailures: 0,
      // Non-recoverable error message, or null. When set, the session
      // stops retrying and `currentStatus()` aggregates to `'error'`.
      // `dismissError()` clears and retries.
      error: null,
      objstoreResourceWaiters: [],
    }
    sessions.set(workspaceId, newSession)
    kickKeyDerivation(newSession)
    applyActive()
    emitStatusIfChanged()
  },

  // Close one session (by id) or, with no argument, every open
  // session. The "switch workspace" path calls `closeSession(oldId)`
  // before `openSession(newId)`; page-unload / "log out of sync" call
  // it with no arg. Zeros `session.key` before dropping (see
  // wipeSessionKey for the key-erasure reasoning).
  closeSession(workspaceId?: string | null): void {
    if (workspaceId == null) {
      for (const s of sessions.values()) wipeSessionKey(s)
      sessions.clear()
    } else {
      const s = sessions.get(workspaceId)
      if (s) wipeSessionKey(s)
      sessions.delete(workspaceId)
    }
    // No `applyActive()` here: closeSession deliberately keeps the
    // socket warm (a workspace switch closes old + opens new — the
    // workspace still exists, so `isActive()` stays true). The
    // workspace-deleted handler reconciles the acquire instead.
    emitStatusIfChanged()
  },

  // Refresh a session's id-set against the live `state.reports` +
  // `ws.reports`, then propagate any newly-in-scope ids' triage to
  // the chain. Idempotent no-op when nothing changed.
  //
  // Called by the UI's switch paths (`switchToFile`,
  // `switchToWorkspace`) right after `ingestReport` populated
  // `state.reports`. Without it, a session opened pre-load (e.g. via
  // the membership listener when a report was dragged in while a
  // different file was focused) keeps its stale open-time id-set, so
  // loading the report later wouldn't expose its finding-ids.
  //
  // **Callers MUST `openSession(workspaceId)` first** — this does
  // NOT auto-open. The membership listener is the canonical creation
  // path (a drop signals the workspace should exist on the wire);
  // refreshSession is downstream, from switch paths that already
  // `openSession`. Auto-opening here would mask drop-misordering bugs
  // (a missing `openSession` would silently no-op and regress the
  // "issue 3" symptom this fixes). The no-session branch logs at
  // `console.debug` so a missing prelude is grep-able.
  refreshSession(workspaceId: string): void {
    const session = sessions.get(workspaceId)
    if (!session) {
      console.debug('triage-sync: refreshSession bail — no session for', workspaceId, '(caller must openSession first)')
      return
    }
    refreshAndPropagate(session)
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
  // error/failure-counter and kicks subscribe + save. No argument
  // clears every session (the sidebar's sync button wires the no-arg
  // form to "click while in error").
  //
  // If key derivation never succeeded (the typical path into `error`
  // from `openSession`), re-run derivation before touching the wire —
  // else key/signingKey stay null and trySendSave/trySendSubscribe
  // silently bail, giving the user a "retried, looks fine" status
  // that secretly never syncs again.
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
      } else if (transport.getSocket()?.readyState === WebSocket.OPEN) {
        trySendSubscribe(session)
        trySendSave(session)
      }
    }
    if (changed) emitStatusIfChanged()
  },

  // True when the persisted-sessions blob is in an unknown-version
  // state `mutateAllSessions` refuses to overwrite. The sync-status
  // badge surfaces a "persistence degraded" hint — in-memory state
  // works but won't survive a reload until the blob is cleared.
  // Two-way: flips OFF when a later `mutateAllSessions` writes a
  // recognized v1 shape, and the cross-tab listener re-probes and
  // aligns the latch when another tab mutates the blob.
  get persistenceDegraded(): boolean { return persistenceDegraded() },
  // Subscribe to degraded-state transitions (fires on every off↔on
  // change AND once on subscribe with the current value). The latch +
  // listeners live in triage-session-store.ts; delegate to it.
  onPersistenceDegraded(cb: (degraded: boolean) => void): () => void { return onPersistenceDegraded(cb) },
}

// Boot wiring — the listeners and persisted-flag restore reach into
// the host, so they run inside `onSyncHostInstalled`, not at module
// init. The host is installed once by `ui/view.js` before any
// `triageSync.*` fires (contract in `client/sync/host.ts`).
onSyncHostInstalled((host) => {
  state = host.state
  listWorkspaces = host.listWorkspaces
  saveTriage = host.saveTriage
  getSecureItem = host.getSecureItem
  setSecureItem = host.setSecureItem

  host.onSecureStorageHydrated(handleSecureStorageHydrated)

  // Restore the persisted enable flag. The server URL is NOT
  // persisted — the per-origin default (`DEFAULT_SYNC_URL` in
  // ui/view/sidebar.js) primes `serverUrl`, so any stored URL is
  // purged here to avoid resurrecting stale endpoints from old builds.
  try {
    localStorage.removeItem(LEGACY_URL_KEY)
    const savedEnabled = getSecureItem(USER_ENABLED_KEY)
    if (savedEnabled === '0') userEnabled = false
    applyActive()
  } catch {}

  // Live counterpart to the page-load prune below: on
  // `deleteWorkspace`, drop the in-memory session and its
  // persisted-base entry. Else the session keeps signing saves for an
  // id the app considers gone, and the persistence blob carries the
  // dead base until next load. Registered BEFORE prunePersistedSessions
  // so a deletion landing during init still has its handler wired
  // (audit L5).
  host.onWorkspaceDeleted((workspaceId) => {
    const removed = sessions.delete(workspaceId)
    // Fire-and-forget — guard the rejection (Web Locks can fail on
    // tab teardown) so it can't surface as an unhandledrejection.
    // Audit M-3 (round 2).
    dropPersistedSession(workspaceId).catch((err) => {
      console.warn('Triage sync: dropPersistedSession lock failed:', err)
    })
    // Reconcile the acquire unconditionally: deleting the LAST
    // workspace makes `isActive()` false, tearing down the socket —
    // even if this workspace never had a triage session (the acquire
    // is held per-workspace-existence, not per-session). The fire runs
    // after the store mutation commits, so `listWorkspaces()` already
    // reflects the deletion.
    applyActive()
    if (removed) emitStatusIfChanged()
  })

  // Workspace privateKey rotation (re-import of a re-keyed bundle, or
  // a future "rotate key" affordance): the live session's cached
  // `signingKey` / `workspaceTag` / `key` are from the OLD key.
  // Continuing would route saves to an orphan workspaceTag and
  // silently drop the user's edits. Tear the session down (in-memory
  // AND persisted base — the chain was content-addressed under the
  // old tag, useless to the new identity) and re-open so
  // kickKeyDerivation picks up the fresh key via listWorkspaces().
  host.onWorkspacePrivateKeyChanged((workspaceId) => {
    const oldSession = sessions.get(workspaceId)
    if (!oldSession) {
      // No live session, but a stale persisted base for the OLD
      // identity would mislead a future openSession (audit H2).
      dropPersistedSession(workspaceId).catch((err) => {
        console.warn('Triage sync: dropPersistedSession lock failed:', err)
      })
      return
    }
    // Disarm the OLD session synchronously: clear keys/tag so a
    // `notify()` during the dropPersistedSession await routes through
    // trySendSave's no-keys bail instead of pushing under the orphan
    // OLD workspaceTag. An edit during the rotation gap would
    // otherwise land on a chain the new identity doesn't own — not
    // data loss (the new session re-emits state.* on first save) but
    // cosmetic growth on a chain nobody reads. The entry stays in
    // `sessions` so iteration doesn't skip it; openSession replaces it
    // atomically after the drop. Audit L2 round-6.
    oldSession.signingKey = null
    oldSession.key = null
    oldSession.verifyingKey = null
    oldSession.workspaceTag = null
    // Invalidate any in-flight key derivation too: a kickKeyDerivation
    // IIFE started under the OLD privateKey may still be awaiting, and
    // nulling the fields above doesn't stop it — its commit guard only
    // checks `sessions.get(...) === session` (true until the delete
    // below) and `keyDerivationGen !== gen`. Without the gen bump it
    // would re-commit OLD-key material under the orphan tag and
    // trySendSubscribe/Save on it. Same invalidation kickKeyDerivation
    // does per kick.
    oldSession.keyDerivationGen = (oldSession.keyDerivationGen ?? 0) + 1
    // Await the persisted-base wipe BEFORE reopening — `openSession`'s
    // `loadPersistedSession` is a lock-free read of the same blob, so
    // without the await it races the lock-scheduled mutator and
    // restores the OLD identity's baseRevision/baseState into the new
    // session. Its first subscribe would then carry a `from` the
    // server doesn't recognize under the new tag, and the next save
    // could clobber the just-rotated chain. Audit H2.
    ;(async () => {
      await dropPersistedSession(workspaceId)
      sessions.delete(workspaceId)
      triageSync.openSession(workspaceId)
      emitStatusIfChanged()
    })().catch((err) => {
      // Web Locks reject on tab teardown / abort. Without this catch
      // the rejection escapes as an unhandledrejection AND
      // `sessions.delete` + `openSession` never run, stranding the
      // entry with keys/tag nulled (by the disarm above) — every later
      // `notify()` short-circuits in `trySendSave` and the workspace
      // silently stops syncing. Log and clean up so a later
      // `dismissError` / re-import has coherent state.
      console.warn('Triage sync: privateKey rotation IIFE failed:', err)
      sessions.delete(workspaceId)
      emitStatusIfChanged()
    })
  })

  host.onReportMembershipChanged((workspaceId) => {
    // Open the session if not already. Dragging a report into a
    // workspace the user hasn't navigated to must still propagate its
    // triage to peers — attaching signals the workspace now claims
    // those finding-ids, else the next browser to open it sees stale
    // data. Idempotent on already-open ids. Mirrors the
    // objstore-presence membership listeners.
    triageSync.openSession(workspaceId)
    const session = sessions.get(workspaceId)
    if (!session) return  // workspace doesn't exist (deleted concurrently)
    refreshAndPropagate(session)
  })

  // Drop persisted entries whose workspace was deleted while away.
  // One-time pass on host install — workspaces load synchronously
  // from localStorage so `listWorkspaces()` is ready here. Runs AFTER
  // the lifecycle listeners so a synchronous deletion during init
  // can't bypass the live handler (audit L5).
  prunePersistedSessions()
})

// Refresh a session's id-set against the live `state.reports` +
// `ws.reports`, hydrate state.* from baseState for newly-in-scope
// ids, and propagate them to the chain. The hydration is
// load-bearing: without it the next `effectiveLocalState` emits a
// delete for every id whose triage was in baseState but never echoed
// into state.* (applyToReactiveState was scoped to the OLD ids),
// wiping the chain's view for those ids.
// Called by the `onReportMembershipChanged` listener (report
// attached/detached) and `triageSync.refreshSession` (switch paths
// after `state.reports` mutates, exposing a newly-loaded report's
// finding-ids).
//
// Branches on whether `refreshSessionIds` found newly-added ids AND
// whether their hydration surfaced conflicts. Conflict-free common
// case: `saveTriage` (fans gap-filled state.* into the chain via
// notify) or, when nothing hydrated, `trySendSave` directly.
function refreshAndPropagate(session: Session): void {
  const { conflicts, hydrated } = refreshSessionIds(session)
  // Both branches run inside an async IIFE so saveTriage is ordered
  // (no parallel writes to the deepview.triage blob from back-to-back
  // attaches), the catch keeps a Web Locks rejection from leaking,
  // and the caller (membership listener or `refreshSession`) still
  // returns synchronously. Audit M-4.
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
  })().catch((err) => { console.warn('Triage sync: refreshAndPropagate failed:', err) })
}

