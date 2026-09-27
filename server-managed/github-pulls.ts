import { type GithubFixRef, type GithubFixResult, type GithubFixStatus, isGithubRepoName, parseGithubFixUrl } from '../common/github-pr.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, TeamReportAccessSnapshot } from './db.ts'
import type { GithubMetadata } from './github-metadata.ts'
import { ensureUserAccessToken } from './github-oauth.ts'

type Metadata = { title: string; description: string | null; status: GithubFixStatus }
const MAX_GITHUB_LOOKUPS = 200
const GITHUB_LOOKUP_TIMEOUT_MS = 10_000
const GITHUB_METADATA_TTL_MS = 60_000

// ref.repo is always the canonical name from managed_selected_repo, never an
// owner/repo/path taken from a Fix URL. Redirects cannot move the user token.
async function fetchMetadata(ref: GithubFixRef, token: string, fetchImpl: typeof fetch): Promise<Metadata | null> {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${ref.repo}/${ref.kind === 'pull' ? 'pulls' : 'issues'}/${ref.number}`, {
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'user-agent': 'deepview-triage', 'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
    })
    if (!response.ok) return null
    const body = await response.json() as { number?: unknown; title?: unknown; body?: unknown; state?: unknown; merged?: unknown;
      draft?: unknown; base?: { repo?: { full_name?: unknown } }; repository_url?: unknown; pull_request?: unknown } | null
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
    return { title: body.title, description: body.body ?? null, status }
  } catch { return null }
}

// The workspace handler checks user -> team membership and finding visibility.
// Every shared cache read is additionally restricted to that team’s repositories,
// including for admins; cached metadata is never itself an access grant.
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
  const metadata = new Map((await db.listGithubMetadata([...jobs.keys()])).map(entry => [entry.key, entry]))
  const now = Date.now()
  const pending = [...jobs.entries()].filter(([key]) => {
    const cached = metadata.get(key)
    return !cached || (['open', 'draft'].includes(cached.status) && cached.fetchedAt + GITHUB_METADATA_TTL_MS <= now)
  }).toSorted(([a], [b]) => (metadata.get(a)?.fetchedAt ?? 0) - (metadata.get(b)?.fetchedAt ?? 0)).slice(0, MAX_GITHUB_LOOKUPS)
  // Only stale/missing, distinct, authorized entries consume the request budget.
  // Prioritize missing/oldest entries so a large workspace makes progress.
  if (pending.length > 0) {
    const signal = AbortSignal.timeout(GITHUB_LOOKUP_TIMEOUT_MS)
    const fetchWithinDeadline: typeof fetch = (input, init) => {
      signal.throwIfAborted()
      return fetchImpl(input, { ...init, signal })
    }
    const token = await ensureUserAccessToken(config, db, snapshot.user.id, now, fetchWithinDeadline)
    const fresh: GithubMetadata[] = []
    if (token) {
      // Token refresh and all waves share one deadline, with at most four
      // upstream calls in flight. Failure retains even stale cached metadata.
      for (let i = 0; i < pending.length && !signal.aborted; i += 4) {
        await Promise.all(pending.slice(i, i + 4).map(async ([key, ref]) => {
          const result = await fetchMetadata(ref, token, fetchWithinDeadline)
          if (result) fresh.push({ key, ...result, fetchedAt: Date.now() })
        }))
      }
    }
    if (fresh.length > 0) {
      await db.setGithubMetadata(fresh)
      // A concurrent merged result must win over a slower open/closed read.
      for (const entry of await db.listGithubMetadata(fresh.map(row => row.key))) metadata.set(entry.key, entry)
    }
  }
  // The handler rechecks workspace access and saved Fix links before returning.
  return urls.flatMap((url, index): GithubFixResult[] => {
    const key = keys[index]
    if (!key) return []
    const found = metadata.get(key)
    return [found ? { url, title: found.title, description: found.description, status: found.status } : { url, error: 'unavailable' }]
  })
}

export function storedFixUrls(entries: { fix: string | null }[]): string[] {
  return [...new Set(entries.flatMap(entry => entry.fix && parseGithubFixUrl(entry.fix) ? [entry.fix] : []))].toSorted()
}
