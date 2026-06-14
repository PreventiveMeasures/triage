// Repository listing for the "Manage repositories" page, READ-ONLY. Repos are
// listed with the logged-in user's persisted GitHub user-to-server token (see
// github-oauth.ts) via GET /user/repos:
//   - PUBLIC repos list with no App installation at all.
//   - PRIVATE repos appear once the App is installed on them (the install grants
//     the token the repository permissions); "Connect a repository" sends the
//     user to the App's install page (installUrl, from the optional slug).
// Nothing here writes — listing only.
import type { ManagedConfig } from './config.ts'

const GITHUB_API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'deepview-triage'
const PER_PAGE = 100
// Safety bound on pagination (100 repos/page) so a runaway Link chain can't spin
// forever; ample for any realistic per-user repo count.
const MAX_PAGES = 20

// One listed repository — the read-only subset the UI shows.
export interface ConnectedRepo {
  fullName: string
  private: boolean
  htmlUrl: string
}

// A failure carrying the HTTP status the router should surface (502 for an
// upstream GitHub problem).
export class GithubApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GithubApiError'
    this.status = status
  }
}

// The GitHub URL that installs the App on a user/org's repositories (where the
// "Connect a repository" button sends the browser), or null when no slug is set
// — in which case only public repos are listable.
export function installUrl(config: ManagedConfig): string | null {
  if (config.githubAppSlug == null) return null
  return `https://github.com/apps/${encodeURIComponent(config.githubAppSlug)}/installations/new`
}

// One authenticated GitHub GET returning parsed JSON, Bearer-authed by the
// user's token. Network / non-2xx / malformed fold into a GithubApiError (401
// passes through so the caller can prompt re-login).
async function githubGet(url: string, token: string, fetchImpl: typeof fetch): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      headers: {
        'authorization': `Bearer ${token}`, 'accept': 'application/vnd.github+json',
        'user-agent': USER_AGENT, 'x-github-api-version': API_VERSION,
      },
    })
  } catch { throw new GithubApiError(502, 'github-unreachable') }
  if (res.status === 401) throw new GithubApiError(401, 'github-unauthorized')
  if (!res.ok) throw new GithubApiError(502, `github-status-${res.status}`)
  try { return await res.json() } catch { throw new GithubApiError(502, 'github-malformed') }
}

// Validate one repo object from the API into a ConnectedRepo (or null to skip).
// Archived repos are skipped — they're read-only history, not triage targets.
function parseRepo(raw: unknown): ConnectedRepo | null {
  if (raw == null || typeof raw !== 'object') return null
  if ((raw as { archived?: unknown }).archived === true) return null
  const fullName = (raw as { full_name?: unknown }).full_name
  if (typeof fullName !== 'string' || fullName === '') return null
  const htmlUrl = (raw as { html_url?: unknown }).html_url
  return {
    fullName,
    private: (raw as { private?: unknown }).private === true,
    htmlUrl: typeof htmlUrl === 'string' ? htmlUrl : '',
  }
}

// List the authenticated user's repositories (GET /user/repos), paginated until
// a short page, deduped by full name and sorted. Public repos come back with no
// App install; private ones the user can access through an App installation are
// included too. READ-ONLY.
export async function listUserRepos(accessToken: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<ConnectedRepo[]> {
  const byName = new Map<string, ConnectedRepo>()
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${GITHUB_API}/user/repos?per_page=${PER_PAGE}&page=${page}&sort=full_name`
    const body = await githubGet(url, accessToken, fetchImpl)
    if (!Array.isArray(body)) break
    for (const r of body) {
      const repo = parseRepo(r)
      if (repo != null) byName.set(repo.fullName, repo)
    }
    if (body.length < PER_PAGE) break
  }
  return [...byName.values()].toSorted((a, b) => a.fullName.localeCompare(b.fullName))
}
