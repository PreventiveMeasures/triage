import { type GithubFixRef, type GithubFixResult, type GithubFixStatus, githubIssueClosedReason, isGithubRepoName, parseGithubFixUrl } from '../common/github-pr.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, TeamReportAccessSnapshot } from './db.ts'
import type { GithubMetadata, GithubRepositoryVisibility } from './github-metadata.ts'
import { ensureUserAccessToken } from './github-oauth.ts'

type Metadata = Pick<GithubMetadata, 'title' | 'description' | 'status' | 'stateReason'>
const MAX_GITHUB_LOOKUPS = 200
const GITHUB_LOOKUP_TIMEOUT_MS = 10_000
const GITHUB_METADATA_TTL_MS = 60_000
const GITHUB_PUBLIC_VISIBILITY_TTL_MS = 60_000
const GITHUB_PRIVATE_REPOSITORIES_URL = 'https://api.github.com/user/repos?visibility=private&per_page=100&page=1'

type Repository = TeamReportAccessSnapshot['repositories'][number]
type RepositoryPayload = { id?: unknown; full_name?: unknown; private?: unknown; visibility?: unknown; permissions?: { pull?: unknown } }
type RepositoryChecks = { remaining: number; verified: Set<string> }
type RepositoryAccessContext = {
  db: ManagedDb
  visibility: GithubRepositoryVisibility[]
  publicRepos: Set<string>
  token: string | null
  signal: AbortSignal
  fetchImpl: typeof fetch
  checks: RepositoryChecks
  includePrivateList?: boolean
}

function githubRequest(token: string | null): RequestInit {
  return {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), accept: 'application/vnd.github+json',
      'user-agent': 'deepview-triage', 'x-github-api-version': '2022-11-28',
    },
    redirect: 'error',
  }
}

function repositoryMatches(repo: Repository, body: RepositoryPayload | null): boolean {
  return body?.id === repo.repoId && typeof body.full_name === 'string' && body.full_name.toLowerCase() === repo.github.toLowerCase()
}

