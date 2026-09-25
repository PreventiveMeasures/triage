import type { ManagedDb, StoredUser } from './db.ts'

export type RepoScope = { repoId: number; path: string | null }
type Content = { repoId: number | null; repoDirectory?: string }

// Read grants for each request: neither the manager role nor a cached page
// confers repository access. Bundles have repository scope; reports also have
// a directory scope. Unassigned content is only available to administrators.
export async function contentAccess(db: ManagedDb, user: StoredUser) {
  const scopes = user.role === 'admin' ? null : await db.listRepoScopesForUser(user.id)
  const bundle = (item: Content) => scopes == null || scopes.some(scope => scope.repoId === item.repoId)
  const report = (item: Content) => scopes == null || scopes.some(scope => scope.repoId === item.repoId
    && (!scope.path || item.repoDirectory === scope.path || item.repoDirectory?.startsWith(scope.path + '/')))
  return { scopes, bundle, report }
}
