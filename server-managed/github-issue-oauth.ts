import type { ManagedConfig } from './config.ts'
import type { ManagedDb, ManagedSession } from './db.ts'
import { ISSUE_STATE_COOKIE, clearCookie, cookieName } from './session.ts'
import { OAuthError, exchangeCode, fetchIdentity, sessionAuthorization, sessionStateValid, stateCookieMatches } from './github-oauth.ts'

export const ISSUE_LOGIN_PATH = '/api/oauth/github/issues/login'

export function isIssueOAuthCallback(config: ManagedConfig, query: URLSearchParams, cookie: string | undefined): boolean {
  return stateCookieMatches(config, ISSUE_STATE_COOKIE, query, cookie)
}

export function issueLoginRedirect(config: ManagedConfig, session: ManagedSession, now = Date.now()) {
  // Reauthorize the same app for the current account, without replacing the
  // DeepView session or permitting an OAuth account switch during creation.
  const { url, setCookie } = sessionAuthorization(config, ISSUE_STATE_COOKIE, session, now)
  return { location: url.href, setCookie }
}

export async function issueOAuthCallback(config: ManagedConfig, db: ManagedDb, session: ManagedSession,
  query: URLSearchParams, cookie: string | undefined, fetchImpl: typeof fetch = fetch, now = Date.now()) {
  const code = query.get('code')
  if (!code || !sessionStateValid(config, ISSUE_STATE_COOKIE, session, query, cookie, now)) throw new OAuthError(400, 'invalid-oauth-state')
  const tokens = await exchangeCode(config, code, now, fetchImpl)
  const identity = await fetchIdentity(tokens.accessToken, fetchImpl)
  if (identity.githubUserId !== await db.getUserGithubId(session.userId)) throw new OAuthError(403, 'github-account-mismatch')
  const current = await db.sessionWithUser(session.id, Date.now())
  if (!current || current.user.role === 'none' || current.session.userId !== session.userId) throw new OAuthError(401, 'unauthenticated')
  await db.setUserTokens(session.userId, tokens)
  return { location: '/github-issue-authorized.html', setCookie: clearCookie(cookieName(config, ISSUE_STATE_COOKIE), config.cookieSecure) }
}
