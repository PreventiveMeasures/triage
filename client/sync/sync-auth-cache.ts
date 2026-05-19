// Shared in-memory + secure-storage cache for the operator-side sync
// password. Both `client/triage-sync.ts` and `client/objstore.ts`
// authenticate independently (separate WebSocket per session, separate
// per-socket `socketAuthorized` flag on the server), so both need the
// same cached password to silently replay on reconnect / re-upload.
//
// Storage shape:
//   * In-memory `inMemory` is the source of truth for synchronous
//     reads from session code (cheap lookup; no async hop required
//     between an `unauthorized` arriving and the silent retry going
//     out).
//   * `deepview.sync.password` in secure-storage is the persisted
//     mirror. When the passkey vault is enabled + unlocked the
//     envelope is encrypted under the vault key; when the vault is
//     disabled it's stored as plaintext, matching the same envelope
//     contract every other entry in `SECURE_KEYS` uses.
//
// The single-key (no per-server scoping) shape is deliberate: a user
// realistically targets one sync relay at a time, and per-server
// scoping would require threading the URL through every getter /
// setter. Server-switch invalidation lives in triage-sync's
// `setServerUrl` (only fires when switching between two different
// non-empty URLs — the boot-time initial set and the off-toggle are
// not invalidations).

import { getItem as getSecureItem, removeItem as removeSecureItem, setItem as setSecureItem } from '../secure-storage.js'

const KEY = 'deepview.sync.password'

let inMemory: string | null = null

// Synchronous read for the session-side `runAuthFlow` paths. Returns
// `null` when nothing is cached (fresh boot pre-hydrate, or after a
// server-switch invalidation / explicit wipe).
export function getCachedSyncPassword(): string | null {
  return inMemory
}

// Called from `onSecureStorageHydrated` in triage-sync (the
// once-per-boot hydrate listener) to populate `inMemory` from the
// just-decrypted secure-storage cache. Both triage-sync and objstore
// read through `getCachedSyncPassword` after this, so a single
// hydrate listener is enough.
export function loadCachedSyncPasswordFromStorage(): void {
  const raw = getSecureItem(KEY)
  inMemory = typeof raw === 'string' && raw.length > 0 ? raw : null
}

// Persist (or wipe) the cached password. Updates `inMemory`
// synchronously so subsequent synchronous reads see the new value
// before the secure-storage write resolves; the write is awaited so
// callers can decide whether to surface a persistence failure (today
// every caller logs and continues — caching is best-effort).
export async function setCachedSyncPassword(password: string | null): Promise<void> {
  inMemory = password
  if (password == null) removeSecureItem(KEY)
  else await setSecureItem(KEY, password)
}
