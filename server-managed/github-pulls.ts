import { type PullRequestRef, type PullRequestResult, type PullRequestStatus, isGithubRepoName, parseGithubPrUrl } from '../common/github-pr.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, TeamReportAccessSnapshot } from './db.ts'
import { ensureUserAccessToken } from './github-oauth.ts'

type Metadata = { title: string; status: PullRequestStatus }

// The repo argument is always the canonical name read from managed_selected_repo,
// never an owner/repo/path taken from a Fix URL. Redirects cannot
// move this authenticated request outside that authorized repository.
async function fetchPullRequest(repo: string, number: number, token: string, fetchImpl: typeof fetch): Promise<Metadata | null> {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/pulls/${number}`, {
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'user-agent': 'deepview-triage', 'x-github-api-version': '2022-11-28',
      },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const body = await response.json() as { number?: unknown; title?: unknown; state?: unknown; merged?: unknown; draft?: unknown; base?: { repo?: { full_name?: unknown } } } | null
    if (body?.number !== number || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 1024
      || !['open', 'closed'].includes(String(body.state)) || typeof body.merged !== 'boolean'
      || typeof body.base?.repo?.full_name !== 'string' || body.base.repo.full_name.toLowerCase() !== repo.toLowerCase()) return null
    const status = body.merged ? 'merged' : body.state === 'closed' ? 'closed' : body.draft === true ? 'draft' : 'open'
    return { title: body.title, status }
  } catch { return null }
}

// Team membership is the local authorization gate, including for admins.
// GitHub independently decides whether the caller's user token can read a PR.
// Never substitute an installation token or another user's credentials.
export async function lookupPullRequests(config: ManagedConfig, db: ManagedDb, snapshot: TeamReportAccessSnapshot, urls: string[], fetchImpl: typeof fetch = globalThis.fetch): Promise<PullRequestResult[]> {
  const allowed = new Map(snapshot.repositories.filter(repo => isGithubRepoName(repo.github))
    .map(repo => [repo.github.toLowerCase(), repo.github]))
  const parsed = urls.map(parseGithubPrUrl)
  const jobs = new Map<string, PullRequestRef>()
  for (const ref of parsed) {
    const repo = ref && allowed.get(ref.repo.toLowerCase())
    if (ref && repo) jobs.set(`${repo}#${ref.number}`, { repo, number: ref.number })
  }
  const metadata = new Map<string, Metadata | null>()
  // Forbidden/invalid-only batches do not even read or refresh a GitHub token.
  const token = jobs.size > 0 ? await ensureUserAccessToken(config, db, snapshot.user.id, Date.now(), fetchImpl) : null
  if (token) {
    const pending = [...jobs.entries()]
    // Bound upstream concurrency; duplicate and differently-cased links share a read.
    for (let i = 0; i < pending.length; i += 4) {
      await Promise.all(pending.slice(i, i + 4).map(async ([key, ref]) => {
        metadata.set(key, await fetchPullRequest(ref.repo, ref.number, token, fetchImpl))
      }))
    }
  }
  // The workspace handler rechecks this snapshot and its stored Fix links after
  // all upstream reads, before releasing any metadata.
  return urls.map((url, index) => {
    const ref = parsed[index]
    if (!ref) return { url, error: 'invalid-url' }
    const repo = allowed.get(ref.repo.toLowerCase())
    if (!repo) return { url, error: 'forbidden' }
    const found = metadata.get(`${repo}#${ref.number}`)
    return found ? { url, ...found } : { url, error: 'unavailable' }
  })
}

export function storedPullRequestUrls(entries: { fix: string | null }[]): string[] {
  return [...new Set(entries.flatMap(entry => entry.fix && parseGithubPrUrl(entry.fix) ? [entry.fix] : []))].toSorted()
}
