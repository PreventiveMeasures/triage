import { randomUUID } from 'node:crypto'
import { ManagedMutationError } from './management.ts'
import type { ManagedSql } from './sql.ts'
import { REVIEW_VERDICTS, type ReviewSummary, type ReviewVerdict, allowedReviewVerdicts, needsPackageJsonReview, summarizeReview } from '../common/dependency-reviews.js'

export interface ReviewContext {
  ecosystem: 'npm'; package: string; version: string; integrity: string
  basePackage: string | null; baseVersion: string | null; baseIntegrity: string | null
}
export interface ReviewInput { file: string; comment: string; status: ReviewVerdict | null }
export interface ReviewEntry extends ReviewInput { id: string; time: number }
export interface ReviewTeam { id: string; name: string }
export interface DependencyReview extends ReviewContext, ReviewSummary {
  id: string; user: string | null; userLogin: string; time: number; revision: number
  publishedAt: number | null; revokedAt: number | null; entries: ReviewEntry[]; teams: ReviewTeam[]; files: string[] | null
  nonTextFiles: string[] | null
  status: ReviewVerdict | null; comment: string
}
export type ReviewChange = { action: 'save'; reviewId: string | null; revision: number | null; entryId: string | null; entry: ReviewInput }
  | { action: 'start'; reviewId: null; revision: null }
  | { action: 'publish'; reviewId: string; revision: number; teamIds: string[]; files: string[]; nonTextFiles: string[]; final: { status: ReviewVerdict; comment: string } | null }
  | { action: 'continue'; reviewId: string; revision: number }
  | { action: 'revoke'; reviewId: string; revision: number }
export interface DependencyReviewStore {
  listDependencyReviews(context: ReviewContext, user: string, allBases?: boolean): Promise<DependencyReview[]>
  getLatestOwnDependencyReview(user: string, target: Pick<ReviewContext, 'ecosystem' | 'package' | 'version' | 'integrity'>): Promise<DependencyReview | null>
  listOwnDependencyReviews(user: string, before: { time: number; id: string } | null): Promise<{ reviews: DependencyReview[]; next: { time: number; id: string } | null }>
  // `user`'s own reviews of `ids`, none another's.
  listOwnDependencyReviewsById(user: string, ids: string[]): Promise<DependencyReview[]>
  // The reviews published to team `teamId`, revoked ones too, the latest
  // published first, a page on from `before` (when it was published, and
  // its id), for one who reads them there (reviewsIn); null for another.
  listTeamDependencyReviews(teamId: string, user: string, before: { time: number; id: string } | null): Promise<{ reviews: DependencyReview[]; next: { time: number; id: string } | null } | null>
  // Whether `user` reads the reviews published to team `teamId` (reviewsIn).
  readsTeamDependencyReviews(teamId: string, user: string): Promise<boolean>
  listDependencyReviewTeams(user: string): Promise<ReviewTeam[]>
  listDependencyReviewEnabledTeams(): Promise<string[]>
  setTeamDependencyReview(sessionId: string, teamId: string, enabled: boolean): Promise<boolean>
  discardDependencyReview(sessionId: string, reviewId: string, revision: number): Promise<void>
  changeDependencyReview(context: ReviewContext, sessionId: string, change: ReviewChange, now: number): Promise<DependencyReview>
}

