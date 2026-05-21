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
// then the `triageSync` object's methods are reachable but inert
// (key derivation / open-session paths bail on missing host calls).
// Direct references read cleaner at each call site than
// `syncHost().listWorkspaces()` and let the existing closure-captured
// pattern stay unchanged.
let state!: State
let listWorkspaces!: () => SyncHostWorkspace[]
let saveTriage!: () => Promise<unknown>
let getSecureItem!: (key: string) => string | null
let setSecureItem!: (key: string, value: string) => Promise<void>
import { loadCachedSyncPasswordFromStorage, setCachedSyncPassword } from './sync-auth-cache.ts'
import { type AcquireHandle } from './socket-transport.ts'
import { getSharedTransport, setSharedAuthResolver } from './sync-transport.ts'
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
  // (`'gated'` for a blocked first action, `'auth-failed'` for a
  // rejected `authenticate`) — the dispatcher switches on it
  // rather than inferring from field presence. May also carry a
  // resourceTag for the objstore-side gating path; this module
  // doesn't act on those (objstore.ts handles them) but the field
  // has to round-trip through the wire-message shape.
  kind?: unknown
  resourceTag?: unknown
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
// Operator-side password cache for the first-action gate. Stored
// via secure-storage so a passkey-enabled vault keeps it encrypted
// at rest. Single string (one password per page session); on server
// URL change the cache is dropped because per-server passwords are
// independent. Hydrated alongside the other secure keys at boot.
// Cached auth password lives in `./sync-auth-cache.ts` and is shared
// with the objstore session (same secure-storage envelope, same
// in-memory mirror — see that module for the rationale on the
// no-per-server-scoping shape).
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

// Operator-side password prompt — installed once at app boot via
// `setAuthenticationResolver(...)`. Lives on the shared transport
// (see `./sync-transport.ts`) so the same resolver drives both
// triage-sync and objstore auth gates on a shared socket. Defaults
// to null — when no resolver is wired (tests, console drivers),
// the auth flow is a no-op: the pending save sits in `pendingSave`
// until a future trigger.
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

// Shared WebSocket transport. Owns the socket lifecycle, reconnect
// backoff, per-connection challenge nonce, application-level
// heartbeat (15s ping / 5s pong timeout default), and the
// operator-side `authenticate` flow. We hold ONE acquire while
// `isActive()` (URL + userEnabled + !forcedOff) and release on
// transition to inactive — the transport's refcount keeps the
// socket alive as long as ANY consumer wants it (objstore
// workspace sessions hold their own acquires; toggling sync off
// without closing workspaces keeps the socket open for objstore).
//
// The transport is the singleton from `./sync-transport.ts` —
// shared with production objstore via `objstore-presence.js`.
// The cached password lives in `./sync-auth-cache.ts` (in-memory
// + secure-storage mirror) and is shared with `client/objstore.ts`
// so both planes see the same value — without the shared cache,
// objstore would re-prompt for the same password the triage-sync
// session just learned.
const transport = getSharedTransport()
let transportAcquire: AcquireHandle | null = null

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
// flipped off, the sidebar isn't suppressing, AND at least one
// workspace exists. The workspace-count gate is what releases the
// shared-transport acquire once the LAST workspace is deleted:
// without it, triage-sync keeps the socket open with nothing to
// sync (the disconnect would then depend on the sidebar happening
// to call `setForcedOff(true)`, fragile UI coupling). It's gated on
// workspace count rather than open-session count deliberately —
// `closeSession` keeps the socket warm across a workspace switch
// (close old + open new), and that switch doesn't change the
// workspace count, so the socket survives. `applyActive()` is
// re-run from the workspace-deleted handler so the acquire tracks
// deletions.
function isActive(): boolean {
  return userEnabled && !forcedOff && Boolean(serverUrl) && hasWorkspaces()
}

