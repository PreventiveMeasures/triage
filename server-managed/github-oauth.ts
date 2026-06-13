// GitHub user-to-server OAuth (identity) for the managed server.
//
//   GET /api/oauth/github/login     → 302 to github.com/login/oauth/authorize
//                                      with a CSRF `state` mirrored into a
//                                      short-lived state cookie.
//   GET /api/oauth/github/callback   → verify `state` vs the cookie, exchange
//                                      the code for a user token, read the
//                                      GitHub identity, upsert the user, mint a
//                                      session, set the cookie, 302 to the app.
//
// The user token is used ONLY for the one identity read and then DISCARDED —
// installation-token / repo access is later work, so nothing GitHub-derived
// beyond {id, login, name, avatar} is persisted yet.
import { Buffer } from 'node:buffer'
import type { AvatarStore } from './avatar-store.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, ManagedUser } from './db.ts'
import { randomToken, safeEqual } from './crypto.ts'
import { STATE_COOKIE, buildCookie, clearCookie, cookieName, createSession, parseCookies } from './session.ts'

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'
const OAUTH_SCOPE = 'read:user'
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

// GET /api/oauth/github/login — redirect to GitHub, stashing the CSRF state.
export function buildLoginRedirect(config: ManagedConfig): { location: string; setCookie: string } {
  const state = randomToken()
  const u = new URL(GITHUB_AUTHORIZE_URL)
  u.searchParams.set('client_id', config.githubClientId)
  u.searchParams.set('redirect_uri', config.oauthCallbackUrl)
  u.searchParams.set('scope', OAUTH_SCOPE)
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
  const token = await exchangeCode(config, code, fetchImpl)
  const user = await fetchIdentity(token, fetchImpl)
  const { setCookie, userId } = await createSession(config, db, user, now)
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

// Exchange the authorization code for a user-to-server access token.
async function exchangeCode(config: ManagedConfig, code: string, fetchImpl: typeof fetch): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.githubClientId, client_secret: config.githubClientSecret,
        code, redirect_uri: config.oauthCallbackUrl,
      }),
    })
  } catch { throw new OAuthError(502, 'github-token-unreachable') }
  if (!res.ok) throw new OAuthError(502, `github-token-status-${res.status}`)
  let body: unknown
  try { body = await res.json() } catch { throw new OAuthError(502, 'github-token-malformed') }
  const tok = (body as { access_token?: unknown }).access_token
  if (typeof tok !== 'string' || tok === '') throw new OAuthError(502, 'github-token-denied')
  return tok
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
  const res = await fetchImpl(avatarUrl)
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
