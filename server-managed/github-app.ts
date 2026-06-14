// Repository listing for the "Manage repositories" page, READ-ONLY. Two sources,
// merged + deduped by full name:
//
//   PUBLIC  — the logged-in user's own repos (GET /user/repos) read with their
//             identity-only login token. No installation; the login App needs no
//             repository permissions, so login never shows "Act on your behalf".
//   PRIVATE — a SEPARATE GitHub App (Contents: Read) the user installs on the
//             repos they want; read server-side via installation tokens. That
//             App's Contents permission lives on IT, never on the login App, so
//             login stays clean. "Connect a repository" installs it (installUrl).
//
// Archived repos are skipped. Nothing here writes.
import { Buffer } from 'node:buffer'
import { createSign } from 'node:crypto'
import type { ManagedConfig } from './config.ts'

const GITHUB_API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'deepview-triage'
const PER_PAGE = 100
// Pagination safety bound (100/page) so a runaway listing can't spin forever.
const MAX_PAGES = 20

// One listed repository. Carries the context to read its contents later:
// `installationId` mints an App installation token (Contents: Read) for a repo
// reached through an installation — null for a public repo listed off the user
// token, readable without the App — and `defaultBranch` is the ref to read.
export interface ConnectedRepo {
  id: number
  fullName: string
  private: boolean
  htmlUrl: string
  defaultBranch: string
  installationId: number | null
}

// A failure carrying the HTTP status the router should surface. 401 passes
// through so the user-token path can map it to "log in again".
export class GithubApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GithubApiError'
    this.status = status
  }
}

// The separate repositories App is configured (id + private key present) →
// private repos can be listed via its installation tokens.
export function githubAppConfigured(config: ManagedConfig): boolean {
  return config.githubAppId != null && config.githubAppPrivateKey != null
}

// The install URL for the repositories App ("Connect a repository"), or null
// when no slug is set.
export function installUrl(config: ManagedConfig): string | null {
  if (config.githubAppSlug == null) return null
  return `https://github.com/apps/${encodeURIComponent(config.githubAppSlug)}/installations/new`
}

// Merge repo lists from every source, deduped by full name and sorted. Later
// sources win a collision (the handler lists private after public).
export function mergeRepos(...lists: ConnectedRepo[][]): ConnectedRepo[] {
  const byName = new Map<string, ConnectedRepo>()
  for (const list of lists) {
    for (const repo of list) byName.set(repo.fullName, repo)
  }
  return [...byName.values()].toSorted((a, b) => a.fullName.localeCompare(b.fullName))
}

// One authenticated GitHub API call returning parsed JSON, Bearer-authed by a
// user token, App JWT, or installation token. Network / non-2xx / malformed
// fold into a GithubApiError (401 passes through for the caller to handle).
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
  } catch { throw new GithubApiError(502, 'github-unreachable') }
  if (res.status === 401) throw new GithubApiError(401, 'github-unauthorized')
  if (!res.ok) throw new GithubApiError(502, `github-status-${res.status}`)
  try { return await res.json() } catch { throw new GithubApiError(502, 'github-malformed') }
}

// Validate one repo object into a ConnectedRepo (or null to skip), tagging it
// with the installation it was reached through (null for the user-token path). A
// missing numeric id or full name → skip (can't key/locate it). Archived repos
// are skipped — read-only history, not triage targets.
function parseRepo(raw: unknown, installationId: number | null): ConnectedRepo | null {
  if (raw == null || typeof raw !== 'object') return null
  if ((raw as { archived?: unknown }).archived === true) return null
  const id = (raw as { id?: unknown }).id
  const fullName = (raw as { full_name?: unknown }).full_name
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null
  if (typeof fullName !== 'string' || fullName === '') return null
  const htmlUrl = (raw as { html_url?: unknown }).html_url
  const branch = (raw as { default_branch?: unknown }).default_branch
  return {
    id,
    fullName,
    private: (raw as { private?: unknown }).private === true,
    htmlUrl: typeof htmlUrl === 'string' ? htmlUrl : '',
    defaultBranch: typeof branch === 'string' ? branch : '',
    installationId,
  }
}

// ── PUBLIC: the user's own repos via their login token ──

