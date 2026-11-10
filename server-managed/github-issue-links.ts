import { type GithubFixResult, githubIssueClosedReason, isGithubRepoName, parseGithubFixUrl } from '../common/github-pr.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, TeamReportAccessSnapshot } from './db.ts'
import type { IssueTracking, ManagedIssue } from './managed-issues.ts'
import { ensureUserAccessToken } from './github-oauth.ts'
import { lookupFixes } from './github-pulls.ts'

export type IssueFixUpdate = { findingId: string; issueUrl: string; previous: IssueTracking; next: IssueTracking; checkedAt: number }
type Pull = { number: number; title: string; body: string | null; state: string; isDraft: boolean; createdAt: string;
  repository: { databaseId: number; nameWithOwner: string } }
type Connection = { nodes: Pull[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
type IssueReference = { number?: unknown; repository?: { databaseId?: unknown; nameWithOwner?: unknown } | null }
type Issue = { number: number; title: string; body: string | null; state: string; stateReason: string | null; closedByPullRequestsReferences?: Connection
  duplicateOf?: IssueReference | null }
type Repository = TeamReportAccessSnapshot['repositories'][number]
// The issue a linked one was closed as a duplicate of, in a workspace
// repository: null for none (or one outside them, never followed or
// disclosed, as a pull request outside them isn't).
type Duplicate = { repo: Repository; number: number } | null
// `duplicateOf` is a linked issue's, from its last page read: undefined while
// none is, or where GitHub refused the reference.
type Job = { repo: Repository; kind: 'pull' | 'issue'; number: number; aliases: string[];
  linked: boolean; cursor: string | null; pulls: Pull[]; complete: boolean; duplicateOf?: Duplicate | undefined }
type Metadata = Exclude<GithubFixResult, { error: string }>
const pullFields = 'number title body state isDraft createdAt repository { databaseId nameWithOwner }'
// A linked issue's: the issue it was closed as a duplicate of, and a page of
// the pull requests linked to it.
const linkedFields = (cursor: string | null) => 'duplicateOf { number repository { databaseId nameWithOwner } } '
  + `closedByPullRequestsReferences(first: 100, includeClosedPrs: true, after: ${JSON.stringify(cursor)}) { nodes { ${pullFields} } pageInfo { hasNextPage endCursor } }`
// How many issues a saved one is followed through, each closed as a
// duplicate of the next: each is another request after the last.
const MAX_DUPLICATE_HOPS = 5
const jobKey = (repo: Repository, kind: Job['kind'], number: number) => `${repo.repoId}:${kind}:${number}`
const issueUrlOf = (repo: Repository, number: number) => `https://github.com/${repo.github}/issues/${number}`

function metadataQuery(jobs: Job[]) {
  return `{ ${jobs.map((job, index) => {
    const [owner, name] = job.repo.github.split('/')
    const fields = job.kind === 'pull' ? pullFields : `number title body state stateReason ${job.linked ? linkedFields(job.cursor) : ''}`
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

// The issue `issue` was closed as a duplicate of, where GitHub names one
// (Duplicate); undefined for a reference it gave malformed.
function duplicateOf(issue: Issue, allowed: Map<string, Repository>): Duplicate | undefined {
  if (issue.state !== 'CLOSED' || issue.stateReason !== 'DUPLICATE' || issue.duplicateOf == null) return null
  const { number, repository } = issue.duplicateOf
  if (!Number.isSafeInteger(number) || (number as number) <= 0 || !Number.isSafeInteger(repository?.databaseId)
    || typeof repository?.nameWithOwner !== 'string' || !isGithubRepoName(repository.nameWithOwner)) return undefined
  const repo = allowed.get(repository.nameWithOwner.toLowerCase())
  return repo && repo.repoId === repository.databaseId ? { repo, number: number as number } : null
}

function readPage(job: Job, item: Issue | Pull, metadata: Map<string, Metadata>, allowed: Map<string, Repository>): boolean {
  const details = itemMetadata(item, job.kind)
  if (!details || item.number !== job.number) return false
  for (const url of job.aliases) metadata.set(url, { url, ...details })
  if (!job.linked) return false
  const duplicate = duplicateOf(item as Issue, allowed)
  if (duplicate === undefined) return false
  const connection = (item as Issue).closedByPullRequestsReferences
  if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean'
    || connection.nodes.some(pr => !pr || !Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.createdAt !== 'string'
      || !Number.isFinite(Date.parse(pr.createdAt)) || !itemMetadata(pr, 'pull') || typeof pr.isDraft !== 'boolean'
      || !Number.isSafeInteger(pr.repository?.databaseId) || typeof pr.repository?.nameWithOwner !== 'string' || !isGithubRepoName(pr.repository.nameWithOwner))) return false
  job.duplicateOf = duplicate
  job.pulls.push(...connection.nodes)
  if (!connection.pageInfo.hasNextPage) { job.complete = true; return false }
  if (typeof connection.pageInfo.endCursor !== 'string' || !connection.pageInfo.endCursor || connection.pageInfo.endCursor === job.cursor) return false
  job.cursor = connection.pageInfo.endCursor
  return true
}

// A saved issue's job, then those of the issues it was closed as a duplicate
// of in turn, as far as this lookup has read them, a redirect followed rather
// than the saved issue replaced: `end` where the last names none further to
// follow (or one already in the chain, or past MAX_DUPLICATE_HOPS), else
// `missing`, where one names an issue this lookup has no linked job for.
function duplicateChain(root: Job, jobs: Map<string, Job>): { chain: Job[]; end: boolean; missing: Duplicate } {
  const chain = [root]
  for (let job = root; ;) {
    const target = job.duplicateOf
    if (target === undefined) return { chain, end: false, missing: null }
    if (target === null || chain.length > MAX_DUPLICATE_HOPS) return { chain, end: true, missing: null }
    const next = jobs.get(jobKey(target.repo, 'issue', target.number))
    if (next && chain.includes(next)) return { chain, end: true, missing: null }
    if (!next?.linked) return { chain, end: false, missing: target }
    chain.push(job = next)
  }
}

// The issues saved ones were closed as duplicates of, which this lookup has
// yet to read with their linked pull requests: each made a linked job, as a
// saved issue's own is, one read without them read again with them.
function duplicateJobs(jobs: Map<string, Job>, roots: Set<string>): Job[] {
  const found: Job[] = []
  for (const key of roots) {
    const root = jobs.get(key)
    const missing = root && duplicateChain(root, jobs).missing
    if (!missing) continue
    const missingKey = jobKey(missing.repo, 'issue', missing.number), url = issueUrlOf(missing.repo, missing.number)
    const job = jobs.get(missingKey)
    if (!job) {
      jobs.set(missingKey, { repo: missing.repo, kind: 'issue', number: missing.number, aliases: [url], linked: true, cursor: null, pulls: [], complete: false })
      found.push(jobs.get(missingKey)!)
      continue
    }
    Object.assign(job, { linked: true, cursor: null, pulls: [], complete: false, duplicateOf: undefined })
    if (!job.aliases.includes(url)) job.aliases.push(url)
    found.push(job)
  }
  return found
}

function issueUpdates(jobs: Map<string, Job>, issues: ManagedIssue[], allowed: Map<string, Repository>, checkedAt: number, metadata: Map<string, Metadata>) {
  const updates: IssueFixUpdate[] = []
  // The issues each job's issue is, by repository and number, read once.
  const byIssue = new Map<string, ManagedIssue[]>()
  for (const issue of issues) {
    const ref = parseGithubFixUrl(issue.issueUrl)
    if (ref?.kind !== 'issue') continue
    const key = `${issue.repoId}:issue:${ref.number}`, same = byIssue.get(key)
    if (same) same.push(issue)
    else byIssue.set(key, [issue])
  }
  for (const [key, saved] of byIssue) {
    const root = jobs.get(key)
    if (!root?.linked) continue
    // The saved issue and every one it was closed as a duplicate of in turn,
    // each read whole: the last is tracked, and the pull requests of all.
    const { chain, end } = duplicateChain(root, jobs)
    if (!end || !chain.every(job => job.complete)) continue
    // "Last" means the newest PR by creation time, never its latest comment.
    const latest = chain.flatMap(job => job.pulls).filter(pr => pr.state !== 'CLOSED')
      .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number)[0]
    const repo = latest && allowed.get(latest.repository.nameWithOwner.toLowerCase())
    // The viewer's token can have broader access than this workspace. Never
    // persist or disclose a PR from outside the workspace repository grants.
    if (latest && (!repo || repo.repoId !== latest.repository.databaseId)) continue
    const autoFix = latest ? `https://github.com/${repo!.github}/pull/${latest.number}` : null
    if (latest && autoFix) metadata.set(autoFix, { url: autoFix, ...itemMetadata(latest, 'pull')! })
    const last = chain.at(-1)!
    const duplicate = chain.length > 1 ? issueUrlOf(last.repo, last.number) : null
    // Only a changed derived Fix or duplicate is written: an unchanged one's
    // check time alone would bump the annotations revision that every open
    // team feed polls, for nothing they show. Changes still stamp it, so an
    // older lookup never replaces a newer change (managed-issues.ts). An older
    // lookup that differs can now land after a newer unchanged one, as it
    // could already land before it (whose compare-and-set then fails); either
    // way the next lookup finds the stored values differ, and writes the
    // current ones.
    for (const issue of saved) {
      if (issue.autoFixUrl !== autoFix || issue.duplicateOfUrl !== duplicate) {
        updates.push({ findingId: issue.findingId, issueUrl: issue.issueUrl!, checkedAt,
          previous: { autoFix: issue.autoFixUrl, duplicateOf: issue.duplicateOfUrl }, next: { autoFix, duplicateOf: duplicate } })
      }
    }
  }
  return updates
}

// Fetch issue details, linked PR states and manual Fix metadata in one batch.
// Pagination, workspaces with over 200 distinct links, and issues closed as a
// duplicate of one not yet read need further batches. A duplicate saved last
// time is read in the first, as a redirect kept is: its URL among `urls`.
// Live GraphQL results prove this viewer's access; never publish them into the
// REST shared cache under an older public-visibility grant.
export async function lookupIssueLinks(config: ManagedConfig, db: ManagedDb, snapshot: TeamReportAccessSnapshot,
  urls: string[], issues: ManagedIssue[], fetchImpl: typeof fetch = fetch): Promise<{ fixes: GithubFixResult[]; updates: IssueFixUpdate[] }> {
  const checkedAt = Date.now(), signal = AbortSignal.timeout(10_000)
  const allowed = new Map(snapshot.repositories.filter(repo => isGithubRepoName(repo.github)).map(repo => [repo.github.toLowerCase(), repo]))
  const jobs = new Map<string, Job>()
  // Saved issues (`roots`), and those (with the duplicates they were saved
  // with), read with their linked pull requests.
  const linked = new Set<string>(), roots = new Set<string>()
  for (const issue of issues) {
    const ref = parseGithubFixUrl(issue.issueUrl)
    if (ref?.kind !== 'issue') continue
    roots.add(`${issue.repoId}:issue:${ref.number}`)
    const duplicate = parseGithubFixUrl(issue.duplicateOfUrl), repo = duplicate && allowed.get(duplicate.repo.toLowerCase())
    if (duplicate?.kind === 'issue' && repo) linked.add(jobKey(repo, 'issue', duplicate.number))
  }
  for (const key of roots) linked.add(key)
  for (const url of urls) {
    const ref = parseGithubFixUrl(url), repo = ref && allowed.get(ref.repo.toLowerCase())
    if (!ref || !repo) continue
    const key = jobKey(repo, ref.kind, ref.number), previous = jobs.get(key)
    if (previous) { previous.aliases.push(url); continue }
    jobs.set(key, { repo, kind: ref.kind, number: ref.number, aliases: [url], linked: linked.has(key), cursor: null, pulls: [], complete: false })
  }
  if (jobs.size === 0) return { fixes: [], updates: [] }
  const withinDeadline: typeof fetch = (input, init) => { signal.throwIfAborted(); return fetchImpl(input, { ...init, signal }) }
  const token = await ensureUserAccessToken(config, db, snapshot.user.id, checkedAt, withinDeadline)
  if (!token) return { fixes: await lookupFixes(config, db, snapshot, urls, withinDeadline), updates: [] }
  const metadata = new Map<string, Metadata>(), refused = new Set<string>()
  let pending = [...jobs.values()]
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
      // One on the issue it duplicates alone, which the viewer may be unable
      // to read, leaves its status, and only what it redirects to unknown.
      if (!body?.data || body.errors != null && (!Array.isArray(body.errors)
        || body.errors.some(error => typeof error?.path?.[0] !== 'string' || !/^r\d+$/u.test(error.path[0])))) break
      data = body.data
      refused.clear()
      for (const error of body.errors ?? []) {
        const [alias, field, reference] = error.path! as string[]
        if (field === 'item' && reference === 'duplicateOf') refused.add(alias!)
        else data[alias!] = null
      }
    } catch { break }
    pending = pending.slice(batch.length)
    for (const [index, job] of batch.entries()) {
      const repository = data[`r${index}`]
      if (repository?.databaseId !== job.repo.repoId || typeof repository.nameWithOwner !== 'string' || repository.nameWithOwner.toLowerCase() !== job.repo.github.toLowerCase()) continue
      if (readPage(job, repository.item, metadata, allowed)) pending.push(job)
      if (refused.has(`r${index}`)) job.duplicateOf = undefined
    }
    for (const job of duplicateJobs(jobs, roots)) if (!pending.includes(job)) pending.push(job)
  }
  const updates = issueUpdates(jobs, issues, allowed, checkedAt, metadata)
  return { fixes: [...metadata.values()], updates }
}
