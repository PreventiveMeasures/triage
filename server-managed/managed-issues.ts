import type { ManagedSql } from './sql.ts'

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
  createdBy: string | null
  createdAt: number
}
export interface ManagedIssueStore {
  getManagedIssue(findingId: string): Promise<ManagedIssue | null>
  claimManagedIssue(issue: Omit<ManagedIssue, 'issueUrl'>): Promise<boolean>
  finishManagedIssue(findingId: string, requestId: string, url: string): Promise<boolean>
  releaseManagedIssue(findingId: string, requestId: string): Promise<void>
}
export function managedIssueMethods(db: ManagedSql): ManagedIssueStore {
  const get = db.prepare(`SELECT finding_id AS findingId, repo_id AS repoId, repository, request_id AS requestId,
    issue_url AS issueUrl, created_by AS createdBy, created_at AS createdAt FROM managed_finding_issue WHERE finding_id = ?`)
  const claim = db.prepare(`INSERT INTO managed_finding_issue (finding_id, repo_id, repository, request_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (finding_id) DO NOTHING`)
  const finish = db.prepare(`UPDATE managed_finding_issue SET issue_url = ? WHERE finding_id = ? AND request_id = ? AND issue_url IS NULL`)
  const release = db.prepare(`DELETE FROM managed_finding_issue WHERE finding_id = ? AND request_id = ? AND issue_url IS NULL`)
  return {
    async getManagedIssue(findingId) { return (await get.get(findingId) as ManagedIssue | undefined) ?? null },
    async claimManagedIssue(issue) {
      return Number((await claim.run(issue.findingId, issue.repoId, issue.repository, issue.requestId, issue.createdBy, issue.createdAt)).changes) > 0
    },
    async finishManagedIssue(findingId, requestId, url) { return Number((await finish.run(url, findingId, requestId)).changes) > 0 },
    async releaseManagedIssue(findingId, requestId) { await release.run(findingId, requestId) },
  }
}
