// Session + cookie plumbing for the managed auth server. The raw session
// token lives ONLY in the cookie; the DB row id is its SHA-256 (see crypto.ts)
// so a DB read can't reconstruct a live cookie. A double-submit CSRF token is
// minted per session and returned to the client (echoed back on mutations).
//
// Async throughout — the store (db.ts) is async so a future non-SQLite
// backend slots in without touching these helpers.
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, ManagedSession, ManagedUser } from './db.ts'
import { hashToken, randomToken } from './crypto.ts'

// Base name for the short-lived OAuth-state cookie; `__Host-` is prefixed via
// `cookieName` when cookies are Secure.
export const STATE_COOKIE = 'dvstate'

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
// set and the CSRF token (also persisted on the row).
export async function createSession(
  config: ManagedConfig, db: ManagedDb, user: ManagedUser, now: number,
): Promise<{ setCookie: string; csrfToken: string }> {
  const token = randomToken()
  const csrfToken = randomToken()
  await db.upsertUser(user, now)
  await db.createSession({ id: hashToken(token), githubUserId: user.githubUserId, csrfToken, expiresAt: now + config.sessionTtlMs }, now)
  const setCookie = buildCookie(config.sessionCookieName, token, {
    maxAgeS: Math.floor(config.sessionTtlMs / 1000), secure: config.cookieSecure, sameSite: 'Lax',
  })
  return { setCookie, csrfToken }
}

// Resolve the current session (+ user) from the request's cookies, or null.
export function readSession(
  config: ManagedConfig, db: ManagedDb, cookieHeader: string | undefined, now: number,
): Promise<{ session: ManagedSession; user: ManagedUser } | null> {
  const token = parseCookies(cookieHeader).get(config.sessionCookieName)
  if (token == null || token === '') return Promise.resolve(null)
  return db.sessionWithUser(hashToken(token), now)
}

// Drop the session named by the request's cookie (logout). The caller also
// clears the cookie client-side.
export async function endSession(config: ManagedConfig, db: ManagedDb, cookieHeader: string | undefined): Promise<void> {
  const token = parseCookies(cookieHeader).get(config.sessionCookieName)
  if (token != null && token !== '') await db.deleteSession(hashToken(token))
}
