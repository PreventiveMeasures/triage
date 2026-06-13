# DeepView managed-mode server (v1.managed)

A **trusted-server** alternative to the end-to-end-encrypted triage-sync
relay (see [`server-e2e/README.md`](../server-e2e/README.md)). Where the e2e protocol treats the
server as an untrusted relay of opaque ciphertext, managed mode makes the
server the authority: users **log in** (GitHub), the server **decides what
each user can see**, stores triage / bundles / reports in a form it can
read, and records every change in a hash-chained **attribution log**.

> **Status: design + scaffold.** This document is the protocol spec. The
> compile-checked type / wire / schema skeletons live alongside this
> file in `server-managed/` and are **not wired into the running
> server yet** — see [§10](#10-scaffold-map--status). Full implementation
> follows.

---

## 1. Why a second protocol — the trust model

The e2e relay's guarantee is *the operator can't read your triage*. That
is exactly wrong for a team deployment where the operator **must** read it:
to list "the bundles available to you", to gate "the reports you're allowed
to see", and to prove "who changed this finding's status". Those features
require a trusted server, so managed mode inverts the trust model rather
than bolting server-side features onto the zero-knowledge design.

| | e2e (`v1` / `v1.objstore`) | **managed (`v1.managed`)** |
| --- | --- | --- |
| Root of authority | per-workspace **seed** (32 bytes); holders are writers | logged-in **user** (GitHub) + server-side **project** scope |
| Per-message auth | Ed25519 signature over a canonical | **session cookie** (server stamps attribution) |
| What the server sees | opaque ciphertext only | plaintext (server-readable; at-rest encryption optional) |
| Who decides visibility | nobody — anyone with the tag can subscribe | the **server**, per request (hybrid GitHub + grants, or explicit ACL) |
| Attribution | none — server can't attribute a revision | every mutation attributed to a user + hash-chained |
| Trust boundary | server may DoS / equivocate but **can't read/forge** | server is **fully trusted**; compromise exposes content |

The two modes are **mutually exclusive per deployment** (chosen by config,
[§2](#2-deployment--configuration)) but a single client supports both and
adapts after probing `GET /api/sync/info` ([§8](#8-coexistence--migration)).
The blob byte-plane, the same-origin gate, the WS+SSE transports, and the
two storage backends (SQLite / Neon) are **reused** — managed mode adds an
identity layer, an authorization layer, and a server-attributed triage log
on top of that existing plumbing.

---

## 2. Deployment & configuration

A new `SYNC_MODE` selects the protocol; it is **orthogonal** to the
existing backend selection (`DATABASE_URL` → Neon vs. SQLite) and blob
backend, so managed mode runs on either pairing unchanged.

| Env var | Default | Notes |
| --- | --- | --- |
| `SYNC_MODE` | `e2e` | `managed` enables this protocol |
| `GITHUB_APP_ID` | — | GitHub App id — for the app JWT → **installation** tokens (data plane: repo discovery, releases, bundles, membership) (**required**) |
| `GITHUB_APP_PRIVATE_KEY` | — | App private key (PEM), server-side only — signs the app JWT (**required**) |
| `GITHUB_CLIENT_ID` | — | the App's client id — for the **user-to-server** (identity) login (**required**) |
| `GITHUB_CLIENT_SECRET` | — | the App's client secret — server-side only (**required**) |
| `OAUTH_CALLBACK_URL` | — | absolute `…/api/auth/github/callback` for the identity login (**required**) |
| `SESSION_TTL_MS` | `1209600000` (14 d) | hard session expiry; sliding refresh bumps it |
| `MANAGED_DEFAULT_VISIBILITY` | `hybrid` | instance-wide default mode (`hybrid` \| `explicit`) |
| `MEMBERSHIP_CACHE_TTL_MS` | `300000` (5 min) | GitHub-facts cache; also the access-revocation lag |
| `SESSION_COOKIE_NAME` | `__Host-dvsid` | `__Host-` ⇒ Secure + host-only + path=`/` enforced |

These parse into a `ManagedConfig`
([`types.ts`](./types.ts)) alongside the existing `Config`,
failing fast on a missing required value exactly like the Neon companions
do today. `SYNC_MODE=managed` requires a non-loopback deployment to be
HTTPS (the `__Host-` cookie + `Secure` flag mandate it); fail fast
otherwise, mirroring the `TRUST_PROXY` boot check.

---

## 3. Identity & authentication

Managed mode is a **GitHub App** (not a plain OAuth app) — one app, two
**decoupled** flows, kept behind an `IdentityProvider` seam (and data /
membership reads behind `GithubAccessFacts`, [§4](#4-authorization--visibility))
so the session / authorization layers don't care which token produced the
facts:

- **Installation** (once, by an org admin/owner): grants the app repo access.
  Capture `installation_id` from the post-install **Setup URL** (or the
  `installation` webhook) and mint **installation access tokens** (via the
  app JWT) — the **primary data-plane credential** for repo auto-discovery,
  releases, and stasis bundles ([§12](#12-roadmap--captured-requirements-not-yet-implemented)).
  App-installation-first: least-privilege, org-admin-controlled, no per-user
  repo tokens to store / refresh.
- **User authorization** (per user, every login): the user-to-server OAuth
  flow below, used **only for identity** (*who* is signing in). Requested
  **separately**, NOT "during installation" — that only authorizes the
  installing admin, so every other user needs the standalone flow regardless,
  and keeping the two callbacks separate keeps each single-purpose.

### Login flow

```
GET  /api/auth/github/login
       → 302 to github.com/login/oauth/authorize
         with client_id, redirect_uri=OAUTH_CALLBACK_URL,
         scope='read:user read:org', and a `state` (CSRF) bound into a
         short-lived signed cookie.
GET  /api/auth/github/callback?code&state
       → validate `state` vs the cookie; exchange `code` for a token
         (server-to-server with GITHUB_CLIENT_SECRET); GET /user; upsert
         managed_user (join on github_id); store the token AEAD-encrypted
         (managed_github_token); mint a session; Set-Cookie; 302 to the app.
POST /api/auth/logout         → delete the session row; clear the cookie.
GET  /api/auth/session        → { user, csrfToken } (SessionInfo) or 401.
```

### Session cookie

The cookie value is a fresh 256-bit random token. The DB stores only
`base64url(SHA-256(token))` as `Session.id` (`hashSessionToken` in
[`wire.ts`](./wire.ts)) — a DB read can't reconstruct a
usable cookie, the same "store the digest, not the bearer" discipline the
e2e objstore REST tokens already use. Attributes:

- `__Host-` prefix ⇒ browser enforces `Secure`, host-only, `Path=/`.
- `HttpOnly` (no JS read), `SameSite=Lax` (so the OAuth redirect **GET**
  carries it; mutations are same-origin `fetch`).
- A **new** session id is minted on login (no fixation); logout deletes the
  row (immediate server-side revocation, not just cookie clearing).
- Sliding refresh bumps `expires_at` up to the `SESSION_TTL_MS` hard cap.

### CSRF

Cookie auth needs CSRF defense on state-changing requests. Defense in
depth, all already partly present:

1. The existing **same-origin gate** (`server-e2e/origin.ts`) runs on every
   `/api/*` request.
2. A **double-submit token**: `GET /api/auth/session` returns a `csrfToken`
   the client echoes in an `X-DV-CSRF` header on every mutating request;
   the server compares it (timing-safe) against a value bound to the
   session. `SameSite=Lax` already blocks the cross-site cookie ride for
   non-GET; the token closes the residual same-site / top-level-GET gaps.
3. All mutations are non-GET (`POST`/`PUT`/`PATCH`/`DELETE`), so a
   `<form>`/`<img>` GET can't trigger one.

---

## 4. Authorization & visibility

The crux of "the server decides what users can see". Every request resolves
the caller's **effective role** on the target project; endpoints gate on it.

### Visibility mode & precedence

A project's effective mode is resolved lowest-to-highest
(`effectiveVisibilityMode` in [`visibility.ts`](./visibility.ts)):

```
instance default (MANAGED_DEFAULT_VISIBILITY)
  → repo-wide policy (managed_repo_policy, keyed by 'owner/repo' or 'owner')
    → project pin (managed_project.visibility_mode)
```

This is "**hybrid** by default, switchable to **explicit** ACL — at the
instance default, repo-wide, **or** per-project": flip
`MANAGED_DEFAULT_VISIBILITY` for the whole instance, drop a
`managed_repo_policy` row to flip one repo's projects, or pin a single
project's `visibility_mode`.

### Roles & the resolver

`viewer ⊂ editor ⊂ admin` (`ROLE_RANK` in `types.ts`).
`resolveProjectAccess` is **pure** — the IO layer gathers facts, it decides:

- **Owner** ⇒ `admin`, in either mode.
- **`hybrid` mode** (the default) consults the user's repo permission
  (`admin`→admin, `maintain`/`write`→editor, `triage`/`read`→viewer) **and**
  honours explicit grants on top (share with a collaborator who isn't on
  the repo).
- **`explicit` mode** ignores GitHub access entirely — only owner + grants
  count (the crisp "switched to explicit ACL" semantics).

Role gates per operation:

| Operation | Min role |
| --- | --- |
| list / read projects, bundles, reports, triage; fetch bytes | `viewer` |
| commit triage; upload / delete bundles & reports | `editor` |
| manage grants, change visibility mode, delete project, read audit log | `admin` |

### GitHub membership resolution

`hybrid` mode needs the user's repo permission + org/team memberships
(`GithubAccessFacts`). The IO layer resolves these with the **GitHub App
installation token** (minted via the app JWT; see [§3](#3-identity--authentication))
— e.g. `GET /repos/{owner}/{repo}/collaborators/{user}/permission` plus org /
team membership checks — and **caches** them for `MEMBERSHIP_CACHE_TTL_MS`.
That TTL is the **revocation-lag window**: a user removed from a repo on
GitHub keeps access until it expires; an admin "refresh access" action busts
the cache. Using the installation token (not a per-user repo token) keeps
scopes minimal and access org-admin-controlled — the user OAuth token only
establishes *identity*. All of this sits behind the `GithubAccessFacts`
boundary, so the pure resolver is unaffected by the token source.

---

## 5. Data model

Server-side (DB) shapes in [`types.ts`](./types.ts); DDL in
[`schema-sql.ts`](./schema-sql.ts) (SQLite STRICT + Postgres,
one template, two dialect tokens). Bundle/report **bytes** reuse the
existing content-addressed `BlobBackend`; only metadata tables are new.

```
managed_user ──< managed_session
     │          managed_github_token (1:1, token AEAD-encrypted at rest)
     │
managed_project ──< managed_bundle        (PK project_id, integrity)
     │            ──< managed_report        (PK project_id, name)
     │            ──< managed_grant         (explicit ACL)
     │            ──< managed_triage_entry  (materialized LWW state / finding)
     │            ──< managed_triage_event  (append-only attributed chain)
managed_repo_policy   (repo-wide visibility override)
managed_audit_log     (instance-wide hash-chained attribution)
```

A **project** is the managed analog of an e2e workspace: the scope that
owns bundles, reports, and a triage log. Triage state is stored twice — the
**event log** (`managed_triage_event`) is the source of truth; the
**materialized entry** table (`managed_triage_entry`) is its last-writer-wins
projection for fast reads, rebuildable from the log.

---

## 6. Wire protocol

Managed mode is mostly **REST + cookie**; a WS/SSE **live channel** carries
real-time triage fan-out. Wire shapes are in
[`wire.ts`](./wire.ts). No request carries a signature — the
session authenticates and the server attributes.

### REST surface

| Method & path | Role | Body / response |
| --- | --- | --- |
| `GET /api/sync/info` | — | `ServerInfo` `{ mode, managed? }` — mode probe |
| `GET /api/auth/session` | — | `SessionInfo` or 401 |
| `GET /api/projects` | viewer | `ProjectSummary[]` (only visible) |
| `POST /api/projects` | — | create (maps to repo/org or standalone) |
| `PATCH /api/projects/:id` | admin | rename / set visibility mode |
| `GET /api/projects/:id/bundles` | viewer | `BundleSummary[]` |
| `PUT /api/projects/:id/bundles/:integrity` | editor | raw bytes; server verifies sha512==integrity |
| `GET /api/projects/:id/bundles/:integrity` | viewer | bytes |
| `DELETE …/bundles/:integrity` | editor | — |
| `GET /api/projects/:id/reports` | viewer | `ReportSummary[]` |
| `PUT/GET/DELETE …/reports/:name` | editor/viewer | report bytes |
| `GET /api/projects/:id/triage?since=<seq>` | viewer | `TriageStateResponse` |
| `POST /api/projects/:id/triage` | editor | `TriageCommitRequest` → `TriageCommitResponse` |
| `GET /api/projects/:id/audit` | admin | hash-chained `AuditEntry[]` (paginated) |

Bundle/report transfer reuses the **content-addressing** the e2e objstore
already relies on (the byte path keys on integrity / content-hash, so blobs
dedup across projects), but the auth is the **cookie + project role**, not a
signed bearer token — there's nothing to sign when the server is trusted.

### Live channel (WS / SSE)

The WS upgrade (with the SSE+POST fallback) is **authenticated by the
session cookie** sent on the upgrade — no `challenge` nonce / signature
handshake. After subscribe, the server pushes every peer's committed triage
so open clients converge live, exactly like the e2e `workspace-state`
broadcast, reusing the same `hub` fan-out + Neon `pubsub` bus (keyed by
`projectId` instead of `workspaceTag`).

```
client → server  project-subscribe { projectId, from }      // from = last seq applied
client → server  project-save      { projectId, base, changes }   // or POST /triage
server → client  project-subscribed { projectId, role, head }
server → client  project-state     { projectId, seq, events:[ PublicTriageEvent… ] }
server → client  project-save-ack  { projectId, base, seq }
server → client  project-save-error { projectId, reason }    // 'forbidden'|'stale'|…
server → client  unauthorized      { reason, projectId? }
```

### Triage commit semantics

A commit is a set of per-finding `TriageChange`s against the `base` seq the
client last saw. The server (in one gated, lockless append — the **same**
`(project_id, seq)` PRIMARY-KEY discipline as the e2e
`workspace_revision` chain) applies **last-writer-wins** per finding,
appends one **attributed** `TriageEvent` per change ([§7](#7-attribution--audit)),
advances the materialized entry, and broadcasts. Differences from e2e:

- ordering & attribution are **server-authoritative** (no client signature
  to verify; the server stamps `userId` / `ts` / `seq`);
- a **stale base** doesn't reject — the server applies LWW and returns the
  `missed` events so the client reconciles its local overlay (the managed
  analog of the e2e stale-base catch-up), because there is one trusted
  linearization and no equivocation to defend against.

---

## 7. Attribution & audit

The "chain of attribution". Two append-only, **hash-chained**, tamper-evident
logs; canonical builders in [`wire.ts`](./wire.ts):

- **Per-project triage chain** (`managed_triage_event`): each event commits
  to its predecessor — `hash = base64url(SHA-256(canonicalTriageEvent(…)))`,
  `prevHash` = the prior event's hash (`''` at genesis). `change` is the
  canonical JSON of the `TriageChange`, hashed **verbatim** so
  re-serialization can't shift the chain (the same "hash the exact bytes the
  signature covered" rule the e2e `computeRevisionId` follows).
- **Instance-wide audit log** (`managed_audit_log`): the same construction
  over `canonicalAuditEntry` for non-triage mutations (login, upload,
  delete, grant change, visibility change).

This is the exact inverse of e2e: there the **client** signs and the server
*can't* attribute; here the **server** attributes (it's trusted) and the
hash chain makes the log **append-only & verifiable** — a reader replays the
chain and recomputes each `hash` to detect any silent rewrite. **Optional
hardening:** the server signs each chain head with a server Ed25519 key, so
an external auditor verifies the server's attestation, bridging back toward
the e2e verifiability story without re-encrypting content.

---

## 8. Coexistence & migration

- **Mode detection.** `GET /api/sync/info` returns `{ mode: 'e2e' }` or
  `{ mode: 'managed', managed: { loginPath, cookieName } }`. The client
  flips its UI accordingly — e2e shows the seed/share flow; managed shows a
  GitHub login button and the server-listed project / bundle / report
  inventory. A managed server **rejects** e2e frames (signed
  `workspace-save` / `objstore-*`) and vice-versa, so a misconfigured client
  fails closed rather than silently half-working.
- **Migration (e2e → managed).** One-way and natural: an authenticated
  client uploads its decrypted bundles/reports into a managed project and
  **replays its triage** as attributed `project-save` commits under the
  caller's identity. The reverse (managed → e2e) means handing content back
  to clients to re-encrypt under a fresh seed — possible, lower priority.

---

## 9. Security considerations & threat model

- **The server is trusted — state it plainly.** Unlike the e2e relay, a
  managed-server compromise exposes all content and lets an attacker forge
  attribution going forward (the hash chain detects *rewrites* of past
  entries, not a compromised live server writing new ones). This is the
  deliberate trade for server-side visibility/attribution; deployments that
  can't accept it should run e2e.
- **Sessions & CSRF:** `__Host-` + `HttpOnly` + `Secure` + `SameSite=Lax`,
  hashed-at-rest tokens, login-time id rotation, server-side revocation on
  logout, double-submit CSRF token + the existing same-origin gate.
- **GitHub token at rest:** AEAD-encrypted under a server key, least scopes
  (`read:user`, `read:org`), never sent to the client.
- **Membership revocation lag:** bounded by `MEMBERSHIP_CACHE_TTL_MS`;
  admins can force-refresh.
- **Reused gates carry over:** same-origin upgrade/REST gate, `TRUST_PROXY`
  for `X-Forwarded-*`, per-socket backpressure & inflight caps. **New:**
  rate-limit the auth endpoints (login/callback) to blunt OAuth abuse.

---

## 10. Scaffold map & status

| File | Defines | Status |
| --- | --- | --- |
| [`types.ts`](./types.ts) | domain/storage types, `Role`/`ROLE_RANK`, `VisibilityMode`, `ManagedConfig`, `GithubAccessFacts` | scaffold; not wired |
| [`wire.ts`](./wire.ts) | REST + WS/SSE wire shapes; canonical hash-chain builders; session-token hash | scaffold; not wired |
| [`visibility.ts`](./visibility.ts) | **pure** `effectiveVisibilityMode` / `resolveProjectAccess` + role mapping & guards | scaffold; not wired |
| [`schema-sql.ts`](./schema-sql.ts) | SQLite + Postgres DDL (one template, two dialects) | scaffold; not wired |

The scaffold type-checks (`node --run lint:ts`) and lints
(`oxlint`) clean. Intentionally **deferred** to implementation: `config.ts`
parsing of the `SYNC_MODE` block, the GitHub OAuth client + membership
resolver, the session middleware, the REST routers, the live-channel
handlers, the gated triage-append + projection, and the blob-plane wiring.

---

## 11. Next steps (implementation sequencing)

1. **Config & mode switch** — parse the managed block in `config.ts`;
   `GET /api/sync/info`; HTTPS/`__Host-` boot check.
2. **Auth** — OAuth login/callback/logout/session; session table + cookie +
   CSRF; `managed_user` / `managed_github_token` upsert.
3. **Authorization** — wire `visibility.ts` to a GitHub client + membership
   cache; per-request role resolution middleware.
4. **Projects & artifacts** — project CRUD; bundle/report REST over the
   reused blob plane.
5. **Triage** — gated attributed append + LWW projection; the live channel
   over the reused hub/pubsub; REST `GET/POST /triage`.
6. **Attribution** — the two hash chains + `GET /audit`; optional
   server-signed heads.
7. **Client** — mode-aware UI, login, server-listed inventory, attributed
   triage, e2e→managed import.
8. **Tests** — pure-resolver precedence; chain determinism & tamper
   detection; session/CSRF; cross-mode rejection — matching the repo's
   per-area test culture.

## 12. Roadmap — captured requirements (not yet implemented)

Recorded so the permission / data model accounts for them before the
implementation reaches each:

- **Client protocol detection (landed).** The client probes
  `GET /api/sync/info`, caches the mode in `localStorage`, and **refuses a
  cross-mode switch**; an explicit, user-confirmed **e2e→managed migration**
  UI is still future work. In managed mode the client hides the workspace
  **export** action and replaces the offline toggle with **login / logout**.
- **Managed client storage.** The managed client likely keeps **no OPFS
  store** — reports are **server-provided** (fetched + filtered per user) and
  bundles live only in an **evictable local cache**. This reshapes the
  client's persistence layer away from the e2e OPFS model.
- **Repo auto-discovery.** Managed mode should auto-discover the repositories
  accessible to the **GitHub App installation + the logged-in user** and
  surface them as projects (rather than only manual creation). This is the
  natural source of the `githubRepo` / `githubOrg` bindings in [§5](#5-data-model)
  and feeds the [§4](#4-authorization--visibility) `hybrid` resolver.
- **Releases & stasis bundles.** Managed mode should **list a repo's GitHub
  releases** and **fetch the stasis bundles attached as release assets** —
  ingesting bundles straight from Releases via the installation's access.
- **Reports stay the unit, with server-side finding filtering.** Managed mode
  still stores data as **reports** (the *same finding* may appear differently
  across reports). The server **parses** reports and **filters the findings**
  it lists over the API per user — e.g. only findings bound to certain repos
  or a given dependency scope, hiding findings in specific packages, or
  surfacing reports for specific npm packages **regardless of repo**. The
  exact scoping mechanism is TBD and extends [§4](#4-authorization--visibility)
  from project-level to **finding / package-level** visibility.

## License

MIT.
