// Shared in-memory + secure-storage cache for the operator-side sync
// password. The server's password gate is a per-socket flag
// (`Peer.authorized`, server-e2e/peer.ts), so every socket
// `socket-transport.ts` opens for triage-sync and objstore has to
// authenticate on its own, and needs the same cached password to
// silently replay on reconnect.
//
// Storage shape:
//   * `inMemory` is the source of truth for synchronous reads from
//     session code — no async hop between an `unauthorized` arriving
//     and the silent retry going out.
//   * `deepview.sync.password` in secure-storage is the persisted
//     mirror: encrypted under the vault key when the passkey vault is
//     enabled + unlocked, plaintext when disabled — the same envelope
//     contract every other `SECURE_KEYS` entry uses.
//
// The single-key (no per-server scoping) shape is deliberate: a user
// realistically targets one relay at a time, and per-server scoping
// would thread the URL through every getter/setter. Server-switch
// invalidation lives in triage-sync's `setServerUrl`, firing only when
// switching between two different non-empty URLs — the boot-time
// initial set and the off-toggle are not invalidations.

import { syncHost } from './host.ts'

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
  const raw = syncHost().getSecureItem(KEY)
  inMemory = typeof raw === 'string' && raw.length > 0 ? raw : null
}

// Persist (or wipe) the cached password. Updates `inMemory`
// synchronously so synchronous reads see the new value before the
// secure-storage write resolves; the write is awaited so callers can
// surface a persistence failure (today every caller logs and continues
// — caching is best-effort).
export async function setCachedSyncPassword(password: string | null): Promise<void> {
  inMemory = password
  const host = syncHost()
  if (password == null) await host.removeSecureItem(KEY)
  else await host.setSecureItem(KEY, password)
}
