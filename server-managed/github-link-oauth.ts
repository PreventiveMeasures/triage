// Linking another GitHub account to the signed-in user (github-links.ts): the
// App's user authorization again, completed by the account to link. GitHub is
// asked for its account picker, as the browser is usually signed in to the
// account the user signs in here with. The token GitHub grants reads the
// account's identity and avatar; it is never stored.
import type { AvatarStore } from './avatar-store.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, ManagedSession } from './db.ts'
import { randomToken, safeEqual } from './crypto.ts'
import { LINK_STATE_COOKIE, buildCookie, clearCookie, cookieName, parseCookies } from './session.ts'
import { OAuthError, cacheAvatar, exchangeCode, fetchIdentity } from './github-oauth.ts'
import { ManagedMutationError } from './management.ts'

export const LINK_LOGIN_PATH = '/api/oauth/github/link'
// The profile page, where linking starts and its callback lands.
const PROFILE_PATH = '/my/profile'
const STATE_TTL_MS = 600_000

export function isLinkOAuthCallback(config: ManagedConfig, query: URLSearchParams, cookie: string | undefined): boolean {
  const expected = parseCookies(cookie).get(cookieName(config, LINK_STATE_COOKIE))?.split('.')[0]
  return !!expected && safeEqual(query.get('state') ?? '', expected)
}

// The state is bound to the session that started linking, so the account
// links to the user who asked, never to whoever is signed in on return.
export function linkLoginRedirect(config: ManagedConfig, session: ManagedSession, now = Date.now()): { location: string; setCookie: string } {
  const state = randomToken()
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', config.githubClientId)
  url.searchParams.set('redirect_uri', config.oauthCallbackUrl)
  url.searchParams.set('state', state)
  url.searchParams.set('allow_signup', 'false')
  url.searchParams.set('prompt', 'select_account')
  return { location: url.href, setCookie: buildCookie(cookieName(config, LINK_STATE_COOKIE), `${state}.${session.id}.${now}`,
    { secure: config.cookieSecure, maxAgeS: STATE_TTL_MS / 1000, sameSite: 'Lax' }) }
}

// Back from GitHub: link the account that authorized, then land on the
// profile, naming the refusal (`link-error`) when it was refused.
// `linked` is the login of an account linked anew.
export async function linkOAuthCallback(config: ManagedConfig, db: ManagedDb, session: ManagedSession,
  query: URLSearchParams, cookie: string | undefined,
  { avatarStore, fetchImpl = fetch, now = Date.now() }: { avatarStore?: AvatarStore; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<{ location: string; setCookie: string; linked: string | null }> {
  const setCookie = clearCookie(cookieName(config, LINK_STATE_COOKIE), config.cookieSecure)
  try {
    const [expected, sessionId, timestamp] = (parseCookies(cookie).get(cookieName(config, LINK_STATE_COOKIE)) ?? '').split('.')
    const code = query.get('code'), started = Number(timestamp), state = query.get('state')
    if (!state || !expected || !safeEqual(state, expected) || sessionId !== session.id
      || !timestamp || !Number.isFinite(started) || now < started || now - started > STATE_TTL_MS) {
      throw new OAuthError(400, 'invalid-oauth-state')
    }
    // Declined on GitHub's side, which sends an error in place of a code.
    if (!code) throw new OAuthError(400, query.get('error') ? 'github-authorization-declined' : 'invalid-oauth-state')
    const tokens = await exchangeCode(config, code, now, fetchImpl)
    const account = await fetchIdentity(tokens.accessToken, fetchImpl)
    const link = await db.linkGithubAccount(session.id, account, now)
    // Best-effort, as at sign-in: the avatar falls back to an initial.
    if (avatarStore != null && account.avatarUrl != null) {
      await cacheAvatar(avatarStore, link.id, account.avatarUrl, fetchImpl).catch((err) => {
        console.warn('managed: linked avatar cache failed:', err)
      })
    }
    return { location: PROFILE_PATH, setCookie, linked: link.created ? account.login : null }
  } catch (err) {
    if (!(err instanceof OAuthError || err instanceof ManagedMutationError)) throw err
    return { location: `${PROFILE_PATH}?${new URLSearchParams({ 'link-error': err.message })}`, setCookie, linked: null }
  }
}
