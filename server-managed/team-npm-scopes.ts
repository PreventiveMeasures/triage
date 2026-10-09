// npm scopes a team lists: its members, whatever their role, may read that
// scope's private packages in the npm viewer (npm-packages.ts), as admins and
// managers may read any. Hidden teams grant nothing, as for their content.
import { MAX_TEAM_NPM_SCOPES, normalizeNpmScope } from '../common/managed/npm-packages.js'
import { ManagedMutationError } from './management.ts'
import type { ManagedSql } from './sql.ts'

export const TEAM_NPM_SCOPE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_team_npm_scope (
  team_id TEXT NOT NULL REFERENCES managed_team(id) ON DELETE CASCADE,
  scope   TEXT NOT NULL,
  PRIMARY KEY (team_id, scope)
) STRICT;
`

export interface TeamNpmScopeStore {
  // Every team's scopes, sorted, keyed by team id; teams without any are absent.
  listTeamNpmScopes(): Promise<Record<string, string[]>>
  // Replaces a team's scopes; admin only. Answers what changed, or null for no team.
  setTeamNpmScopes(sessionId: string, teamId: string, scopes: unknown): Promise<{ added: string[]; removed: string[] } | null>
  // The scopes a user's visible teams list.
  listUserNpmScopes(userId: string): Promise<string[]>
}

// Each distinct scope, normalized; a list with one npm could not publish
// under, or too many, is refused whole.
export function parseTeamNpmScopes(input: unknown): string[] {
  if (!Array.isArray(input)) throw new ManagedMutationError(400, 'bad-scopes')
  const scopes = new Set<string>()
  for (const value of input) {
    const scope = normalizeNpmScope(value)
    if (scope === null) throw new ManagedMutationError(400, 'bad-scope')
    scopes.add(scope)
  }
  if (scopes.size > MAX_TEAM_NPM_SCOPES) throw new ManagedMutationError(400, 'too-many-scopes')
  return [...scopes].toSorted()
}

export function teamNpmScopeMethods(db: ManagedSql): TeamNpmScopeStore {
  return {
    async listTeamNpmScopes() {
      const rows = await db.prepare('SELECT team_id AS teamId, scope FROM managed_team_npm_scope ORDER BY team_id, scope').all() as { teamId: string; scope: string }[]
      const result: Record<string, string[]> = {}
      for (const { teamId, scope } of rows) (result[teamId] ??= []).push(scope)
      return result
    },
    async setTeamNpmScopes(sessionId, teamId, input) {
      const user = await db.prepare(`SELECT u.role FROM managed_session s JOIN managed_user u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ?`).get(sessionId, Date.now()) as { role: string } | undefined
      if (!user) throw new ManagedMutationError(401, 'unauthenticated')
      if (user.role !== 'admin') throw new ManagedMutationError(403, 'forbidden')
      const scopes = parseTeamNpmScopes(input)
      if (!await db.prepare('SELECT id FROM managed_team WHERE id = ?').get(teamId)) return null
      const current = (await db.prepare('SELECT scope FROM managed_team_npm_scope WHERE team_id = ?').all(teamId) as { scope: string }[]).map(row => row.scope)
      const removed = current.filter(scope => !scopes.includes(scope)).toSorted()
      const added = scopes.filter(scope => !current.includes(scope))
      for (const scope of removed) await db.prepare('DELETE FROM managed_team_npm_scope WHERE team_id = ? AND scope = ?').run(teamId, scope)
      for (const scope of added) await db.prepare('INSERT INTO managed_team_npm_scope (team_id, scope) VALUES (?, ?)').run(teamId, scope)
      return { added, removed }
    },
    async listUserNpmScopes(userId) {
      const rows = await db.prepare(`SELECT DISTINCT ns.scope FROM managed_team_user tu
        JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
        JOIN managed_team_npm_scope ns ON ns.team_id = tu.team_id
        WHERE tu.user_id = ? ORDER BY ns.scope`).all(userId) as { scope: string }[]
      return rows.map(row => row.scope)
    },
  }
}
