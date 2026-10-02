// Repository discovery uses the signed-in user token and App installation
// tokens. Login and repository installation can use one GitHub App: user
// authorization requests account permissions, installation grants repository
// permissions. Discovery itself is read-only and skips archived repositories.
import { Buffer } from 'node:buffer'
import { createHash, createSign } from 'node:crypto'
import { createClient } from '@preventive/upstream/github.js'
import type { ManagedConfig } from './config.ts'
import { GithubApiError, throwGithubResponseError, upstreamGithub } from './github-errors.ts'

export { GithubApiError } from './github-errors.ts'

const GITHUB_API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'deepview-triage'
const PER_PAGE = 100
const INSTALLATION_TOKEN_TTL_MS = 5 * 60_000
const INSTALLATION_TOKEN_EXPIRY_MARGIN_MS = 60_000
const MAX_INSTALLATION_TOKENS = 256
interface InstallationTokenEntry { token: string | null; expiresAt: number; pending: Promise<string> | null }
// Credentials only: visibility, user identities, and permissions are never
// cached here. Bound memory per transport and separate App/key/install scopes.
const installationTokens = new WeakMap<typeof fetch, Map<string, InstallationTokenEntry>>()

function discardInstallationToken(token: string | null, fetchImpl: typeof fetch): void {
  if (!token) return
  const cache = installationTokens.get(fetchImpl)
  if (!cache) return
  for (const [key, entry] of cache) if (entry.token === token) cache.delete(key)
}

// One listed repository. Carries the context to read its contents later:
// `installationId` mints an App installation token (Contents: Read) for a repo
// reached through an installation — null for a public repo listed off the user
// token, readable without the App — and `defaultBranch` is the ref to read.
export interface ConnectedRepo {
  id: number
  fullName: string
  private: boolean
  visibility: 'public' | 'private' | 'internal' | null
  htmlUrl: string
  defaultBranch: string
  installationId: number | null
}

// App installation credentials are configured (id + private key present) →
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

// One GitHub API call returning parsed JSON, optionally Bearer-authed by a
// user token, App JWT, or installation token. Network / non-2xx / malformed
// fold into a GithubApiError (401 passes through for the caller to handle).
export async function githubJson(url: string, token: string | null, fetchImpl: typeof fetch, method: 'GET' | 'POST' = 'GET'): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      method,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
      headers: {
        ...(token == null ? {} : { authorization: `Bearer ${token}` }), 'accept': 'application/vnd.github+json',
        'user-agent': USER_AGENT, 'x-github-api-version': API_VERSION,
      },
    })
  } catch { throw new GithubApiError(502, 'github-unreachable') }
  if (res.status === 401) discardInstallationToken(token, fetchImpl)
  if (!res.ok) await throwGithubResponseError(res)
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
  const visibility = (raw as { visibility?: unknown }).visibility
  return {
    id,
    fullName,
    private: (raw as { private?: unknown }).private === true,
    visibility: visibility === 'public' || visibility === 'private' || visibility === 'internal' ? visibility : null,
    htmlUrl: typeof htmlUrl === 'string' ? htmlUrl : '',
    defaultBranch: typeof branch === 'string' ? branch : '',
    installationId,
  }
}

// Accept an owner/repo or exact GitHub repository URL, never an arbitrary API
// path. Reject traversal and encoded separators before constructing a fixed URL.
export function publicRepositoryName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim().replace(/^https:\/\/github\.com\//iu, '').replace(/\/$/u, '')
  if (!/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/iu.test(name)) return null
  if (['.', '..'].includes(name.split('/')[1]!)) return null
  return name
}

// Public additions must be readable by the server without the acting user's
// credentials. Require explicit public visibility and use GitHub's canonical
// metadata, never client-supplied ids, installation ids, or branches.
export async function fetchPublicRepository(fullName: string): Promise<ConnectedRepo> {
  if (publicRepositoryName(fullName) !== fullName) throw new GithubApiError(400, 'bad-repository')
  const repo = parseRepo(await upstreamGithub(() => createClient({ token: null, userAgent: USER_AGENT }).getRepo({ repo: fullName })), null)
  if (repo == null || repo.private || repo.visibility !== 'public') throw new GithubApiError(409, 'repo-not-public')
  if (publicRepositoryName(repo.fullName) !== repo.fullName || repo.fullName.toLowerCase() !== fullName.toLowerCase()) throw new GithubApiError(502, 'github-malformed')
  return { ...repo, htmlUrl: `https://github.com/${repo.fullName}` }
}

