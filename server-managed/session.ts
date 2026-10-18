// Session + cookie plumbing for the managed auth server. The raw session
// token lives ONLY in the cookie; the DB row id is its SHA-256 (see crypto.ts)
// so a DB read can't reconstruct a live cookie. A double-submit CSRF token is
// minted per session and returned to the client (echoed back on mutations).
//
// Async throughout — the store (db.ts) is async so a future non-SQLite
// backend slots in without touching these helpers.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, ManagedSession, ManagedUser, StoredUser } from './db.ts'
import { hashToken, randomToken } from './crypto.ts'

// Base name for the short-lived OAuth-state cookie; `__Host-` is prefixed via
// `cookieName` when cookies are Secure.
export const STATE_COOKIE = 'dvstate'

// Base names for GitHub issue authorization state (github-issue-oauth.ts),
// linking another GitHub account (github-link-oauth.ts) and an
// administrator's read-only view as another user (view-as.ts).
export const ISSUE_STATE_COOKIE = 'dvissuestate'
export const LINK_STATE_COOKIE = 'dvlinkstate'
export const VIEW_COOKIE = 'dvview'
// The session cookie cannot share a name with these, or one would overwrite
// or be read as the other.
export const RESERVED_COOKIES: readonly string[] = [STATE_COOKIE, ISSUE_STATE_COOKIE, LINK_STATE_COOKIE, VIEW_COOKIE]

// `__Host-`-prefix the base name when cookies are Secure (the prefix mandates
// Secure + Path=/ + no Domain, which `buildCookie` already emits).
export function cookieName(config: ManagedConfig, base: string): string {
  return config.cookieSecure ? `__Host-${base}` : base
}

export function buildCookie(
  name: string, value: string,
  opts: { maxAgeS: number; secure: boolean; sameSite?: 'Lax' | 'Strict' },
): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${opts.sameSite ?? 'Lax'}`, `Max-Age=${opts.maxAgeS}`]
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

// Expire a cookie now (Max-Age=0).
export function clearCookie(name: string, secure: boolean): string {
  return buildCookie(name, '', { maxAgeS: 0, secure })
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    if (k) out.set(k, part.slice(eq + 1).trim())
  }
  return out
}

// Mint a session for a freshly-authenticated user. Upserts the identity, then
// stores the session keyed by the cookie token's hash. Returns the cookie to
// set and the CSRF token (also persisted on the row), or null for an account
// a user linked to theirs, which can neither sign in nor register.
export async function createSession(
  config: ManagedConfig, db: ManagedDb, user: ManagedUser, now: number,
): Promise<{ setCookie: string; csrfToken: string; userId: string } | null> {
  const token = randomToken()
  const csrfToken = randomToken()
  const userId = await db.upsertUser(user, now, config.initialAdminGithubId)
  if (userId == null) return null
  await db.createSession({ id: hashToken(token), userId, csrfToken, expiresAt: now + config.sessionTtlMs }, now)
  const setCookie = buildCookie(config.sessionCookieName, token, {
    maxAgeS: Math.floor(config.sessionTtlMs / 1000), secure: config.cookieSecure, sameSite: 'Lax',
  })
  return { setCookie, csrfToken, userId }
}

// A request's sign-in, whose presence its first read to find it records.
// Every read after it in that request (the rechecks after its reads of
// storage, GitHub or npm among them) only reads: last_seen_at was written a
// moment before, by the read that let the request in.
const requests = new AsyncLocalStorage<{ seen: boolean }>()
export function runRequestPresence<T>(work: () => T): T {
  return requests.run({ seen: false }, work)
}

// Resolve the current session (+ user) from the request's cookies, or null.
// A view cookie resolves only to that admin's view as another user: a view
// that has ended never falls back to the admin's own session. `own` skips the
// view and reads the signed-in session itself.
export async function readSession(
  config: ManagedConfig, db: ManagedDb, cookieHeader: string | undefined, now: number, { own = false } = {},
): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const cookies = parseCookies(cookieHeader)
  const token = cookies.get(config.sessionCookieName)
  if (token == null || token === '') return null
  const view = own ? undefined : cookies.get(cookieName(config, VIEW_COOKIE))
  const request = requests.getStore(), seen = request?.seen === true
  const s = view != null && view !== ''
    ? await (seen ? db.getViewSessionWithUser : db.viewSessionWithUser)(hashToken(view), hashToken(token), now)
    : await (seen ? db.getSessionWithUser : db.sessionWithUser)(hashToken(token), now)
  if (s && request) request.seen = true
  return s
}

// Drop the session named by the request's cookie (logout). The caller also
// clears the cookie client-side.
export async function endSession(config: ManagedConfig, db: ManagedDb, cookieHeader: string | undefined): Promise<void> {
  const token = parseCookies(cookieHeader).get(config.sessionCookieName)
  if (token != null && token !== '') await db.deleteSession(hashToken(token))
}
