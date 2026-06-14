// GitHub App user-authorization (identity) for the managed server. This is the
// GitHub *App* user-to-server flow, NOT an OAuth App: the authorize request
// carries NO `scope` (a GitHub App's permissions live on the App itself), so
// login asks for identity only — repo access is a SEPARATE installation flow
// (later work), keeping the broad "act on your behalf" ask off of login.
//
//   GET /api/oauth/github/login     → 302 to github.com/login/oauth/authorize
//                                      with a CSRF `state` mirrored into a
//                                      short-lived state cookie.
//   GET /api/oauth/github/callback   → verify `state` vs the cookie, exchange
//                                      the code for a user token, read the
//                                      GitHub identity, upsert the user, mint a
//                                      session, set the cookie, 302 to the app.
//
// The user-to-server token is read for the identity AND persisted (see
// db.setUserTokens): the "Manage repositories" page lists the user's repos with
// it on demand (GET /user/repos — public repos with no App install; private
// ones once the App is installed). `ensureUserAccessToken` refreshes it when the
// App issues expiring tokens.
import { Buffer } from 'node:buffer'
import type { AvatarStore } from './avatar-store.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, ManagedUser, UserTokens } from './db.ts'
import { randomToken, safeEqual } from './crypto.ts'
import { STATE_COOKIE, buildCookie, clearCookie, cookieName, createSession, parseCookies } from './session.ts'

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'
const STATE_TTL_S = 600

export const LOGIN_PATH = '/api/oauth/github/login'
export const CALLBACK_PATH = '/api/oauth/github/callback'

// A failure with the HTTP status the router should surface.
export class OAuthError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'OAuthError'
    this.status = status
  }
}

export interface CallbackResult { location: string; setCookies: string[] }
export interface CallbackDeps { config: ManagedConfig; db: ManagedDb; avatarStore?: AvatarStore; now?: number; fetchImpl?: typeof fetch }

// GET /api/oauth/github/login — redirect to GitHub, stashing the CSRF state. No
// `scope` is sent: as the GitHub App user-authorization flow, the App's own
// permission set governs access, so login requests identity only (repo access
// is granted separately by installing the App).
export function buildLoginRedirect(config: ManagedConfig): { location: string; setCookie: string } {
  const state = randomToken()
  const u = new URL(GITHUB_AUTHORIZE_URL)
  u.searchParams.set('client_id', config.githubClientId)
  u.searchParams.set('redirect_uri', config.oauthCallbackUrl)
  u.searchParams.set('state', state)
  u.searchParams.set('allow_signup', 'false')
  const setCookie = buildCookie(cookieName(config, STATE_COOKIE), state, {
    maxAgeS: STATE_TTL_S, secure: config.cookieSecure, sameSite: 'Lax',
  })
  return { location: u.toString(), setCookie }
}

// GET /api/oauth/github/callback?code&state — the GitHub OAuth hook.
export async function handleCallback(
  query: URLSearchParams, cookieHeader: string | undefined, deps: CallbackDeps,
): Promise<CallbackResult> {
  const { config, db } = deps
  const now = deps.now ?? Date.now()
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const code = query.get('code')
  const state = query.get('state')
  const stateCookie = parseCookies(cookieHeader).get(cookieName(config, STATE_COOKIE))
  // CSRF: the `state` GitHub echoes back must match the one we set at /login.
  if (!code || !state || !stateCookie || !safeEqual(state, stateCookie)) {
    throw new OAuthError(400, 'invalid-oauth-state')
  }
  const tokens = await exchangeCode(config, code, now, fetchImpl)
  const user = await fetchIdentity(tokens.accessToken, fetchImpl)
  const { setCookie, userId } = await createSession(config, db, user, now)
  // Persist the user token so the repositories page can list repos on demand.
  await db.setUserTokens(userId, tokens)
  // Cache the avatar for same-origin serving (the page's CSP forbids loading
  // github's CDN directly). Best-effort: a fetch/store failure must not break
  // login, and the avatar endpoint just 404s until a later login fills it.
  if (deps.avatarStore != null && user.avatarUrl != null) {
    await cacheAvatar(deps.avatarStore, userId, user.avatarUrl, fetchImpl).catch((err) => {
      console.warn('managed: avatar cache failed:', err)
    })
  }
  // Clear the spent state cookie, set the session cookie, land on the app.
  return {
    location: '/',
    setCookies: [clearCookie(cookieName(config, STATE_COOKIE), config.cookieSecure), setCookie],
  }
}

// Exchange the authorization code for a user-to-server token set.
function exchangeCode(config: ManagedConfig, code: string, now: number, fetchImpl: typeof fetch): Promise<UserTokens> {
  return postToken({
    client_id: config.githubClientId, client_secret: config.githubClientSecret,
    code, redirect_uri: config.oauthCallbackUrl,
  }, now, fetchImpl)
}

