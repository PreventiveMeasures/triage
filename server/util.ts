// Small cross-cutting helpers shared across the relay (both the
// triage-sync root plane and the objstore plane). Kept in one module
// so the one-liners don't scatter / drift across call sites.

import { randomBytes } from 'node:crypto'

// Truncate a base64url tag for `DEBUG=1` logging. A full workspaceTag
// is an Ed25519 public key; operator logs shouldn't carry it verbatim.
export function debugTag(s: string): string { return `${s.slice(0, 12)}…` }

// 16 random bytes → 22 base64url chars (no padding). The shared shape
// for per-socket challenge nonces, staging ids, and commit-lock holder
// ids — collision is 1/2^128. `isValidStagingId` in objstore/store.ts
// validates exactly this shape.
export function randomId(): string { return randomBytes(16).toString('base64url') }

// Log-friendly view of an unknown throw. `errMsg` for the common
// one-line warning, `errStack` where a post-mortem wants the throw
// site. Both fall back to `String(err)` for a non-Error throw rather
// than leaking `[object Object]` into a template literal; an Error's
// `.message` / `.stack` is already a string, so the common path is
// unchanged.
export function errMsg(err: unknown): string { return (err as Error)?.message ?? String(err) }
export function errStack(err: unknown): string { return (err as Error)?.stack ?? String(err) }