// Workspace presence, guarded for the pre-install window where the
// late-bound `listWorkspaces` host accessor isn't wired yet (no
// host ⇒ nothing to sync ⇒ inactive).
function hasWorkspaces(): boolean {
  try { return listWorkspaces().length > 0 } catch { return false }
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
  const sock = transport.getSocket()
  if (!sock || sock.readyState !== WebSocket.OPEN) return 'offline'
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

// Cross-tab persistence recovery. The `storage` event fires on
// every OTHER tab when localStorage mutates. Tab-A clearing the
// sessions blob from DevTools / the unlock-link flow / a user
// "log out everywhere" affordance: tab-B's latch (if currently
// degraded) needs to flip back so its UI hint disappears. Probe
// `loadAllSessionsResult` on the storage event for the
// SESSION_STATE_KEY; ignore other keys so we don't spin on
// unrelated localStorage activity. Audit follow-up to PR #61
// latch-lifecycle review.
//
// Subscribes to secure-storage's `onAfterHydrate` instead of the
// raw `storage` event. The sessions blob is read through the
// secure-storage cache (encrypted at rest under the passkey vault);
// the raw `storage` handler would fire synchronously on the
// sibling's just-written enveloped base64, but secure-storage's
// hydrate is async — so a sync read here would see the stale
// pre-hydrate cache and silently miss the cross-tab clear. The
// after-hydrate hook fires post-decrypt, so `loadAllSessionsResult`
// sees the fresh cache. Same pattern `workspaces.js` /
// `state.ts` adopted for their secure-storage keys.
//
// Asymmetric transitions: we only flip the latch in the two
// directions that have unambiguous semantics — unknown-version
// turns it ON, recognised-version turns it OFF. The 'empty' case
// (someone removed the blob entirely, e.g. a DevTools delete or a
// fresh-vault wipe) does NOT touch the latch: a pre-existing ON
// state from a failed write should persist across the empty
// transition until a SUCCESSFUL save proves the underlying issue
// (quota, vault-locked) is resolved.
// Secure-storage hydrate handler is registered from the bottom-of-
// file `onSyncHostInstalled` block so module init doesn't reach for
// a host that hasn't been installed yet.
function handleSecureStorageHydrated(): void {
  const r = loadAllSessionsResult()
  if (r.kind === 'unknown-version') setPersistenceDegraded(true)
  else if (r.kind === 'v1' || r.kind === 'legacy') setPersistenceDegraded(false)
  // Hydrate the shared auth-password cache (in ./sync-auth-cache.ts)
  // alongside the sessions blob. A passkey-enabled vault keeps this
  // encrypted at rest; the post-unlock cache surfaces the plaintext
  // for the in-memory replay on the next `unauthorized`. Reset the
  // per-socket replay guard so a freshly-hydrated cache gets one
  // optimistic attempt on the live connection (covers the boot-
  // after-unlock path: socket opens → server gates first save → we
  // replay from cache).
  loadCachedSyncPasswordFromStorage()
  transport.resetCachedReplayGuard()
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
      if (transport.getSocket()?.readyState !== WebSocket.OPEN) {
        // Socket isn't open yet — applyActive() acquires (and the
        // transport's first acquire opens the socket) so the very
        // first openSession of the page-load brings the connection
        // up. Subsequent openSessions reuse the existing acquisition.
        applyActive()
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
// ─────────── transport / wire ───────────

function send(msg: unknown): boolean {
  return transport.send(msg as object)
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
  const sock = transport.getSocket()
  if (!sock || sock.readyState !== WebSocket.OPEN) return
  if (!force && session.subscribed) return
  if (!session.signingKey || !session.workspaceTag) return
  // The server-issued challenge nonce binds the subscribe sig to
  // this connection; we can't sign until it arrives (round-9 H2).
  // The transport's `onConnected(nonce)` callback re-kicks every
  // session's subscribe attempt the moment the nonce lands, so
  // bailing here is safe — the legit client always sends `challenge`
  // first.
  const startNonce = transport.getNonce()
  if (startNonce == null) return
  // Capture both `from` and the connection nonce BEFORE the await —
  // chain handlers running during the sign promise could otherwise
  // advance baseRevision out from under us, and a socket teardown +
  // reconnect could swap the nonce.
  const fromBase = session.baseRevision
  const startSocket = sock
  const signingKey = session.signingKey
  const workspaceTag = session.workspaceTag
  ;(async () => {
    try {
      const signature = await signSubscribePayload(signingKey, workspaceTag, fromBase, startNonce)
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
      // Bail if the socket OR nonce moved while we were signing
      // (socket close + reconnect during the sign await). The
      // signed canonical is bound to the OLD nonce; sending it now
      // would fail server-side verify against the NEW nonce. The
      // post-reconnect `onConnected` will re-kick this session.
      if (transport.getSocket() !== startSocket || transport.getNonce() !== startNonce) return
      // Mark subscribed BEFORE sending so re-entrant calls (the
      // onConnected handler firing twice during a flaky reconnect,
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
  const sock = transport.getSocket()
  if (!sock || sock.readyState !== WebSocket.OPEN) return
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
  // benign race. The preferred mitigation in that case is to
  // reaffirm the non-empty-chain server invariant (it's an explicit
  // protocol contract, not an accident). Moving `session.pending =
  // null` above this guard is technically a wider fix but subtly
  // changes behavior for genuinely-malformed empty `workspace-state`
  // frames from a buggy / hostile server: today they're a no-op;
  // hoisting the clear would re-arm pendingSave on every empty
  // chain. Audit follow-up to PR #79 correctness review.
  if (!Array.isArray(revisions) || revisions.length === 0) return
  // Key not derived yet — bail; a future open will retry once
  // deriveSessionKey lands and trySendSave re-runs. This early-
  // return ALSO bypasses the pending-clear, but it's safe: the
  // guard is only reachable in the pre-key-derivation bootstrap
  // window. `trySendSave` gates on `!session.key || !session.signingKey`
  // before assigning `session.pending`, so `session.pending` is
  // provably null at this point. Parallel invariant to the empty-
  // revisions guard above — without an explicit assertion, a
  // refactor that loosens the trySendSave gate won't break this
  // function at runtime; it would silently land here with pending
  // set and take the non-recoverable branch. Pinned by the
  // sync-client tests covering pre-key handleChain paths.
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

async function handleMessage(wire: WireMessage): Promise<void> {
  // Server accepted our `authenticate { password }`. The transport
  // already resolved the in-flight auth round-trip; we just kick
  // every session whose `pendingSave` / `subscribed` was deferred
  // by the gate. The same socket is now authorised for ANY future
  // first-action on this connection — handles the unusual case
  // where one socket creates several brand-new workspaces in a row.
  if (wire.type === 'authenticated') {
    for (const session of sessions.values()) {
      trySendSubscribe(session)
      trySendSave(session)
    }
    return
  }
  // `unauthorized.gated` — a per-action block that needs the auth
  // flow to run. (`auth-failed` is consumed by the transport's
  // internal authResponseResolver; never reaches consumers.)
  // Unknown / missing `kind` is dropped silently — buggy server
  // or future variant; safe behaviour is "do nothing".
  if (wire.type === 'unauthorized') {
    if (wire.kind === 'gated') {
      // Gating signal: scope the pending-save cleanup to the matching
      // session, then kick the auth flow. Objstore-side gating
      // (resourceTag present) is handled in client/objstore.ts — this
      // handler skips the save cleanup for those. Sessions whose tag
      // we don't recognise just drop the gating context; the auth
      // flow runs anyway (the user still benefits from authenticating
      // now even though THIS save was for a workspace we no longer
      // track).
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
    // Server confirmed our subscribe was accepted — we're a
    // peer now and broadcasts will reach us. Flip the status
    // out of `connecting`. The chain that follows arrives as
    // a separate `workspace-state` message.
    session.subscribeAcked = true
    emitStatusIfChanged()
  }
}

// `unauthorized { workspaceTag, base }` — the server blocked a
// `workspace-save` because the workspace tag doesn't exist on the
// server yet AND this socket hasn't authenticated. Mirror
// `handleSaveError`'s base-match check so a stale unauthorized for
// a save we've already rebased past doesn't clobber a fresh
// pending. The session-side cleanup is the same as the recoverable-
// save-error branch (clear pending, re-arm pendingSave for the
// next trigger); the auth flow then runs once on this socket to
// turn the gate off so the next trySendSave succeeds.
function handleUnauthorizedForSave(session: Session, wire: WireMessage): void {
  if (!session.pending) return
  if (typeof wire.base !== 'string' && wire.base !== null) return
  if (wire.base !== session.pending.base) return
  session.pending = null
  session.pendingSave = true
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

// Serialize message handlers via a Promise chain — handleAck and
// handleChain both contain awaits (decrypt, saveTriage,
// persistSession), and the transport's `onMessage` fires a fresh
// synchronous invocation per frame, so without the chain two
// handlers can interleave: one's `rebaseAndPersist` running while
// the other reads / mutates `session.localState`, double-render(),
// persistSession with intermediate state, and similar small
// horrors. The chain forces strictly serial processing so each
// message sees a settled state before the next runs. Errors are
// swallowed (logged) so one bad message doesn't break the chain.
//
// Compare to objstore's `onTransportMessage` which is itself sync
// — that consumer's handlers don't await, so the chain isn't
// needed.
let messageQueue: Promise<void> = Promise.resolve()

function onTransportMessage(msg: { type?: unknown; [k: string]: unknown }): void {
  messageQueue = messageQueue.then(() => handleMessage(msg as WireMessage)).catch((err) => {
    console.warn('Triage sync handler error:', err)
  })
}

function onTransportConnected(_nonce: string): void {
  // Re-establish every open session against the freshly opened
  // socket. baseState / baseRevision survived the disconnect;
  // subscribed + subscribeAcked were cleared by onTransportDisconnected
  // and stay false here until each session's trySendSubscribe ack
  // lands; if there's an overlay (or we hadn't sent the initial
  // state yet), trySendSave pushes it.
  //
  // On first-ever connect of the page there's no preceding
  // onDisconnected — Session init seeds the same false values
  // (see `openSession` below), so the contract holds either way.
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
    trySendSubscribe(session)
    trySendSave(session)
  }
  emitStatusIfChanged()
}

function onTransportDisconnected(_reason: string): void {
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

// Wire up the UI's password prompt for the operator-side first-
// action gate. Called once at app boot from view.js (in lockstep
// with `installHydrationConflictResolver` and friends). When the
// server emits `unauthorized` for a never-before-seen workspace
// tag, this resolver is invoked; its return value is sent over the
// wire as `authenticate { password }`. Defaults to null — without
// a resolver wired the auth flow is a no-op: the pending save sits
// in `pendingSave` until a future trigger and the user has no path
// to authenticate. Tests / console drivers can keep the null
// resolver when they don't exercise the gate.
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
// clear a session's sticky `error` so `trySendSave` isn't wedged at its
// error-gate. The error string carries four classes — a server-reject
// (e.g. `too-large`), `'workspace no longer exists'`, `'key derivation
// failed: …'`, `'encrypt/sign failed: …'`. The latter local-fault
// classes need key derivation re-kicked to actually recover (just
// clearing the error would leave the session "looks online but silently
// fails to sync"), so re-kick when no keys are present. Audit M1 +
// round-5 F1.
function clearSessionErrorForRetry(session: Session): void {
  const hadError = session.error != null
  session.error = null
  session.consecutiveFailures = 0
  if (hadError && (!session.key || !session.signingKey)) {
    kickKeyDerivation(session)
  }
}

// Reset a session to its inactive baseline when sync deactivates
// (disable / force-off / server switch): free the pending slot, drop
// the subscribe state so a later re-activate re-subscribes, and clear
// `encrypting` so a stranded in-flight encryption IIFE doesn't make the
// next `trySendSave` redundantly raise `pendingSave` (audit M2 round-4).
// NB: `onTransportDisconnected` deliberately does NOT use this — it
// raises `pendingSave` and leaves `encrypting` to drain (reconnect
// contract), so it stays inline.
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
    // Same-URL re-apply is intentionally a no-op — this entry point
    // is "switch server", not "retry against current server". The
    // dedicated retry paths are `dismissError(wsId)` for a single
    // session, or the `setEnabled(false)` → `setEnabled(true)`
    // toggle for all sessions. (`setForcedOff(true)` →
    // `setForcedOff(false)` mirrors the same kick logic but is
    // sidebar-visibility driven, not user-triggerable.) Without this
    // guard, every UI re-render that passes the current URL would
    // pointlessly tear the transport down + reset every session's
    // `pending` / `pendingSave` / `subscribed`.
    if (next === serverUrl) return
    const prev = serverUrl
    serverUrl = next
    // Drop persisted entries whose `serverUrl` doesn't match the
    // new relay — they could never be applied (loadPersistedSession
    // rejects on URL mismatch) and otherwise sit in localStorage
    // indefinitely. Empty `next` (sync turning off) skips the prune
    // so a user toggling sync back on doesn't lose their bases.
    if (next) prunePersistedSessions(next)
    // Server change invalidates the cached auth password only when
    // we're actually SWITCHING between two different non-empty
    // servers (different relays may run different password gates).
    // The initial set (`prev === ''` → `next === '<resolved URL>'`)
    // and the off-toggle (`next === ''`) MUST NOT wipe — that would
    // nuke a freshly-hydrated cache on every page load (the boot
    // path calls setServerUrl after hydrate to install the resolved
    // default URL) and nuke the cache when the user momentarily
    // toggles sync off-then-on without restarting the browser.
    // Audit follow-up to the "Password asked each time" regression.
    if (prev && next && prev !== next) {
      setCachedSyncPassword(null).catch((err) => {
        console.warn('Triage sync: failed to drop cached auth password on server change:', err)
      })
    }
    // Tell the transport to swap URLs — it tears down the current
    // socket and (if still acquired against the new URL) re-opens.
    // applyActive() below reconciles the acquisition: a switch from
    // a valid URL to empty becomes a release.
    transport.setServerUrl(next)
    // Server changed — revision IDs are per-server, so every
    // active session's tracking is stale. Reset each one; if
    // there's persisted state for the NEW server (or null when
    // turning sync off), fold that in. localState rebuilds from
    // state.* per session so unsynced edits survive the reset and
    // replay onto the new base via the rebase path.
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

  // Persisted user-driven toggle. URL stays put — re-enabling
  // resumes against the same endpoint. applyActive() releases the
  // transport acquisition when `isActive()` becomes false; the
  // transport's `release()` tears down the socket without scheduling
  // reconnect.
  setEnabled(value: boolean): void {
    const next = Boolean(value)
    if (next === userEnabled) return
    userEnabled = next
    // Best-effort persist via secure-storage so an enabled-vault
    // user's sync toggle is encrypted at rest. Failure logged but
    // not surfaced — userEnabled stays in-memory either way.
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

  // Called by triage.js at the tail of saveTriage(). When inside
  // applyChainToBase / handleAck (suppressNotify > 0), bail — that
  // path already owns persistence. Otherwise schedule a save for
  // every open session; trySendSave's empty-changeset short-circuit
  // means sessions with no local changes turn into a cheap no-op.
  notify(): void {
    if (suppressNotify > 0) return
    for (const session of sessions.values()) trySendSave(session)
  },

  // Ensure a sync session — and therefore the single
  // `workspace-subscribe` for this workspace's tag on the shared
  // socket — exists, returning a token the objstore presence layer
  // MUST pass into `objstoreClient.openWorkspace`. This is the seam
  // that couples every objstore session to a backing sync subscribe:
  // the objstore client never subscribes itself, so it refuses to open
  // (and thus to send `objstore-list` / ops) without this proof. Idempotent
  // (delegates to `openSession`). Returns null when the workspace is
  // unknown (no session could be opened), so the caller skips opening
  // an objstore session that nothing would subscribe.
  ensureSubscription(workspaceId: string): { workspaceId: string } | null {
    triageSync.openSession(workspaceId)
    return sessions.has(workspaceId) ? { workspaceId } : null
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
    applyActive()
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
    // No `applyActive()` here: closeSession deliberately keeps the
    // shared socket warm (a workspace switch closes the old session
    // then opens the new one — the workspace still exists, so
    // `isActive()` stays true). The acquire is reconciled by the
    // workspace-deleted handler instead.
    emitStatusIfChanged()
  },

  // Refresh a session's id-set against the live `state.reports` +
  // `ws.reports`, then propagate any newly-in-scope ids' triage
  // to the workspace's chain. Idempotent no-op when nothing
  // changed.
  //
  // Called by the UI's switch paths (`switchToFile`,
  // `switchToWorkspace`) right after `state.reports` has been
  // populated by `ingestReport`. Without this hook, a session
  // opened pre-load (e.g. via the membership-changed listener
  // when a report was dragged in while a different file was
  // focused) sticks with the stale id-set it had at open time —
  // loading the report later wouldn't expose its finding-ids to
  // the chain.
  //
  // **Callers MUST `openSession(workspaceId)` first** — this
  // method intentionally does NOT auto-open. The membership-
  // changed listener is the canonical creation path (it auto-
  // opens because a drop is the user's signal that the workspace
  // should exist on the wire); refreshSession is downstream of
  // that, called from the UI's switch paths which already invoke
  // `openSession` for the desired workspace ids. Duplicating the
  // auto-open here would mask drop-misordering bugs in future
  // callers (a missing `openSession` would silently no-op and
  // regress the "issue 3" symptom this method was introduced to
  // fix). Logged at `console.debug` on the no-session branch so a
  // missing prelude is grep-able when investigating a missing
  // propagation.
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
      } else if (transport.getSocket()?.readyState === WebSocket.OPEN) {
        trySendSubscribe(session)
        trySendSave(session)
      }
    }
    if (changed) emitStatusIfChanged()
  },

  // Reflects whether the persisted-sessions blob is currently in
  // an unknown-version state that `mutateAllSessions` is refusing
  // to overwrite. UI consumers (sync-status badge) read this to
  // surface a "persistence degraded" hint — the in-memory state
  // works for this session but won't survive a reload until the
  // blob is cleared.
  //
  // Two-way: the latch flips OFF when a subsequent
  // `mutateAllSessions` writes a recognized v1 shape (the user
  // cleared the unknown-version blob via DevTools or another tab
  // did so), and the cross-tab `storage` listener re-probes and
  // aligns the latch when another tab mutates the sessions blob.
  get persistenceDegraded(): boolean { return persistenceDegraded() },
  // Subscribe to degraded-state transitions (fires on every off↔on
  // change AND once on subscribe with the current value). The latch +
  // listeners live in triage-session-store.ts; delegate to it.
  onPersistenceDegraded(cb: (degraded: boolean) => void): () => void { return onPersistenceDegraded(cb) },
}

// Boot wiring — workspaces / secure-storage listeners and the
// persisted-flag restore both reach into the host, so they run
// inside `onSyncHostInstalled` rather than at module init. The host
// is installed once by `ui/view.js` before any `triageSync.*` entry
// point fires (see `client/sync/host.ts` for the contract).
onSyncHostInstalled((host) => {
  state = host.state
  listWorkspaces = host.listWorkspaces
  saveTriage = host.saveTriage
  getSecureItem = host.getSecureItem
  setSecureItem = host.setSecureItem

  host.onSecureStorageHydrated(handleSecureStorageHydrated)

  // Restore the user's persisted enable flag on module load. The
  // server URL is NOT persisted — the per-origin detected default
  // (see `DEFAULT_SYNC_URL` in ui/view/sidebar.js) primes `serverUrl`
  // via `setServerUrl`, so any previously-stored URL is purged here
  // to avoid resurrecting stale endpoints from older builds.
  try {
    localStorage.removeItem(LEGACY_URL_KEY)
    const savedEnabled = getSecureItem(USER_ENABLED_KEY)
    if (savedEnabled === '0') userEnabled = false
    applyActive()
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
  host.onWorkspaceDeleted((workspaceId) => {
    const removed = sessions.delete(workspaceId)
    // Fire-and-forget — guard the rejection (Web Locks can fail on
    // tab teardown) so it can't surface as an unhandledrejection.
    // Audit M-3 (round 2).
    dropPersistedSession(workspaceId).catch((err) => {
      console.warn('Triage sync: dropPersistedSession lock failed:', err)
    })
    // Reconcile the transport acquire unconditionally: deleting the
    // LAST workspace makes `isActive()` false (no workspaces left),
    // so the socket tears down — even if this workspace never had an
    // open triage session (the acquire is held while any workspace
    // exists, not per-session). `fireWorkspaceDeleted` runs after the
    // store mutation commits, so `listWorkspaces()` already reflects
    // the deletion here.
    applyActive()
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
  host.onWorkspacePrivateKeyChanged((workspaceId) => {
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

  host.onReportMembershipChanged((workspaceId) => {
    // Open the session if it wasn't already open. Dragging a report
    // into a workspace the user hasn't navigated to must still
    // propagate that report's triage state to peers — the act of
    // attaching is the user's signal that the workspace now claims
    // those finding-ids, and the next browser to open the workspace
    // would otherwise see stale data. `openSession` is idempotent on
    // already-open ids. Mirrors the post-multiplex objstore-presence
    // membership listeners.
    triageSync.openSession(workspaceId)
    const session = sessions.get(workspaceId)
    if (!session) return  // workspace doesn't exist (deleted concurrently)
    refreshAndPropagate(session)
  })

  // Drop persisted session entries whose workspace was deleted
  // while we were away. One-time pass on host install — workspaces
  // are loaded synchronously from localStorage so `listWorkspaces()`
  // is ready by the time the host installs. Runs AFTER the lifecycle
  // listeners are wired so any synchronous deletion during init
  // wouldn't bypass the live handler (audit L5).
  prunePersistedSessions()
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
// Refresh a session's id-set against the live `state.reports` +
// `ws.reports` and propagate any newly-in-scope ids to the chain.
// Called by:
//   - the `onReportMembershipChanged` listener (a report was
//     attached / detached from a workspace);
//   - `triageSync.refreshSession(workspaceId)` (the UI's switch
//     paths after `state.reports` mutates, so loading a previously-
//     unloaded report exposes its finding-ids to the workspace's
//     chain).
//
// Branches on whether `refreshSessionIds` found newly-added ids
// AND whether their hydration surfaced conflicts vs the chain's
// baseState. Conflict-free path is the common case: either run
// `saveTriage` (which fans gap-filled state.* into the chain via
// notify) or `trySendSave` directly when nothing was hydrated.
function refreshAndPropagate(session: Session): void {
  const { conflicts, hydrated } = refreshSessionIds(session)
  // Both branches run inside an async IIFE so saveTriage is
  // ordered (no parallel writes to the deepview.triage blob from
  // back-to-back attaches), the catch keeps a Web Locks rejection
  // from leaking as an unhandledrejection, and the caller —
  // `setReportWorkspace` (via the membership listener) or
  // `switchToFile` / `switchToWorkspace` (via the public
  // `refreshSession` method) — still returns synchronously.
  // Audit M-4.
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