async function listPrivateRepositories(token: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<(RepositoryPayload | null)[]> {
  try {
    const response = await fetchImpl(GITHUB_PRIVATE_REPOSITORIES_URL, githubRequest(token))
    if (!response.ok) return []
    const body = await response.json() as (RepositoryPayload | null)[] | null
    return Array.isArray(body) && body.length <= 100 && !signal.aborted ? body : []
  } catch { return [] } // A failed list is unknown access; direct checks can still verify it.
}

// Public visibility can be reused briefly across users. Private access stays
// request-local: one page of the viewer's own repo list grants matching repos,
// then direct checks cover omissions, pagination and failed list requests.
async function readableRepositories(repositories: Repository[], { db, visibility, publicRepos, token, signal, fetchImpl, checks, includePrivateList = true }: RepositoryAccessContext): Promise<Set<string>> {
  const readable = new Set(publicRepos)
  const byId = new Map(repositories.map(repo => [repo.repoId, repo]))
  const unverified = repositories.filter(repo => !readable.has(repo.github))
  const updates = new Map<number, GithubRepositoryVisibility>()
  const grant = (repo: Repository, body: RepositoryPayload, checkedAt: number) => {
    const isPublic = body.private === false && body.visibility === 'public'
    readable.add(repo.github)
    checks.verified.add(repo.github)
    if (isPublic) publicRepos.add(repo.github)
    updates.set(repo.repoId, { repoId: repo.repoId, github: repo.github, public: isPublic, checkedAt })
  }
  if (includePrivateList && token && unverified.length > 0 && !signal.aborted) {
    const checkedAt = Date.now()
    for (const entry of await listPrivateRepositories(token, signal, fetchImpl)) {
      const repo = typeof entry?.id === 'number' ? byId.get(entry.id) : undefined
      if (repo && !readable.has(repo.github) && repositoryMatches(repo, entry) && entry?.permissions?.pull === true) grant(repo, entry, checkedAt)
    }
  }
  const formerlyPublic = new Set(visibility.filter(entry => entry.public
    && byId.get(entry.repoId)?.github.toLowerCase() === entry.github.toLowerCase()).map(entry => entry.repoId))
  const pending = unverified.filter(repo => !readable.has(repo.github) && (token || formerlyPublic.has(repo.repoId))).slice(0, checks.remaining)
  checks.remaining -= pending.length
  for (let i = 0; i < pending.length && !signal.aborted; i += 4) {
    await Promise.all(pending.slice(i, i + 4).map(async repo => {
      if (signal.aborted) return
      const checkedAt = Date.now()
      try {
        const response = await fetchImpl(`https://api.github.com/repos/${repo.github}`, githubRequest(token))
        if (!response.ok) return
        const body = await response.json() as RepositoryPayload | null
        if (!signal.aborted && body && repositoryMatches(repo, body)
          && (token || (body.private === false && body.visibility === 'public'))) grant(repo, body, checkedAt)
      } catch { /* Unverified access must never expose cached metadata. */ }
    }))
  }
  if (updates.size > 0) await db.setGithubRepositoryVisibility([...updates.values()])
  return readable
}

async function verifyPublicRefreshes(config: ManagedConfig, userId: string, repositories: Repository[], context: RepositoryAccessContext): Promise<string | null> {
  // Cached public metadata needs no credentials. New content uses a viewer
  // token only after a live check, so privatization cannot publish private data
  // under an old public grant. Anonymous reads remain available without a token.
  const { db, publicRepos } = context
  const token = context.token ?? await ensureUserAccessToken(config, db, userId, Date.now(), context.fetchImpl)
  if (token) {
    const currentPublic = new Set<string>()
    const readable = await readableRepositories(repositories, { ...context, publicRepos: currentPublic, token, includePrivateList: false })
    for (const repo of repositories) if (readable.has(repo.github) && !currentPublic.has(repo.github)) publicRepos.delete(repo.github)
  }
  return token
}

// ref.repo is always the canonical name from managed_selected_repo, never an
// owner/repo/path taken from a Fix URL. Redirects cannot move the user token.
async function fetchMetadata(ref: GithubFixRef, token: string | null, fetchImpl: typeof fetch): Promise<Metadata | null> {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${ref.repo}/${ref.kind === 'pull' ? 'pulls' : 'issues'}/${ref.number}`, githubRequest(token))
    if (!response.ok) return null
    const body = await response.json() as { number?: unknown; title?: unknown; body?: unknown; state?: unknown; merged?: unknown;
      draft?: unknown; base?: { repo?: { full_name?: unknown } }; repository_url?: unknown; pull_request?: unknown; state_reason?: unknown } | null
    if (body?.number !== ref.number || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 1024
      || !['open', 'closed'].includes(String(body.state)) || (body.body != null && typeof body.body !== 'string')) return null
    let status: GithubFixStatus
    if (ref.kind === 'pull') {
      if (typeof body.merged !== 'boolean' || typeof body.base?.repo?.full_name !== 'string'
        || body.base.repo.full_name.toLowerCase() !== ref.repo.toLowerCase()) return null
      status = body.merged ? 'merged' : body.state === 'closed' ? 'closed' : body.draft === true ? 'draft' : 'open'
    } else {
      // The issues API also accepts PR numbers. Do not cache a PR as a closed
      // ordinary issue: only the pulls API can establish its merged state.
      if (body.pull_request != null || typeof body.repository_url !== 'string'
        || body.repository_url.toLowerCase() !== `https://api.github.com/repos/${ref.repo}`.toLowerCase()) return null
      status = body.state === 'closed' ? 'closed' : 'open'
    }
    const stateReason = ref.kind === 'issue' && status === 'closed' ? githubIssueClosedReason(body.state_reason) : null
    return { title: body.title, description: body.body ?? null, status, stateReason }
  } catch { return null }
}

