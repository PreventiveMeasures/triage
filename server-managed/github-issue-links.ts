import { type GithubFixResult, githubIssueClosedReason, isGithubRepoName, parseGithubFixUrl } from '../common/github-pr.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, TeamReportAccessSnapshot } from './db.ts'
import type { ManagedIssue } from './managed-issues.ts'
import { ensureUserAccessToken } from './github-oauth.ts'
import { lookupFixes } from './github-pulls.ts'

export type IssueFixUpdate = { findingId: string; issueUrl: string; previous: string | null; next: string | null; checkedAt: number }
type Pull = { number: number; title: string; body: string | null; state: string; isDraft: boolean; createdAt: string;
  repository: { databaseId: number; nameWithOwner: string } }
type Connection = { nodes: Pull[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
type Issue = { number: number; title: string; body: string | null; state: string; stateReason: string | null; closedByPullRequestsReferences?: Connection }
type Repository = TeamReportAccessSnapshot['repositories'][number]
type Job = { repo: Repository; kind: 'pull' | 'issue'; number: number; aliases: string[];
  linked: boolean; cursor: string | null; pulls: Pull[]; complete: boolean }
type Metadata = Exclude<GithubFixResult, { error: string }>
const pullFields = 'number title body state isDraft createdAt repository { databaseId nameWithOwner }'

function metadataQuery(jobs: Job[]) {
  return `{ ${jobs.map((job, index) => {
    const [owner, name] = job.repo.github.split('/')
    const fields = job.kind === 'pull' ? pullFields : `number title body state stateReason ${job.linked
      ? `closedByPullRequestsReferences(first: 100, includeClosedPrs: true, after: ${JSON.stringify(job.cursor)}) { nodes { ${pullFields} } pageInfo { hasNextPage endCursor } }` : ''}`
    return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { databaseId nameWithOwner item: ${job.kind === 'pull' ? 'pullRequest' : 'issue'}(number: ${job.number}) { ${fields} } }`
  }).join('\n')} }`
}

function itemMetadata(item: Issue | Pull, kind: Job['kind']): Omit<Metadata, 'url'> | null {
  if (!item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 1024
    || item.body != null && typeof item.body !== 'string' || !['OPEN', 'CLOSED', ...(kind === 'pull' ? ['MERGED'] : [])].includes(item.state)) return null
  const status = item.state === 'MERGED' ? 'merged' : item.state === 'CLOSED' ? 'closed' : 'isDraft' in item && item.isDraft === true ? 'draft' : 'open'
  const stateReason = kind === 'issue' && status === 'closed' ? githubIssueClosedReason(String((item as Issue).stateReason).toLowerCase()) : null
  return { title: item.title, description: item.body ?? null, status, stateReason }
}

function readPage(job: Job, item: Issue | Pull, metadata: Map<string, Metadata>): boolean {
  const details = itemMetadata(item, job.kind)
  if (!details || item.number !== job.number) return false
  for (const url of job.aliases) metadata.set(url, { url, ...details })
  if (!job.linked) return false
  const connection = (item as Issue).closedByPullRequestsReferences
  if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean'
    || connection.nodes.some(pr => !pr || !Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.createdAt !== 'string'
      || !Number.isFinite(Date.parse(pr.createdAt)) || !itemMetadata(pr, 'pull') || typeof pr.isDraft !== 'boolean'
      || !Number.isSafeInteger(pr.repository?.databaseId) || typeof pr.repository?.nameWithOwner !== 'string' || !isGithubRepoName(pr.repository.nameWithOwner))) return false
  job.pulls.push(...connection.nodes)
  if (!connection.pageInfo.hasNextPage) { job.complete = true; return false }
  if (typeof connection.pageInfo.endCursor !== 'string' || !connection.pageInfo.endCursor || connection.pageInfo.endCursor === job.cursor) return false
  job.cursor = connection.pageInfo.endCursor
  return true
}

function issueUpdates(jobs: Job[], issues: ManagedIssue[], allowed: Map<string, Repository>, checkedAt: number, metadata: Map<string, Metadata>) {
  const updates: IssueFixUpdate[] = []
  for (const job of jobs) {
    if (!job.linked || !job.complete) continue
    // "Last" means the newest PR by creation time, never its latest comment.
    const latest = job.pulls.filter(pr => pr.state !== 'CLOSED').toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number)[0]
    const repo = latest && allowed.get(latest.repository.nameWithOwner.toLowerCase())
    // The viewer's token can have broader access than this workspace. Never
    // persist or disclose a PR from outside the workspace repository grants.
    if (latest && (!repo || repo.repoId !== latest.repository.databaseId)) continue
    const next = latest ? `https://github.com/${repo!.github}/pull/${latest.number}` : null
    if (latest && next) metadata.set(next, { url: next, ...itemMetadata(latest, 'pull')! })
    for (const issue of issues) {
      const ref = parseGithubFixUrl(issue.issueUrl)
      if (ref?.kind === 'issue' && ref.number === job.number && issue.repoId === job.repo.repoId) {
        updates.push({ findingId: issue.findingId, issueUrl: issue.issueUrl!, previous: issue.autoFixUrl, next, checkedAt })
      }
    }
  }
  return updates
}

