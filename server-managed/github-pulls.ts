import { type PullRequestRef, type PullRequestResult, type PullRequestStatus, isGithubRepoName, parseGithubPrUrl } from '../common/github-pr.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb } from './db.ts'
import { ensureUserAccessToken } from './github-oauth.ts'

type Metadata = { title: string; status: PullRequestStatus }

// The repo argument is always the canonical name read from selected_repo,
// never an owner/repo/path taken from the submitted URL. Redirects cannot
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
export async function lookupPullRequests(config: ManagedConfig, db: ManagedDb, userId: string, urls: string[], fetchImpl: typeof fetch = globalThis.fetch): Promise<PullRequestResult[]> {
  const [scopes, repos] = await Promise.all([db.listRepoScopesForUser(userId), db.listAllRepos()])
  const allowedIds = new Set(scopes.map(scope => scope.repoId))
  const allowed = new Map(repos.filter(repo => allowedIds.has(repo.repoId) && isGithubRepoName(repo.fullName))
    .map(repo => [repo.fullName.toLowerCase(), repo.fullName]))
  const parsed = urls.map(parseGithubPrUrl)
  const jobs = new Map<string, PullRequestRef>()
  for (const ref of parsed) {
    const repo = ref && allowed.get(ref.repo.toLowerCase())
    if (ref && repo) jobs.set(`${repo}#${ref.number}`, { repo, number: ref.number })
  }
  const metadata = new Map<string, Metadata | null>()
  // Forbidden/invalid-only batches do not even read or refresh a GitHub token.
  const token = jobs.size > 0 ? await ensureUserAccessToken(config, db, userId, Date.now(), fetchImpl) : null
  if (token) {
    const pending = [...jobs.entries()]
    // Bound upstream concurrency; duplicate and differently-cased links share a read.
    for (let i = 0; i < pending.length; i += 4) {
      await Promise.all(pending.slice(i, i + 4).map(async ([key, ref]) => {
        metadata.set(key, await fetchPullRequest(ref.repo, ref.number, token, fetchImpl))
      }))
    }
  }
  return urls.map((url, index) => {
    const ref = parsed[index]
    if (!ref) return { url, error: 'invalid-url' }
    const repo = allowed.get(ref.repo.toLowerCase())
    if (!repo) return { url, error: 'forbidden' }
    const found = metadata.get(`${repo}#${ref.number}`)
    return found ? { url, ...found } : { url, error: 'unavailable' }
  })
}
