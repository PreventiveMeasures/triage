// An administrator's read-only view as another user, for checking what that
// account can access. The view is a session row for the viewed user (so every
// access check applies that user's role, teams and permissions unchanged) tied
// to the admin's own session, carried in its own cookie beside the session
// cookie. Ending the admin session, or the admin role, ends the view.
//
// The router refuses writes for any request that carries the view cookie, and
// such requests never act with the viewed user's GitHub credentials: GitHub
// data that needs them is left out instead.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, ManagedSession } from './db.ts'
import { hashToken, randomToken } from './crypto.ts'
import { VIEW_COOKIE, buildCookie, clearCookie, cookieName, parseCookies } from './session.ts'

export const VIEW_AS_PATH = '/api/auth/view-as'
export const VIEW_ONLY_ERROR = 'view-only'

export function viewCookieName(config: ManagedConfig): string {
  return cookieName(config, VIEW_COOKIE)
}

// The raw view token, or null when the request carries no view.
export function viewToken(config: ManagedConfig, cookieHeader: string | undefined): string | null {
  const token = parseCookies(cookieHeader).get(viewCookieName(config))
  return token == null || token === '' ? null : token
}

export function clearViewCookie(config: ManagedConfig): string {
  return clearCookie(viewCookieName(config), config.cookieSecure)
}

// Open a view as `userId` from the admin's `session`, replacing any earlier
// view of that session. Null when the database refuses it (see createViewSession).
export async function startViewSession(config: ManagedConfig, db: ManagedDb, session: ManagedSession, userId: string, now: number): Promise<string | null> {
  const token = randomToken()
  const ok = await db.createViewSession({ id: hashToken(token), viewerSessionId: session.id, userId, csrfToken: randomToken() }, now)
  if (!ok) return null
  return buildCookie(viewCookieName(config), token, {
    maxAgeS: Math.max(0, Math.floor((session.expiresAt - now) / 1000)), secure: config.cookieSecure, sameSite: 'Lax',
  })
}

export async function endViewSession(config: ManagedConfig, db: ManagedDb, cookieHeader: string | undefined): Promise<void> {
  const token = viewToken(config, cookieHeader)
  if (token != null) await db.deleteSession(hashToken(token))
}

const viewing = new AsyncLocalStorage<boolean>()

export function runViewing<T>(active: boolean, work: () => T): T {
  return active ? viewing.run(true, work) : work()
}

// Whether the current request is an admin's view as another user.
export function isViewing(): boolean {
  return viewing.getStore() === true
}