// List the authenticated user's repositories (GET /user/repos), paginated until
// a short page, deduped + sorted. With an identity-only token this returns the
// user's PUBLIC repos. READ-ONLY.
export async function listUserRepos(accessToken: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<ConnectedRepo[]> {
  const byName = new Map<string, ConnectedRepo>()
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${GITHUB_API}/user/repos?per_page=${PER_PAGE}&page=${page}&sort=full_name`
    const body = await githubJson(url, accessToken, fetchImpl)
    if (!Array.isArray(body)) break
    for (const r of body) {
      const repo = parseRepo(r, null)
      if (repo != null) byName.set(repo.fullName, repo)
    }
    if (body.length < PER_PAGE) break
  }
  return [...byName.values()].toSorted((a, b) => a.fullName.localeCompare(b.fullName))
}

// ── PRIVATE: the separate App's installations via installation tokens ──

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

// Mint a short-lived App JWT (RS256) for the repositories App. iat backdated 60s
// for clock skew; exp 8 min out (within GitHub's 10-min cap); iss = the App id.
export function appJwt(appId: string, privateKeyPem: string, now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000)
  const iat = seconds - 60
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ iat, exp: seconds + 480, iss: appId }))
  const signingInput = `${header}.${payload}`
  return `${signingInput}.${base64url(createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem))}`
}

// The repositories App's installation ids (one per org/user that installed it).
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

// Exchange the App JWT for a scoped installation access token (inherits the
// App's Contents: Read).
async function mintInstallationToken(jwt: string, installId: number, fetchImpl: typeof fetch): Promise<string> {
  const body = await githubJson(`${GITHUB_API}/app/installations/${installId}/access_tokens`, jwt, fetchImpl, 'POST')
  const token = (body as { token?: unknown }).token
  if (typeof token !== 'string' || token === '') throw new GithubApiError(502, 'github-install-token-denied')
  return token
}

// The `repositories` array of one /installation/repositories page → ConnectedRepo[],
// each tagged with the installation id that can read it.
function repoPage(body: unknown, installationId: number): ConnectedRepo[] {
  const repositories = (body as { repositories?: unknown }).repositories
  if (!Array.isArray(repositories)) return []
  const out: ConnectedRepo[] = []
  for (const r of repositories) {
    const repo = parseRepo(r, installationId)
    if (repo != null) out.push(repo)
  }
  return out
}

// Every repository one installation can read, paginated by the page count from
// `total_count` (avoids Link-header parsing).
async function listInstallationRepos(token: string, installationId: number, fetchImpl: typeof fetch): Promise<ConnectedRepo[]> {
  const pageUrl = (page: number): string => `${GITHUB_API}/installation/repositories?per_page=${PER_PAGE}&page=${page}`
  const first = await githubJson(pageUrl(1), token, fetchImpl) as { total_count?: unknown }
  const repos = repoPage(first, installationId)
  const total = typeof first.total_count === 'number' ? first.total_count : repos.length
  const pages = Math.min(Math.ceil(total / PER_PAGE), MAX_PAGES)
  for (let page = 2; page <= pages; page++) {
    repos.push(...repoPage(await githubJson(pageUrl(page), token, fetchImpl), installationId))
  }
  return repos
}

// List every repo the repositories App is installed on, across installations
// (public + PRIVATE within those installs), deduped + sorted. Empty when the App
// isn't configured. READ-ONLY.
export async function listInstalledRepos(config: ManagedConfig, fetchImpl: typeof fetch = globalThis.fetch): Promise<ConnectedRepo[]> {
  const { githubAppId, githubAppPrivateKey } = config
  if (githubAppId == null || githubAppPrivateKey == null) return []
  const jwt = appJwt(githubAppId, githubAppPrivateKey)
  const byName = new Map<string, ConnectedRepo>()
  for (const id of await listInstallationIds(jwt, fetchImpl)) {
    const token = await mintInstallationToken(jwt, id, fetchImpl)
    for (const repo of await listInstallationRepos(token, id, fetchImpl)) byName.set(repo.fullName, repo)
  }
  return [...byName.values()].toSorted((a, b) => a.fullName.localeCompare(b.fullName))
}

// Mint a token to READ a selected repo's contents: an installation token (the
// App's Contents: Read) when the repo was reached through an installation, or
// null for a public repo readable unauthenticated. This is the whole point of
// persisting `installationId` — the stored context is enough to read.
export async function repoAccessToken(config: ManagedConfig, installationId: number | null, fetchImpl: typeof fetch = globalThis.fetch): Promise<string | null> {
  const { githubAppId, githubAppPrivateKey } = config
  if (installationId == null || githubAppId == null || githubAppPrivateKey == null) return null
  return await mintInstallationToken(appJwt(githubAppId, githubAppPrivateKey), installationId, fetchImpl)
}

// ── merged listing ──

export interface RepoListing {
  repositories: ConnectedRepo[]
  tokenMissing: boolean
}

// Every repo a user can reach, merged (deduped + sorted): PUBLIC via their login
// token + PRIVATE via the App's installations. Each source is best-effort so one
// failing never blanks the other; `tokenMissing` flags a missing/stale user
// token (→ the page prompts re-login). A repo seen on both sides keeps the
// installation tag (private listed last → wins the merge).
export async function collectRepos(config: ManagedConfig, userToken: string | null, fetchImpl: typeof fetch = globalThis.fetch): Promise<RepoListing> {
  let tokenMissing = userToken == null
  const lists: ConnectedRepo[][] = []
  if (userToken != null) {
    try {
      lists.push(await listUserRepos(userToken, fetchImpl))
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 401) tokenMissing = true
      else console.warn('managed: public repo list failed:', err)
    }
  }
  if (githubAppConfigured(config)) {
    try {
      lists.push(await listInstalledRepos(config, fetchImpl))
    } catch (err) {
      console.warn('managed: private repo list failed:', err)
    }
  }
  return { repositories: mergeRepos(...lists), tokenMissing }
}
