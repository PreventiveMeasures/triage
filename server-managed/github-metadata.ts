import type { GithubFixStatus, GithubIssueClosedReason } from '../common/github-pr.ts'
import type { ManagedSql } from './sql.ts'

export interface GithubMetadata {
  key: string
  title: string
  description: string | null
  status: GithubFixStatus
  // NULL on legacy entries; 'unknown' means a closed issue was checked but
  // GitHub supplied no recognized reason, so it needs no further backfill.
  stateReason: GithubIssueClosedReason | null
  fetchedAt: number
  attemptedAt: number | null
}
export interface GithubRepositoryVisibility {
  repoId: number
  github: string
  public: boolean
  checkedAt: number
}
// A commit's details, keyed by githubCommitKey. Commits never change, so an
// entry is never refreshed or evicted.
export interface GithubCommit {
  key: string
  message: string
  authorName: string | null
  authorLogin: string | null
  authoredAt: number | null
  committedAt: number | null
  fetchedAt: number
}
export interface GithubTag { name: string; sha: string }
export interface GithubMetadataStore {
  listGithubMetadata(keys: readonly string[]): Promise<GithubMetadata[]>
  setGithubMetadata(entries: readonly Omit<GithubMetadata, 'attemptedAt'>[]): Promise<void>
  recordGithubMetadataAttempts(keys: readonly string[], attemptedAt: number): Promise<void>
  listGithubRepositoryVisibility(repoIds: readonly number[]): Promise<GithubRepositoryVisibility[]>
  setGithubRepositoryVisibility(entries: readonly GithubRepositoryVisibility[]): Promise<void>
}
export interface GithubCommitStore {
  listGithubCommits(keys: readonly string[]): Promise<GithubCommit[]>
  setGithubCommits(entries: readonly GithubCommit[]): Promise<void>
  // The cached tags that point to each commit, by githubCommitKey.
  listGithubCommitTags(keys: readonly string[]): Promise<{ key: string; name: string }[]>
  // `complete` is a listing of every tag the repository has: tags it leaves
  // out were deleted. Otherwise only the listed tags are updated.
  refreshGithubTags(repoId: number, tags: readonly GithubTag[], complete: boolean): Promise<void>
}

// A stable repository ID survives renames, as in the PR metadata keys.
export function githubCommitKey(repoId: number, sha: string): string {
  return `${repoId}:${sha}`
}

// Successful GitHub reads are shared and retained without eviction. The stable
// repository ID in the key survives renames, but is never an access grant.
// Callers must verify current user -> team -> repo grants plus either recently
// verified public visibility or the viewer's live GitHub access with their token.
export const GITHUB_STATE_REASON_COLUMN = "TEXT CHECK (state_reason IN ('completed', 'not_planned', 'duplicate', 'unknown'))"
export const GITHUB_METADATA_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_github_metadata (
  cache_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'draft', 'closed', 'merged')),
  state_reason ${GITHUB_STATE_REASON_COLUMN},
  fetched_at INTEGER NOT NULL,
  attempted_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS managed_github_repository_visibility (
  repo_id INTEGER PRIMARY KEY,
  github TEXT NOT NULL,
  is_public INTEGER NOT NULL CHECK (is_public IN (0, 1)),
  checked_at INTEGER NOT NULL
) STRICT;
`
// Bundles show their commit's details and tags from these tables. Readers rely
// on bundle access alone; only a GitHub read made with access fills them.
// Commits are retained without eviction. Create a bundle refreshes a
// repository's tags, which go with the repository.
export const GITHUB_COMMIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_github_commit (
  cache_key TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  author_name TEXT,
  author_login TEXT,
  authored_at INTEGER,
  committed_at INTEGER,
  fetched_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS managed_github_tag (
  repo_id INTEGER NOT NULL REFERENCES managed_selected_repo(repo_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  commit_key TEXT NOT NULL,
  PRIMARY KEY (repo_id, name)
) STRICT;
CREATE INDEX IF NOT EXISTS managed_github_tag_commit_idx ON managed_github_tag(commit_key);
`