// An unpublished review belongs only to its author. Publication freezes all
// entries together and attaches that snapshot to its selected teams. Continuing
// makes a new review; published entries and their timestamps never change.
export const DEPENDENCY_REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_dependency_review (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  user_login TEXT NOT NULL, ecosystem TEXT NOT NULL,
  package TEXT NOT NULL, version TEXT NOT NULL, integrity TEXT NOT NULL,
  base_package TEXT NOT NULL, base_version TEXT NOT NULL, base_integrity TEXT NOT NULL,
  time INTEGER NOT NULL, revision INTEGER NOT NULL, published_at INTEGER, revoked_at INTEGER, files TEXT,
  status TEXT CHECK (status IN ('accept', 'accept-with-nits', 'request-changes', 'reject')), comment TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX IF NOT EXISTS managed_dependency_review_context_idx
  ON managed_dependency_review(ecosystem, package, version, integrity, base_package, base_version, base_integrity, time);
CREATE UNIQUE INDEX IF NOT EXISTS managed_dependency_review_unpublished_idx
  ON managed_dependency_review(user_id, ecosystem, package, version, integrity, base_package, base_version, base_integrity)
  WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS managed_dependency_review_author_idx ON managed_dependency_review(user_id, time, id);
CREATE TABLE IF NOT EXISTS managed_dependency_file_review (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES managed_dependency_review(id) ON DELETE CASCADE,
  file TEXT NOT NULL, comment TEXT NOT NULL,
  status TEXT CHECK (status IN ('accept', 'accept-with-nits', 'request-changes', 'reject')), time INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS managed_dependency_file_review_idx ON managed_dependency_file_review(review_id);
CREATE TABLE IF NOT EXISTS managed_dependency_review_team (
  review_id TEXT NOT NULL REFERENCES managed_dependency_review(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES managed_team(id) ON DELETE CASCADE,
  PRIMARY KEY (review_id, team_id)
) STRICT;
CREATE INDEX IF NOT EXISTS managed_dependency_review_team_idx ON managed_dependency_review_team(team_id, review_id);
`
const values = (c: ReviewContext) => [c.ecosystem, c.package, c.version, c.integrity, c.basePackage ?? '', c.baseVersion ?? '', c.baseIntegrity ?? '']
const targetWhere = 'ecosystem = ? AND package = ? AND version = ? AND integrity = ?'
const contextWhere = `${targetWhere} AND base_package = ? AND base_version = ? AND base_integrity = ?`
const columns = `id, user_id AS user, user_login AS userLogin, ecosystem, package, version, integrity,
  NULLIF(base_package, '') AS basePackage, NULLIF(base_version, '') AS baseVersion, NULLIF(base_integrity, '') AS baseIntegrity,
  time, revision, published_at AS publishedAt, revoked_at AS revokedAt, files, status, comment`
const conflict = () => { throw new ManagedMutationError(409, 'review-conflict') }

// Who reviews dependencies in team `t`, user `u` as the query joins them: an
// admin, in any team; a member who manages, in theirs; a member who triages,
// in theirs whose dependencies they may see (`view_dependencies`). Publishing
// (`publishing`) needs the team to review dependencies; reading what was
// published there, not, so what it published stays read once it stops. A
// hidden team is no one's.
export const reviewsIn = (publishing: boolean) => `t.hidden = 0${publishing ? ' AND t.dependency_review = 1' : ''} AND (u.role = 'admin' OR EXISTS (
  SELECT 1 FROM managed_team_user m WHERE m.team_id = t.id AND m.user_id = u.id
    AND (u.role = 'manage' OR (u.role = 'triage' AND m.view_dependencies = 1))))`

// Fold legacy multi-note files into one text field without changing a frozen
// snapshot's stored rows. Continuing or saving uses one row per file.
function fileEntries(entries: ReviewEntry[]): ReviewEntry[] {
  const files = new Map<string, ReviewEntry>(), verdicts = Object.keys(REVIEW_VERDICTS)
  for (const entry of entries) {
    if (entry.status === null) continue
    const current = files.get(entry.file)
    if (!current) { files.set(entry.file, { ...entry }); continue }
    current.comment = [current.comment, entry.comment].filter(Boolean).join('\n\n')
    if (verdicts.indexOf(entry.status ?? '') > verdicts.indexOf(current.status ?? '')) current.status = entry.status
    current.time = Math.max(current.time, entry.time)
  }
  return [...files.values()]
}

async function actor(db: ManagedSql, sessionId: string, admin = false) {
  const user = await db.prepare(`SELECT u.id, u.login, u.role FROM managed_session s JOIN managed_user u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ? AND s.viewer_session IS NULL`).get(sessionId, Date.now()) as { id: string; login: string; role: string } | undefined
  if (!user) throw new ManagedMutationError(401, 'unauthenticated')
  if (!(admin ? ['admin'] : ['triage', 'manage', 'admin']).includes(user.role)) throw new ManagedMutationError(403, 'forbidden')
  return user
}
// The teams `user` publishes reviews to (reviewsIn).
async function teams(db: ManagedSql, user: string): Promise<ReviewTeam[]> {
  return await db.prepare(`SELECT t.id, t.name FROM managed_team t JOIN managed_user u ON u.id = ?
    WHERE ${reviewsIn(true)} ORDER BY t.name, t.id`).all(user) as ReviewTeam[]
}
// A draft is begun or edited by one who publishes to some team; their own
// published review revoked, or published to more teams, as `publish` checks
// each, whoever they are now.
async function requireReviewer(db: ManagedSql, user: string) {
  if ((await teams(db, user)).length === 0) throw new ManagedMutationError(403, 'review-access-required')
}

async function expandReviews(db: ManagedSql, rows: unknown[], user: string): Promise<DependencyReview[]> {
  const reviews = rows as (Omit<DependencyReview, 'files'> & { files: string | null })[]
  if (reviews.length === 0) return []
  const ids = reviews.map(review => review.id), placeholders = ids.map(() => '?').join(',')
  const entries = await db.prepare(`SELECT review_id AS reviewId, id, file, comment, status, time
    FROM managed_dependency_file_review WHERE review_id IN (${placeholders}) ORDER BY time, id`).all(...ids) as (ReviewEntry & { reviewId: string })[]
  const linked = await db.prepare(`SELECT rt.review_id AS reviewId, t.id, t.name FROM managed_dependency_review_team rt
    JOIN managed_dependency_review r ON r.id = rt.review_id JOIN managed_team t ON t.id = rt.team_id JOIN managed_user u ON u.id = ?
    WHERE rt.review_id IN (${placeholders}) AND (r.user_id = u.id OR (${reviewsIn(false)}))
    ORDER BY t.name, t.id`).all(user, ...ids) as (ReviewTeam & { reviewId: string })[]
  // Each review's own, in their order, by its id.
  const byReview = <T extends { reviewId: string }>(list: T[]) => {
    const of = new Map<string, Omit<T, 'reviewId'>[]>()
    for (const { reviewId, ...row } of list) {
      const own = of.get(reviewId)
      if (own) own.push(row)
      else of.set(reviewId, [row])
    }
    return of
  }
  const [entriesOf, teamsOf] = [byReview(entries), byReview(linked)]
  return reviews.map(review => {
    const snapshot = review.files === null ? null : JSON.parse(review.files) as string[] | { paths: string[]; nonTextFiles: string[] }
    const files = Array.isArray(snapshot) ? snapshot : snapshot?.paths ?? null
    const nonTextFiles = Array.isArray(snapshot) ? null : snapshot?.nonTextFiles ?? []
    const ownEntries = fileEntries((entriesOf.get(review.id) ?? []) as ReviewEntry[])
    return { ...review, files, nonTextFiles, entries: ownEntries, ...summarizeReview(ownEntries, files, nonTextFiles), teams: (teamsOf.get(review.id) ?? []) as ReviewTeam[] }
  })
}

async function publish(db: ManagedSql, current: DependencyReview | undefined, user: string, change: Extract<ReviewChange, { action: 'publish' }>, now: number) {
  if (!current || current.revokedAt !== null) return conflict()
  const allowed = new Set((await teams(db, user)).map(team => team.id))
  const selected = [...new Set(change.teamIds)]
  if (selected.length === 0 || selected.some(team => !allowed.has(team))) throw new ManagedMutationError(400, 'bad-review-teams')
  const entries = await db.prepare('SELECT file, status FROM managed_dependency_file_review WHERE review_id = ?').all(current.id) as ReviewInput[]
  if (current.publishedAt === null) {
    if (!summarizeReview(entries, change.files, change.nonTextFiles).checkedFiles) throw new ManagedMutationError(400, 'no-reviewed-files')
    if (!change.final || !allowedReviewVerdicts(entries.filter(entry => !change.nonTextFiles.includes(entry.file))).includes(change.final.status)) throw new ManagedMutationError(400, 'bad-final-verdict')
    if (needsPackageJsonReview(entries, change.files, change.nonTextFiles)) throw new ManagedMutationError(400, 'package-json-not-reviewed')
    await db.prepare(`UPDATE managed_dependency_review SET published_at = ?, files = ?, status = ?, comment = ?, revision = revision + 1 WHERE id = ?`)
      .run(now, JSON.stringify({ paths: [...new Set(change.files)].toSorted(), nonTextFiles: [...new Set(change.nonTextFiles)].toSorted() }), change.final.status, change.final.comment, current.id)
  } else {
    if (change.final) return conflict()
    await db.prepare('UPDATE managed_dependency_review SET revision = revision + 1 WHERE id = ?').run(current.id)
  }
  for (const team of selected) await db.prepare('INSERT INTO managed_dependency_review_team (review_id, team_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(current.id, team)
}

async function listOwn(db: ManagedSql, user: string, before: { time: number; id: string } | null) {
  const rows = await db.prepare(`SELECT ${columns} FROM managed_dependency_review WHERE user_id = ?
    ${before ? 'AND (time < ? OR (time = ? AND id < ?))' : ''} ORDER BY time DESC, id DESC LIMIT 51`)
    .all(user, ...before ? [before.time, before.time, before.id] : []) as DependencyReview[]
  const page = rows.slice(0, 50)
  const last = page.at(-1)
  return { reviews: await expandReviews(db, page, user), next: rows.length > 50 && last ? { time: last.time, id: last.id } : null }
}

// A version's reviews, of its base (`context`), or of any (`allBases`), that
// `user` reads: their own, and those published to a team they read in.
async function listContext(db: ManagedSql, context: ReviewContext, user: string, allBases: boolean) {
  const rows = await db.prepare(`SELECT ${columns} FROM managed_dependency_review r WHERE ${allBases ? targetWhere : contextWhere}
    AND (user_id = ? OR (published_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM managed_dependency_review_team rt JOIN managed_team t ON t.id = rt.team_id JOIN managed_user u ON u.id = ?
      WHERE rt.review_id = r.id AND ${reviewsIn(false)})))
    ORDER BY time, id`).all(...values(context).slice(0, allBases ? 4 : 7), user, user)
  return expandReviews(db, rows, user)
}

const readsTeam = async (db: ManagedSql, teamId: string, user: string) =>
  Boolean(await db.prepare(`SELECT 1 FROM managed_team t JOIN managed_user u ON u.id = ? WHERE t.id = ? AND ${reviewsIn(false)}`).get(user, teamId))

async function listTeam(db: ManagedSql, teamId: string, user: string, before: { time: number; id: string } | null) {
  if (!await readsTeam(db, teamId, user)) return null
  const rows = await db.prepare(`SELECT ${columns} FROM managed_dependency_review r JOIN managed_dependency_review_team rt ON rt.review_id = r.id
    WHERE rt.team_id = ? AND r.published_at IS NOT NULL ${before ? 'AND (r.published_at < ? OR (r.published_at = ? AND r.id < ?))' : ''}
    ORDER BY r.published_at DESC, r.id DESC LIMIT 51`).all(teamId, ...before ? [before.time, before.time, before.id] : []) as DependencyReview[]
  const page = rows.slice(0, 50)
  const last = page.at(-1)
  return { reviews: await expandReviews(db, page, user), next: rows.length > 50 && last ? { time: Number(last.publishedAt), id: last.id } : null }
}

async function saveFile(db: ManagedSql, reviewId: string, entry: ReviewInput, requestedId: string | null, now: number) {
  const existing = await db.prepare(`SELECT id FROM managed_dependency_file_review
    WHERE review_id = ? AND file = ? ORDER BY time, id`).all(reviewId, entry.file) as { id: string }[]
  if (requestedId && !existing.some(row => row.id === requestedId)) return conflict()
  if (entry.status === null) {
    await db.prepare('DELETE FROM managed_dependency_file_review WHERE review_id = ? AND file = ?').run(reviewId, entry.file)
  } else if (existing.length > 0) {
    const entryId = existing[0]!.id
    await db.prepare('UPDATE managed_dependency_file_review SET comment = ?, status = ?, time = ? WHERE id = ?')
      .run(entry.comment, entry.status, now, entryId)
    if (existing.length > 1) {
      await db.prepare(`DELETE FROM managed_dependency_file_review
        WHERE review_id = ? AND file = ? AND id <> ?`).run(reviewId, entry.file, entryId)
    }
  } else {
    await db.prepare('INSERT INTO managed_dependency_file_review (id, review_id, file, comment, status, time) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), reviewId, entry.file, entry.comment, entry.status, now)
  }
}

export function dependencyReviewMethods(db: ManagedSql): DependencyReviewStore {
  const read = (id: string) => db.prepare(`SELECT ${columns} FROM managed_dependency_review WHERE id = ?`).get(id)
  return {
    listOwnDependencyReviews: (user, before) => listOwn(db, user, before),
    async listOwnDependencyReviewsById(user, ids) {
      if (ids.length === 0) return []
      return expandReviews(db, await db.prepare(`SELECT ${columns} FROM managed_dependency_review WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})
        ORDER BY time, id`).all(user, ...ids), user)
    },
    listTeamDependencyReviews: (teamId, user, before) => listTeam(db, teamId, user, before),
    readsTeamDependencyReviews: (teamId, user) => readsTeam(db, teamId, user),
    async getLatestOwnDependencyReview(user, target) {
      const row = await db.prepare(`SELECT ${columns} FROM managed_dependency_review
        WHERE user_id = ? AND ecosystem = ? AND package = ? AND version = ? AND integrity = ? ORDER BY time DESC, id DESC LIMIT 1`)
        .get(user, target.ecosystem, target.package, target.version, target.integrity)
      return row ? (await expandReviews(db, [row], user))[0]! : null
    },
    async discardDependencyReview(sessionId, reviewId, revision) {
      const user = await actor(db, sessionId)
      const { changes } = await db.prepare(`DELETE FROM managed_dependency_review
        WHERE id = ? AND user_id = ? AND revision = ? AND published_at IS NULL`).run(reviewId, user.id, revision)
      if (Number(changes) !== 1) conflict()
    },
    listDependencyReviewEnabledTeams: async () => (await db.prepare('SELECT id FROM managed_team WHERE dependency_review = 1 ORDER BY id').all() as { id: string }[]).map(row => row.id),
    async setTeamDependencyReview(sessionId, teamId, enabled) {
      await actor(db, sessionId, true)
      if (!await db.prepare('SELECT id FROM managed_team WHERE id = ?').get(teamId)) return false
      await db.prepare('UPDATE managed_team SET dependency_review = ? WHERE id = ?').run(enabled ? 1 : 0, teamId)
      return true
    },
    listDependencyReviewTeams: user => teams(db, user),
    listDependencyReviews: (context, user, allBases = false) => listContext(db, context, user, allBases),
    async changeDependencyReview(context, sessionId, change, now) {
      const user = await actor(db, sessionId)
      if (change.action !== 'revoke' && change.action !== 'publish') await requireReviewer(db, user.id)
      let id = change.reviewId
      let current: DependencyReview | undefined
      if (id) {
        current = await db.prepare(`SELECT ${columns} FROM managed_dependency_review WHERE id = ? AND user_id = ? AND ${contextWhere}`)
          .get(id, user.id, ...values(context)) as DependencyReview | undefined
        if (!current || current.revision !== change.revision) return conflict()
      }
      const unpublished = () => db.prepare(`SELECT id FROM managed_dependency_review WHERE user_id = ? AND ${contextWhere} AND published_at IS NULL`)
        .get(user.id, ...values(context)) as Promise<{ id: string } | undefined>
      const create = async () => {
        if (await unpublished()) return conflict()
        const next = randomUUID()
        await db.prepare(`INSERT INTO managed_dependency_review
          (id, user_id, user_login, ecosystem, package, version, integrity, base_package, base_version, base_integrity, time, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(next, user.id, user.login, ...values(context), now)
        return next
      }
      if (change.action === 'start') {
        id = await create()
      } else if (change.action === 'continue') {
        if (!current?.publishedAt) return conflict()
        id = await create()
        await db.prepare('UPDATE managed_dependency_review SET comment = ? WHERE id = ?').run(current.comment, id)
        const entries = await db.prepare('SELECT id, file, comment, status, time FROM managed_dependency_file_review WHERE review_id = ? ORDER BY time, id').all(current.id) as ReviewEntry[]
        for (const entry of fileEntries(entries)) {
          await db.prepare(`INSERT INTO managed_dependency_file_review
          (id, review_id, file, comment, status, time) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), id, entry.file, entry.comment, entry.status, entry.time)
        }
      } else if (change.action === 'revoke') {
        if (!current || current.publishedAt === null || current.revokedAt !== null) return conflict()
        await db.prepare('UPDATE managed_dependency_review SET revoked_at = ?, revision = revision + 1 WHERE id = ?').run(now, id)
      } else if (change.action === 'publish') {
        await publish(db, current, user.id, change, now)
      } else {
        if (current?.publishedAt != null) return conflict()
        if (change.entry.status === null && !change.entryId) throw new ManagedMutationError(400, 'bad-review')
        if (id) await db.prepare('UPDATE managed_dependency_review SET time = ?, revision = revision + 1 WHERE id = ?').run(now, id)
        else { if (change.entryId) return conflict(); id = await create() }
        await saveFile(db, id, change.entry, change.entryId, now)
      }
      return (await expandReviews(db, [await read(id!)], user.id))[0]!
    },
  }
}
