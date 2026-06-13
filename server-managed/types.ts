// Domain types for the **managed** server protocol (v1.managed) — the
// trusted-server alternative to the e2e triage-sync relay. SCAFFOLD ONLY:
// these types describe the storage + identity model documented in
// `server-managed/MANAGED.md`; nothing here is wired into the running server yet.
//
// Where the e2e protocol roots authority in a per-workspace seed (the
// server never learns the content; see server-e2e/README.md), the managed
// protocol roots authority in a logged-in **user** (GitHub) and a
// server-side **project** scope. The server is trusted: it stores triage /
// bundles / reports in a form it can read, decides per-request what each
// user may see, and records every mutation in a hash-chained attribution
// log. These types are the server-side (DB-facing) shapes; the on-the-wire
// request / response / frame shapes live in `./wire.ts`, and the pure
// access-decision logic in `./visibility.ts`.

// ─────────── identity & sessions ───────────

// Internal, opaque user id (NOT the GitHub id — that's an external
// identifier we don't want leaking into URLs / ACL rows as the primary
// key). Minted server-side, e.g. `u_` + base64url(random 16 bytes).
export type UserId = string

export interface User {
  id: UserId
  // GitHub's numeric account id — stable across login renames, so it's
  // the join key when reconciling a returning user (the login string can
  // change; the id can't).
  githubId: number
  githubLogin: string
  name: string | null
  avatarUrl: string | null
  createdAt: number // ms epoch
  lastSeenAt: number // ms epoch
}

// The GitHub OAuth token the server holds to resolve org / team / repo
// membership for `visibilityMode: 'hybrid'`. Stored ENCRYPTED at rest
// under a server key (never in the clear, never sent to the client). A
// GitHub App installation token is the alternative — see MANAGED.md.
export interface GithubToken {
  userId: UserId
  // AEAD ciphertext (base64) of the access token + its nonce — the
  // plaintext token never sits in the DB. Mirrors the e2e objstore
  // at-rest discipline, but here the KEY is server-held.
  nonce: string
  ciphertext: string
  scopes: string // space-joined granted scopes, e.g. 'read:user read:org'
  // GitHub user tokens can be non-expiring (classic OAuth app) or
  // expiring (GitHub App user-to-server); null = non-expiring.
  expiresAt: number | null
  refreshedAt: number
}

// A login session. The RAW session token lives ONLY in the user's
// `__Host-` cookie; the DB stores its hash (`id`), so a DB read can't mint
// a cookie. Mirrors the objstore REST-token discipline (store the HMAC,
// not the bearer).
export interface Session {
  // = base64url(SHA-256(rawCookieToken)). Lookups hash the presented
  // cookie and probe this column.
  id: string
  userId: UserId
  createdAt: number
  expiresAt: number // hard expiry; sliding refresh bumps it
  lastUsedAt: number
  userAgent: string | null
}

// ─────────── projects & visibility ───────────

// How a project's audience is decided. `hybrid` (the instance default,
// configurable) derives access from GitHub membership AND honours explicit
// in-app grants layered on top; `explicit` ignores GitHub access and
// consults only owner + grants. Owner is always admin in either mode. See
// `./visibility.ts` for the resolver.
export type VisibilityMode = 'hybrid' | 'explicit'

// Access level within a project. Monotonic: editor ⊇ viewer, admin ⊇
// editor. The numeric rank lets `./visibility.ts` take the max across
// several grant sources.
export type Role = 'viewer' | 'editor' | 'admin'
export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 }

// The managed analog of an e2e "workspace": a server-side scope that owns
// bundles, reports and a triage log. Optionally bound to a GitHub repo
// and/or org, which drives `visibilityMode: 'hybrid'`.
export interface Project {
  id: string
  slug: string // URL-safe, unique per instance
  name: string
  githubRepo: string | null // 'owner/repo' — the repo whose access maps to this project
  githubOrg: string | null // 'owner' — org-level scope (team grants resolve under it)
  // null = inherit the repo-wide policy (`RepoPolicy`), then the instance
  // default. A non-null value pins this project regardless of either.
  visibilityMode: VisibilityMode | null
  ownerUserId: UserId
  createdAt: number
}

// Repo-WIDE visibility default. Lets an operator/admin flip every project
// mapped to one repo (or org) to `explicit` without touching each project
// row — the "switchable to explicit … repo-wide" requirement. Precedence:
// project.visibilityMode → RepoPolicy.visibilityMode → instance default.
export interface RepoPolicy {
  scope: string // 'owner/repo' (repo) or 'owner' (org-wide)
  visibilityMode: VisibilityMode
  updatedBy: UserId
  updatedAt: number
}

// An explicit grant principal. `user` = one account; `team` =
// 'org/team-slug'; `org` = every member of 'owner'.
export type PrincipalType = 'user' | 'team' | 'org'

export interface Grant {
  projectId: string
  principalType: PrincipalType
  // UserId for `user`; 'org/team-slug' for `team`; 'owner' for `org`.
  principalRef: string
  role: Role
  grantedBy: UserId
  grantedAt: number
}

// ─────────── stored artifacts (server-readable) ───────────

// A bundle stored under a project. Content-addressed by the same SRI
// integrity the e2e client computes (`common/integrity.js`), so the byte
// blob can be shared/deduped across projects while VISIBILITY stays
// per-project. Unlike the e2e objstore the bytes are server-readable
// (plaintext, or server-side-encrypted under a server key).
export interface ManagedBundle {
  projectId: string
  integrity: string // 'sha512-<base64>'
  name: string
  contentLength: number
  uploadedBy: UserId
  uploadedAt: number
}

