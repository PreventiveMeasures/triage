import type { ManagedConfig } from './config.ts'
import type { ManagedDb, ManagedSession } from './db.ts'
import type { BlobStore } from './blob-store.ts'
import type { ManagedIssue } from './managed-issues.ts'
import { randomToken } from './crypto.ts'
import { githubIssueClosedReason } from '../common/github-pr.ts'
import { reportEntries, reportRepoGithub } from '../report/index.js'
import { newIssueLabels } from '../common/github-issue-labels.js'
import { appJwt, githubAppConfigured, installUrl, publicRepositoryName } from './github-app.ts'
import { ISSUE_LOGIN_PATH, issueUserToken } from './github-issue-oauth.ts'
import { TeamReportsError, loadTeamReports, recheckTeam, teamSnapshot } from './team-reports.ts'

export const MAX_ISSUE_BODY_BYTES = 512_000
export class IssueError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

type Context = { reportId: string; findingId: string; repository: string }
export function parseIssueContext(raw: unknown): Context {
  const value = raw as Partial<Context> | null
  const repository = publicRepositoryName(value?.repository)
  if (!repository || typeof value?.reportId !== 'string' || !value.reportId || value.reportId.length > 200
    || typeof value.findingId !== 'string' || !value.findingId || value.findingId.length > 4096) throw new IssueError(400, 'bad-request')
  return { repository, reportId: value.reportId, findingId: value.findingId }
}

async function github(path: string, token: string, fetchImpl: typeof fetch, payload?: unknown) {
  let response: Response
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      method: payload === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'user-agent': 'deepview-triage', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    })
  } catch { throw new IssueError(502, payload === undefined ? 'github-unavailable' : 'github-create-uncertain') }
  return response
}

function referenceResult(stored: ManagedIssue, repoIds: number[]) {
  // A shared finding ID does not grant access to another team's repository.
  if (!repoIds.includes(stored.repoId)) return { mode: 'unavailable' as const }
  return stored.issueUrl ? { mode: 'existing' as const, url: stored.issueUrl }
    : { mode: 'pending' as const, repositoryUrl: `https://github.com/${stored.repository}/issues` }
}

function issueDetails(raw: unknown, url: string, number: number, fallback: { title: string; body: string; labels: string[] }) {
  const issue = raw as { title?: unknown; body?: unknown; state?: unknown; state_reason?: unknown;
    user?: { login?: unknown }; labels?: ({ name?: unknown } | string)[] } | null
  const status = issue?.state === 'closed' ? 'closed' : 'open'
  return { url, number, title: typeof issue?.title === 'string' ? issue.title : fallback.title,
    description: typeof issue?.body === 'string' ? issue.body : fallback.body, status,
    stateReason: status === 'closed' ? githubIssueClosedReason(issue?.state_reason) : null,
    author: typeof issue?.user?.login === 'string' ? issue.user.login : null,
    labels: Array.isArray(issue?.labels) ? issue.labels.map(label => typeof label === 'string' ? label : label?.name).filter((label): label is string => typeof label === 'string') : fallback.labels }
}

// Authorize before any upstream lookup, including installation/label discovery.
// Report filtering also supplies the full row/link isSecurity classification.
export async function prepareGithubIssue(config: ManagedConfig, db: ManagedDb, store: BlobStore,
  session: ManagedSession, teamId: string, context: Context, fetchImpl: typeof fetch = fetch) {
  const snapshot = await teamSnapshot(db, session.id, teamId)
  if (!snapshot.reports.some(report => report.id === context.reportId)) throw new TeamReportsError(404, 'no-report')
  const reports = await loadTeamReports(db, store, snapshot)
  const report = reports.find(item => item.id === context.reportId)!
  const findings = (reportEntries(report.data) ?? []).flat() as Record<string, unknown>[]
  const finding = findings.find(item => item['id'] === context.findingId)
  if (!finding) throw new TeamReportsError(404, 'no-finding')
  const recheck = () => recheckTeam(db, session.id, snapshot)
  await recheck()
  const labels = newIssueLabels(finding['isSecurity'] === true, config.githubNewIssueLabels ?? '')
  const repoIds = snapshot.repositories.map(repo => repo.repoId)
  const stored = await db.getManagedIssue(context.findingId)
  if (stored) return { ...referenceResult(stored, repoIds), labels, recheck }
  // The target comes from this finding's own source, or the report's managed
  // assignment. Team membership alone must not let a caller claim an unrelated
  // repository's issue as the permanent reference for this finding.
  const findingRepo = finding['repo'] as { github?: unknown } | null | undefined
  const targetRepository = publicRepositoryName(reportRepoGithub({ repo: { github: findingRepo?.github || report.repo.github } }))
  if (!targetRepository || targetRepository.toLowerCase() !== context.repository.toLowerCase()) throw new IssueError(400, 'bad-issue-repository')
  const repository = snapshot.repositories.find(repo => repo.github.toLowerCase() === targetRepository.toLowerCase())
  if (!repository || !githubAppConfigured(config)) return { mode: 'form' as const, labels, recheck }
  const path = `/repos/${targetRepository.split('/').map(encodeURIComponent).join('/')}`
  const installation = await github(`${path}/installation`, appJwt(config.githubAppId!, config.githubAppPrivateKey!), fetchImpl)
  if (installation.status === 404) return { mode: 'form' as const, labels, recheck }
  if (!installation.ok) throw new IssueError(502, 'github-unavailable')
  let installed: { permissions?: { issues?: string } }
  try { installed = await installation.json() } catch { throw new IssueError(502, 'github-unavailable') }
  if (installed?.permissions?.issues !== 'write') return { mode: 'permissions' as const, authorizationPath: installUrl(config), labels, recheck }
  const token = await issueUserToken(config, db, session.userId, fetchImpl)
  if (!token) return { mode: 'authorize' as const, authorizationPath: ISSUE_LOGIN_PATH, labels, recheck }
  // All requested labels are optional, including security and operator labels.
  // Omit missing names rather than rejecting issue creation or creating labels.
  const existingLabels: string[] = []
  for (const name of labels) {
    const label = await github(`${path}/labels/${encodeURIComponent(name)}`, token, fetchImpl)
    if (label.status === 401) return { mode: 'authorize' as const, authorizationPath: ISSUE_LOGIN_PATH, labels, recheck }
    if (label.status === 404) continue
    if (!label.ok) throw new IssueError(502, 'github-unavailable')
    existingLabels.push(name)
  }
  return { mode: 'api' as const, token, path, labels: existingLabels, recheck,
    db, findingId: context.findingId, repoId: repository.repoId, repository: targetRepository, repoIds, userId: session.userId }
}

