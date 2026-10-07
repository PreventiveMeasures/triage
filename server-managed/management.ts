import type { AdminReport, BundleReuse, ManagedBundle, ManagedDb, ManagedRepo, RepoDataItem, RepoReportItem, ReportRecord, StoredUser } from './db-methods.ts'
import { roleAtLeast } from '../common/managed/roles.ts'

export class ManagedMutationError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export type ContentMutation = { type: 'delete' } | { type: 'repo'; repoId: number | null; directory: string } | { type: 'visibility'; visible: boolean }
export type ReportMutation = ContentMutation
type RemovalRepo = Pick<ManagedRepo, 'repoId' | 'fullName' | 'addedAt'>
type RemovalAnnotations = { reports: string; ids: string[] }
export interface ManagementStore {
  mutateReport(sessionId: string, id: string, change: ReportMutation): Promise<{ report: ReportRecord; user: StoredUser }>
  mutateBundle(sessionId: string, id: string, change: ContentMutation): Promise<{ bundle: ManagedBundle; user: StoredUser }>
  // A repeated upload/build of stored bytes (see reuseBundle). Renames need the
  // access other bundle mutations need; a server build labels the row anyway.
  reuseBundleUpload(sessionId: string, id: string, reuse: Omit<BundleReuse, 'rename'>): Promise<boolean>
  removeRepository(sessionId: string, expected: RemovalRepo, annotations: RemovalAnnotations | null): Promise<{
    reports: RepoReportItem[]; bundles: RepoDataItem[]; deletedReports: number; deletedBundles: number; deletedTriage: number
  }>
}
type ManagementDb = Pick<ManagedDb, 'sessionWithUser' | 'getReport' | 'getBundle' | 'listReports' | 'listReportsForRepo'
  | 'listBundlesForRepo' | 'listAllRepos' | 'listSelectedRepos' | 'userCanReadReport' | 'userCanReadBundle' | 'userCanReadRepoPath'
  | 'deleteReport' | 'setReportRepo' | 'setReportVisible' | 'deleteBundle' | 'setBundleRepo' | 'setBundleVisible' | 'reuseBundle'
  | 'deleteReportsForRepo' | 'deleteBundlesForRepo' | 'deleteRepo' | 'deleteTriage' | 'recordActivity'>

// Only immutable bytes/format and repository membership affect the overlap
// scan. Ignore publication, user display names, and unrelated bundle links.
export function reportReferenceSnapshot(reports: readonly Pick<AdminReport, 'id' | 'sha256' | 'filename' | 'repoId'>[]): string {
  return JSON.stringify(reports.map(r => [r.id, r.sha256, r.filename, r.repoId]).toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))))
}

// These methods are wrapped by scopeManagedMethods: authorization, comparison,
// metadata changes (and repository-removal audit) share the writer transaction. Blob reads
// and deletes stay outside it. Use the raw store here, never nested scopes.
export function managementMethods(db: ManagementDb): ManagementStore {
  async function authorize(sessionId: string, role: 'admin' | 'manage') {
    const s = await db.sessionWithUser(sessionId, Date.now())
    if (!s) throw new ManagedMutationError(401, 'unauthenticated')
    if (!roleAtLeast(s.user.role, role)) throw new ManagedMutationError(403, 'forbidden')
    return s.user
  }
  async function destination(user: { id: string; role: string }, change: ContentMutation) {
    if (change.type !== 'repo' || change.repoId === null) return
    if (!(await db.listSelectedRepos()).some(repo => repo.repoId === change.repoId)) throw new ManagedMutationError(400, 'bad-repo')
    if (user.role !== 'admin' && !await db.userCanReadRepoPath(user.id, change.repoId, change.directory)) throw new ManagedMutationError(403, 'repo-forbidden')
  }
  return {
    async mutateReport(sessionId: string, id: string, change: ReportMutation) {
      const user = await authorize(sessionId, 'manage')
      const report = await db.getReport(id)
      if (!report || (user.role !== 'admin' && report.uploadedBy !== user.id && !await db.userCanReadReport(user.id, id))) throw new ManagedMutationError(404, 'no-report')
      if (user.role !== 'admin' && report.repoId !== null && !await db.userCanReadReport(user.id, id)) throw new ManagedMutationError(403, 'repo-forbidden')
      if (change.type === 'repo' && report.repoEmbedded) throw new ManagedMutationError(409, 'repo-in-report')
      if (change.type !== 'visibility') await destination(user, change)
      if (change.type === 'delete') await db.deleteReport(id)
      else if (change.type === 'visibility') await db.setReportVisible(id, change.visible)
      else await db.setReportRepo(id, change.repoId, change.directory)
      return { report, user }
    },
    async mutateBundle(sessionId: string, id: string, change: ContentMutation) {
      const user = await authorize(sessionId, 'manage')
      const bundle = await db.getBundle(id)
      if (!bundle || (user.role !== 'admin' && !await db.userCanReadBundle(user.id, id))) throw new ManagedMutationError(404, 'no-bundle')
      if (user.role !== 'admin' && bundle.repoId !== null && !await db.userCanReadRepoPath(user.id, bundle.repoId, bundle.repoDirectory)) throw new ManagedMutationError(403, 'repo-forbidden')
      await destination(user, change)
      if (change.type === 'delete') await db.deleteBundle(id)
      else if (change.type === 'visibility') await db.setBundleVisible(id, change.visible)
      else await db.setBundleRepo(id, change.repoId, change.directory)
      return { bundle, user }
    },
    async reuseBundleUpload(sessionId: string, id: string, reuse: Omit<BundleReuse, 'rename'>) {
      const user = await authorize(sessionId, 'manage')
      const bundle = await db.getBundle(id)
      if (!bundle) return false
      const rename = user.role === 'admin' || (await db.userCanReadBundle(user.id, id)
        && (bundle.repoId === null || await db.userCanReadRepoPath(user.id, bundle.repoId, bundle.repoDirectory)))
      if (!rename && reuse.provenance !== 'build') return false
      return db.reuseBundle(id, { ...reuse, rename })
    },
    async removeRepository(sessionId: string, expected: RemovalRepo, annotations: RemovalAnnotations | null) {
      const user = await authorize(sessionId, 'admin')
      const repo = (await db.listAllRepos()).find(r => r.repoId === expected.repoId)
      if (!repo) throw new ManagedMutationError(404, 'no-repo')
      if (repo.fullName !== expected.fullName || repo.addedAt !== expected.addedAt) throw new ManagedMutationError(409, 'repository-changed')
      if (annotations && reportReferenceSnapshot(await db.listReports()) !== annotations.reports) throw new ManagedMutationError(409, 'repository-changed')
      const reports = await db.listReportsForRepo(repo.repoId)
      const bundles = await db.listBundlesForRepo(repo.repoId)
      const deletedReports = await db.deleteReportsForRepo(repo.repoId)
      const deletedBundles = await db.deleteBundlesForRepo(repo.repoId)
      const deletedTriage = await db.deleteTriage(annotations?.ids ?? [])
      await db.deleteRepo(repo.repoId)
      await db.recordActivity({ kind: 'delete', actor: user.login, actorId: user.id, repo: repo.fullName,
        action: `removed a repository (${deletedReports} reports, ${deletedBundles} bundles, ${deletedTriage} triage entries)` }, Date.now())
      return { reports, bundles, deletedReports, deletedBundles, deletedTriage }
    },
  }
}