// Fetch issue details, linked PR states and manual Fix metadata in one batch.
// Pagination and workspaces with over 200 distinct links need further batches.
// Live GraphQL results prove this viewer's access; never publish them into the
// REST shared cache under an older public-visibility grant.
export async function lookupIssueLinks(config: ManagedConfig, db: ManagedDb, snapshot: TeamReportAccessSnapshot,
  urls: string[], issues: ManagedIssue[], fetchImpl: typeof fetch = fetch): Promise<{ fixes: GithubFixResult[]; updates: IssueFixUpdate[] }> {
  const checkedAt = Date.now(), signal = AbortSignal.timeout(10_000)
  const allowed = new Map(snapshot.repositories.filter(repo => isGithubRepoName(repo.github)).map(repo => [repo.github.toLowerCase(), repo]))
  const jobs = new Map<string, Job>()
  const linked = new Set(issues.filter(issue => issue.issueUrl).map(issue => {
    const ref = parseGithubFixUrl(issue.issueUrl)
    return ref?.kind === 'issue' ? `${issue.repoId}:issue:${ref.number}` : ''
  }))
  for (const url of urls) {
    const ref = parseGithubFixUrl(url), repo = ref && allowed.get(ref.repo.toLowerCase())
    if (!ref || !repo) continue
    const key = `${repo.repoId}:${ref.kind}:${ref.number}`, previous = jobs.get(key)
    if (previous) { previous.aliases.push(url); continue }
    jobs.set(key, { repo, kind: ref.kind, number: ref.number, aliases: [url], linked: linked.has(key), cursor: null, pulls: [], complete: false })
  }
  if (jobs.size === 0) return { fixes: [], updates: [] }
  const withinDeadline: typeof fetch = (input, init) => { signal.throwIfAborted(); return fetchImpl(input, { ...init, signal }) }
  const token = await ensureUserAccessToken(config, db, snapshot.user.id, checkedAt, withinDeadline)
  if (!token) return { fixes: await lookupFixes(config, db, snapshot, urls, withinDeadline), updates: [] }
  const metadata = new Map<string, Metadata>(), selected = [...jobs.values()]
  let pending = selected
  for (let page = 0; pending.length > 0 && page < 100 && !signal.aborted; page++) {
    const batch = pending.slice(0, 200), query = metadataQuery(batch)
    let data: Record<string, { databaseId: number; nameWithOwner: string; item: Issue | Pull } | null>
    try {
      const response = await withinDeadline('https://api.github.com/graphql', {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'deepview-triage' }, body: JSON.stringify({ query }),
      })
      if (!response.ok) break
      const body = await response.json() as { data?: typeof data; errors?: { path?: unknown[] }[] }
      // Errors attached to an alias invalidate that whole job, including its
      // connection. Other aliases can succeed even if one issue was deleted.
      if (!body?.data || body.errors != null && (!Array.isArray(body.errors)
        || body.errors.some(error => typeof error?.path?.[0] !== 'string' || !/^r\d+$/u.test(error.path[0])))) break
      data = body.data
      for (const error of body.errors ?? []) data[error.path![0] as string] = null
    } catch { break }
    pending = pending.slice(batch.length)
    for (const [index, job] of batch.entries()) {
      const repository = data[`r${index}`]
      if (repository?.databaseId !== job.repo.repoId || typeof repository.nameWithOwner !== 'string' || repository.nameWithOwner.toLowerCase() !== job.repo.github.toLowerCase()) continue
      if (readPage(job, repository.item, metadata)) pending.push(job)
    }
  }
  const updates = issueUpdates(selected, issues, allowed, checkedAt, metadata)
  return { fixes: [...metadata.values()], updates }
}
