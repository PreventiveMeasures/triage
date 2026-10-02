import { roleAtLeast } from '../common/managed/roles.ts'
import { type RepoScope, contentAccess } from './content-access.ts'
import type { AdminBundle, AdminReport, ManagedDb } from './db-methods.ts'
import { ManagedMutationError } from './management.ts'

type CatalogAccess = { repos: { repoId: number; fullName: string }[]; repoScopes: RepoScope[] | null }
export interface ManagementCatalogStore {
  getReportCatalog(sessionId: string, now: number): Promise<CatalogAccess & { reports: (AdminReport & { canChangeRepo: boolean })[] }>
  getBundleCatalog(sessionId: string, now: number): Promise<CatalogAccess & { bundles: (AdminBundle & { canChangeRepo: boolean })[] }>
}
type CatalogDb = Pick<ManagedDb, 'getReportAccessSnapshot' | 'listRepoScopesForUser' | 'listSelectedRepos'
  | 'listReports' | 'listBundles' | 'listReadableBundleIds'>

// The outer store method owns one read snapshot. Use raw methods here so the
// session, grants, rows and action flags agree without per-row transactions.
export function managementCatalogMethods(db: CatalogDb): ManagementCatalogStore {
  async function access(sessionId: string, now: number) {
    const snapshot = await db.getReportAccessSnapshot(sessionId, now, [])
    if (!snapshot) throw new ManagedMutationError(401, 'unauthenticated')
    if (!roleAtLeast(snapshot.user.role, 'manage')) throw new ManagedMutationError(403, 'forbidden')
    const scope = await contentAccess(db, snapshot.user)
    const repos = (await db.listSelectedRepos()).filter(scope.bundle).map(({ repoId, fullName }) => ({ repoId, fullName }))
    return { userId: snapshot.user.role === 'admin' ? undefined : snapshot.user.id, scope, repos }
  }
  return {
    async getReportCatalog(sessionId, now) {
      const { userId, scope, repos } = await access(sessionId, now)
      const reports = await db.listReports(userId)
      const linked = reports.flatMap(report => report.bundleId ? [report.bundleId] : [])
      const readable = userId === undefined ? new Set(linked) : new Set(await db.listReadableBundleIds(userId, linked))
      return { repos, repoScopes: scope.scopes, reports: reports.map(report => ({ ...report,
        canChangeRepo: report.repoId === null || scope.report(report),
        bundleId: report.bundleId && readable.has(report.bundleId) ? report.bundleId : null,
        bundleFilename: report.bundleId && readable.has(report.bundleId) ? report.bundleFilename : null,
      })) }
    },
    async getBundleCatalog(sessionId, now) {
      const { userId, scope, repos } = await access(sessionId, now)
      const bundles = await db.listBundles(userId)
      return { repos, repoScopes: scope.scopes, bundles: bundles.map(bundle => ({ ...bundle,
        canChangeRepo: bundle.repoId === null || scope.report(bundle),
      })) }
    },
  }
}
