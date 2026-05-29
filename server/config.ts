// Boot configuration: parse + validate every external input (env
// vars, the optional config.json) into one immutable `Config`, failing
// loud on malformed values so a typo surfaces at startup rather than
// deep in `node:net` / at the first token verification. Pure parsing —
// no backends opened, no crypto keys derived, no side effects beyond
// `--help` / fail-fast `process.exit`. index.ts destructures the
// result and does the wiring (backend selection, password HMAC, …).

import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { argv, env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export type Config = {
  port: number
  host: string
  dbPath: string
  objstoreDir: string
  reapIntervalMs: number
  maxInflightPerSocket: number
  debug: boolean
  neonUrl: string | null
  blobToken: string | null
  tokenSecret: Uint8Array<ArrayBuffer> | null
  password: string | null
  trustProxyEnv: string | undefined
}

// Parse + range-validate an integer env var, exiting with a clear
// up-front message on a malformed value — a NaN from `Number("abc")`
// otherwise surfaces as a confusing crash deep inside `node:net`
// (`WebSocketServer({ port: NaN })`) or a 0-ms `setInterval` loop. An
// absent var falls back to `def` (assumed in-range). One shape for
// every integer env var so they validate + fail identically; `hint`
// appends operator guidance (range meaning, default) to the error.
function intEnv(name: string, def: number, min: number, max: number, hint = ''): number {
  const raw = env[name]
  const n = raw == null ? def : Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    console.error(`Invalid ${name}: ${raw} — must be an integer in [${min}, ${max}].${hint ? ` ${hint}` : ''}`)
    process.exit(1)
  }
  return n
}

const HELP = `Usage: node server/index.ts
Environment:
  PORT                       listen port (default 8765)
  HOST                       bind host (default 127.0.0.1)
  DB_PATH                    sqlite file (default: server/data/data.db);
                             ignored when DATABASE_URL is set
  DATABASE_URL               Neon Postgres connection string; if set,
                             selects the Neon backend instead of
                             SQLite. Requires the optional peer dep
                             @neondatabase/serverless. The Neon
                             pairing additionally requires
                             BLOB_READ_WRITE_TOKEN (Vercel Blob
                             Private Storage) for the byte plane —
                             local-FS bytes cannot back a multi-
                             replica DB plane.
  BLOB_READ_WRITE_TOKEN      Vercel Blob R/W token (private store).
                             Required when DATABASE_URL is set;
                             ignored otherwise. Requires the optional
                             peer dep @vercel/blob.
  OBJSTORE_TOKEN_SECRET      Base64 (32 bytes) HMAC secret for REST
                             bearer tokens. REQUIRED when DATABASE_URL
                             is set (multi-replica deployments: a
                             token minted on one replica's WS plane
                             must validate on another replica's REST
                             plane). Optional under SQLite (a fresh
                             per-process secret is minted at boot).
                             Generate one with:
                               node -e 'console.log(crypto.randomBytes(32).toString("base64"))'
  OBJSTORE_DIR               object store root (default: ./objstore
                             next to DB_PATH). Used by the local-FS
                             byte plane only; ignored when
                             DATABASE_URL + BLOB_READ_WRITE_TOKEN
                             are set (bytes live in Vercel Blob).
  OBJSTORE_REAP_INTERVAL_MS  orphan reaper period (default 600000)
  TRUST_PROXY                set '1' / 'true' to honour X-Forwarded-
                             Host / X-Forwarded-Proto when computing
                             the same-origin gate's expected origin.
                             Default: ON when HOST is a loopback
                             (127.0.0.1, ::1, localhost) — the typical
                             "behind nginx on same host" deployment.
                             OFF for public binds (HOST=0.0.0.0 etc.)
                             where a bare X-Forwarded-* would
                             otherwise let an attacker page bypass
                             the gate.
  MAX_INFLIGHT_PER_SOCKET    per-socket in-flight async-handler
                             cap; saves dropped past this fire a
                             typed 'busy' workspace-save-error
                             NACK. Default 64. Lower for tests
                             that need to deterministically
                             exercise the cap.
  CONFIG_PATH                operator config JSON path (default:
                             server/config.json). Currently the
                             only field is { "password": "..." }
                             which gates first-action creation of
                             a new workspace on the
                             authenticate { password } handshake.
                             Missing file / null password →
                             no gating (default).
  DEBUG=1                    log every message`

type ServerConfigFile = { password?: string | null }

