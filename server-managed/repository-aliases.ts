import { randomUUID } from 'node:crypto'
import { reportRepoGithub } from '@preventive/report'
import { type RepositoryAliasInput, matchRepositoryAlias, repositoryAliasNeedsFilePrefix } from '../common/managed/repository-alias.ts'
import type { ManagedDb } from './db.ts'
import { ManagedMutationError } from './management.ts'
import { normalizeTeamPath } from './repo-path.ts'
import type { ManagedSql } from './sql.ts'

export const REPOSITORY_ALIAS_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_repository_alias (
  id TEXT PRIMARY KEY,
  old_repo TEXT NOT NULL,
  old_path TEXT NOT NULL DEFAULT '',
  repo_id INTEGER NOT NULL REFERENCES managed_selected_repo(repo_id) ON DELETE CASCADE,
  new_path TEXT NOT NULL DEFAULT '',
  UNIQUE(old_repo, old_path)
) STRICT;
`
export interface RepositoryAlias extends RepositoryAliasInput { id: string }
export interface RepositoryAliasStore {
  listRepositoryAliases(): Promise<RepositoryAlias[]>
  saveRepositoryAlias(sessionId: string, id: string | null, input: unknown): Promise<RepositoryAlias>
  deleteRepositoryAlias(sessionId: string, id: string): Promise<void>
  getRepositoryImportLocation(github: string, directory: string, filePrefix?: string): Promise<{ repoId: number | null; directory: string }>
}

// Keep expensive inventory reads outside database transactions and skip them
// unless a currently connected alias can use the bundle's existing paths.
export async function resolveRepositoryImportLocation(db: ManagedDb, github: string, directory: string, loadFilePrefix: () => Promise<string>) {
  const aliases = await db.listRepositoryAliases()
  let filePrefix = ''
  if (repositoryAliasNeedsFilePrefix(github, directory, aliases)) {
    const active = new Set((await db.listSelectedRepos()).map(repo => repo.repoId))
    if (repositoryAliasNeedsFilePrefix(github, directory, aliases.filter(alias => active.has(alias.repoId)))) filePrefix = await loadFilePrefix()
  }
  return db.getRepositoryImportLocation(github, directory, filePrefix)
}

function parseAlias(input: unknown): RepositoryAliasInput {
  if (!input || typeof input !== 'object') throw new ManagedMutationError(400, 'bad-alias')
  const { oldRepo, oldPath, repoId, newPath } = input as RepositoryAliasInput
  const github = typeof oldRepo === 'string' ? reportRepoGithub({ repo: { github: oldRepo.trim() } }) : null
  if (!github) throw new ManagedMutationError(400, 'bad-old-repo')
  if (typeof oldPath !== 'string' || typeof newPath !== 'string') throw new ManagedMutationError(400, 'bad-directory')
  const old = normalizeTeamPath(oldPath), target = normalizeTeamPath(newPath)
  if (!old.ok || !target.ok) throw new ManagedMutationError(400, 'bad-directory')
  if (!Number.isSafeInteger(repoId) || repoId <= 0) throw new ManagedMutationError(400, 'bad-repo')
  return { oldRepo: github.toLowerCase(), oldPath: old.path ?? '', repoId, newPath: target.path ?? '' }
}

export function repositoryAliasMethods(db: ManagedSql): RepositoryAliasStore {
  async function authorize(sessionId: string) {
    const user = await db.prepare(`SELECT u.role FROM managed_session s JOIN managed_user u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`).get(sessionId, Date.now()) as { role: string } | undefined
    if (!user) throw new ManagedMutationError(401, 'unauthenticated')
    if (user.role !== 'admin') throw new ManagedMutationError(403, 'forbidden')
  }
  async function listRepositoryAliases() {
    return await db.prepare(`SELECT id, old_repo AS oldRepo, old_path AS oldPath, repo_id AS repoId, new_path AS newPath
      FROM managed_repository_alias ORDER BY old_repo, old_path, id`).all() as RepositoryAlias[]
  }
  return {
    listRepositoryAliases,
    async saveRepositoryAlias(sessionId, id, input) {
      await authorize(sessionId)
      const alias = parseAlias(input)
      if (!await db.prepare('SELECT repo_id FROM managed_selected_repo WHERE repo_id = ? AND active = 1').get(alias.repoId)) throw new ManagedMutationError(400, 'bad-repo')
      if (id && !await db.prepare('SELECT id FROM managed_repository_alias WHERE id = ?').get(id)) throw new ManagedMutationError(404, 'no-alias')
      const duplicate = await db.prepare('SELECT id FROM managed_repository_alias WHERE old_repo = ? AND old_path = ?').get(alias.oldRepo, alias.oldPath) as { id: string } | undefined
      if (duplicate && duplicate.id !== id) throw new ManagedMutationError(409, 'alias-exists')
      const key = id ?? randomUUID()
      await db.prepare(`INSERT INTO managed_repository_alias (id, old_repo, old_path, repo_id, new_path) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET old_repo = excluded.old_repo, old_path = excluded.old_path, repo_id = excluded.repo_id, new_path = excluded.new_path`)
        .run(key, alias.oldRepo, alias.oldPath, alias.repoId, alias.newPath)
      return { id: key, ...alias }
    },
    async deleteRepositoryAlias(sessionId, id) {
      await authorize(sessionId)
      if (!(await db.prepare('DELETE FROM managed_repository_alias WHERE id = ?').run(id)).changes) throw new ManagedMutationError(404, 'no-alias')
    },
    async getRepositoryImportLocation(github, directory, filePrefix = '') {
      const alias = matchRepositoryAlias(github, directory, await listRepositoryAliases(), filePrefix)
      const normalized = normalizeTeamPath(alias?.directory ?? directory)
      if (!normalized.ok) throw new ManagedMutationError(400, 'bad-directory')
      const repo = await (alias
        ? db.prepare('SELECT repo_id AS repoId FROM managed_selected_repo WHERE active = 1 AND repo_id = ?').get(alias.repoId)
        : db.prepare('SELECT repo_id AS repoId FROM managed_selected_repo WHERE active = 1 AND LOWER(full_name) = ?').get(github.toLowerCase())) as { repoId: number } | undefined
      return { repoId: repo?.repoId ?? null, directory: normalized.path ?? '' }
    },
  }
}
