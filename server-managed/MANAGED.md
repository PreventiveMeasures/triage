# DeepView managed-mode server

A **trusted-server** alternative to the end-to-end-encrypted triage-sync
relay (see [`server-e2e/README.md`](../server-e2e/README.md)). Where the e2e
protocol treats the server as an untrusted relay of opaque ciphertext,
managed mode makes the server the authority: users **log in** (GitHub), the
server **decides what each user can see**, stores triage / bundles / reports
in a form it can read, and attributes every triage change to the account
that made it.

This document is both the spec and the map of what exists. Sections
[§1](#1-why-a-second-server--the-trust-model)–[§9](#9-security-considerations--threat-model)
describe the server as **implemented today**; [§10](#10-considered-alternatives)
records designs that were weighed and dropped, and
[§11](#11-roadmap--not-yet-implemented) the ones still ahead. Nothing in
§1–§9 is aspirational — where a piece is missing it says so inline.

---

## 1. Why a second server — the trust model

The e2e relay's guarantee is *the operator can't read your triage*. That is
exactly wrong for a team deployment where the operator **must** read it: to
list "the reports available to you", to gate "the findings you're allowed to
see", and to record "who changed this finding's status". Those features
require a trusted server, so managed mode inverts the trust model rather
than bolting server-side features onto the zero-knowledge design.

| | e2e (`v1` / `v1.objstore`) | **managed** |
| --- | --- | --- |
| Root of authority | per-workspace **seed** (32 bytes); holders are writers | logged-in **user** (GitHub) + server-side **role** and **team** scope |
| Per-message auth | Ed25519 signature over a canonical revision | **session cookie** (server stamps attribution) |
| What the server sees | opaque ciphertext only | plaintext — it parses reports and filters findings |
| Who decides visibility | nobody — anyone with the tag can subscribe | the **server**, per request (role ladder + team membership + per-membership permissions) |
| Attribution | none — the server can't attribute a revision | every triage write attributed to a user, with a per-finding trail |
| Trust boundary | server may DoS / equivocate but **can't read/forge** | server is **fully trusted**; compromise exposes content |

The two are separate processes with separate stores, not one server in two
modes — see [§2](#2-running-a-managed-server). A single client supports both
and adapts after probing `GET /api/config`
([§8](#8-coexistence-with-the-e2e-client)). The same-origin gate
(`server-common/origin.ts`) is shared; the WS sync plane, the signed-blob
objstore, and the Neon/Vercel backends are **not** — a managed server has no
`/api/sync` yet ([§11](#11-roadmap--not-yet-implemented)).

---

## 2. Running a managed server

```sh
node --run server-managed      # or: node server-managed/index.ts
```

A separate entry point from `node --run server` (the e2e relay), with its
own SQLite file, its own HTTP router, and no sync plane. `GET /api/config`
advertises `{ mode: 'managed', managed: { loginPath, cookieName } }` so a
client can tell the two apart before connecting.

Config is parsed once at boot and **fails fast** on a missing or invalid
required value, the same discipline as `server-e2e/config.ts`
([`config.ts`](./config.ts)):

| Env var | Default | Notes |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | — | the **login** App's client id — user-to-server identity flow (**required**) |
| `GITHUB_CLIENT_SECRET` | — | the login App's client secret, server-side only (**required**) |
| `OAUTH_CALLBACK_URL` | — | absolute `…/api/oauth/github/callback`; its scheme decides `Secure` (**required**) |
| `GITHUB_APP_ID` | — | the **separate private-repo** App's id (optional; absent ⇒ public-only repo listing) |
| `GITHUB_APP_PRIVATE_KEY` | — | that App's PEM key; literal or `\n`-escaped (optional) |
| `GITHUB_APP_SLUG` | — | that App's slug, to build the "Connect a repository" install URL (optional) |
| `SESSION_COOKIE_NAME` | `__Host-dvsid` | `__Host-` ⇒ `Secure` + host-only + `Path=/`; use a plain name for loopback http |
| `SESSION_TTL_MS` | `1209600000` (14 d) | hard session expiry |
| `MAX_REPORT_BYTES` | `10485760` (10 MiB) | per-upload cap on the "Manage reports" page |
| `MAX_BUNDLE_BYTES` | `104857600` (100 MiB) | per-upload cap on bundles (matches the e2e objstore cap) |
| `TRIAGE_HISTORY_LIMIT` | `0` (keep everything) | per-finding cap on the triage trail; `0` = unbounded |
| `PORT` / `HOST` / `DB_PATH` / `DEBUG` / `TRUST_PROXY` | `8765` / `127.0.0.1` / `server-managed/data/managed.db` / off / — | as in e2e |

Two boot checks mirror the e2e `TRUST_PROXY` check and exist because a
`__Host-` cookie mandates `Secure`: a **non-loopback** `HOST` with a
non-HTTPS callback fails, and so does a `__Host-`-prefixed cookie name with
a non-HTTPS callback. Loopback http dev runs with a plain cookie name.

Bytes live on disk beside the DB — `data/reports/<uuid>`,
`data/bundles/<uuid>`, `data/avatars/<uuid>`. There is no Neon / Vercel Blob
backend for managed mode yet.

---

## 3. Identity & authentication

Managed mode uses **two decoupled GitHub Apps**, which is the whole point of
the split:

- **The login App** (required) runs the user-to-server OAuth flow and is used
  **only for identity** — *who* is signing in. It holds no repository
  permissions, so its consent screen never says "act on your behalf".
- **The private-repo App** (optional, separate) carries `Contents: Read` and
  is installed per org/repo by an admin. Its App JWT (RS256) mints
  **installation access tokens** (`/app/installations` → `/access_tokens` →
  `/installation/repositories`), which is how private repositories are
  listed. Keeping it separate is what keeps that permission off the login
  consent; absent it, only public repos are listable.

App-installation-first for the data plane: least privilege, org-admin
controlled, and no per-user repo tokens to refresh. The user's own token is
persisted (`managed_user.gh_access_token`) only so the repositories page can
list *their* repos on demand.

### Login flow

```
GET  /api/oauth/github/login    → 302 to github.com/login/oauth/authorize
                                  with client_id, redirect_uri, and a `state`
                                  bound into a short-lived signed cookie.
GET  /api/oauth/github/callback?code&state
                                → validate `state`; exchange `code`
                                  server-to-server; GET /user; upsert
                                  managed_user (joined on github_user_id);
                                  mint a session; Set-Cookie; 302 to the app.
GET  /api/auth/session          → { user, csrfToken } or 401.
POST /api/auth/logout           → same-origin + CSRF; deletes the session row.
```

### Session cookie

A fresh random token per login; the DB stores the session id, never a
reusable secret in the clear. Attributes:

- `__Host-` prefix ⇒ browser-enforced `Secure`, host-only, `Path=/`.
- `HttpOnly`, `SameSite=Lax` — so the OAuth redirect **GET** carries the
  cookie while mutations stay same-origin `fetch`.
- A **new** session id on every login (no fixation); logout deletes the row,
  so revocation is server-side and immediate, not just a cleared cookie.
- Expired rows are excluded by every lookup (`expires_at > now`) and swept
  hourly — the sweep is housekeeping, not the security control.

### CSRF

Cookie auth needs CSRF defense on state-changing requests. Three layers, all
present:

1. The **same-origin gate** (`server-common/origin.ts`) on `/api/*`.
2. A **double-submit token**: `GET /api/auth/session` returns a `csrfToken`
   the client echoes in `x-csrf-token` on every mutation; the server compares
   it against the value bound to the session row.
3. All mutations are non-GET, so a `<form>` / `<img>` GET can't trigger one.

---

## 4. Authorization — roles, teams, permissions

Two independent axes, both server-side, both checked on every request. A
user needs to clear **both** to read a report.

### The role ladder

`admin > manage > triage > view > none` ([`roles.ts`](../common/managed/roles.ts),
with `roleAtLeast`). It is instance-wide, stored on `managed_user.role`, and
defaults to `none` for a newly logged-in account:

| Role | What it unlocks |
| --- | --- |
| `admin` | everything, incl. setting other users' roles; **bypasses team membership** |
| `manage` | the management surface — repos, reports, bundles, teams |
| `triage` | writing per-finding triage (with membership) |
| `view` | reading team reports (with membership) |
| `none` | nothing |

### Teams

A **team** groups users and repos; it is the managed analog of an e2e
workspace and the unit of report visibility.

- **team ↔ repo**, many-to-many, with an optional `path` — a subpath of the
  repo the team is scoped to; `NULL` means the whole repo.
- **team ↔ user**, many-to-many, with per-membership **visibility
  permissions** (`dependencies`, `security`), **both default off**
  ([`permissions.ts`](../common/managed/permissions.ts)).

A report is attached to a repo; a user sees it if some team holds that repo
and lists that user. Teams are listed in the client sidebar above workspaces,
with their reports beneath them.

### The report gate

Stated once, enforced once, on the server — the client is never the
authority:

```
view a report   →  role is admin
                   OR (roleAtLeast(role, 'view')   AND team membership for the report's repo)
write triage    →  role is admin
                   OR (roleAtLeast(role, 'triage') AND team membership for the report's repo)
```

Membership alone is not enough (a `none` member of a holding team is
refused), and `manage` alone is not enough to *write* triage — managing the
stored reports is not membership of the teams reading them. The same gate
filters the `/api/teams` listing, so the sidebar never offers a report the
user can't open, and every denial is reported as **404**, so neither a
report's existence nor a user's membership is probeable.

---

## 5. Data model

SQLite (`node:sqlite`, STRICT tables, WAL, `PRAGMA foreign_keys = ON`),
created with `CREATE TABLE IF NOT EXISTS` at open; columns added later are
applied idempotently by an `ensureColumn` helper, since
`CREATE TABLE IF NOT EXISTS` never alters an existing table. Report and
bundle **bytes** live in the on-disk blob store, keyed by the row's uuid;
only metadata is in the DB. Schema in [`db.ts`](./db.ts).

```
managed_user ──< managed_session
     │
selected_repo ──< managed_report ──> managed_bundle   (auto-linked by integrity)
     │        └──< managed_bundle
     │
managed_team ──< team_repo  >── selected_repo
             └──< team_user  >── managed_user   (view_dependencies, view_security)

finding_triage          (current state, one row per finding id)
finding_triage_event    (append-only trail behind it)
```

Notes that matter:

- **`selected_repo`** is keyed by GitHub's numeric repo id (stable across
  renames) and carries everything needed to read the repo's contents later:
  `installation_id` (NULL ⇒ a public repo needing no App), `full_name`,
  `default_branch`, `html_url`.
- **Triage is keyed by finding id alone**, not by report. Reports mostly
  repeat one another — a re-scan of the same code carries the same finding
  ids — and a finding's triage is shared by every report carrying it. *Which*
  ids a viewer may read or write is decided per report at the endpoint.
- A **cleared** triage entry keeps its row with every field NULL — a
  tombstone a reader adopts as "cleared", where a missing row means "never
  annotated", so a stale client copy can't resurrect a teammate's clear.
- Attribution columns come in pairs: a live FK (`uploaded_by`, `updated_by`,
  `actor_id`, nulled on user deletion) plus a durable login **snapshot**
  (`uploaded_by_login`, `updated_by_login`, `actor_login`), so "who did this"
  survives the account being removed.

---

## 6. HTTP surface

REST + session cookie. No request carries a signature — the session
authenticates and the server attributes. The authoritative list is the header
comment of [`http.ts`](./http.ts); in outline:

| Group | Routes | Gate |
| --- | --- | --- |
| Probe / auth | `GET /api/config`, `/api/oauth/github/{login,callback}`, `GET /api/auth/session`, `POST /api/auth/logout` | public / session |
| Teams | `GET /api/teams` | session (reports stripped below `view`) |
| Reports | `GET /api/reports/<id>`, `GET/POST /api/reports/<id>/triage`, `GET …/triage/history?finding=` | [§4](#4-authorization--roles-teams-permissions) |
| Avatars | `GET /api/avatar/<id>` | session |
| Admin — users | `GET /api/admin/users`, `POST /api/admin/set-role` | `admin` |
| Admin — repos | `GET /api/admin/repositories`, `POST …/select` | `admin`\|`manage` |
| Admin — reports | `GET/POST /api/admin/reports`, `GET/DELETE …/<id>`, `POST …/set-repo` | `admin`\|`manage` |
| Admin — bundles | `GET/POST /api/admin/bundles`, `GET/DELETE …/<id>`, `POST …/set-repo` | `admin`\|`manage` |
| Admin — teams | `GET/POST /api/admin/teams`, `POST …/{rename,delete,set-repo,remove-repo,set-member,remove-member}` | `admin`\|`manage` |

A report is served as `text/plain; charset=utf-8` with
`x-content-type-options: nosniff` and `cache-control: no-store`; the client
renders it in place and deliberately does **not** cache it to OPFS. Local
OPFS ingest is disabled outright in managed mode — a drag-and-dropped file
uploads to the server or does nothing, it never lands in browser storage.

Uploaded bundles are content-addressed (`sha512-<base64>`, byte-identical to
the client's `crypto.subtle.digest('SHA-512')`), so re-uploading the same
bytes dedupes and a report's declared `bundleHashes` auto-link to a bundle
that arrives later.

---

## 7. Server-side finding filtering

The server parses reports, so visibility can be finer than "this report".
Below `manage`, a viewer's bytes are filtered before they leave the process
([`report-filter.ts`](../common/managed/report-filter.ts)); `admin` and
`manage` see reports whole.

Permissions are resolved by OR across **all** of the viewer's memberships
that hold the report's repo, then applied:

- **no `dependencies`** ⇒ every finding classified as a dependency finding is
  dropped. Dependency classification mirrors the client's directory
  precedence (`node_modules` > `vendor` > `dependencies`).
- **no `security`** ⇒ every finding is dropped whose sole entry — or *any*
  entry in its `duplicates` array — comes from a security analyzer (the
  analyzer / type / source names contain "security") or is stamped
  `"security": true`.

Filtering runs on the same parse the client would do, so the finding-id set a
viewer's triage endpoints accept is exactly the set that viewer can see: a
filtered-out finding cannot be read, written, or probed. The parse is
memoized per `(report, filter)` — a report is immutable — rather than redone
on every debounced push.

---

## 8. Coexistence with the e2e client

`GET /api/config` returns `{ mode: 'e2e' | 'managed', managed }`
([`server-info.ts`](../common/server-info.ts)), the same shape the e2e server
emits as its first `server-info` frame on a sync connection. The client
probes it, caches the answer, and **refuses a cross-mode switch**, so a
misconfigured client fails closed rather than half-working. In managed mode
it shows GitHub login instead of the seed/share flow, hides the workspace
export action, and lists the server-provided team inventory.

An explicit, user-confirmed **e2e → managed migration** — uploading decrypted
bundles/reports and replaying triage as attributed writes — is
[roadmap](#11-roadmap--not-yet-implemented). The reverse direction means
handing content back to clients to re-encrypt under a fresh seed; possible,
lower priority.

---

## 9. Security considerations & threat model

- **The server is trusted — state it plainly.** Unlike the e2e relay, a
  managed-server compromise exposes all content and lets an attacker forge
  attribution going forward. This is the deliberate trade for server-side
  visibility and attribution; deployments that can't accept it should run
  e2e. Managed mode does not weaken the e2e guarantee — it is a different
  deployment, not a mode of the same one.
- **Authorization is server-side only.** Every report read and triage write
  re-resolves role + membership from the DB; nothing is trusted from the
  client, and the filtered bytes are the only bytes that leave the process.
  Denials are 404s so membership isn't probeable.
- **Sessions & CSRF:** `__Host-` + `HttpOnly` + `Secure` + `SameSite=Lax`,
  session-id rotation on login, server-side revocation on logout,
  double-submit CSRF token plus the same-origin gate.
- **Two Apps, least privilege:** the login App holds no repo permissions;
  `Contents: Read` lives only on the separate, org-admin-installed App and is
  used through short-lived installation tokens.
- **Upload caps** (`MAX_REPORT_BYTES` / `MAX_BUNDLE_BYTES`) bound a single
  request; reports are parsed only after the cap is applied.
- **Known gaps:** the user's GitHub token is stored unencrypted at rest
  (encrypting it under a server key is [roadmap](#11-roadmap--not-yet-implemented));
  the auth endpoints are not rate-limited; there is no instance-wide audit log
  beyond the triage trail.

---

## 10. Considered alternatives

Recorded because they were designed in full and deliberately dropped, so the
next reader doesn't re-litigate them:

- **Projects + grants instead of teams.** A `managed_project` scope owning
  bundles/reports/triage, with an explicit `managed_grant` ACL and a
  `viewer ⊂ editor ⊂ admin` ladder. Rejected in favour of **teams**: the
  grouping people actually asked for was "these users, these repos", and
  teams give that directly without a second scope object between a repo and
  its reports.
- **`hybrid` vs `explicit` visibility modes**, resolved instance default →
  repo-wide policy → per-project pin, where `hybrid` derived roles from the
  caller's GitHub repo permission (`admin`→admin, `write`→editor,
  `read`→viewer). Rejected for now as premature: it needs live GitHub
  membership resolution ([§11](#11-roadmap--not-yet-implemented)) to mean
  anything, and the instance-wide role ladder plus explicit team membership
  covers the deployments in front of us with far less surface. If GitHub-
  derived access lands, it should map *into* the existing ladder rather than
  reintroduce a parallel one.

---

## 11. Roadmap — not yet implemented

- **Live channel (WS / SSE).** Today triage is plain REST: opening a report
  hydrates from `GET /api/reports/<id>/triage` once, local edits push back
  debounced, and a teammate's change only shows up on the next open. The
  intended design: authenticate the WS
  upgrade (and the SSE+POST fallback) by the **session cookie** — no
  challenge/signature handshake — then fan out every peer's committed triage
  so open clients converge live, reusing the e2e `hub` fan-out keyed by team
  instead of workspace tag.

  ```
  client → server  subscribe   { scope, from }        // from = last seq applied
  client → server  save        { scope, base, changes }
  server → client  subscribed  { scope, role, head }
  server → client  state       { scope, seq, events:[…] }
  server → client  save-ack    { scope, base, seq }
  server → client  save-error  { scope, reason }
  ```

  The commit semantics differ from e2e in one important way: a **stale base
  doesn't reject**. The server applies last-writer-wins and returns the
  `missed` events for the client to reconcile its overlay, because there is
  one trusted linearization and no equivocation to defend against.
- **Hash-chained attribution.** `finding_triage_event` records who and when,
  ordered by `seq`, but is not tamper-evident: each event should commit to its
  predecessor (`hash = SHA-256(canonical(event))`, `prevHash` = the prior
  hash, `''` at genesis), hashing the stored bytes **verbatim** so
  re-serialization can't shift the chain — the same rule the e2e
  `computeRevisionId` follows. Then a reader replays the log and recomputes
  each hash to detect a silent rewrite. This is the exact inverse of e2e:
  there the client signs and the server can't attribute; here the server
  attributes and the chain makes the log append-only and verifiable.
  **Optional hardening:** the server signs each chain head with an Ed25519
  key, so an external auditor can verify the attestation.
- **Instance-wide audit log.** The same construction over non-triage
  mutations — login, upload, delete, role change, team change — which today
  leave no record at all.
- **GitHub membership resolution.** Resolve the caller's repo permission and
  org/team memberships through the installation token
  (`GET /repos/{owner}/{repo}/collaborators/{user}/permission` + org checks)
  behind a cached facts boundary. The cache TTL is also the
  **revocation-lag window** — a user removed on GitHub keeps access until it
  expires — so it needs an admin "refresh access" action to bust it. This is
  the prerequisite for anything like [§10](#10-considered-alternatives)'s
  hybrid mode.
- **Repo auto-discovery.** Surface the repositories reachable by the App
  installation automatically, rather than only through manual selection.
- **Releases & stasis bundles.** List a repo's GitHub releases and ingest the
  stasis bundles attached as release assets, straight through the
  installation's access — the natural upstream for `managed_bundle`.
- **Finding-level scoping beyond the two permission flags.** Hiding findings
  in specific packages, or surfacing findings for an npm package *regardless*
  of repo, extends [§7](#7-server-side-finding-filtering) from a per-viewer
  boolean pair to a scoping expression.
- **Token encryption at rest**, auth-endpoint rate limiting, and a Neon /
  blob backend for multi-instance deployments.
- **e2e → managed migration UI** ([§8](#8-coexistence-with-the-e2e-client)).

## License

MIT.