export async function createGithubIssue(prepared: Awaited<ReturnType<typeof prepareGithubIssue>>, input: unknown, fetchImpl: typeof fetch = fetch) {
  if (prepared.mode !== 'api') throw new IssueError(409, 'github-authorization-required')
  const { title, body } = input as { title?: unknown; body?: unknown }
  if (typeof title !== 'string' || !title.trim() || title.length > 256 || typeof body !== 'string' || body.length > 65_536) throw new IssueError(400, 'bad-issue')
  const { db, findingId } = prepared
  const requestId = randomToken()
  if (!await db.claimManagedIssue({ findingId, repoId: prepared.repoId, repository: prepared.repository,
    requestId, createdBy: prepared.userId, createdAt: Date.now() })) {
    const stored = await db.getManagedIssue(findingId)
    await prepared.recheck()
    // The competing request may have released its reservation after a definite
    // failure. Still return a listing, never a fresh creation form, for this race.
    return stored ? referenceResult(stored, prepared.repoIds)
      : { mode: 'pending' as const, repositoryUrl: `https://github.com/${prepared.repository}/issues` }
  }
  // The last awaited operation before the external write checks current access.
  // Release only when we know no issue was created; unknown outcomes stay claimed.
  try { await prepared.recheck() }
  catch (error) { await db.releaseManagedIssue(findingId, requestId); throw error }
  const response = await github(`${prepared.path}/issues`, prepared.token, fetchImpl, { title: title.trim(), body, labels: prepared.labels })
  if (response.status >= 400 && response.status < 500) await db.releaseManagedIssue(findingId, requestId)
  if (response.status === 401) throw new IssueError(409, 'github-authorization-required')
  if (response.status === 403) throw new IssueError(403, 'github-issue-forbidden')
  if (!response.ok) throw new IssueError(response.status === 422 ? 422 : 502, response.status >= 500 ? 'github-create-uncertain' : 'github-create-failed')
  let issue: { number?: unknown }
  try { issue = await response.json() } catch { throw new IssueError(502, 'github-create-uncertain') }
  if (!Number.isSafeInteger(issue?.number) || Number(issue.number) <= 0) throw new IssueError(502, 'github-create-uncertain')
  // Construct the URL from validated inputs, never an upstream redirect target.
  const number = Number(issue.number), url = `https://github.com${prepared.path.slice('/repos'.length)}/issues/${issue.number}`
  if (!await db.finishManagedIssue(findingId, requestId, url)) throw new IssueError(502, 'github-create-uncertain')
  let details = issueDetails(issue, url, number, { title, body, labels: prepared.labels }), detailsUnavailable = true
  try {
    const fetched = await github(`${prepared.path}/issues/${number}`, prepared.token, fetchImpl)
    if (fetched.ok) {
      details = issueDetails(await fetched.json(), url, number, { title, body, labels: prepared.labels })
      detailsUnavailable = false
    }
  } catch { /* Creation and its permanent reference succeeded; detail reads are best effort. */ }
  try { await prepared.recheck() }
  catch {
    // The external write and permanent reference succeeded. Withhold details
    // if current access cannot be confirmed, but never advertise a safe retry.
    return { mode: 'created-unavailable' as const }
  }
  return { url, issue: details, detailsUnavailable }
}
