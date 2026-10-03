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
export interface GithubMetadataStore {
  listGithubMetadata(keys: readonly string[]): Promise<GithubMetadata[]>
  setGithubMetadata(entries: readonly Omit<GithubMetadata, 'attemptedAt'>[]): Promise<void>
  recordGithubMetadataAttempts(keys: readonly string[], attemptedAt: number): Promise<void>
  listGithubRepositoryVisibility(repoIds: readonly number[]): Promise<GithubRepositoryVisibility[]>
  setGithubRepositoryVisibility(entries: readonly GithubRepositoryVisibility[]): Promise<void>
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
