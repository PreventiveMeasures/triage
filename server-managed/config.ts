// Managed-server boot config (SYNC_MODE=managed), parsed once at startup and
// failing fast on a missing / invalid required value — the same discipline as
// server-e2e/config.ts. This first slice is AUTH ONLY (GitHub identity +
// sessions); GitHub App installation tokens, repo discovery, and the sync
// protocol are intentionally NOT parsed here yet.
import { env } from 'node:process'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export interface ManagedConfig {
  port: number
  host: string
  dbPath: string
  debug: boolean
  trustProxyEnv: string | undefined
  // GitHub user-to-server OAuth (identity). For a GitHub App these are the
  // App's client credentials; the App id / private key (installation tokens)
  // arrive with the later repo-discovery work, not here.
  githubClientId: string
  githubClientSecret: string
  // Absolute callback registered with GitHub, e.g.
  // 'https://triage.example.com/api/oauth/github/callback'.
  oauthCallbackUrl: string
  // Whether cookies carry `Secure` (callback is https). Also gates the
  // `__Host-` prefix, so loopback http dev can run with a plain cookie name.
  cookieSecure: boolean
  sessionCookieName: string
  sessionTtlMs: number
}

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

function requireStr(name: string): string {
  const v = env[name]
  if (v == null || v === '') fail(`Missing required env ${name} (managed mode).`)
  return v
}

function intEnv(name: string, def: number, min: number, max: number): number {
  const raw = env[name]
  const n = raw == null ? def : Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    fail(`Invalid ${name}: ${raw} — must be an integer in [${min}, ${max}].`)
  }
  return n
}

function urlOrFail(name: string, raw: string): URL {
  try { return new URL(raw) } catch { fail(`${name} is not a valid URL: ${raw}`) }
}

export function loadManagedConfig(): ManagedConfig {
  const host = env['HOST'] ?? '127.0.0.1'
  const oauthCallbackUrl = requireStr('OAUTH_CALLBACK_URL')
  const callback = urlOrFail('OAUTH_CALLBACK_URL', oauthCallbackUrl)
  const cookieSecure = callback.protocol === 'https:'
  // A `__Host-` cookie mandates `Secure`, so any non-loopback bind must be
  // HTTPS — fail fast (mirrors server-e2e's boot check). Loopback dev over
  // http is allowed with a non-prefixed cookie name.
  if (!LOOPBACK_HOSTS.has(host) && !cookieSecure) {
    fail(`HOST=${host} is not loopback but OAUTH_CALLBACK_URL is not https — the session cookie needs Secure.`)
  }
  const sessionCookieName = env['SESSION_COOKIE_NAME'] ?? '__Host-dvsid'
  if (sessionCookieName.startsWith('__Host-') && !cookieSecure) {
    fail(`SESSION_COOKIE_NAME=${sessionCookieName} uses the __Host- prefix but the callback is not https. Use a non-prefixed name for loopback http dev.`)
  }
  return {
    port: intEnv('PORT', 8765, 1, 65535),
    host,
    dbPath: env['DB_PATH'] ?? 'server-managed/data/managed.db',
    debug: env['DEBUG'] === '1' || env['DEBUG'] === 'true',
    trustProxyEnv: env['TRUST_PROXY'],
    githubClientId: requireStr('GITHUB_CLIENT_ID'),
    githubClientSecret: requireStr('GITHUB_CLIENT_SECRET'),
    oauthCallbackUrl,
    cookieSecure,
    sessionCookieName,
    sessionTtlMs: intEnv('SESSION_TTL_MS', 1_209_600_000, 60_000, 7_776_000_000),
  }
}
