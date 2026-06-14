// Managed-server boot config (SYNC_MODE=managed), parsed once at startup and
// failing fast on a missing / invalid required value — the same discipline as
// server-e2e/config.ts. Auth (GitHub identity + sessions) is required; optional
// GitHub App credentials enable READ-ONLY repository connections; the sync
// protocol is not parsed here yet.
import { env } from 'node:process'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export interface ManagedConfig {
  port: number
  host: string
  dbPath: string
  debug: boolean
  trustProxyEnv: string | undefined
  // GitHub App user-authorization (identity) credentials — the App's client id
  // + secret, used by the login flow.
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
  // Optional GitHub App credentials for repository connections (READ-ONLY): the
  // App id + PEM private key mint installation tokens to LIST connected repos;
  // the slug builds the install URL. All absent → the repos feature is off.
  githubAppId: string | null
  githubAppPrivateKey: string | null
  githubAppSlug: string | null
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
    githubAppId: env['GITHUB_APP_ID'] ?? null,
    githubAppPrivateKey: normalizePem(env['GITHUB_APP_PRIVATE_KEY']),
    githubAppSlug: env['GITHUB_APP_SLUG'] ?? null,
  }
}

// PEM private keys are awkward in env vars; accept a literal multi-line value or
// one with escaped newlines (`\n`). Empty/absent → null (repos feature off).
function normalizePem(raw: string | undefined): string | null {
  if (raw == null || raw === '') return null
  return raw.includes('\\n') ? raw.replaceAll('\\n', '\n') : raw
}