// ── PUBLIC: the user's own repos via their login token ──

// List the authenticated user's repositories (GET /user/repos), paginated until
// a short page, deduped + sorted. With an identity-only token this returns the
// user's PUBLIC repos. READ-ONLY.
export async function listUserRepos(accessToken: string): Promise<ConnectedRepo[]> {
  const byName = new Map<string, ConnectedRepo>()
  const body = await upstreamGithub(() => createClient({ token: accessToken, userAgent: USER_AGENT }).listUserRepos())
  for (const r of body) {
    const repo = parseRepo(r, null)
    if (repo != null) byName.set(repo.fullName, repo)
  }
  return [...byName.values()].toSorted((a, b) => a.fullName.localeCompare(b.fullName))
}

// ── PRIVATE: App installations via installation tokens ──

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
  const ids: number[] = []
  for (let page = 1; ; page++) {
    const body = await githubJson(`${GITHUB_API}/app/installations?per_page=${PER_PAGE}&page=${page}`, jwt, fetchImpl)
    if (!Array.isArray(body)) throw new GithubApiError(502, 'github-malformed')
    for (const inst of body) {
      const id = (inst as { id?: unknown }).id
      if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ids.push(id)
    }
    if (body.length < PER_PAGE) break
  }
  return ids
}

// Reuse installation credentials only in this process. Refresh well before
// expiry and coalesce concurrent mints; failed or undated tokens are not cached.
async function installationAccessToken(appId: string, privateKey: string, installId: number, fetchImpl: typeof fetch): Promise<string> {
  let cache = installationTokens.get(fetchImpl)
  if (!cache) { cache = new Map(); installationTokens.set(fetchImpl, cache) }
  const now = Date.now()
  for (const [key, entry] of cache) if (!entry.pending && entry.expiresAt <= now) cache.delete(key)
  const key = JSON.stringify([appId, createHash('sha256').update(privateKey).digest('hex'), installId])
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    if (cached.pending) return cached.pending
    return cached.token!
  }
  const entry: InstallationTokenEntry = { token: null, expiresAt: 0, pending: null }
  const pending = Promise.resolve().then(async () => {
    try {
      const jwt = appJwt(appId, privateKey)
      const body = await githubJson(`${GITHUB_API}/app/installations/${installId}/access_tokens`, jwt, fetchImpl, 'POST') as { token?: unknown; expires_at?: unknown }
      if (typeof body?.token !== 'string' || body.token === '') throw new GithubApiError(502, 'github-install-token-denied')
      entry.token = body.token
      const expiresAt = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : NaN
      entry.expiresAt = Number.isFinite(expiresAt) ? Math.min(now + INSTALLATION_TOKEN_TTL_MS, expiresAt - INSTALLATION_TOKEN_EXPIRY_MARGIN_MS) : 0
      if (entry.expiresAt <= Date.now() && cache.get(key) === entry) cache.delete(key)
      return body.token
    } catch (err) {
      if (cache.get(key) === entry) cache.delete(key)
      throw err
    } finally { entry.pending = null }
  })
  entry.pending = pending
  cache.set(key, entry)
  if (cache.size > MAX_INSTALLATION_TOKENS) cache.delete(cache.keys().next().value!)
  return await pending
}

