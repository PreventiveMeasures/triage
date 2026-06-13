// DDL stubs for the managed protocol's metadata tables. SCAFFOLD ONLY —
// these schemas are NOT wired into `openDb` / `openNeonDb` yet; they
// describe the storage model in `server-managed/MANAGED.md` and give the future
// implementation a single, reviewed starting point.
//
// Same two-backend split as the e2e planes (SQLite STRICT + local FS, or
// Neon Postgres + Vercel Blob): blob BYTES (bundle / report content) reuse
// the existing `BlobBackend` (`server-e2e/objstore/blob.ts`), content-addressed
// by integrity / content-hash exactly as today; only the METADATA tables
// below are new. One template with two substitution tokens — `__INT__`
// (INTEGER on SQLite, BIGINT on Postgres) and `__STRICT__` (the SQLite
// STRICT marker, empty on Postgres) — so the two dialects can't drift,
// mirroring `db-revision-sql.ts`'s single-source approach. The tokens are
// replaced only with the two hardcoded literal sets at the bottom (never
// caller input), so there's no dynamic-SQL surface.

// The shared schema, with `__INT__` / `__STRICT__` placeholders. A
// module-level constant (not a function body) so the CHECKs / FKs / index
// definitions live in one reviewable block.
const MANAGED_SCHEMA_TEMPLATE = `
  -- A logged-in user. github_id (numeric, rename-stable) is the reconcile
  -- key for a returning account; the login string can change.
  CREATE TABLE IF NOT EXISTS managed_user (
    id           TEXT NOT NULL PRIMARY KEY,
    github_id    __INT__ NOT NULL UNIQUE,
    github_login TEXT NOT NULL,
    name         TEXT,
    avatar_url   TEXT,
    created_at   __INT__ NOT NULL,
    last_seen_at __INT__ NOT NULL
  ) __STRICT__;

  -- The user's GitHub OAuth token, AEAD-encrypted under a SERVER key (the
  -- managed server is trusted; the client never sees this). Used to resolve
  -- membership for visibility_mode='hybrid'.
  CREATE TABLE IF NOT EXISTS managed_github_token (
    user_id      TEXT NOT NULL PRIMARY KEY REFERENCES managed_user(id),
    nonce        TEXT NOT NULL,
    ciphertext   TEXT NOT NULL,
    scopes       TEXT NOT NULL,
    expires_at   __INT__,
    refreshed_at __INT__ NOT NULL
  ) __STRICT__;

  -- A login session. id = base64url(SHA-256(cookie token)); the raw token
  -- lives only in the user's __Host- cookie, so a DB read can't mint one.
  CREATE TABLE IF NOT EXISTS managed_session (
    id           TEXT NOT NULL PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES managed_user(id),
    created_at   __INT__ NOT NULL,
    expires_at   __INT__ NOT NULL,
    last_used_at __INT__ NOT NULL,
    user_agent   TEXT
  ) __STRICT__;
  CREATE INDEX IF NOT EXISTS managed_session_user_idx ON managed_session(user_id);
  CREATE INDEX IF NOT EXISTS managed_session_expiry_idx ON managed_session(expires_at);

  -- A project — the managed analog of an e2e workspace. visibility_mode
  -- NULL = inherit (repo policy -> instance default).
  CREATE TABLE IF NOT EXISTS managed_project (
    id              TEXT NOT NULL PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    github_repo     TEXT,
    github_org      TEXT,
    visibility_mode TEXT CHECK (visibility_mode IN ('hybrid', 'explicit')),
    owner_user_id   TEXT NOT NULL REFERENCES managed_user(id),
    created_at      __INT__ NOT NULL
  ) __STRICT__;
  CREATE INDEX IF NOT EXISTS managed_project_repo_idx ON managed_project(github_repo);
  CREATE INDEX IF NOT EXISTS managed_project_owner_idx ON managed_project(owner_user_id);

  -- Repo-WIDE visibility override (the "repo-wide" switch): keyed by
  -- 'owner/repo' or 'owner'. Sits between the project pin and the instance
  -- default in precedence.
  CREATE TABLE IF NOT EXISTS managed_repo_policy (
    scope           TEXT NOT NULL PRIMARY KEY,
    visibility_mode TEXT NOT NULL CHECK (visibility_mode IN ('hybrid', 'explicit')),
    updated_by      TEXT NOT NULL REFERENCES managed_user(id),
    updated_at      __INT__ NOT NULL
  ) __STRICT__;

  -- Explicit access grants (consulted in both modes; the only non-owner
  -- source in 'explicit' mode). principal_ref: a user id / 'org/team-slug' /
  -- 'owner' depending on principal_type.
  CREATE TABLE IF NOT EXISTS managed_grant (
    project_id     TEXT NOT NULL REFERENCES managed_project(id),
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'team', 'org')),
    principal_ref  TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
    granted_by     TEXT NOT NULL REFERENCES managed_user(id),
    granted_at     __INT__ NOT NULL,
    PRIMARY KEY (project_id, principal_type, principal_ref)
  ) __STRICT__;
  CREATE INDEX IF NOT EXISTS managed_grant_principal_idx ON managed_grant(principal_type, principal_ref);

  -- A bundle stored under a project. Content-addressed by SRI integrity
  -- (same as the e2e client); BYTES live in the blob backend, dedup'd by
  -- integrity across projects. Visibility stays per row.
  CREATE TABLE IF NOT EXISTS managed_bundle (
    project_id     TEXT NOT NULL REFERENCES managed_project(id),
    integrity      TEXT NOT NULL,
    name           TEXT NOT NULL,
    content_length __INT__ NOT NULL CHECK (content_length >= 0),
    uploaded_by    TEXT NOT NULL REFERENCES managed_user(id),
    uploaded_at    __INT__ NOT NULL,
    PRIMARY KEY (project_id, integrity)
  ) __STRICT__;

  -- A report stored under a project. content_hash = base64url SHA-256 of
  -- the stored bytes; finding_count is NULL until the server parses it.
  CREATE TABLE IF NOT EXISTS managed_report (
    project_id     TEXT NOT NULL REFERENCES managed_project(id),
    name           TEXT NOT NULL,
    content_hash   TEXT NOT NULL,
    content_length __INT__ NOT NULL CHECK (content_length >= 0),
    finding_count  __INT__,
    uploaded_by    TEXT NOT NULL REFERENCES managed_user(id),
    uploaded_at    __INT__ NOT NULL,
    PRIMARY KEY (project_id, name)
  ) __STRICT__;

  -- Materialized current triage state per finding — a last-writer-wins
  -- projection of managed_triage_event. fields = JSON of ManagedTriageFields.
  CREATE TABLE IF NOT EXISTS managed_triage_entry (
    project_id TEXT NOT NULL REFERENCES managed_project(id),
    finding_id TEXT NOT NULL,
    fields     TEXT NOT NULL,
    updated_by TEXT NOT NULL REFERENCES managed_user(id),
    updated_at __INT__ NOT NULL,
    seq        __INT__ NOT NULL,
    PRIMARY KEY (project_id, finding_id)
  ) __STRICT__;

  -- The append-only, hash-chained, ATTRIBUTED triage log — the per-project
  -- "chain of attribution". seq is server-assigned monotonic per project;
  -- hash chains via prev_hash for tamper-evidence. PRIMARY KEY (project_id,
  -- seq) backs a gated lockless append exactly like the e2e workspace_revision
  -- chain (see MANAGED.md), but rows are server-attributed (user_id), not
  -- client-signed.
  CREATE TABLE IF NOT EXISTS managed_triage_event (
    project_id TEXT NOT NULL REFERENCES managed_project(id),
    seq        __INT__ NOT NULL,
    finding_id TEXT NOT NULL,
    change     TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES managed_user(id),
    ts         __INT__ NOT NULL,
    prev_hash  TEXT,
    hash       TEXT NOT NULL,
    PRIMARY KEY (project_id, seq),
    UNIQUE (project_id, hash)
  ) __STRICT__;
  CREATE INDEX IF NOT EXISTS managed_triage_event_finding_idx ON managed_triage_event(project_id, finding_id);

  -- Instance-wide hash-chained audit log for non-triage mutations. user_id
  -- NULL only for pre-auth events (e.g. a rejected login). detail = canonical
  -- JSON, hashed verbatim.
  CREATE TABLE IF NOT EXISTS managed_audit_log (
    seq        __INT__ NOT NULL PRIMARY KEY,
    ts         __INT__ NOT NULL,
    user_id    TEXT REFERENCES managed_user(id),
    action     TEXT NOT NULL,
    project_id TEXT REFERENCES managed_project(id),
    target     TEXT,
    detail     TEXT NOT NULL,
    prev_hash  TEXT,
    hash       TEXT NOT NULL UNIQUE
  ) __STRICT__;
  CREATE INDEX IF NOT EXISTS managed_audit_project_idx ON managed_audit_log(project_id, seq);
`

// Substitute the two dialect tokens. `int` / `strict` are only ever the
// hardcoded literals below — never caller input — so this is a fixed-string
// rewrite, not a dynamic-SQL surface.
function buildManagedSchema(int: string, strict: string): string {
  return MANAGED_SCHEMA_TEMPLATE.replaceAll('__INT__', int).replaceAll('__STRICT__', strict)
}

// SQLite: STRICT tables (column-type enforcement, matching the e2e planes)
// + INTEGER for epoch-ms / seq / counts.
export const MANAGED_SCHEMA_SQLITE = buildManagedSchema('INTEGER', 'STRICT')

// Neon/Postgres: BIGINT for the same columns, native types otherwise, no
// STRICT marker. The CHECK constraints carry over identically.
export const MANAGED_SCHEMA_PG = buildManagedSchema('BIGINT', '')