// A report stored under a project. `contentHash` is base64url SHA-256 of
// the stored bytes (the server CAN parse it via `common/report-findings.js`
// to populate `findingCount` and index findings for attribution).
export interface ManagedReport {
  projectId: string
  name: string
  contentHash: string
  contentLength: number
  findingCount: number | null // null until parsed
  uploadedBy: UserId
  uploadedAt: number
}

// ─────────── triage (server-readable, attributed) ───────────

// Mirrors `client/state.ts`'s TriageEntry — the server stores these fields
// in the clear (it's trusted), keyed per finding. Kept as an independent
// definition rather than importing the client type so the server layer
// carries no browser/`@rray/frontend` coupling.
export type TriageBucket = 'inprogress' | 'fixed' | 'invalid' | 'deleted'

export interface ManagedTriageFields {
  color?: string
  triage?: TriageBucket
  comment?: string
  fix?: string
  flagged?: boolean
  ignoredReports?: string[]
}

// A change to one finding's triage: the new fields, or `null` to clear the
// entry entirely (the managed analog of a changeset's `id: null`).
export type TriageChange = ManagedTriageFields | null

// The materialized current triage state for one finding within a project —
// a last-writer-wins projection of the event log below. This is what
// `GET /api/projects/:id/triage` serves.
export interface ManagedTriageEntry extends ManagedTriageFields {
  projectId: string
  findingId: string
  updatedBy: UserId
  updatedAt: number
  seq: number // the triage-event seq that last touched this finding
}

// One attributed, hash-chained entry in a project's append-only triage
// log. The server assigns `seq` / `ts` / `userId` (the client cannot forge
// attribution — it has no signing key here; the session IS the proof) and
// links each event to its predecessor by hash. `change` is the canonical
// JSON of a `TriageChange`, hashed VERBATIM (see `./wire.ts` —
// `canonicalTriageEvent`), so re-serialization can't shift the chain.
export interface TriageEvent {
  projectId: string
  seq: number // server-assigned, monotonic per project
  findingId: string
  change: string // canonical JSON of TriageChange, hashed as-is
  userId: UserId
  ts: number
  prevHash: string | null // hash of seq-1's event (null at genesis)
  hash: string // base64url SHA-256 of this event's canonical bytes
}

// ─────────── attribution / audit log ───────────

// Actions worth attributing beyond triage edits. Every mutating endpoint
// appends one `AuditEntry`; reads are not logged (volume) unless an
// operator opts in.
export type AuditAction =
  | 'login'
  | 'logout'
  | 'project.create'
  | 'project.update'
  | 'project.delete'
  | 'bundle.upload'
  | 'bundle.delete'
  | 'report.upload'
  | 'report.delete'
  | 'triage.commit'
  | 'grant.add'
  | 'grant.remove'
  | 'visibility.change'

// A hash-chained audit record — the instance-wide "chain of attribution".
// Same tamper-evident construction as `TriageEvent` (each entry commits to
// the previous via `prevHash`), so a reader can verify the log was only
// ever appended to, never rewritten. `userId` is null only for a failed /
// pre-auth event (e.g. a rejected login).
export interface AuditEntry {
  seq: number // monotonic, instance-wide
  ts: number
  userId: UserId | null
  action: AuditAction
  projectId: string | null
  target: string | null // the touched resource (integrity / findingId / principalRef / …)
  detail: string // canonical JSON detail, hashed verbatim
  prevHash: string | null
  hash: string
}

// ─────────── instance configuration ───────────

// Managed-mode boot config (parsed alongside the existing `Config` in
// `server-e2e/config.ts` when SYNC_MODE=managed). Documented in MANAGED.md.
export interface ManagedConfig {
  // GitHub App credentials. App-installation-first (see MANAGED.md §3): the
  // app id + PEM private key mint the app JWT → INSTALLATION access tokens,
  // the primary data-plane credential (repo discovery, releases, stasis
  // bundles, membership reads). `privateKey` stays server-side only.
  githubAppId: string
  githubAppPrivateKey: string
  // The App's user-to-server (OAuth) credentials, used ONLY to establish
  // identity (who is logging in) — not to read repo data. `clientSecret`
  // stays server-side only.
  githubClientId: string
  githubClientSecret: string
  // Absolute callback URL for the user-to-server identity login, e.g.
  // 'https://triage.example.com/api/auth/github/callback'.
  oauthCallbackUrl: string
  // Cookie name — `__Host-`-prefixed so the browser enforces Secure +
  // host-only + path=/ (no Domain), hardening against subdomain injection.
  cookieName: string
  sessionTtlMs: number
  // How long a resolved `GithubAccessFacts` set is cached before a
  // re-query. The revocation-lag window: a user removed from a repo on
  // GitHub keeps access until this expires (admins can force-refresh).
  membershipCacheTtlMs: number
  // Instance-wide default visibility mode (`hybrid` unless overridden),
  // the lowest-precedence input to the resolver.
  defaultVisibility: VisibilityMode
}

// GitHub-derived facts the server resolves (and caches) for a user BEFORE
// an access decision — the only GitHub-dependent input to the otherwise
// pure resolver in `./visibility.ts`. Populated by the (future) GitHub
// client layer from the user's stored token.
export interface GithubAccessFacts {
  login: string
  // The user's permission on the project's `githubRepo`, or null if none
  // (or the project isn't repo-bound). GitHub's repo permission ladder.
  repoPermission: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | null
  // Orgs the user belongs to ('owner' slugs).
  orgs: ReadonlySet<string>
  // Team memberships as 'org/team-slug'.
  teams: ReadonlySet<string>
}
