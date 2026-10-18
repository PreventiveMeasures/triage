// A connected repository's dependency review, as an admin sets it, and the
// reviews that pass its pull requests' dependencies (pull-dependency-reviews.ts).
// Enabled, each package version its open pull requests' lockfiles lock needs
// as many published reviews as `required`; those its lockfiles locked at
// `since`, a commit (null for none), none; of the lockfiles it holds to
// (`lockfiles`, lockfile-scope.ts), every one by default. It is in effect only where a team
// that reviews dependencies has the repository, which is where reviews that
// count are published, and not revoked: each reviewer's latest of a version
// tells where they stand on it, a reject holding it unreviewed whatever
// others passed it till they accept it again; and a reviewer standing on
// accepting it passes it by a review of theirs that is full (every file
// checked; a partial review counts for nothing yet) and accepting (Accept,
// or Accept with nits).
import type { ManagedSql } from './sql.ts'
import { type LockfileScope, scopeText, storedScope } from './lockfile-scope.ts'
import { reviewsIn } from './dependency-reviews.ts'
import { type ReviewVerdict, summarizeReview } from '../common/dependency-reviews.js'

export const REPOSITORY_DEPENDENCY_REVIEW_COLUMNS = [['dependency_review', 'INTEGER NOT NULL DEFAULT 0'],
  ['dependency_reviews_required', 'INTEGER NOT NULL DEFAULT 1'], ['dependency_review_since', 'TEXT'], ['dependency_review_lockfiles', 'TEXT']] as const
export const MAX_REQUIRED_REVIEWS = 10
export const SINCE_COMMIT = /^[a-f\d]{40}$/u

export interface RepoDependencyReview { enabled: boolean; required: number; since: string | null; lockfiles: LockfileScope }
// A review published of the version it is of: its package, version and
// npm's integrity of it, the patch it is of (none here, the app reviewing no
// patch yet), the version it was compared with (none for a whole package's),
// who wrote it (`reviewer`, their id, else their login then), its verdict,
// whether it checked every file (`full`), and when it was published.
// One made in a pull request's comments (`comment`) counts for it alone;
// one published here has its `id`.
export interface PublishedReview {
  id?: string; package: string; version: string; integrity: string; patchHash?: string; basePackage: string | null; baseVersion: string | null
  reviewer: string; status: ReviewVerdict; full: boolean; time: number; comment?: true
}
// A repository's review in effect for a reader: its settings, whether they
// publish reviews to one of the teams that count (`canReview`), and the
// published reviews of the packages asked.
export interface RepoReviewState extends Omit<RepoDependencyReview, 'enabled'> { canReview: boolean; reviews: PublishedReview[] }

// A package version whose published reviews are asked.
export interface ReviewedVersionKey { name: string; version: string }

export interface RepositoryDependencyReviewStore {
  listRepoDependencyReviews(): Promise<Map<number, RepoDependencyReview>>
  // One repository's, none where it isn't connected.
  repoDependencyReview(repoId: number): Promise<RepoDependencyReview | null>
  // Those of `repoIds` connected, by their ids, in one statement.
  getRepoDependencyReviews(repoIds: number[]): Promise<Map<number, RepoDependencyReview>>
  // The teams whose published reviews count for each repository (COUNTING_TEAM),
  // by name.
  listRepoReviewTeams(): Promise<Map<number, { id: string; name: string }[]>>
  // Sets a repository's review, its commit and lockfiles too but where
  // `since` or `lockfiles` is undefined, which keeps it; the setting then, or
  // null for no repository.
  setRepoDependencyReview(repoId: number, setting: Omit<RepoDependencyReview, 'since' | 'lockfiles'> & { since?: string | null; lockfiles?: LockfileScope }): Promise<RepoDependencyReview | null>
  // Its review in effect for `user`, as `setting` tells it where read
  // already, with the published reviews of `versions`.
  repoDependencyReviewState(repoId: number, user: string, versions: ReviewedVersionKey[], setting?: RepoDependencyReview | null): Promise<RepoReviewState | null>
  // Which of `users` publish reviews to a team counting for repository
  // `repoId`, whose reviews its pull requests' comments make count.
  listRepoReviewers(repoId: number, users: string[]): Promise<Set<string>>
}