// Refresh an expiring user-to-server token (GitHub Apps with expiring tokens
// enabled). Returns the fresh token set; OAuthError(502) on any failure.
export function refreshUserToken(config: ManagedConfig, refreshToken: string, now: number, fetchImpl: typeof fetch = globalThis.fetch): Promise<UserTokens> {
  return postToken({
    client_id: config.githubClientId, client_secret: config.githubClientSecret,
    grant_type: 'refresh_token', refresh_token: refreshToken,
  }, now, fetchImpl)
}

// POST the GitHub token endpoint and parse the {access_token, refresh_token?,
// expires_in?} body into a UserTokens (expiry resolved to an absolute ms time).
async function postToken(payload: Record<string, string>, now: number, fetchImpl: typeof fetch): Promise<UserTokens> {
  let res: Response
  try {
    res = await fetchImpl(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch { throw new OAuthError(502, 'github-token-unreachable') }
  if (!res.ok) throw new OAuthError(502, `github-token-status-${res.status}`)
  let body: unknown
  try { body = await res.json() } catch { throw new OAuthError(502, 'github-token-malformed') }
  const tok = (body as { access_token?: unknown }).access_token
  if (typeof tok !== 'string' || tok === '') throw new OAuthError(502, 'github-token-denied')
  const refresh = (body as { refresh_token?: unknown }).refresh_token
  const expiresIn = (body as { expires_in?: unknown }).expires_in
  return {
    accessToken: tok,
    refreshToken: typeof refresh === 'string' && refresh !== '' ? refresh : null,
    expiresAt: typeof expiresIn === 'number' && expiresIn > 0 ? now + expiresIn * 1000 : null,
  }
}

// Resolve a usable access token for a user: the stored one if still valid, else
// refreshed (when a refresh token is on file) and re-persisted. Null when there
// is no token or it's expired and unrefreshable — the caller prompts re-login.
// A 60s skew margin avoids handing back a token about to expire mid-request.
export async function ensureUserAccessToken(
  config: ManagedConfig, db: ManagedDb, userId: string, now: number, fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  const tokens = await db.getUserTokens(userId)
  if (tokens == null) return null
  if (tokens.expiresAt == null || tokens.expiresAt > now + 60_000) return tokens.accessToken
  if (tokens.refreshToken == null) return null
  try {
    const fresh = await refreshUserToken(config, tokens.refreshToken, now, fetchImpl)
    await db.setUserTokens(userId, fresh)
    return fresh.accessToken
  } catch (err) {
    console.warn('managed: token refresh failed:', err)
    return null
  }
}

// Read the authenticated user's identity (`GET /user`).
async function fetchIdentity(token: string, fetchImpl: typeof fetch): Promise<ManagedUser> {
  let res: Response
  try {
    res = await fetchImpl(GITHUB_USER_URL, {
      headers: {
        'authorization': `Bearer ${token}`, 'accept': 'application/vnd.github+json',
        'user-agent': 'deepview-triage', 'x-github-api-version': '2022-11-28',
      },
    })
  } catch { throw new OAuthError(502, 'github-user-unreachable') }
  if (!res.ok) throw new OAuthError(502, `github-user-status-${res.status}`)
  let body: unknown
  try { body = await res.json() } catch { throw new OAuthError(502, 'github-user-malformed') }
  const user = parseGithubUser(body)
  if (user == null) throw new OAuthError(502, 'github-user-invalid')
  return user
}

// Validate GitHub's `GET /user` payload into a ManagedUser (or null).
function parseGithubUser(body: unknown): ManagedUser | null {
  if (body == null || typeof body !== 'object') return null
  const id = (body as { id?: unknown }).id
  const login = (body as { login?: unknown }).login
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof login !== 'string' || login === '') return null
  const name = (body as { name?: unknown }).name
  const avatar = (body as { avatar_url?: unknown }).avatar_url
  return {
    githubUserId: id, login,
    name: typeof name === 'string' ? name : null,
    avatarUrl: typeof avatar === 'string' ? avatar : null,
  }
}

// Fetch the user's GitHub avatar and cache it for same-origin serving. The host
// is validated (githubusercontent.com over https) as SSRF defence-in-depth,
// even though the URL comes from GitHub's own /user response.
async function cacheAvatar(store: AvatarStore, id: string, avatarUrl: string, fetchImpl: typeof fetch): Promise<void> {
  if (!isGithubAvatarUrl(avatarUrl)) return
  // `redirect: 'manual'` so a 3xx off the (validated) avatars host can't bounce
  // the fetch to an internal address — an opaque-redirect / 3xx fails the
  // `res.ok` + image check below and is skipped (SSRF defence-in-depth).
  const res = await fetchImpl(avatarUrl, { redirect: 'manual' })
  const contentType = res.headers.get('content-type') ?? ''
  if (!res.ok || !contentType.startsWith('image/')) return
  await store.put(id, contentType, Buffer.from(await res.arrayBuffer()))
}

function isGithubAvatarUrl(raw: string): boolean {
  let url: URL
  try { url = new URL(raw) } catch { return false }
  return url.protocol === 'https:'
    && (url.hostname === 'avatars.githubusercontent.com' || url.hostname.endsWith('.githubusercontent.com'))
}