// Optional operator-side config file. Absence is silently fine
// (preserves the no-auth default). Parse errors fail loud so a typo
// doesn't silently fall back to "no auth required".
function readServerConfigFile(path: string): ServerConfigFile {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    console.error(`Failed to read ${path}:`, (err as Error)?.message ?? err); process.exit(1)
  }
  try { return JSON.parse(raw) as ServerConfigFile }
  catch (err) {
    console.error(`Failed to parse ${path} as JSON:`, (err as Error)?.message ?? err); process.exit(1)
  }
}

// Decode + length-check the REST-token HMAC secret upfront so a
// misconfigured secret fails at boot, not at the first verification.
// `Buffer.from(s, 'base64')` does NOT throw on invalid input — it
// silently strips non-alphabet chars, so a typo like `+→-` decodes to
// a DIFFERENT secret. Detect by re-encoding and comparing (modulo `=`).
function decodeTokenSecret(raw: string): Uint8Array<ArrayBuffer> {
  // Trim whitespace — a copy-pasted env value often ends in `\n` and
  // Buffer.from(..., 'base64') would silently strip it, then the
  // typo-detector below would fail with a misleading message.
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    console.error('OBJSTORE_TOKEN_SECRET is empty after trimming whitespace')
    process.exit(1)
  }
  const decoded = Buffer.from(trimmed, 'base64')
  const reencoded = decoded.toString('base64')
  const norm = (s: string): string => s.replace(/=+$/u, '')
  if (norm(reencoded) !== norm(trimmed)) {
    console.error('OBJSTORE_TOKEN_SECRET contains non-base64 characters (likely a typo, e.g. base64url chars in a base64 secret).')
    console.error('Regenerate with: node -e \'console.log(require("crypto").randomBytes(32).toString("base64"))\'')
    process.exit(1)
  }
  if (decoded.byteLength !== 32) {
    console.error(`OBJSTORE_TOKEN_SECRET must decode to 32 bytes (got ${decoded.byteLength})`)
    process.exit(1)
  }
  // Copy into a fresh ArrayBuffer so the type matches
  // `Uint8Array<ArrayBuffer>` (Buffer may be SharedArrayBuffer-backed).
  return new Uint8Array(decoded)
}

export function loadConfig(): Config {
  // 0 = OS-assigned ephemeral port (the test harness boots with PORT=0).
  const port = intEnv('PORT', 8765, 0, 65535)
  const host = env['HOST'] ?? '127.0.0.1'
  // `fileURLToPath` decodes percent-escapes / non-ASCII path segments;
  // `new URL(...).pathname` would leave `%20` raw.
  const dbPath = env['DB_PATH'] ?? fileURLToPath(new URL('./data/data.db', import.meta.url))
  // `path.join` so a Windows DB_PATH doesn't get a mixed-separator child.
  const objstoreDir = env['OBJSTORE_DIR'] ?? join(dirname(dbPath), 'objstore')
  // No practical upper bound beyond the safe-integer range.
  const reapIntervalMs = intEnv('OBJSTORE_REAP_INTERVAL_MS', 10 * 60 * 1000, 1, Number.MAX_SAFE_INTEGER)
  const debug = env['DEBUG'] === '1'

  const configPath = env['CONFIG_PATH'] ?? fileURLToPath(new URL('./config.json', import.meta.url))
  const serverConfig = readServerConfigFile(configPath)
  const rawPassword = serverConfig.password
  if (rawPassword != null && typeof rawPassword !== 'string') {
    console.error(`Invalid ${configPath}: "password" must be a string or null`); process.exit(1)
  }
  const password = rawPassword ?? null
  // Upper bound 65_536 — bounds memory under hostile load; a deployer
  // passing MAX_SAFE_INTEGER would silently defeat the cap. Validated
  // here, after the config.json / password parse, to keep the
  // error-precedence order.
  const maxInflightPerSocket = intEnv('MAX_INFLIGHT_PER_SOCKET', 64, 1, 65_536)

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    process.exit(0)
  }

  const neonUrl = env['DATABASE_URL'] ?? null
  const blobToken = env['BLOB_READ_WRITE_TOKEN'] ?? null
  const tokenSecretB64 = env['OBJSTORE_TOKEN_SECRET'] ?? null
  const tokenSecret = tokenSecretB64 ? decodeTokenSecret(tokenSecretB64) : null

  return {
    port, host, dbPath, objstoreDir, reapIntervalMs, maxInflightPerSocket,
    debug, neonUrl, blobToken, tokenSecret, password,
    trustProxyEnv: env['TRUST_PROXY'],
  }
}