type SettingRow = { repoId: number; enabled: number; required: number; since: string | null; lockfiles: string | null }
const setting = (row: SettingRow): RepoDependencyReview => ({ enabled: row.enabled === 1, required: row.required, since: row.since, lockfiles: storedScope(row.lockfiles) })
// Teams whose published reviews count for repository `?`: that review
// dependencies and have it, not hidden.
const COUNTING_TEAM = `t.hidden = 0 AND t.dependency_review = 1 AND EXISTS (
  SELECT 1 FROM managed_team_repo tr WHERE tr.team_id = t.id AND tr.repo_id = ?)`
const VERSIONS_AT_ONCE = 250

// The published and unrevoked reviews of `versions` in teams counting for
// repository `repoId`, each with whether it is full, a couple of hundred
// versions a query: those of their packages' and versions' found, the
// versions asked alone kept, their files' reviews read of those alone.
async function publishedReviews(db: ManagedSql, repoId: number, versions: ReviewedVersionKey[]): Promise<PublishedReview[]> {
  const found: PublishedReview[] = []
  for (let at = 0; at < versions.length; at += VERSIONS_AT_ONCE) {
    const asked = versions.slice(at, at + VERSIONS_AT_ONCE)
    const keys = new Set(asked.map(({ name, version }) => `${name}@${version}`))
    const [names, numbers] = [[...new Set(asked.map(({ name }) => name))], [...new Set(asked.map(({ version }) => version))]]
    const rows = (await db.prepare(`SELECT r.id, r.user_id AS userId, r.user_login AS userLogin, r.package, r.version, r.integrity,
        NULLIF(r.base_package, '') AS basePackage, NULLIF(r.base_version, '') AS baseVersion, r.files, r.status, r.published_at AS publishedAt
      FROM managed_dependency_review r
      WHERE r.ecosystem = 'npm' AND r.published_at IS NOT NULL AND r.revoked_at IS NULL AND r.status IS NOT NULL
        AND r.package IN (${names.map(() => '?').join(',')}) AND r.version IN (${numbers.map(() => '?').join(',')})
        AND EXISTS (SELECT 1 FROM managed_dependency_review_team rt JOIN managed_team t ON t.id = rt.team_id
          WHERE rt.review_id = r.id AND ${COUNTING_TEAM})`).all(...names, ...numbers, repoId) as
      { id: string; userId: string | null; userLogin: string; package: string; version: string; integrity: string
        basePackage: string | null; baseVersion: string | null; files: string | null; status: ReviewVerdict; publishedAt: number }[])
      .filter(row => keys.has(`${row.package}@${row.version}`))
    if (rows.length === 0) continue
    const entries = new Map<string, { file: string; status: ReviewVerdict | null }[]>()
    for (const { reviewId, ...entry } of await db.prepare(`SELECT review_id AS reviewId, file, status FROM managed_dependency_file_review
      WHERE review_id IN (${rows.map(() => '?').join(',')})`).all(...rows.map(row => row.id)) as { reviewId: string; file: string; status: ReviewVerdict | null }[]) {
      const of = entries.get(reviewId)
      if (of) of.push(entry)
      else entries.set(reviewId, [entry])
    }
    for (const row of rows) {
      const snapshot = row.files === null ? null : JSON.parse(row.files) as string[] | { paths: string[]; nonTextFiles: string[] }
      // A snapshot of paths alone, before non-text files were told, can't be full.
      const files = Array.isArray(snapshot) ? snapshot : snapshot?.paths ?? null
      const nonText = Array.isArray(snapshot) ? null : snapshot?.nonTextFiles ?? []
      const full = summarizeReview(entries.get(row.id) ?? [], files, nonText).coverage === 'full'
      found.push({ id: row.id, package: row.package, version: row.version, integrity: row.integrity, basePackage: row.basePackage, baseVersion: row.baseVersion,
        reviewer: row.userId ?? `login:${row.userLogin.toLowerCase()}`, status: row.status, full, time: Number(row.publishedAt) })
    }
  }
  return found
}

