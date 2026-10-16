// A connected repository's dependency review, as an admin sets it, and the
// reviews that pass its pull requests' dependencies (pull-dependency-reviews.ts).
// Enabled, each package version its open pull requests' lockfiles lock needs
// as many published reviews as `required`; those its lockfiles locked at
// `since`, a commit (null for none), none. It is in effect only where a team
// that reviews dependencies has the repository, which is where reviews that
// count are published: by its reviewers, full (every file checked; a partial
// review counts for nothing yet), accepting (Accept, or Accept with nits),
// and neither revoked.
import type { ManagedSql } from './sql.ts'
import { reviewsIn } from './dependency-reviews.ts'
import { type ReviewVerdict, summarizeReview } from '../common/dependency-reviews.js'

export const REPOSITORY_DEPENDENCY_REVIEW_COLUMNS = [['dependency_review', 'INTEGER NOT NULL DEFAULT 0'],
  ['dependency_reviews_required', 'INTEGER NOT NULL DEFAULT 1'], ['dependency_review_since', 'TEXT']] as const
export const MAX_REQUIRED_REVIEWS = 10
export const SINCE_COMMIT = /^[a-f\d]{40}$/u

export interface RepoDependencyReview { enabled: boolean; required: number; since: string | null }
// A review that passes the version it is of: its package, version and npm's
// integrity of it, the version it was compared with (none for a whole
// package's), and who wrote it (`reviewer`, their id, else their login then).
export interface PassingReview { package: string; version: string; integrity: string; basePackage: string | null; baseVersion: string | null; reviewer: string }
// A repository's review in effect for a reader: its settings, whether they
// publish reviews to one of the teams that count (`canReview`), and the
// passing reviews of the packages asked.
export interface RepoReviewState extends Omit<RepoDependencyReview, 'enabled'> { canReview: boolean; reviews: PassingReview[] }

export interface RepositoryDependencyReviewStore {
  listRepoDependencyReviews(): Promise<Map<number, RepoDependencyReview>>
  // Sets a repository's review, its commit too but where `since` is
  // undefined, which keeps it; the setting then, or null for no repository.
  setRepoDependencyReview(repoId: number, setting: Omit<RepoDependencyReview, 'since'> & { since?: string | null }): Promise<RepoDependencyReview | null>
  repoDependencyReviewState(repoId: number, user: string, packages: string[]): Promise<RepoReviewState | null>
}

type SettingRow = { repoId: number; enabled: number; required: number; since: string | null }
const setting = (row: SettingRow): RepoDependencyReview => ({ enabled: row.enabled === 1, required: row.required, since: row.since })
// Teams whose published reviews count for repository `?`: that review
// dependencies and have it, not hidden.
const COUNTING_TEAM = `t.hidden = 0 AND t.dependency_review = 1 AND EXISTS (
  SELECT 1 FROM managed_team_repo tr WHERE tr.team_id = t.id AND tr.repo_id = ?)`
const PACKAGES_AT_ONCE = 500

// The full, accepting, published and unrevoked reviews of `packages` in teams
// counting for repository `repoId`, a few hundred packages a query.
async function passingReviews(db: ManagedSql, repoId: number, packages: string[]): Promise<PassingReview[]> {
  const found: PassingReview[] = []
  for (let at = 0; at < packages.length; at += PACKAGES_AT_ONCE) {
    const names = packages.slice(at, at + PACKAGES_AT_ONCE)
    const rows = await db.prepare(`SELECT r.id, r.user_id AS userId, r.user_login AS userLogin, r.package, r.version, r.integrity,
        NULLIF(r.base_package, '') AS basePackage, NULLIF(r.base_version, '') AS baseVersion, r.files
      FROM managed_dependency_review r
      WHERE r.ecosystem = 'npm' AND r.published_at IS NOT NULL AND r.revoked_at IS NULL AND r.status IN ('accept', 'accept-with-nits')
        AND r.package IN (${names.map(() => '?').join(',')})
        AND EXISTS (SELECT 1 FROM managed_dependency_review_team rt JOIN managed_team t ON t.id = rt.team_id
          WHERE rt.review_id = r.id AND ${COUNTING_TEAM})`).all(...names, repoId) as
      { id: string; userId: string | null; userLogin: string; package: string; version: string; integrity: string
        basePackage: string | null; baseVersion: string | null; files: string | null }[]
    if (rows.length === 0) continue
    const entries = await db.prepare(`SELECT review_id AS reviewId, file, status FROM managed_dependency_file_review
      WHERE review_id IN (${rows.map(() => '?').join(',')})`).all(...rows.map(row => row.id)) as { reviewId: string; file: string; status: ReviewVerdict | null }[]
    for (const row of rows) {
      const snapshot = row.files === null ? null : JSON.parse(row.files) as string[] | { paths: string[]; nonTextFiles: string[] }
      // A snapshot of paths alone, before non-text files were told, can't be full.
      const files = Array.isArray(snapshot) ? snapshot : snapshot?.paths ?? null
      const nonText = Array.isArray(snapshot) ? null : snapshot?.nonTextFiles ?? []
      if (summarizeReview(entries.filter(entry => entry.reviewId === row.id), files, nonText).coverage !== 'full') continue
      found.push({ package: row.package, version: row.version, integrity: row.integrity, basePackage: row.basePackage, baseVersion: row.baseVersion,
        reviewer: row.userId ?? `login:${row.userLogin}` })
    }
  }
  return found
}

export function repositoryDependencyReviewMethods(db: ManagedSql): RepositoryDependencyReviewStore {
  const columns = `repo_id AS repoId, dependency_review AS enabled, dependency_reviews_required AS required, dependency_review_since AS since`
  return {
    async listRepoDependencyReviews() {
      const rows = await db.prepare(`SELECT ${columns} FROM managed_selected_repo`).all() as SettingRow[]
      return new Map(rows.map(row => [row.repoId, setting(row)]))
    },
    async setRepoDependencyReview(repoId, { enabled, required, since }) {
      const { changes } = since === undefined
        ? await db.prepare(`UPDATE managed_selected_repo SET dependency_review = ?, dependency_reviews_required = ? WHERE repo_id = ?`)
          .run(enabled ? 1 : 0, required, repoId)
        : await db.prepare(`UPDATE managed_selected_repo SET dependency_review = ?, dependency_reviews_required = ?,
          dependency_review_since = ? WHERE repo_id = ?`).run(enabled ? 1 : 0, required, since, repoId)
      if (Number(changes) === 0) return null
      return setting(await db.prepare(`SELECT ${columns} FROM managed_selected_repo WHERE repo_id = ?`).get(repoId) as SettingRow)
    },
    async repoDependencyReviewState(repoId, user, packages) {
      const row = await db.prepare(`SELECT ${columns} FROM managed_selected_repo WHERE repo_id = ?`).get(repoId) as SettingRow | undefined
      if (!row || row.enabled !== 1) return null
      if (!await db.prepare(`SELECT 1 FROM managed_team t WHERE ${COUNTING_TEAM}`).get(repoId)) return null
      const canReview = await db.prepare(`SELECT 1 FROM managed_team t JOIN managed_user u ON u.id = ?
        WHERE ${reviewsIn(true)} AND ${COUNTING_TEAM}`).get(user, repoId) != null
      return { required: row.required, since: row.since, canReview, reviews: await passingReviews(db, repoId, [...new Set(packages)]) }
    },
  }
}