// Resolve this exact repository with the App's identity, then confirm the
// installation token reaches the same numeric repository. A missing grant is
// actionable through installation; transport/auth/rate errors must stay errors.
export async function repositoryInstallation(config: ManagedConfig, repoId: number, fullName: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<number | null> {
  const { githubAppId, githubAppPrivateKey } = config
  if (githubAppId == null || githubAppPrivateKey == null) throw new GithubApiError(503, 'github-app-not-configured')
  if (publicRepositoryName(fullName) !== fullName) throw new GithubApiError(409, 'repo-identity-changed')
  const path = fullName.split('/').map(encodeURIComponent).join('/')
  const jwt = appJwt(githubAppId, githubAppPrivateKey)
  let raw
  try { raw = await githubJson(`${GITHUB_API}/repos/${path}/installation`, jwt, fetchImpl) } catch (err) {
    if (err instanceof GithubApiError && err.status === 404) return null
    throw err
  }
  const installation = raw as { id?: unknown; suspended_at?: unknown; permissions?: { contents?: unknown } } | null
  const id = installation?.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new GithubApiError(502, 'github-malformed')
  if (installation?.suspended_at != null || !['read', 'write'].includes(String(installation?.permissions?.contents))) return null
  const token = await installationAccessToken(githubAppId, githubAppPrivateKey, id, fetchImpl)
  const repo = parseRepo(await githubJson(`${GITHUB_API}/repos/${path}`, token, fetchImpl), id)
  if (repo == null || repo.id !== repoId || repo.fullName.toLowerCase() !== fullName.toLowerCase()) throw new GithubApiError(409, 'repo-identity-changed')
  return id
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
  const pages = Math.ceil(total / PER_PAGE)
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
  const lists = await mapGithubRequests(await listInstallationIds(jwt, fetchImpl), async (id) => {
    const token = await installationAccessToken(githubAppId, githubAppPrivateKey, id, fetchImpl)
    return listInstallationRepos(token, id, fetchImpl)
  })
  return mergeRepos(...lists)
}

// Bound fan-out while keeping independent installations/permission checks off
// one long serial critical path. Preserve input order for deterministic merges.
async function mapGithubRequests<T, U>(items: T[], work: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index]!)
    }
  }))
  return results
}

// The login App and repository App are separate: /user/repos with the login
// token is not evidence of private-repo access. Ask the repository App for the
// user's effective GitHub permission (including teams/org/enterprise grants).
// This endpoint accepts installation tokens with Metadata: read; it does NOT
// require Administration permission (unlike collaborator mutation endpoints).
// https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user
// Resolve the current login from /user so renamed handles cannot check someone
// else's access. All repo paths come from GitHub's installation catalogue.
export async function githubUserIdentity(userToken: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<{ id: number; login: string }> {
  const identity = await githubJson(`${GITHUB_API}/user`, userToken, fetchImpl) as { id?: unknown; login?: unknown }
  if (typeof identity?.login !== 'string' || !identity.login || typeof identity.id !== 'number' || !Number.isSafeInteger(identity.id) || identity.id <= 0) throw new GithubApiError(502, 'github-malformed')
  return { id: identity.id, login: identity.login }
}

export async function githubRepoReadPermission(fullName: string, token: string, identity: { id: number; login: string }, fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
  const path = fullName.split('/').map(encodeURIComponent).join('/')
  try {
    const body = await githubJson(`${GITHUB_API}/repos/${path}/collaborators/${encodeURIComponent(identity.login)}/permission`, token, fetchImpl) as { permission?: unknown; user?: { id?: unknown } }
    return body?.user?.id === identity.id && ['read', 'write', 'admin'].includes(String(body?.permission))
  } catch (err) {
    if (err instanceof GithubApiError && err.status === 404) return false
    throw err // Never broaden access when GitHub cannot verify permission.
  }
}

export async function filterInstalledRepos(config: ManagedConfig, repositories: ConnectedRepo[], userToken: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<ConnectedRepo[]> {
  const identity = await githubUserIdentity(userToken, fetchImpl)
  const tokens = new Map<number, Promise<string | null>>()
  const allowed = await mapGithubRequests(repositories, async (repo) => {
    // Internal repos may have private=false; missing visibility is not proof
    // of public access either. Only explicitly public repositories skip checks.
    if (repo.visibility === 'public') return true
    if (repo.installationId == null) return false
    let token = tokens.get(repo.installationId)
    if (!token) {
      token = repoAccessToken(config, repo.installationId, fetchImpl)
      tokens.set(repo.installationId, token)
    }
    const accessToken = await token
    if (!accessToken) return false
    return githubRepoReadPermission(repo.fullName, accessToken, identity, fetchImpl)
  })
  return repositories.filter((_, index) => allowed[index])
}

// Get a token to READ a selected repo's contents: an installation token (the
// App's Contents: Read) when the repo was reached through an installation, or
// null for a public repo readable unauthenticated. This is the whole point of
// persisting `installationId` — the stored context is enough to read.
export async function repoAccessToken(config: ManagedConfig, installationId: number | null, fetchImpl: typeof fetch = globalThis.fetch): Promise<string | null> {
  const { githubAppId, githubAppPrivateKey } = config
  if (installationId == null || githubAppId == null || githubAppPrivateKey == null) return null
  return await installationAccessToken(githubAppId, githubAppPrivateKey, installationId, fetchImpl)
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
      lists.push(await listUserRepos(userToken))
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
