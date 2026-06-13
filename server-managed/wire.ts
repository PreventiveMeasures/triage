// On-the-wire shapes + canonical byte builders for the **managed**
// protocol (v1.managed). SCAFFOLD ONLY — see `server-managed/MANAGED.md`.
//
// Two halves:
//   1. The REST request / response bodies and the WS/SSE live-channel
//      frames the client and server exchange. In managed mode the
//      SESSION COOKIE is the authentication (no per-message Ed25519
//      signatures like the e2e protocol), so these shapes carry no
//      `signature` field — the server stamps attribution itself.
//   2. The canonical byte builders for the hash-chained attribution log
//      (`TriageEvent` / `AuditEntry`). These mirror the e2e canonical
//      discipline (domain prefix + newline-joined fields, hashed with
//      SHA-256 → base64url; see server-e2e/sign.ts `canonicalSave` /
//      `computeRevisionIdFromCanonical`) — but here the chain links
//      events by `prevHash` for tamper-evidence rather than signing each.

import { Buffer } from 'node:buffer'
import { encodeUtf8 } from '../common/utf8.js'
import type {
  ManagedTriageFields, Role, TriageChange, VisibilityMode,
} from './types.ts'

// Distinct from every e2e domain (`deepview-triage-sync.v1.*` /
// `deepview-objstore.v1.*`) so no hash/signature crosses protocols.
const TRIAGE_EVENT_DOMAIN = 'deepview-managed.v1.triage-event'
const AUDIT_ENTRY_DOMAIN = 'deepview-managed.v1.audit-entry'

// ─────────── public projections (server → client) ───────────

// A user as exposed to other clients (never the GitHub token / internal
// audit fields). The minimum to render attribution in the UI.
export interface PublicUserRef {
  id: string
  githubLogin: string
}

// `GET /api/auth/session` — the logged-in user + the CSRF token the
// client must echo (header / double-submit) on mutating requests. 401
// with no body when there's no valid session.
export interface SessionInfo {
  user: PublicUserRef & { name: string | null; avatarUrl: string | null }
  csrfToken: string
}

// `GET /api/sync/info` — lets a client detect which protocol the server
// speaks and adapt its UI (login button + project list vs. e2e seed
// flow). The e2e relay reports `{ mode: 'e2e' }`.
export interface ServerInfo {
  mode: 'e2e' | 'managed'
  // Present only in managed mode — the login entry point + cookie name.
  managed?: {
    loginPath: string // '/api/auth/github/login'
    cookieName: string
  }
}

// `GET /api/projects` item. `role` is the caller's effective role
// (already resolved server-side); the list only contains projects the
// caller can at least view.
export interface ProjectSummary {
  id: string
  slug: string
  name: string
  githubRepo: string | null
  role: Role
  visibilityMode: VisibilityMode // the EFFECTIVE mode (post-precedence)
}

// `GET /api/projects/:id/bundles` item.
export interface BundleSummary {
  integrity: string
  name: string
  contentLength: number
  uploadedBy: PublicUserRef
  uploadedAt: number
}

// `GET /api/projects/:id/reports` item.
export interface ReportSummary {
  name: string
  contentHash: string
  contentLength: number
  findingCount: number | null
  uploadedBy: PublicUserRef
  uploadedAt: number
}

// One materialized triage entry as served to the client — the triage
// fields plus who last touched it and at which `seq`.
export interface PublicTriageEntry extends ManagedTriageFields {
  findingId: string
  by: PublicUserRef
  updatedAt: number
  seq: number
}

// `GET /api/projects/:id/triage` — the full current state at `seq`
// (the project's head). Clients diff against their last-applied `seq`.
export interface TriageStateResponse {
  projectId: string
  seq: number
  entries: PublicTriageEntry[]
}

// `POST /api/projects/:id/triage` body — the client's desired change set
// against the `base` seq it last saw. The server validates editor role,
// applies last-writer-wins, appends attributed events, and returns the
// new head. No signature: the session authenticates, the server attributes.
export interface TriageCommitRequest {
  base: number | null
  changes: Record<string, TriageChange> // findingId → change (null clears)
}

export interface TriageCommitResponse {
  seq: number // new project head after applying
  applied: number // count of events appended
  // On a stale base the server still applies (LWW) but reports the events
  // the client missed so it can reconcile its local overlay, mirroring the
  // e2e stale-base catch-up.
  missed?: PublicTriageEvent[]
}

