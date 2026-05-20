// Small cross-cutting helpers shared across the relay (both the
// triage-sync root plane and the objstore plane). Kept in one module
// so the one-liners don't scatter / drift across call sites.

import { randomBytes } from 'node:crypto'

// Truncate a base64url tag for `DEBUG=1` logging. A full workspaceTag
// is an Ed25519 public key; operator logs shouldn't carry it verbatim.
export function debugTag(s: string): string { return `${s.slice(0, 12)}…` }

// 16 random bytes → 22 base64url chars (no padding). The shared shape
// for per-socket challenge nonces and staging ids — collision is
// 1/2^128. `isValidStagingId` in objstore/store.ts validates exactly
// this shape.
export function randomId(): string { return randomBytes(16).toString('base64url') }

// Log-friendly view of an unknown throw, for use as a `console.*`
// ARGUMENT (not interpolated into a template literal — see below).
// `errMsg` for the common one-line warning, `errStack` where a
// post-mortem wants the throw site. An Error's `.message` / `.stack`
// is a string; a non-Error throw is returned unchanged so console
// renders it structurally (util.inspect) instead of coercing it to
// the useless `[object Object]`. A template-literal caller would
// coerce the return via `String()` and lose that, so pass these as a
// separate console argument.
export function errMsg(err: unknown): unknown { return (err as Error)?.message ?? err }
export function errStack(err: unknown): unknown { return (err as Error)?.stack ?? err }