export function githubMetadataMethods(db: ManagedSql): GithubMetadataStore {
  const list = db.prepare(`SELECT cache_key AS key, title, description, status, state_reason AS stateReason, fetched_at AS fetchedAt, attempted_at AS attemptedAt
    FROM managed_github_metadata WHERE cache_key IN (SELECT value FROM json_each(?))`)
  const set = db.prepare(`INSERT INTO managed_github_metadata (cache_key, title, description, status, state_reason, fetched_at)
    SELECT json_extract(e.value, '$.key'), json_extract(e.value, '$.title'),
      json_extract(e.value, '$.description'), json_extract(e.value, '$.status'), json_extract(e.value, '$.stateReason'),
      CAST(json_extract(e.value, '$.fetchedAt') AS BIGINT)
    FROM json_each(:contexts) e WHERE 1 = 1
    ON CONFLICT (cache_key) DO UPDATE SET title = excluded.title, description = excluded.description,
      status = excluded.status, state_reason = excluded.state_reason, fetched_at = excluded.fetched_at
    WHERE managed_github_metadata.status != 'merged' AND managed_github_metadata.fetched_at <= excluded.fetched_at`)
  // Scheduling attempts never overwrite metadata or make stale data fresh.
  // The monotonic guard preserves a newer attempt recorded by another reader.
  const attempt = db.prepare(`UPDATE managed_github_metadata SET attempted_at = ?
    WHERE cache_key IN (SELECT value FROM json_each(?)) AND (attempted_at IS NULL OR attempted_at < ?)`)
  const visibility = db.prepare(`SELECT repo_id AS repoId, github, is_public AS public, checked_at AS checkedAt
    FROM managed_github_repository_visibility WHERE repo_id IN (SELECT CAST(value AS BIGINT) FROM json_each(?))`)
  const setVisibility = db.prepare(`INSERT INTO managed_github_repository_visibility (repo_id, github, is_public, checked_at)
    SELECT CAST(json_extract(e.value, '$.repoId') AS BIGINT), json_extract(e.value, '$.github'),
      CAST(json_extract(e.value, '$.public') AS BIGINT), CAST(json_extract(e.value, '$.checkedAt') AS BIGINT)
    FROM json_each(:contexts) e WHERE 1 = 1
    ON CONFLICT (repo_id) DO UPDATE SET github = excluded.github, is_public = excluded.is_public, checked_at = excluded.checked_at
    WHERE managed_github_repository_visibility.checked_at < excluded.checked_at
      OR (managed_github_repository_visibility.checked_at = excluded.checked_at
        AND (managed_github_repository_visibility.is_public = 1 OR excluded.is_public = 0))`)
  return {
    async listGithubMetadata(keys) {
      if (keys.length === 0) return []
      const rows = await list.all(JSON.stringify(keys)) as GithubMetadata[]
      return rows.map(row => ({ ...row }))
    },
    async setGithubMetadata(entries) {
      if (entries.length > 0) await set.run({ contexts: JSON.stringify(entries) })
    },
    async recordGithubMetadataAttempts(keys, attemptedAt) {
      if (keys.length > 0) await attempt.run(attemptedAt, JSON.stringify(keys), attemptedAt)
    },
    async listGithubRepositoryVisibility(repoIds) {
      if (repoIds.length === 0) return []
      const rows = await visibility.all(JSON.stringify(repoIds)) as (Omit<GithubRepositoryVisibility, 'public'> & { public: number })[]
      return rows.map(row => ({ ...row, public: row.public === 1 }))
    },
    async setGithubRepositoryVisibility(entries) {
      if (entries.length > 0) await setVisibility.run({ contexts: JSON.stringify(entries.map(entry => ({ ...entry, public: entry.public ? 1 : 0 }))) })
    },
  }
}

export function githubCommitMethods(db: ManagedSql): GithubCommitStore {
  const commits = db.prepare(`SELECT cache_key AS key, message, author_name AS authorName, author_login AS authorLogin,
      authored_at AS authoredAt, committed_at AS committedAt, fetched_at AS fetchedAt
    FROM managed_github_commit WHERE cache_key IN (SELECT value FROM json_each(?))`)
  // Concurrent reads of one commit store the same details; the first stays.
  const setCommits = db.prepare(`INSERT INTO managed_github_commit (cache_key, message, author_name, author_login, authored_at, committed_at, fetched_at)
    SELECT json_extract(e.value, '$.key'), json_extract(e.value, '$.message'), json_extract(e.value, '$.authorName'),
      json_extract(e.value, '$.authorLogin'), CAST(json_extract(e.value, '$.authoredAt') AS BIGINT),
      CAST(json_extract(e.value, '$.committedAt') AS BIGINT), CAST(json_extract(e.value, '$.fetchedAt') AS BIGINT)
    FROM json_each(:contexts) e WHERE 1 = 1
    ON CONFLICT (cache_key) DO NOTHING`)
  const commitTags = db.prepare(`SELECT commit_key AS key, name FROM managed_github_tag
    WHERE commit_key IN (SELECT value FROM json_each(?)) ORDER BY commit_key, name`)
  const deleteTags = db.prepare('DELETE FROM managed_github_tag WHERE repo_id = ? AND name NOT IN (SELECT value FROM json_each(?))')
  const setTags = db.prepare(`INSERT INTO managed_github_tag (repo_id, name, commit_key)
    SELECT CAST(json_extract(e.value, '$.repoId') AS BIGINT), json_extract(e.value, '$.name'), json_extract(e.value, '$.key')
    FROM json_each(:contexts) e WHERE 1 = 1
    ON CONFLICT (repo_id, name) DO UPDATE SET commit_key = excluded.commit_key`)
  return {
    async listGithubCommits(keys) {
      if (keys.length === 0) return []
      const rows = await commits.all(JSON.stringify(keys)) as GithubCommit[]
      return rows.map(row => ({ ...row }))
    },
    async setGithubCommits(entries) {
      if (entries.length > 0) await setCommits.run({ contexts: JSON.stringify(entries) })
    },
    async listGithubCommitTags(keys) {
      if (keys.length === 0) return []
      const rows = await commitTags.all(JSON.stringify(keys)) as { key: string; name: string }[]
      return rows.map(row => ({ ...row }))
    },
    async refreshGithubTags(repoId, tags, complete) {
      // Postgres refuses an upsert that names one row twice.
      const unique = [...new Map(tags.map(tag => [tag.name, tag])).values()]
      if (complete) await deleteTags.run(repoId, JSON.stringify(unique.map(tag => tag.name)))
      if (unique.length > 0) {
        await setTags.run({ contexts: JSON.stringify(unique.map(tag => ({ repoId, name: tag.name, key: githubCommitKey(repoId, tag.sha) }))) })
      }
    },
  }
}