// The workspace handler checks user -> team membership and finding visibility.
// Shared private metadata also requires this viewer's live GitHub access,
// including for admins. Only recently verified public repos skip that check.
export async function lookupFixes(config: ManagedConfig, db: ManagedDb, snapshot: TeamReportAccessSnapshot, urls: string[], fetchImpl: typeof fetch = globalThis.fetch): Promise<GithubFixResult[]> {
  const allowed = new Map(snapshot.repositories.filter(repo => isGithubRepoName(repo.github)).map(repo => [repo.github.toLowerCase(), repo]))
  const parsed = urls.map(parseGithubFixUrl)
  const jobs = new Map<string, GithubFixRef>()
  const keys = parsed.map(ref => {
    const repo = ref && allowed.get(ref.repo.toLowerCase())
    if (!ref || !repo) return null
    const key = `${repo.repoId}:${ref.kind}:${ref.number}`
    jobs.set(key, { ...ref, repo: repo.github })
    return key
  })
  if (jobs.size === 0) return []
  const now = Date.now()
  const signal = AbortSignal.timeout(GITHUB_LOOKUP_TIMEOUT_MS)
  const fetchWithinDeadline: typeof fetch = (input, init) => {
    signal.throwIfAborted()
    return fetchImpl(input, { ...init, signal })
  }
  const repositories = [...new Map([...jobs.values()].map(ref => {
    const repo = allowed.get(ref.repo.toLowerCase())!
    return [repo.repoId, repo] as const
  })).values()]
  const visibility = await db.listGithubRepositoryVisibility(repositories.map(repo => repo.repoId))
  const byId = new Map(repositories.map(repo => [repo.repoId, repo]))
  const publicRepos = new Set(visibility.filter(entry => entry.public && entry.checkedAt <= now
    && entry.checkedAt + GITHUB_PUBLIC_VISIBILITY_TTL_MS > now
    && byId.get(entry.repoId)?.github.toLowerCase() === entry.github.toLowerCase()).map(entry => byId.get(entry.repoId)!.github))
  let token = repositories.some(repo => !publicRepos.has(repo.github))
    ? await ensureUserAccessToken(config, db, snapshot.user.id, now, fetchWithinDeadline) : null
  const checks: RepositoryChecks = { remaining: MAX_GITHUB_LOOKUPS, verified: new Set() }
  const context = { db, visibility, publicRepos, token, signal, fetchImpl: fetchWithinDeadline, checks }
  const readable = await readableRepositories(repositories, context)
  const authorized = [...jobs.entries()].filter(([, ref]) => readable.has(ref.repo))
  const metadata = new Map((await db.listGithubMetadata(authorized.map(([key]) => key))).map(entry => [entry.key, entry]))
  const lastCheckedAt = (key: string) => {
    const cached = metadata.get(key)
    return Math.max(cached?.fetchedAt ?? 0, cached?.attemptedAt ?? 0)
  }
  const pending = authorized.filter(([key, ref]) => {
    const cached = metadata.get(key)
    // Backfill closed issues cached before closure reasons existed, within the
    // same authorized/capped queue. Even an unknown reason completes backfill.
    return !cached || (ref.kind === 'issue' && cached.status === 'closed' && cached.stateReason == null)
      || (['open', 'draft'].includes(cached.status) && cached.fetchedAt + GITHUB_METADATA_TTL_MS <= now)
  }).toSorted(([a], [b]) => lastCheckedAt(a) - lastCheckedAt(b)).slice(0, MAX_GITHUB_LOOKUPS)
  // Only stale/missing, distinct, authorized entries consume the request budget.
  // Prioritize missing/oldest entries so a large workspace makes progress.
  if (pending.length > 0) {
    const publicRefreshes = new Set(pending.filter(([, ref]) => publicRepos.has(ref.repo) && !checks.verified.has(ref.repo)).map(([, ref]) => ref.repo))
    if (publicRefreshes.size > 0) token = await verifyPublicRefreshes(config, snapshot.user.id, repositories.filter(repo => publicRefreshes.has(repo.github)), context)
    const fresh: Omit<GithubMetadata, 'attemptedAt'>[] = []
    const attempted: string[] = []
    // All waves and access checks share one deadline and four-call limit.
    for (let i = 0; i < pending.length && !signal.aborted; i += 4) {
      await Promise.all(pending.slice(i, i + 4).map(async ([key, ref]) => {
        if (signal.aborted) return
        if (metadata.has(key)) attempted.push(key)
        const result = await fetchMetadata(ref, publicRepos.has(ref.repo) && !checks.verified.has(ref.repo) ? null : token, fetchWithinDeadline)
        if (result) fresh.push({ key, ...result, fetchedAt: Date.now() })
      }))
    }
    // Only started cached reads rotate. Missing entries retain priority, and
    // jobs skipped by the cap, deadline or absent token keep their place.
    if (attempted.length > 0) await db.recordGithubMetadataAttempts(attempted, Date.now())
    if (fresh.length > 0) {
      await db.setGithubMetadata(fresh)
      // A concurrent merged result must win over a slower open/closed read.
      for (const entry of await db.listGithubMetadata(fresh.map(row => row.key))) metadata.set(entry.key, entry)
    }
  }
  if (publicRepos.size > 0) {
    // Another request may already have discovered a public -> private change
    // and written new private metadata. Honor that newer visibility observation.
    const current = await db.listGithubRepositoryVisibility(repositories.filter(repo => publicRepos.has(repo.github)).map(repo => repo.repoId))
    const stillPublic = new Set(current.filter(entry => entry.public
      && byId.get(entry.repoId)?.github.toLowerCase() === entry.github.toLowerCase()).map(entry => byId.get(entry.repoId)!.github))
    for (const [key, ref] of authorized) if (publicRepos.has(ref.repo) && !stillPublic.has(ref.repo)) metadata.delete(key)
  }
  // The handler rechecks workspace access and saved Fix links before returning.
  return urls.flatMap((url, index): GithubFixResult[] => {
    const key = keys[index]
    if (!key) return []
    const found = metadata.get(key)
    return [found ? { url, title: found.title, description: found.description, status: found.status, stateReason: found.stateReason } : { url, error: 'unavailable' }]
  })
}

export function storedFixUrls(entries: { fix: string | null }[]): string[] {
  return [...new Set(entries.flatMap(entry => entry.fix && parseGithubFixUrl(entry.fix) ? [entry.fix] : []))].toSorted()
}
