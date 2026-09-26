export const MANAGED_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_user (
  id             TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL UNIQUE,
  login          TEXT NOT NULL,
  name           TEXT,
  avatar_url     TEXT,
  role           TEXT NOT NULL DEFAULT 'none',
  -- GitHub user-to-server token, persisted so the repositories page can list
  -- the user's repos (GET /user/repos) on demand. Refresh token + expiry are
  -- null for non-expiring tokens (GitHub App with expiring tokens disabled).
  gh_access_token      TEXT,
  gh_refresh_token     TEXT,
  gh_token_expires_at  INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  -- Presence is independent of admin edits and background token refreshes.
  -- NULL for legacy accounts until a known session authenticates them.
  last_seen_at   INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS managed_session (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES managed_user(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS managed_session_user_idx ON managed_session(user_id);
CREATE INDEX IF NOT EXISTS managed_session_expires_idx ON managed_session(expires_at);

-- Repositories selected to operate on. Keyed by GitHub's numeric repo id
-- (stable across renames). The row carries everything needed to read the repo's
-- contents server-side later: installation_id mints an App installation token
-- (Contents: Read) for PRIVATE repos — NULL means a PUBLIC repo readable without
-- the App — and full_name + default_branch locate the contents. added_by is the
-- selector, nulled (not cascaded) if that user is removed so the selection
-- survives.
CREATE TABLE IF NOT EXISTS selected_repo (
  repo_id         INTEGER PRIMARY KEY,
  full_name       TEXT NOT NULL,
  is_private      INTEGER NOT NULL,
  installation_id INTEGER,
  default_branch  TEXT NOT NULL,
  html_url        TEXT NOT NULL,
  added_by        TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  added_at        INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX IF NOT EXISTS selected_repo_full_name_idx ON selected_repo(full_name);

-- Bundles uploaded to the server (the "Manage bundles" page). Like reports, the
-- bytes are stored in the clear (blob-store, keyed by this opaque uuid id) for
-- the server to operate on. integrity is the content hash (sha512-<base64>,
-- byte-identical to the client's) so re-uploading the same bytes dedupes (UNIQUE);
-- it is also the key a report's bundleHashes match to auto-link.
-- uploaded_by / repo_id are the (nullable) user + repo links, both nulled (not
-- cascaded) when the referenced user / selected repo goes away.
CREATE TABLE IF NOT EXISTS managed_bundle (
  id           TEXT PRIMARY KEY,
  integrity    TEXT NOT NULL UNIQUE,
  filename     TEXT NOT NULL,
  kind         TEXT,
  byte_size    INTEGER NOT NULL,
  uploaded_by  TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  -- Durable snapshot of the uploader's login at upload time, so "who uploaded
  -- this" survives the uploader being removed (when uploaded_by nulls out).
  uploaded_by_login TEXT,
  repo_id      INTEGER REFERENCES selected_repo(repo_id) ON DELETE SET NULL,
  uploaded_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS managed_bundle_uploaded_at_idx ON managed_bundle(uploaded_at);

-- Reports uploaded to the server (the "Manage reports" page). A managed server
-- is TRUSTED, so the bytes are stored in the clear (blob-store, keyed by this
-- opaque uuid id) for the server to operate on later; this row carries the
-- metadata + attribution. uploaded_by / repo_id are the (nullable) user + repo
-- links, nulled (not cascaded) when the user / selected repo goes away. bundle_id
-- is the (nullable) auto-resolved link to a stored bundle; bundle_integrity is
-- the report's declared primary bundle (from its bundleHashes), kept so a later
-- bundle upload of that integrity can re-link.
CREATE TABLE IF NOT EXISTS managed_report (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL,
  filename         TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  byte_size        INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  uploaded_by      TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  -- Durable snapshot of the uploader's login (see managed_bundle).
  uploaded_by_login TEXT,
  repo_id          INTEGER REFERENCES selected_repo(repo_id) ON DELETE SET NULL,
  repo_directory   TEXT NOT NULL DEFAULT '',
  repo_embedded    INTEGER NOT NULL DEFAULT 0,
  analyzer         TEXT,
  visible          INTEGER NOT NULL DEFAULT 0,
  bundle_id        TEXT REFERENCES managed_bundle(id) ON DELETE SET NULL,
  bundle_integrity TEXT,
  uploaded_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS managed_report_uploaded_at_idx ON managed_report(uploaded_at);
CREATE INDEX IF NOT EXISTS managed_report_bundle_integrity_idx ON managed_report(bundle_integrity);
CREATE INDEX IF NOT EXISTS managed_report_bundle_hash_idx ON managed_report(bundle_id, sha256);

-- Per-finding triage annotations — the managed (trusted-plaintext) counterpart
-- of the client's localStorage triage map, keyed the same way: by finding id
-- alone, not by report. Reports mostly repeat one another (a re-scan of the
-- same code carries the same finding ids) and a finding's triage is shared by
-- every report that carries it; which ids a viewer may read or write is
-- decided per report at the endpoint, not here. The wire shape lives in
-- common/managed/triage.ts. Whole-entry replace, NULL columns are unset;
-- flagged is tri-state: NULL unset / 1 flagged / 0 an explicit un-flag
-- tombstone. A cleared entry keeps its row with every field NULL — a
-- tombstone a reader adopts as "cleared", where a missing row means "never
-- annotated" (so a stale client copy can't resurrect a teammate's clear).
-- updated_by is the last writer (nulled when that user is removed);
-- updated_by_login is the durable login snapshot (see managed_bundle).
CREATE TABLE IF NOT EXISTS finding_triage (
  finding_id       TEXT PRIMARY KEY,
  color            TEXT,
  triage           TEXT,
  comment          TEXT,
  fix              TEXT,
  flagged          INTEGER,
  updated_by       TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  updated_by_login TEXT,
  updated_at       INTEGER NOT NULL
) STRICT;

-- The trail behind finding_triage: one row per write that CHANGED an entry,
-- holding the entry as written (every field NULL = a clear), who wrote it and
-- when. finding_triage stays the current-state projection reads hit; this is
-- walked only for a finding's history. The wire is whole-entry replace, so a
-- snapshot per write is exactly what arrived and "what changed" is the diff
-- against the previous row for the same id, computed on read. batch_id groups
-- the rows of one request. seq is the rowid: a total order that breaks ties
-- on at. actor_id / actor_login follow the uploaded_by / uploaded_by_login
-- convention (live account, durable login snapshot). Everything is kept by
-- default — the trail is the record; an operator may bound it per finding
-- (TRIAGE_HISTORY_LIMIT), in which case a finding's older events are trimmed
-- as new ones land. An id no report carries any more is the tombstone GC's
-- concern.
CREATE TABLE IF NOT EXISTS finding_triage_event (
  seq          INTEGER PRIMARY KEY,
  finding_id   TEXT NOT NULL,
  batch_id     TEXT NOT NULL,
  color        TEXT,
  triage       TEXT,
  comment      TEXT,
  fix          TEXT,
  flagged      INTEGER,
  actor_id     TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  actor_login  TEXT,
  at           INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS finding_triage_event_finding_idx ON finding_triage_event(finding_id, seq);
CREATE INDEX IF NOT EXISTS finding_triage_event_actor_at_idx ON finding_triage_event(actor_id, at);

-- Teams group users + repos for access scoping. A team has just a name here;
-- the two link tables below carry the many-many relations.
CREATE TABLE IF NOT EXISTS managed_team (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

-- Team <-> repo, many-many, with an OPTIONAL path (a subpath of the repo the
-- team is scoped to; empty path = the whole repo). Distinct paths can coexist;
-- adding the whole repo replaces them. CASCADE removes links with either side. repo_id
-- references the selected (operate-on) repos.
CREATE TABLE IF NOT EXISTS team_repo (
  team_id  TEXT NOT NULL REFERENCES managed_team(id) ON DELETE CASCADE,
  repo_id  INTEGER NOT NULL REFERENCES selected_repo(repo_id) ON DELETE CASCADE,
  path     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (team_id, repo_id, path)
) STRICT;

CREATE INDEX IF NOT EXISTS team_repo_repo_idx ON team_repo(repo_id);

-- Team <-> user, many-many, with per-membership visibility permissions (see
-- common/managed/permissions.ts) — view_dependencies / view_security, both
-- default 0 (off). CASCADE so the membership dies with either side.
CREATE TABLE IF NOT EXISTS team_user (
  team_id           TEXT NOT NULL REFERENCES managed_team(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES managed_user(id) ON DELETE CASCADE,
  view_dependencies INTEGER NOT NULL DEFAULT 0,
  view_security     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, user_id)
) STRICT;

CREATE INDEX IF NOT EXISTS team_user_user_idx ON team_user(user_id);
`
