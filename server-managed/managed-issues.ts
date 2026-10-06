import type { ManagedSql } from './sql.ts'
import type { TeamReportAccessSnapshot } from './db.ts'
import { parseGithubPrUrl } from '../common/github-pr.ts'

// One immutable reference per finding, shared across reports and teams. Keep
// reservations across crashes/uncertain GitHub responses to prevent duplicates.
// No triage/import/admin patch accepts these fields.
export const MANAGED_ISSUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_finding_issue (
  finding_id TEXT PRIMARY KEY,
  repo_id INTEGER NOT NULL,
  repository TEXT NOT NULL,
  request_id TEXT NOT NULL,
  issue_url TEXT,
  auto_fix_url TEXT,
  auto_fix_checked_at INTEGER,
  created_by TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
) STRICT;
`
export interface ManagedIssue {
  findingId: string
  repoId: number
  repository: string
  requestId: string
  issueUrl: string | null
  autoFixUrl: string | null
  autoFixCheckedAt: number | null
  createdBy: string | null
  createdAt: number
}
export interface ManagedIssueStore {
  getManagedIssue(findingId: string): Promise<ManagedIssue | null>
  listManagedIssues(findingIds: readonly string[]): Promise<ManagedIssue[]>
  claimManagedIssue(issue: Omit<ManagedIssue, 'issueUrl' | 'autoFixUrl' | 'autoFixCheckedAt'>): Promise<boolean>
  finishManagedIssue(findingId: string, requestId: string, url: string): Promise<boolean>
  releaseManagedIssue(findingId: string, requestId: string): Promise<void>
  setManagedIssueAutoFix(findingId: string, issueUrl: string, previous: string | null, next: string | null, checkedAt: number): Promise<boolean>
}

// A repeated finding ID never grants access to another team's repository.
export function visibleManagedIssues(issues: ManagedIssue[], snapshot: TeamReportAccessSnapshot) {
  if (snapshot.user.id.startsWith('share:')) return []
  const repos = new Set(snapshot.repositories.map(repo => repo.repoId))
  const names = new Set(snapshot.repositories.map(repo => repo.github.toLowerCase()))
  return issues.filter(issue => issue.issueUrl && repos.has(issue.repoId)).map(issue => {
    const ref = parseGithubPrUrl(issue.autoFixUrl)
    return { ...issue, autoFixUrl: ref && names.has(ref.repo.toLowerCase()) ? issue.autoFixUrl : null }
  })
}
export function managedIssueMethods(db: ManagedSql): ManagedIssueStore {
  const fields = `finding_id AS findingId, repo_id AS repoId, repository, request_id AS requestId,
    issue_url AS issueUrl, auto_fix_url AS autoFixUrl, auto_fix_checked_at AS autoFixCheckedAt, created_by AS createdBy, created_at AS createdAt`
  const get = db.prepare(`SELECT ${fields} FROM managed_finding_issue WHERE finding_id = ?`)
  const list = db.prepare(`SELECT ${fields} FROM managed_finding_issue WHERE finding_id IN (SELECT value FROM json_each(?)) ORDER BY finding_id`)
  const autoFix = db.prepare(`UPDATE managed_finding_issue SET auto_fix_url = ?, auto_fix_checked_at = ?
    WHERE finding_id = ? AND issue_url = ? AND COALESCE(auto_fix_url, '') = COALESCE(?, '')
      AND (auto_fix_checked_at IS NULL OR auto_fix_checked_at <= ?)`)
  const claim = db.prepare(`INSERT INTO managed_finding_issue (finding_id, repo_id, repository, request_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (finding_id) DO NOTHING`)
  const finish = db.prepare(`UPDATE managed_finding_issue SET issue_url = ? WHERE finding_id = ? AND request_id = ? AND issue_url IS NULL`)
  const release = db.prepare(`DELETE FROM managed_finding_issue WHERE finding_id = ? AND request_id = ? AND issue_url IS NULL`)
  return {
    async getManagedIssue(findingId) { return (await get.get(findingId) as ManagedIssue | undefined) ?? null },
    async listManagedIssues(ids) { return await list.all(JSON.stringify(ids)) as ManagedIssue[] },
    async setManagedIssueAutoFix(findingId, issueUrl, previous, next, checkedAt) {
      return Number((await autoFix.run(next, checkedAt, findingId, issueUrl, previous, checkedAt)).changes) > 0
    },
    async claimManagedIssue(issue) {
      return Number((await claim.run(issue.findingId, issue.repoId, issue.repository, issue.requestId, issue.createdBy, issue.createdAt)).changes) > 0
    },
    async finishManagedIssue(findingId, requestId, url) { return Number((await finish.run(url, findingId, requestId)).changes) > 0 },
    async releaseManagedIssue(findingId, requestId) { await release.run(findingId, requestId) },
  }
}