export function repositoryDependencyReviewMethods(db: ManagedSql): RepositoryDependencyReviewStore {
  const columns = `repo_id AS repoId, dependency_review AS enabled, dependency_reviews_required AS required, dependency_review_since AS since,
    dependency_review_lockfiles AS lockfiles`
  const readSetting = async (repoId: number) => {
    const row = await db.prepare(`SELECT ${columns} FROM managed_selected_repo WHERE repo_id = ?`).get(repoId) as SettingRow | undefined
    return row ? setting(row) : null
  }
  return {
    async listRepoDependencyReviews() {
      const rows = await db.prepare(`SELECT ${columns} FROM managed_selected_repo`).all() as SettingRow[]
      return new Map(rows.map(row => [row.repoId, setting(row)]))
    },
    repoDependencyReview: readSetting,
    async getRepoDependencyReviews(repoIds) {
      if (repoIds.length === 0) return new Map()
      const rows = await db.prepare(`SELECT ${columns} FROM managed_selected_repo WHERE repo_id IN (${repoIds.map(() => '?').join(',')})`).all(...repoIds) as SettingRow[]
      return new Map(rows.map(row => [row.repoId, setting(row)]))
    },
    async listRepoReviewTeams() {
      const rows = await db.prepare(`SELECT DISTINCT tr.repo_id AS repoId, t.id AS id, t.name AS name FROM managed_team_repo tr
        JOIN managed_team t ON t.id = tr.team_id WHERE t.hidden = 0 AND t.dependency_review = 1 ORDER BY t.name, t.id`).all() as { repoId: number; id: string; name: string }[]
      const teams = new Map<number, { id: string; name: string }[]>()
      for (const { repoId, id, name } of rows) teams.set(repoId, [...teams.get(repoId) ?? [], { id, name }])
      return teams
    },
    async setRepoDependencyReview(repoId, { enabled, required, since, lockfiles }) {
      const set: [string, unknown][] = [['dependency_review', enabled ? 1 : 0], ['dependency_reviews_required', required],
        ...since === undefined ? [] : [['dependency_review_since', since] as [string, unknown]],
        ...lockfiles === undefined ? [] : [['dependency_review_lockfiles', scopeText(lockfiles)] as [string, unknown]]]
      const { changes } = await db.prepare(`UPDATE managed_selected_repo SET ${set.map(([column]) => `${column} = ?`).join(', ')} WHERE repo_id = ?`)
        .run(...set.map(([, value]) => value), repoId)
      if (Number(changes) === 0) return null
      return setting(await db.prepare(`SELECT ${columns} FROM managed_selected_repo WHERE repo_id = ?`).get(repoId) as SettingRow)
    },
    async listRepoReviewers(repoId, users) {
      if (users.length === 0) return new Set()
      const rows = await db.prepare(`SELECT DISTINCT u.id FROM managed_user u JOIN managed_team t ON t.hidden = 0
        WHERE u.id IN (${users.map(() => '?').join(',')}) AND ${reviewsIn(true)} AND ${COUNTING_TEAM}`).all(...users, repoId) as { id: string }[]
      return new Set(rows.map(row => row.id))
    },
    async repoDependencyReviewState(repoId, user, versions, read) {
      const now = read === undefined ? await readSetting(repoId) : read
      if (!now?.enabled) return null
      if (!await db.prepare(`SELECT 1 FROM managed_team t WHERE ${COUNTING_TEAM}`).get(repoId)) return null
      const canReview = await db.prepare(`SELECT 1 FROM managed_team t JOIN managed_user u ON u.id = ?
        WHERE ${reviewsIn(true)} AND ${COUNTING_TEAM}`).get(user, repoId) != null
      const asked = [...new Map(versions.map(version => [`${version.name}@${version.version}`, version])).values()]
      return { required: now.required, since: now.since, lockfiles: now.lockfiles, canReview, reviews: await publishedReviews(db, repoId, asked) }
    },
  }
}
