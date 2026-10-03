import type { ManagedConfig } from './config.ts'
import type { ManagedDb, ManagedSession } from './db.ts'
import { randomToken, safeEqual } from './crypto.ts'
import { buildCookie, clearCookie, cookieName, parseCookies } from './session.ts'
import { OAuthError, ensureUserAccessToken, exchangeCode, fetchIdentity, issueClient } from './github-oauth.ts'

export const ISSUE_LOGIN_PATH = '/api/oauth/github/issues/login'
const COOKIE = 'dvissuestate'

export function isIssueOAuthCallback(config: ManagedConfig, query: URLSearchParams, cookie: string | undefined): boolean {
  const expected = parseCookies(cookie).get(cookieName(config, COOKIE))?.split('.')[0]
  return !!expected && safeEqual(query.get('state') ?? '', expected)
}

export function issueLoginRedirect(config: ManagedConfig, session: ManagedSession, now = Date.now()) {
  const state = randomToken()
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', issueClient(config).id)
  url.searchParams.set('redirect_uri', config.oauthCallbackUrl)
  url.searchParams.set('state', state)
  url.searchParams.set('allow_signup', 'false')
  // Authorize the issue App (the repository App, or the login App when they are
  // one) for the current account, without replacing the DeepView session or
  // permitting an OAuth account switch during creation.
  const value = `${state}.${session.id}.${now}`
  return { location: url.href, setCookie: buildCookie(cookieName(config, COOKIE), value,
    { secure: config.cookieSecure, maxAgeS: 600, sameSite: 'Lax' }) }
}

export async function issueOAuthCallback(config: ManagedConfig, db: ManagedDb, session: ManagedSession,
  query: URLSearchParams, cookie: string | undefined, fetchImpl: typeof fetch = fetch, now = Date.now()) {
  const [expected, sessionId, timestamp] = (parseCookies(cookie).get(cookieName(config, COOKIE)) ?? '').split('.')
  const code = query.get('code'), state = query.get('state')
  if (!state || !expected || !safeEqual(state, expected) || sessionId !== session.id
    || !timestamp || !Number.isFinite(Number(timestamp)) || now < Number(timestamp) || now - Number(timestamp) > 600_000) {
    throw new OAuthError(400, 'invalid-oauth-state')
  }
  const done = (page: string) => ({ location: page, setCookie: clearCookie(cookieName(config, COOKIE), config.cookieSecure) })
  // Cancelling on GitHub returns `error` instead of a code. Nothing is stored;
  // the issue dialog keeps offering GitHub's prefilled form.
  if (!code) {
    if (query.get('error') === 'access_denied') return done('/github-issue-declined.html')
    throw new OAuthError(400, 'invalid-oauth-state')
  }
  const client = issueClient(config)
  const tokens = await exchangeCode(config, code, now, fetchImpl, client)
  const identity = await fetchIdentity(tokens.accessToken, fetchImpl)
  if (identity.githubUserId !== await db.getUserGithubId(session.userId)) throw new OAuthError(403, 'github-account-mismatch')
  const current = await db.sessionWithUser(session.id, Date.now())
  if (!current || current.user.role === 'none' || current.session.userId !== session.userId) throw new OAuthError(401, 'unauthenticated')
  // A separate repository App's token gets its own slot; login never replaces it.
  await db.setUserTokens(session.userId, tokens, client.slot)
  return done('/github-issue-authorized.html')
}

export function issueUserToken(config: ManagedConfig, db: ManagedDb, userId: string, fetchImpl: typeof fetch = fetch) {
  return ensureUserAccessToken(config, db, userId, Date.now(), fetchImpl, issueClient(config))
}
