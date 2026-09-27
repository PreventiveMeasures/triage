import type { ManagedSql } from './sql.ts'
import type { ManagedBundle, TeamReportAccessSnapshot, UserTeam } from './db.ts'
import { type TeamUserPermissions, parseTeamUserPermissions } from '../common/managed/permissions.ts'

export const WORKSPACE_SHARE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_workspace_share (
  token_hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES managed_team(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES managed_user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  dependencies INTEGER NOT NULL DEFAULT 0,
  security INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS managed_workspace_share_team_idx ON managed_workspace_share(team_id);
`

export interface WorkspaceShareSnapshot extends TeamReportAccessSnapshot {
  team: UserTeam
  permissions: TeamUserPermissions
  repositories: { repoId: number; github: string; path: string }[]
  bundles: ManagedBundle[]
}
export interface WorkspaceShareInfo {
  id: string
  createdAt: number
  createdBy: string
  permissions: TeamUserPermissions
}
export interface ManagedWorkspaceShare extends WorkspaceShareInfo {
  teamId: string
  teamName: string
  teamSlug: string
}
export interface WorkspaceShareStore {
  createWorkspaceShare(sessionId: string, now: number, teamId: string, tokenHash: string, permissions?: TeamUserPermissions): Promise<boolean>
  listWorkspaceShares(sessionId: string, now: number, teamId: string): Promise<WorkspaceShareInfo[] | null>
  listManagedWorkspaceShares(sessionId: string, now: number): Promise<ManagedWorkspaceShare[] | null>
  updateWorkspaceShare(sessionId: string, now: number, teamId: string, id: string, permissions: TeamUserPermissions): Promise<boolean>
  revokeWorkspaceShares(sessionId: string, now: number, teamId: string, id?: string): Promise<boolean>
  getWorkspaceShare(tokenHash: string): Promise<WorkspaceShareSnapshot | null>
}

// A share is a capability, never a user session. Its issuer must still manage
// this team on every read. No union of the issuer's other memberships applies.
function shareQueries(db: ManagedSql) {
  const manager = db.prepare(`SELECT 1 FROM managed_session s
    JOIN managed_user u ON u.id = s.user_id
    JOIN managed_team t ON t.id = ?
    WHERE s.id = ? AND s.expires_at > ? AND (u.role = 'admin' OR (u.role = 'manage'
      AND EXISTS (SELECT 1 FROM managed_team_user tu WHERE tu.user_id = u.id AND tu.team_id = t.id)))`)
  const insert = db.prepare(`INSERT INTO managed_workspace_share (token_hash, team_id, created_by, created_at, dependencies, security)
    SELECT ?, ?, user_id, ?, ?, ? FROM managed_session WHERE id = ?`)
  const remove = db.prepare('DELETE FROM managed_workspace_share WHERE team_id = ? AND (CAST(? AS TEXT) IS NULL OR token_hash = ?)')
  const update = db.prepare('UPDATE managed_workspace_share SET dependencies = ?, security = ? WHERE team_id = ? AND token_hash = ?')
  // The management ID is a hash, never a bearer token. Existing URLs remain
  // unchanged when their permissions are edited; plaintext tokens aren't kept.
  const list = db.prepare(`SELECT s.token_hash AS id, s.created_at AS createdAt, u.login AS createdBy, s.dependencies, s.security
    FROM managed_workspace_share s JOIN managed_user u ON u.id = s.created_by WHERE s.team_id = ? ORDER BY s.created_at DESC, s.token_hash`)
  const session = db.prepare(`SELECT u.id, u.role FROM managed_session s JOIN managed_user u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ? AND u.role IN ('manage', 'admin')`)
  const all = db.prepare(`SELECT s.token_hash AS id, s.created_at AS createdAt, u.login AS createdBy, s.dependencies, s.security,
    t.id AS teamId, t.slug AS teamSlug, t.name AS teamName FROM managed_workspace_share s
    JOIN managed_user u ON u.id = s.created_by JOIN managed_team t ON t.id = s.team_id
    WHERE ? = 'admin' OR EXISTS (SELECT 1 FROM managed_team_user tu WHERE tu.user_id = ? AND tu.team_id = s.team_id)
    ORDER BY t.name, t.id, s.created_at DESC, s.token_hash`)
  const share = db.prepare(`SELECT t.id, t.slug, t.name, s.dependencies, s.security FROM managed_workspace_share s
    JOIN managed_user u ON u.id = s.created_by
    JOIN managed_team t ON t.id = s.team_id
    WHERE s.token_hash = ? AND (u.role = 'admin' OR (u.role = 'manage'
      AND EXISTS (SELECT 1 FROM managed_team_user tu WHERE tu.user_id = u.id AND tu.team_id = s.team_id)))`)
  const repositories = db.prepare(`SELECT tr.repo_id AS repoId, sr.full_name AS github, tr.path
    FROM managed_team_repo tr JOIN managed_selected_repo sr ON sr.repo_id = tr.repo_id
    WHERE tr.team_id = ? ORDER BY tr.repo_id, tr.path`)
  const reports = db.prepare(`SELECT DISTINCT r.id, r.slug, r.filename, r.byte_size AS byteSize,
    r.sha256, r.repo_directory AS directory, sr.full_name AS github
    FROM managed_team_repo tr JOIN managed_report r ON r.repo_id = tr.repo_id
    JOIN managed_selected_repo sr ON sr.repo_id = r.repo_id
    WHERE tr.team_id = ? AND r.visible = 1 AND (tr.path = '' OR r.repo_directory = tr.path
      OR substr(r.repo_directory, 1, length(tr.path) + 1) = tr.path || '/') ORDER BY r.id`)
  // A raw bundle is visible only when its declared root is inside the team scope.
  // Root bundles remain hidden from directory-only grants.
  const bundles = db.prepare(`SELECT DISTINCT b.id, b.slug, b.integrity, b.filename, b.kind, b.byte_size AS byteSize,
    b.uploaded_by AS uploadedBy, b.repo_id AS repoId, b.repo_directory AS repoDirectory, b.uploaded_at AS uploadedAt, sr.full_name AS repoFullName
    FROM managed_team_repo tr JOIN managed_bundle b ON b.repo_id = tr.repo_id
    JOIN managed_selected_repo sr ON sr.repo_id = b.repo_id
    WHERE tr.team_id = ? AND (tr.path = '' OR b.repo_directory = tr.path
      OR substr(b.repo_directory, 1, length(tr.path) + 1) = tr.path || '/') ORDER BY b.id`)
  return { manager, insert, remove, update, list, session, all, share, repositories, reports, bundles }
}

function shareInfo<T extends { dependencies: number; security: number }>(row: T) {
  const { dependencies, security, ...rest } = row
  return { ...rest, permissions: { dependencies: dependencies === 1, security: security === 1 } }
}

export function workspaceShareMethods(db: ManagedSql): WorkspaceShareStore {
  const q = shareQueries(db)
  return {
    async createWorkspaceShare(sessionId, now, teamId, tokenHash, permissions) {
      if (!await q.manager.get(teamId, sessionId, now)) return false
      const p = parseTeamUserPermissions(permissions)
      await q.insert.run(tokenHash, teamId, now, +p.dependencies, +p.security, sessionId)
      return true
    },
    async listWorkspaceShares(sessionId, now, teamId) {
      if (!await q.manager.get(teamId, sessionId, now)) return null
      const rows = await q.list.all(teamId) as { id: string; createdAt: number; createdBy: string; dependencies: number; security: number }[]
      return rows.map(shareInfo)
    },
    async listManagedWorkspaceShares(sessionId, now) {
      const viewer = await q.session.get(sessionId, now) as { id: string; role: string } | undefined
      if (!viewer) return null
      const rows = await q.all.all(viewer.role, viewer.id) as (Omit<ManagedWorkspaceShare, 'permissions'> & { dependencies: number; security: number })[]
      return rows.map(shareInfo)
    },
    async updateWorkspaceShare(sessionId, now, teamId, id, permissions) {
      if (!await q.manager.get(teamId, sessionId, now)) return false
      const p = parseTeamUserPermissions(permissions)
      return (await q.update.run(+p.dependencies, +p.security, teamId, id)).changes > 0
    },
    async revokeWorkspaceShares(sessionId, now, teamId, id) {
      if (!await q.manager.get(teamId, sessionId, now)) return false
      const result = await q.remove.run(teamId, id ?? null, id ?? null)
      return id === undefined || result.changes > 0
    },
    async getWorkspaceShare(tokenHash) {
      const grant = await q.share.get(tokenHash) as { id: string; slug: string; name: string; dependencies: number; security: number } | undefined
      if (!grant) return null
      const { dependencies, security, ...team } = grant
      const permissions = { dependencies: dependencies === 1, security: security === 1 }
      const rows = await q.reports.all(team.id) as { id: string; slug: string; filename: string; byteSize: number; sha256: string; directory: string; github: string }[]
      const bundleRows = await q.bundles.all(team.id) as (ManagedBundle & { repoFullName: string })[]
      return {
        user: { id: `share:${tokenHash}`, login: 'public', name: 'Public workspace', avatarUrl: null, role: 'view' },
        teamId: team.id,
        permissions,
        repositories: await q.repositories.all(team.id) as WorkspaceShareSnapshot['repositories'],
        reports: rows.map(row => ({ id: row.id, filename: row.filename, byteSize: row.byteSize, sha256: row.sha256,
          repo: { github: row.github, directory: row.directory }, permissions })),
        team: { ...team,
          reports: rows.map(row => ({ id: row.id, slug: row.slug, filename: row.filename, repoFullName: row.github, repoDirectory: row.directory,
            cacheKey: JSON.stringify([row.sha256, row.github, row.directory, row.filename, permissions]) })),
          bundles: bundleRows.map(row => ({ id: row.id, slug: row.slug, integrity: row.integrity,
            filename: row.filename, byteSize: row.byteSize, repoId: row.repoId!, repoDirectory: row.repoDirectory, repoFullName: row.repoFullName })),
        },
        bundles: bundleRows,
      }
    },
  }
}
