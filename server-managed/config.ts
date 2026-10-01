// Managed-server boot config. GitHub user authorization establishes identity;
// optional App installation credentials enable repository access. A single
// GitHub App can provide both flows, with repository grants at installation.
import { env } from 'node:process'
import { databaseUrls } from '../server-common/database-config.ts'
import { MAX_UPLOAD_BYTES } from './uploads.ts'
import { parseStorageKey } from '../server-common/storage-crypto.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export interface ManagedConfig {
  port: number
  host: string
  dbPath: string
  neonUrl?: string | null
  blobToken?: string | null
  storageEncryptionKey?: string | null
  storageEncryptionMigrate?: boolean
  storageEncryptionMigrateMaxMs?: number
  vercelPreview?: boolean
  serverless?: boolean
  debug: boolean
  allowShare: boolean
  trustProxyEnv: string | undefined
  // GitHub App user-authorization (identity) credentials — the App's client id
  // + secret, used by the login flow.
  githubClientId: string
  githubClientSecret: string
  // Preapproved GitHub identity promoted on login when it is the only user
  // and its role is No access, including a login after registration.
  initialAdminGithubId: number | null
  // Absolute callback registered with GitHub, e.g.
  // 'https://triage.example.com/api/oauth/github/callback'.
  oauthCallbackUrl: string
  // Whether cookies carry `Secure` (callback is https). Also gates the
  // `__Host-` prefix, so loopback http dev can run with a plain cookie name.
  cookieSecure: boolean
  sessionCookieName: string
  sessionTtlMs: number
  // Optional installation credentials for the same GitHub App as login.
  // Repository permissions are approved when connecting repositories.
  githubAppId: string | null
  githubAppPrivateKey: string | null
  githubAppSlug: string | null
  githubNewIssueLabels?: string
  // Max accepted size (bytes) for an uploaded report on the "Manage reports"
  // page. Reports are findings dumps (JSON / markdown / CSV), small to a few MB.
  maxReportBytes: number
  // Max accepted size (bytes) for an uploaded bundle (sourcemap / stasis
  // archive). Bundles run larger than reports, so a higher cap (default 200 MiB).
  maxBundleBytes: number
  // How many triage-trail events to keep per finding (managed_finding_triage_event):
  // 0, the default, keeps everything — the trail is the record. An operator
  // who would rather bound the store sets a positive count; older events of a
  // finding are then trimmed as new ones land.
  triageHistoryLimit: number
}

function fail(msg: string): never {
  throw new Error(msg)
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

function optionalGithubId(name: string): number | null {
  const raw = env[name]
  if (raw == null || raw === '') return null
  const id = Number(raw)
  if (!/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(id)) {
    fail(`Invalid ${name}: must be a single positive numeric GitHub user ID.`)
  }
  return id
}

function urlOrFail(name: string, raw: string): URL {
  try { return new URL(raw) } catch { fail(`${name} is not a valid URL: ${raw}`) }
}

export function loadManagedConfig({ combined = false } = {}): ManagedConfig {
  const serverless = env['VERCEL'] === '1'
  const neonUrl = databaseUrls({ combined }).managed
  const blobToken = env['BLOB_READ_WRITE_TOKEN'] || null
  const storageEncryptionKey = env['MANAGED_STORAGE_ENCRYPTION_KEY'] || null
  parseStorageKey(storageEncryptionKey)
  const storageEncryptionMigrate = env['MANAGED_STORAGE_ENCRYPTION_MIGRATE'] === '1'
  if (storageEncryptionMigrate && !storageEncryptionKey) fail('MANAGED_STORAGE_ENCRYPTION_MIGRATE requires MANAGED_STORAGE_ENCRYPTION_KEY.')
  if (serverless && !neonUrl) fail('Vercel managed mode requires DATABASE_URL or MANAGED_DATABASE_URL.')
  if (neonUrl && !blobToken) fail('Managed Neon mode requires BLOB_READ_WRITE_TOKEN.')
  const host = env['HOST'] ?? '127.0.0.1'
  const oauthCallbackUrl = requireStr('OAUTH_CALLBACK_URL')
  const callback = urlOrFail('OAUTH_CALLBACK_URL', oauthCallbackUrl)
  const cookieSecure = callback.protocol === 'https:'
  // A `__Host-` cookie mandates `Secure`, so any non-loopback bind must be
  // HTTPS — fail fast (mirrors server-e2e's boot check). Loopback dev over
  // http is allowed with a non-prefixed cookie name.
  if ((serverless || !LOOPBACK_HOSTS.has(host)) && !cookieSecure) {
    fail(`Vercel or non-loopback HOST=${host} requires an https OAUTH_CALLBACK_URL — the session cookie needs Secure.`)
  }
  const sessionCookieName = env['SESSION_COOKIE_NAME'] ?? '__Host-dvsid'
  if (sessionCookieName.startsWith('__Host-') && !cookieSecure) {
    fail(`SESSION_COOKIE_NAME=${sessionCookieName} uses the __Host- prefix but the callback is not https. Use a non-prefixed name for loopback http dev.`)
  }
  return {
    neonUrl, blobToken, serverless, storageEncryptionKey, storageEncryptionMigrate,
    storageEncryptionMigrateMaxMs: intEnv('MANAGED_STORAGE_ENCRYPTION_MIGRATE_MAX_MS', 150_000, 1, serverless ? 240_000 : 3_600_000),
    vercelPreview: env['VERCEL_ENV'] === 'preview',
    port: intEnv('PORT', 8765, 0, 65535),
    host,
    // DB_PATH belongs to e2e in a combined process. Keep the two stores apart.
    dbPath: env['MANAGED_DB_PATH'] ?? (combined ? undefined : env['DB_PATH']) ?? 'server-managed/data/managed.db',
    debug: env['DEBUG'] === '1' || env['DEBUG'] === 'true',
    allowShare: env['DEEPVIEW_ALLOW_SHARE'] === '1',
    trustProxyEnv: env['TRUST_PROXY'] ?? (serverless ? '1' : undefined),
    githubClientId: requireStr('GITHUB_CLIENT_ID'),
    githubClientSecret: requireStr('GITHUB_CLIENT_SECRET'),
    initialAdminGithubId: optionalGithubId('MANAGED_INITIAL_ADMIN_GITHUB_ID'),
    oauthCallbackUrl,
    cookieSecure,
    sessionCookieName,
    sessionTtlMs: intEnv('SESSION_TTL_MS', 1_209_600_000, 60_000, 7_776_000_000),
    githubAppId: env['GITHUB_APP_ID'] ?? null,
    githubAppPrivateKey: normalizePem(env['GITHUB_APP_PRIVATE_KEY']),
    githubAppSlug: env['GITHUB_APP_SLUG'] ?? null,
    githubNewIssueLabels: env['GITHUB_NEW_ISSUE_LABELS'] ?? '',
    maxReportBytes: intEnv('MAX_REPORT_BYTES', 10_485_760, 1, 104_857_600),
    maxBundleBytes: intEnv('MAX_BUNDLE_BYTES', 209_715_200, 1, MAX_UPLOAD_BYTES),
    triageHistoryLimit: intEnv('TRIAGE_HISTORY_LIMIT', 0, 0, 1_000_000_000),
  }
}

// PEM private keys are awkward in env vars; accept a literal multi-line value or
// one with escaped newlines (`\n`). Empty/absent → null (private repos off).
function normalizePem(raw: string | undefined): string | null {
  if (raw == null || raw === '') return null
  return raw.includes('\\n') ? raw.replaceAll('\\n', '\n') : raw
}
