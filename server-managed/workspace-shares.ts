import type { ManagedSql } from './sql.ts'
import type { ManagedBundle, TeamReportAccessSnapshot, UserTeam } from './db.ts'

export const WORKSPACE_SHARE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_workspace_share (
  token_hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES managed_team(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES managed_user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS managed_workspace_share_team_idx ON managed_workspace_share(team_id);
`

export interface WorkspaceShareSnapshot extends TeamReportAccessSnapshot {
  team: UserTeam
  repositories: { repoId: number; github: string; path: string }[]
  bundles: ManagedBundle[]
}
export interface WorkspaceShareStore {
  createWorkspaceShare(sessionId: string, now: number, teamId: string, tokenHash: string): Promise<boolean>
  revokeWorkspaceShares(sessionId: string, now: number, teamId: string): Promise<boolean>
  getWorkspaceShare(tokenHash: string): Promise<WorkspaceShareSnapshot | null>
}

// A share is a capability, never a user session. Its issuer must still manage
// this team on every read. No union of the issuer's other memberships applies.
export function workspaceShareMethods(db: ManagedSql): WorkspaceShareStore {
  const manager = db.prepare(`SELECT 1 FROM managed_session s
    JOIN managed_user u ON u.id = s.user_id
    JOIN managed_team_user tu ON tu.user_id = u.id
    WHERE s.id = ? AND s.expires_at > ? AND tu.team_id = ? AND u.role IN ('manage', 'admin')`)
  const insert = db.prepare(`INSERT INTO managed_workspace_share (token_hash, team_id, created_by, created_at)
    SELECT ?, ?, user_id, ? FROM managed_session WHERE id = ?`)
  const remove = db.prepare('DELETE FROM managed_workspace_share WHERE team_id = ?')
  const share = db.prepare(`SELECT t.id, t.slug, t.name FROM managed_workspace_share s
    JOIN managed_user u ON u.id = s.created_by
    JOIN managed_team_user tu ON tu.user_id = u.id AND tu.team_id = s.team_id
    JOIN managed_team t ON t.id = s.team_id
    WHERE s.token_hash = ? AND u.role IN ('manage', 'admin')`)
  const repositories = db.prepare(`SELECT tr.repo_id AS repoId, sr.full_name AS github, tr.path
    FROM managed_team_repo tr JOIN managed_selected_repo sr ON sr.repo_id = tr.repo_id
    WHERE tr.team_id = ? ORDER BY tr.repo_id, tr.path`)
  const reports = db.prepare(`SELECT DISTINCT r.id, r.slug, r.filename, r.byte_size AS byteSize,
    r.sha256, r.repo_directory AS directory, sr.full_name AS github
    FROM managed_team_repo tr JOIN managed_report r ON r.repo_id = tr.repo_id
    JOIN managed_selected_repo sr ON sr.repo_id = r.repo_id
    WHERE tr.team_id = ? AND r.visible = 1 AND (tr.path = '' OR r.repo_directory = tr.path
      OR substr(r.repo_directory, 1, length(tr.path) + 1) = tr.path || '/') ORDER BY r.id`)
  // Raw bundles cover a whole repository. Directory-only grants expose cited
  // source files through the report endpoint, never the entire archive.
  const bundles = db.prepare(`SELECT DISTINCT b.id, b.integrity, b.filename, b.kind, b.byte_size AS byteSize,
    b.uploaded_by AS uploadedBy, b.repo_id AS repoId, b.uploaded_at AS uploadedAt, sr.full_name AS repoFullName
    FROM managed_team_repo tr JOIN managed_bundle b ON b.repo_id = tr.repo_id
    JOIN managed_selected_repo sr ON sr.repo_id = b.repo_id
    WHERE tr.team_id = ? AND tr.path = '' ORDER BY b.id`)
  return {
    async createWorkspaceShare(sessionId, now, teamId, tokenHash) {
      if (!await manager.get(sessionId, now, teamId)) return false
      await insert.run(tokenHash, teamId, now, sessionId)
      return true
    },
    async revokeWorkspaceShares(sessionId, now, teamId) {
      if (!await manager.get(sessionId, now, teamId)) return false
      await remove.run(teamId)
      return true
    },
    async getWorkspaceShare(tokenHash) {
      const team = await share.get(tokenHash) as { id: string; slug: string; name: string } | undefined
      if (!team) return null
      const rows = await reports.all(team.id) as { id: string; slug: string; filename: string; byteSize: number; sha256: string; directory: string; github: string }[]
      const bundleRows = await bundles.all(team.id) as (ManagedBundle & { repoFullName: string })[]
      return {
        user: { id: `share:${tokenHash}`, login: 'public', name: 'Public workspace', avatarUrl: null, role: 'view' },
        teamId: team.id,
        repositories: await repositories.all(team.id) as WorkspaceShareSnapshot['repositories'],
        reports: rows.map(row => ({ id: row.id, filename: row.filename, byteSize: row.byteSize, sha256: row.sha256,
          repo: { github: row.github, directory: row.directory }, permissions: { dependencies: true, security: true } })),
        team: { ...team,
          reports: rows.map(row => ({ id: row.id, slug: row.slug, filename: row.filename,
            cacheKey: JSON.stringify([row.sha256, row.github, row.directory, row.filename]) })),
          bundles: bundleRows.map(row => ({ id: row.id, filename: row.filename, repoFullName: row.repoFullName })),
        },
        bundles: bundleRows,
      }
    },
  }
}