// A decoded triage event for the client (the canonical `change` STRING is
// re-parsed to `TriageChange` for convenience; the server retains the
// verbatim string for hashing). Carried by `project-state` pushes and the
// commit `missed` list.
export interface PublicTriageEvent {
  seq: number
  findingId: string
  change: TriageChange
  by: PublicUserRef
  ts: number
}

// ─────────── live channel frames (WS / SSE) ───────────
//
// The live channel reuses the e2e transport plumbing (WS upgrade with the
// SSE+POST fallback, same-origin gated) but is authenticated by the
// session cookie sent on the upgrade — no `challenge` nonce / signature
// handshake. After subscribe the server pushes every peer's committed
// triage so open clients converge live, exactly like the e2e
// `workspace-state` broadcast.

export type ManagedSaveErrorReason =
  | 'forbidden' // session lacks editor role
  | 'too-large' // change set over the cap
  | 'busy' // per-socket inflight cap
  | 'not-found' // project gone / not visible

export type ManagedUnauthorizedReason =
  | 'no-session' // no / unparseable cookie
  | 'expired' // session past expiry
  | 'forbidden' // valid session, no access to this project

export type ManagedClientFrame =
  | { type: 'project-subscribe'; projectId: string; from: number | null }
  | { type: 'project-save'; projectId: string; base: number | null; changes: Record<string, TriageChange> }
  | { type: 'ping' }

export type ManagedServerFrame =
  | { type: 'project-subscribed'; projectId: string; role: Role; head: number }
  | { type: 'project-state'; projectId: string; seq: number; events: PublicTriageEvent[] }
  | { type: 'project-save-ack'; projectId: string; base: number | null; seq: number }
  | { type: 'project-save-error'; projectId: string; reason: ManagedSaveErrorReason }
  | { type: 'unauthorized'; reason: ManagedUnauthorizedReason; projectId?: string }
  | { type: 'pong' }

// ─────────── attribution hash chain ───────────

// Canonical bytes for one triage event. Newline-joined after the domain
// prefix, same framing as the e2e canonicals — safe because none of the
// fields can contain a raw newline: ids / hashes are base64url or slugs,
// the numerics stringify without one, and `change` is `JSON.stringify`
// output (structural JSON emits no raw 0x0A and escapes in-string
// newlines to `\n`). `prevHash` is '' at genesis. The server is the sole
// canonicalizer of `change`, so the bytes are reproducible for audit.
export function canonicalTriageEvent(e: {
  projectId: string
  seq: number
  findingId: string
  change: string // canonical JSON of a TriageChange
  userId: string
  ts: number
  prevHash: string | null
}): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    TRIAGE_EVENT_DOMAIN,
    e.projectId,
    String(e.seq),
    e.findingId,
    e.userId,
    String(e.ts),
    e.prevHash ?? '',
    e.change,
  ].join('\n'))
}

// Canonical bytes for one audit entry — same construction, distinct
// domain. `userId` is '' for a pre-auth event; `projectId` / `target`
// are '' when absent.
export function canonicalAuditEntry(e: {
  seq: number
  ts: number
  userId: string | null
  action: string
  projectId: string | null
  target: string | null
  detail: string // canonical JSON detail
  prevHash: string | null
}): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    AUDIT_ENTRY_DOMAIN,
    String(e.seq),
    String(e.ts),
    e.userId ?? '',
    e.action,
    e.projectId ?? '',
    e.target ?? '',
    e.detail,
    e.prevHash ?? '',
  ].join('\n'))
}

// SHA-256 → base64url of a chain link's canonical bytes. The `hash` an
// event/entry stores AND the `prevHash` the next one commits to. Mirrors
// server-e2e/sign.ts `computeRevisionIdFromCanonical`.
export async function computeChainHash(canonical: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', canonical)
  return Buffer.from(new Uint8Array(digest)).toString('base64url')
}

// Hash a raw session-cookie token to its stored `Session.id`. The raw
// token lives only in the cookie; the DB holds this digest, so a DB read
// can't reconstruct a usable cookie.
export async function hashSessionToken(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encodeUtf8(rawToken))
  return Buffer.from(new Uint8Array(digest)).toString('base64url')
}
