import type { ManagedConfig } from './config.ts'
import type { ManagedDb, ManagedSession } from './db.ts'
import { randomToken, safeEqual } from './crypto.ts'
import { buildCookie, clearCookie, cookieName, parseCookies } from './session.ts'
import { OAuthError, ensureUserAccessToken, exchangeCode, fetchIdentity } from './github-oauth.ts'

export const ISSUE_LOGIN_PATH = '/api/oauth/github/issues/login'
const COOKIE = 'dvissuestate'

export function isIssueOAuthCallback(config: ManagedConfig, query: URLSearchParams, cookie: string | undefined): boolean {
  const expected = parseCookies(cookie).get(cookieName(config, COOKIE))?.split('.')[0]
  return !!expected && safeEqual(query.get('state') ?? '', expected)
}

export function issueLoginRedirect(config: ManagedConfig, session: ManagedSession, now = Date.now()) {
  const state = randomToken()
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', config.githubClientId)
  url.searchParams.set('redirect_uri', config.oauthCallbackUrl)
  url.searchParams.set('state', state)
  url.searchParams.set('allow_signup', 'false')
  // Reauthorize the same app for the current account, without replacing the
  // DeepView session or permitting an OAuth account switch during creation.
  const value = `${state}.${session.id}.${now}`
  return { location: url.href, setCookie: buildCookie(cookieName(config, COOKIE), value,
    { secure: config.cookieSecure, maxAgeS: 600, sameSite: 'Lax' }) }
}

export async function issueOAuthCallback(config: ManagedConfig, db: ManagedDb, session: ManagedSession,
  query: URLSearchParams, cookie: string | undefined, fetchImpl: typeof fetch = fetch, now = Date.now()) {
  const [expected, sessionId, timestamp] = (parseCookies(cookie).get(cookieName(config, COOKIE)) ?? '').split('.')
  const code = query.get('code'), state = query.get('state')
  if (!code || !state || !expected || !safeEqual(state, expected) || sessionId !== session.id
    || !timestamp || !Number.isFinite(Number(timestamp)) || now < Number(timestamp) || now - Number(timestamp) > 600_000) {
    throw new OAuthError(400, 'invalid-oauth-state')
  }
  const tokens = await exchangeCode(config, code, now, fetchImpl)
  const identity = await fetchIdentity(tokens.accessToken, fetchImpl)
  if (identity.githubUserId !== await db.getUserGithubId(session.userId)) throw new OAuthError(403, 'github-account-mismatch')
  const current = await db.sessionWithUser(session.id, Date.now())
  if (!current || current.user.role === 'none' || current.session.userId !== session.userId) throw new OAuthError(401, 'unauthenticated')
  await db.setUserTokens(session.userId, tokens)
  return { location: '/github-issue-authorized.html', setCookie: clearCookie(cookieName(config, COOKIE), config.cookieSecure) }
}

export function issueUserToken(config: ManagedConfig, db: ManagedDb, userId: string, fetchImpl: typeof fetch = fetch) {
  return ensureUserAccessToken(config, db, userId, Date.now(), fetchImpl)
}
