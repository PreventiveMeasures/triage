// GitHub App installation access for READ-ONLY repository connections. The App's
// own permission set — operator-configured to repository "Contents: Read-only"
// — governs what a connected repo exposes; nothing here ever writes. The flow is
// the standard GitHub App server-to-server one:
//
//   App JWT (RS256, signed with the App private key, iss=appId, ≤10 min)
//     → GET  /app/installations                     list the App's installations
//     → POST /app/installations/<id>/access_tokens  mint an installation token
//     → GET  /installation/repositories             repos that install can read
//
// Aggregated across every installation, deduped by full name, sorted. The
// credentials are OPTIONAL (see config.ts): all absent → `githubAppConfigured`
// is false and the "Manage repositories" page shows a not-configured notice
// instead of a list, rather than the server failing to boot.
import { Buffer } from 'node:buffer'
import { createSign } from 'node:crypto'
import type { ManagedConfig } from './config.ts'

const GITHUB_API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'deepview-triage'
const PER_PAGE = 100

// One connected repository — the read-only subset the UI lists.
export interface ConnectedRepo {
  fullName: string
  private: boolean
  htmlUrl: string
}

// A failure carrying the HTTP status the router should surface: 503 when the App
// isn't configured, 502 for an upstream GitHub problem.
export class GithubAppError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GithubAppError'
    this.status = status
  }
}

// All three App credentials present → the repository-connections feature is on.
export function githubAppConfigured(config: ManagedConfig): boolean {
  return config.githubAppId != null && config.githubAppPrivateKey != null && config.githubAppSlug != null
}

// The GitHub URL that installs the App on a user/org's repositories (where the
// "Connect a repository" button sends the browser). Null when no slug is set.
export function installUrl(config: ManagedConfig): string | null {
  if (config.githubAppSlug == null) return null
  return `https://github.com/apps/${encodeURIComponent(config.githubAppSlug)}/installations/new`
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

// Mint a short-lived App JWT (RS256). `iat` is backdated 60s to tolerate clock
// skew with GitHub; `exp` is 8 min out (comfortably within GitHub's 10-min cap).
// `iss` is the App id. Signed with the App's PEM private key.
export function appJwt(appId: string, privateKeyPem: string, now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000)
  const iat = seconds - 60
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ iat, exp: seconds + 480, iss: appId }))
  const signingInput = `${header}.${payload}`
  const signature = base64url(createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem))
  return `${signingInput}.${signature}`
}

// One authenticated GitHub API call returning parsed JSON, Bearer-authed by the
// App JWT or an installation token. Network / non-2xx / malformed all fold into
// a 502 GithubAppError.
async function githubJson(url: string, token: string, fetchImpl: typeof fetch, method: 'GET' | 'POST' = 'GET'): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        'authorization': `Bearer ${token}`, 'accept': 'application/vnd.github+json',
        'user-agent': USER_AGENT, 'x-github-api-version': API_VERSION,
      },
    })
  } catch { throw new GithubAppError(502, 'github-app-unreachable') }
  if (!res.ok) throw new GithubAppError(502, `github-app-status-${res.status}`)
  try { return await res.json() } catch { throw new GithubAppError(502, 'github-app-malformed') }
}

// The App's installation ids (one per org/user that installed it).
async function listInstallationIds(jwt: string, fetchImpl: typeof fetch): Promise<number[]> {
  const body = await githubJson(`${GITHUB_API}/app/installations?per_page=${PER_PAGE}`, jwt, fetchImpl)
  if (!Array.isArray(body)) return []
  const ids: number[] = []
  for (const inst of body) {
    const id = (inst as { id?: unknown }).id
    if (typeof id === 'number' && Number.isSafeInteger(id)) ids.push(id)
  }
  return ids
}

// Exchange the App JWT for a scoped installation access token (POST, no body —
// the token inherits the App's full permission set, i.e. Contents: Read).
async function mintInstallationToken(jwt: string, installId: number, fetchImpl: typeof fetch): Promise<string> {
  const body = await githubJson(`${GITHUB_API}/app/installations/${installId}/access_tokens`, jwt, fetchImpl, 'POST')
  const token = (body as { token?: unknown }).token
  if (typeof token !== 'string' || token === '') throw new GithubAppError(502, 'github-app-token-denied')
  return token
}

// Validate one repo object from the API into a ConnectedRepo (or null to skip).
function parseRepo(raw: unknown): ConnectedRepo | null {
  if (raw == null || typeof raw !== 'object') return null
  const fullName = (raw as { full_name?: unknown }).full_name
  if (typeof fullName !== 'string' || fullName === '') return null
  const htmlUrl = (raw as { html_url?: unknown }).html_url
  return {
    fullName,
    private: (raw as { private?: unknown }).private === true,
    htmlUrl: typeof htmlUrl === 'string' ? htmlUrl : '',
  }
}

// The `repositories` array of one /installation/repositories page → ConnectedRepo[].
function repoPage(body: unknown): ConnectedRepo[] {
  const repositories = (body as { repositories?: unknown }).repositories
  if (!Array.isArray(repositories)) return []
  const out: ConnectedRepo[] = []
  for (const r of repositories) {
    const repo = parseRepo(r)
    if (repo != null) out.push(repo)
  }
  return out
}

// Every repository one installation can read. Pagination is driven by the page
// count derived from `total_count`, avoiding Link-header parsing.
async function listInstallationRepos(token: string, fetchImpl: typeof fetch): Promise<ConnectedRepo[]> {
  const pageUrl = (page: number): string => `${GITHUB_API}/installation/repositories?per_page=${PER_PAGE}&page=${page}`
  const first = await githubJson(pageUrl(1), token, fetchImpl) as { total_count?: unknown }
  const repos = repoPage(first)
  const total = typeof first.total_count === 'number' ? first.total_count : repos.length
  const pages = Math.ceil(total / PER_PAGE)
  for (let page = 2; page <= pages; page++) {
    repos.push(...repoPage(await githubJson(pageUrl(page), token, fetchImpl)))
  }
  return repos
}

// List every repository the App can read across all installations, deduped by
// full name and sorted. READ-ONLY: installation tokens inherit the App's
// permissions (Contents: Read), so nothing reached here can modify a repo.
export async function listConnectedRepos(config: ManagedConfig, fetchImpl: typeof fetch = globalThis.fetch): Promise<ConnectedRepo[]> {
  const { githubAppId, githubAppPrivateKey, githubAppSlug } = config
  if (githubAppId == null || githubAppPrivateKey == null || githubAppSlug == null) {
    throw new GithubAppError(503, 'github-app-not-configured')
  }
  const jwt = appJwt(githubAppId, githubAppPrivateKey)
  const byName = new Map<string, ConnectedRepo>()
  for (const id of await listInstallationIds(jwt, fetchImpl)) {
    const token = await mintInstallationToken(jwt, id, fetchImpl)
    for (const repo of await listInstallationRepos(token, fetchImpl)) byName.set(repo.fullName, repo)
  }
  return [...byName.values()].toSorted((a, b) => a.fullName.localeCompare(b.fullName))
}
