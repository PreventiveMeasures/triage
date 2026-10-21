import { createHash } from 'node:crypto'
import type { ManagedSql } from './sql.ts'

// Each team's catalog summary (team-app.ts), kept for every instance: working
// one out builds the team's whole workspace, which an instance would otherwise
// do for the first catalog it serves. Keyed by the catalog's own content key
// (team-app.ts teamAppKey), hashed: the published reports, their content and
// what the reader is allowed of each (its role, its dependency and security
// permissions, the team's scopes and links), so readers whose workspaces
// differ never share one. A change to any of them is a new key, as is a new
// deployment; one no longer asked for goes once it is old (index.ts reap).
export const TEAM_APP_SUMMARY_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_team_app_summary (
  summary_key TEXT PRIMARY KEY,
  summary     TEXT NOT NULL,
  stored_at   INTEGER NOT NULL
) STRICT;
`

export interface TeamAppSummaryStore {
  // Hashed key (teamAppSummaryKey) → summary for those of `keys` kept.
  getTeamAppSummaries(keys: string[]): Promise<Map<string, string>>
  setTeamAppSummary(key: string, summary: string, storedAt: number): Promise<void>
  // Removes those stored before `before`; how many.
  deleteTeamAppSummaries(before: number): Promise<number>
}

// How a summary is worked out (common/workspace-app.js, team-app.js), which a
// deployment may change: one stored by another deployment, or before this
// is raised, is worked out again.
const SUMMARY_VERSION = 1
const DEPLOYMENT = process.env['VERCEL_DEPLOYMENT_ID'] ?? null

export const teamAppSummaryKey = (key: string): string => createHash('sha256').update(JSON.stringify([SUMMARY_VERSION, DEPLOYMENT, key])).digest('base64url')

export function teamAppSummaryMethods(db: ManagedSql): TeamAppSummaryStore {
  const getMany = db.prepare('SELECT summary_key, summary FROM managed_team_app_summary WHERE summary_key IN (SELECT value FROM json_each(?))')
  const set = db.prepare(`INSERT INTO managed_team_app_summary (summary_key, summary, stored_at) VALUES (?, ?, ?)
    ON CONFLICT (summary_key) DO UPDATE SET summary = excluded.summary, stored_at = excluded.stored_at`)
  const remove = db.prepare('DELETE FROM managed_team_app_summary WHERE stored_at < ?')
  return {
    async getTeamAppSummaries(keys) {
      if (keys.length === 0) return new Map()
      const rows = await getMany.all(JSON.stringify(keys)) as { summary_key: string; summary: string }[]
      return new Map(rows.map(row => [row.summary_key, row.summary]))
    },
    async setTeamAppSummary(key, summary, storedAt) {
      await set.run(key, summary, storedAt)
    },
    async deleteTeamAppSummaries(before) {
      return Number((await remove.run(before)).changes)
    },
  }
}
