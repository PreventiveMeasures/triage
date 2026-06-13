// HTTP router for the managed auth server. Mounts the GitHub OAuth flow plus
// the session endpoints + the mode probe; there is NO api/sync here (a managed
// server doesn't speak the e2e sync protocol yet). Every handler is async; the
// boot's `track()` keeps in-flight requests drainable on shutdown.
//
//   GET  /api/config             → { mode:'managed', managed:{ loginPath, cookieName } }  (public)
//   GET  /api/oauth/github/login → 302 to GitHub (+ state cookie)
//   GET  /api/oauth/github/callback → the OAuth hook (see github-oauth.ts)
//   GET  /api/auth/session       → { user, csrfToken } | 401
//   GET  /api/auth/avatar        → cached GitHub avatar bytes | 401/404
//   POST /api/auth/logout        → same-origin + CSRF, drops the session
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AvatarStore } from './avatar-store.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb } from './db.ts'
import type { OriginGate } from '../server-common/origin.ts'
import { CONFIG_PATH } from '../common/server-info.ts'
import { CALLBACK_PATH, LOGIN_PATH, OAuthError, buildLoginRedirect, handleCallback } from './github-oauth.ts'
import { clearCookie, endSession, readSession } from './session.ts'

const SESSION_PATH = '/api/auth/session'
const AVATAR_PATH = '/api/auth/avatar'
const LOGOUT_PATH = '/api/auth/logout'

export interface ManagedHttpDeps {
  config: ManagedConfig
  db: ManagedDb
  avatarStore: AvatarStore
  originGate: OriginGate
  isShuttingDown: () => boolean
  track: (p: Promise<unknown>) => void
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

function send405(res: ServerResponse, allow: string): void {
  sendJson(res, 405, { error: 'method-not-allowed' }, { allow })
}

function firstHeader(v: string | string[] | undefined): string | null {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.length > 0) return v[0] ?? null
  return null
}

export function createManagedRequestHandler(deps: ManagedHttpDeps): Handler {
  const { config, db, avatarStore, originGate, isShuttingDown, track } = deps

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const cookie = req.headers.cookie

    // Public mode probe — lets a client detect the managed protocol up front.
    if (path === CONFIG_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      sendJson(res, 200, { mode: 'managed', managed: { loginPath: LOGIN_PATH, cookieName: config.sessionCookieName } })
      return
    }
    // OAuth: start → redirect to GitHub with the CSRF state cookie.
    if (path === LOGIN_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const { location, setCookie } = buildLoginRedirect(config)
      res.writeHead(302, { location, 'set-cookie': setCookie, 'cache-control': 'no-store' })
      res.end()
      return
    }
    // OAuth: callback (the GitHub hook) → mint a session, land on the app.
    if (path === CALLBACK_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      try {
        const result = await handleCallback(url.searchParams, cookie, { config, db, avatarStore })
        res.writeHead(302, { location: result.location, 'set-cookie': result.setCookies, 'cache-control': 'no-store' })
        res.end()
      } catch (err) {
        if (err instanceof OAuthError) sendJson(res, err.status, { error: err.message })
        else throw err
      }
      return
    }
    // Who am I?
    if (path === SESSION_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = await readSession(config, db, cookie, Date.now())
      if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
      sendJson(res, 200, {
        user: { id: s.user.uuid, login: s.user.login, name: s.user.name },
        csrfToken: s.session.csrfToken,
      })
      return
    }
    // Cached GitHub avatar, served same-origin (the page CSP forbids github's CDN).
    if (path === AVATAR_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = await readSession(config, db, cookie, Date.now())
      if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
      const avatar = await avatarStore.get(s.user.uuid)
      if (avatar == null) { sendJson(res, 404, { error: 'no-avatar' }); return }
      res.writeHead(200, {
        'content-type': avatar.contentType,
        'content-length': String(avatar.bytes.length),
        'cache-control': 'private, max-age=600',
      })
      res.end(avatar.bytes)
      return
    }
    // Logout — a mutation: same-origin gate + double-submit CSRF.
    if (path === LOGOUT_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      if (!originGate.isOriginAllowed(req)) { sendJson(res, 403, { error: 'origin-denied' }); return }
      const s = await readSession(config, db, cookie, Date.now())
      const csrf = firstHeader(req.headers['x-csrf-token'])
      if (s == null || csrf == null || csrf !== s.session.csrfToken) { sendJson(res, 403, { error: 'csrf' }); return }
      await endSession(config, db, cookie)
      res.writeHead(204, { 'set-cookie': clearCookie(config.sessionCookieName, config.cookieSecure), 'cache-control': 'no-store' })
      res.end()
      return
    }
    sendJson(res, 404, { error: 'not-found' }, { connection: 'close' })
  }

  return (req, res) => {
    if (isShuttingDown()) { sendJson(res, 503, { error: 'shutting-down' }, { connection: 'close' }); return }
    track(route(req, res).catch((err) => {
      console.warn('managed: request handler error:', err)
      if (res.headersSent) { try { res.destroy() } catch {} }
      else sendJson(res, 500, { error: 'internal' })
    }))
  }
}
