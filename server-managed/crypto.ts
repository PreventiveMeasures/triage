// Token helpers for the managed auth server. The raw session token lives ONLY
// in the cookie; the DB row id is its SHA-256 (see db.ts / session.ts), so a
// DB read can't reconstruct a live cookie. No HMAC pepper is needed — the
// tokens are 256-bit random, not guessable or reversible from their hash.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// 256-bit URL-safe random token: the session cookie value and the OAuth CSRF
// `state` nonce.
export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

// At-rest id for a session cookie token (stored as the managed_session PK).
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url')
}

// Constant-time equality for CSRF / OAuth-state checks. A length mismatch
// short-circuits (the length of these fixed-width tokens isn't a secret).
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
