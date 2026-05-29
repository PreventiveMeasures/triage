// Secure-storage layer — wraps a curated set of localStorage keys
// with envelope encryption tied to the passkey vault. Triage data
// (`deepview.triage`) and OPFS report files have their own
// envelope handling for historical / async-correctness reasons;
// THIS module handles everything else that contains user-derived
// metadata or secrets:
//
//   - `deepview.workspaces`        — private keys + workspace meta
//   - `deepview.sync.sessions`     — sync state (cursor / pending)
//   - `deepview.sync.userEnabled`  — sync toggle (existence-leaks)
//   - `deepview.repoUrls`          — per-report repo URLs
//   - `deepview.fileCounts`        — per-report finding counts
//   - `deepview.lastFile`          — last-viewed file/workspace name
//
// Not encrypted (intentional):
//   - `deepview.passkey.v1` / `deepview.passkey.userId` — vault
//     metadata, NOT secret (must be readable to bootstrap unlock).
//   - `deepview.viewMode`, `deepview.sidebarCollapsed`,
//     `deepview.theme`, `deepview.passkey.firstImportPrompted`,
//     `deepview.triageSyncUrl` — UI preferences / non-sensitive flags.
//   - `deepview.triage`, `deepview.triage.pending`, `deepview.report:*`
//     — handled directly in triage.js / storage.js because their
//     async-aware paths predate this module.
//
// Design constraints:
//   1. Read APIs stay SYNCHRONOUS (`getItem`). Many existing
//      callers (`workspaces.listWorkspaces`, the `storage` event
//      handler, module-init code) can't be async. We achieve this
//      by hydrating an in-memory cache once at boot AFTER vault
//      unlock (or immediately when the vault is disabled), then
//      serving reads from the cache.
//   2. Write APIs are ASYNC (`setItem`). Callers update the cache
//      synchronously then await a seal + LS write. The cache stays
//      hot for subsequent reads.
//   3. The full-page lock overlay (`ui/view/lock-overlay.js`)
//      blocks all UI interaction while the vault is enabled-but-
//      locked, so we don't have to serve reads against a locked
//      vault — the cache hydrates on unlock and stays consistent.

import { decodeUtf8, encodeUtf8 } from '../common/utf8.js'
import { hasEnvelopeMagic, openEnvelope, sealEnvelope } from './passkey-crypto.ts'
import { getCurrentIdentityTag, getSessionKey, isEncryptionEnabled, isWipingInThisTab, onVaultStateChange } from './passkey-vault.js'

export const SECURE_KEYS = Object.freeze([
  'deepview.workspaces',
  'deepview.sync.sessions',
  'deepview.sync.userEnabled',
  // Cached operator-side sync password (see triage-sync.ts's
  // first-action-gate handling). Encrypted at rest under the passkey
  // vault when enabled, plaintext otherwise — same envelope
  // contract as every other entry in this list.
  'deepview.sync.password',
  'deepview.repoUrls',
  'deepview.fileCounts',
  'deepview.lastFile',
])

const cache = new Map()
let hydratedOnce = false
// Per-key FIFO promise chain. Without this, two rapid `setItem`
// calls for the same key can have their `sealEnvelope` + LS write
// land out of order (different nonces complete in different times),
// leaving disk with an OLDER snapshot than the cache reflects.
// Concrete data-loss flagged in the round-5 concurrency audit:
// `saveRepoUrlFor('A','urlA'); saveRepoUrlFor('B','urlB');` — cache
// shows `{A,B}`, disk persists `{A}` because urlA's seal happened
// to finish after urlB's. Reload reverts to `{A}`. The chain
// serialises persists per-key so disk always reflects last-write-
// wins in CALL order.
const writeChain = new Map()

// Latest pending value per key for in-flight `setItem` calls.
// `setItem` updates the cache synchronously but the persist is
// async; if a `hydrate()` fires in that window (sibling tab storage
// event, vault state change) it `cache.clear()`s and reads disk —
// which still holds the OLD value — silently reverting the
// optimistic write in cache. Subsequent RMWs via `mutateWorkspaces`
// would then drop the user's just-applied change.
//
// Hydrate consults this map and skips keys with a pending write
// (the cache value is correct; the disk read would be stale). The
// finally clauses in setItem clear the entry when no later writer
// has come, so the map stays bounded by the in-flight write count.
const pendingValues = new Map()

// Listeners that fire AFTER `hydrate()` has refreshed the cache.
// Subscribed by `workspaces.js` (in place of a raw `storage` event
// listener) so its `propagateWorkspaceChangesFromStorage` diff sees
// the just-updated cache, not the pre-hydrate stale one. Without
// this hook, the cross-tab workspace-mutation propagation chain
// reads stale data because secure-storage's hydrate is async while
// the storage event handlers run synchronously.
const afterHydrateListeners = new Set()
export function onAfterHydrate(cb) {
  afterHydrateListeners.add(cb)
  return () => afterHydrateListeners.delete(cb)
}
function fireAfterHydrate() {
  for (const cb of afterHydrateListeners) {
    try { cb() } catch (err) { console.warn('secure-storage after-hydrate listener:', err) }
  }
}

// AAD binds each envelope to (a) its key name, so a workspaces
// envelope dropped into the sync.sessions slot fails AEAD on the
// next read; AND (b) the vault's identity tag (the userId base64
// string from metadata), matching the triage / OPFS layers'
// `deepview.triage.v1|<userId>` / `deepview.opfs.v1|<userId>|<file>`
// shape. Without the identity-tag binding, a backup of a
// secure-storage envelope from vault A restored into vault B that
// happens to share the same content key (iCloud-Keychain shared
// passkey scenario) would silently decrypt — a swap attack the
// triage / OPFS layers already block. Empty tag (unlocked-vault
// but somehow tag-less) is rejected by the metadata validator in
// `passkey-vault.readMetadata`, so the only way to seal/open with
// an empty tag is by misuse — and the resulting AAD wouldn't match
// any envelope produced under the normal flow.
function aadFor(key) {
  const tag = getCurrentIdentityTag() ?? ''
  return encodeUtf8(`deepview.secure.v1|${tag}|${key}`)
}

// Distinguish an enveloped value from a plaintext string. A
// plaintext value would have to be valid base64 AND decode to bytes
// starting with the `DVE1` magic to be mistaken for an envelope —
// astronomically unlikely for human-readable JSON / strings.
// `Uint8Array.fromBase64` throws on non-base64 input; treat any
// throw as "this is plaintext".
function tryDecodeEnvelope(raw) {
  try {
    const bytes = Uint8Array.fromBase64(raw)
    if (hasEnvelopeMagic(bytes)) return bytes
  } catch {}
  return null
}

// Public sync read — returns the cached value (or null if no value
// was hydrated). Caller is responsible for calling `hydrate()` at
// boot before relying on reads.
export function getItem(key) {
  return cache.get(key) ?? null
}

// Public async write — updates the cache synchronously, persists
// asynchronously through a per-key FIFO chain. When the vault is
// unlocked, the persisted form is an envelope; when disabled,
// plaintext. When the vault is enabled-but-locked (which the lock
// overlay prevents the user from reaching, but defense-in-depth),
// we throw — refusing to write plaintext under an enabled vault
// matches the saveFile / saveTriage invariant.
//
// Cache rollback: if the persist throws (quota, vault flipped to
// locked mid-flight, AEAD failure), the cache is reverted to its
// pre-call value so subsequent reads don't return a value that's
// not on disk. The rollback skips itself when a LATER successful
// set has already overwritten the cache entry — undoing that
// would silently revert a write the caller observed as successful.
export async function setItem(key, value) {
  if (typeof value !== 'string') throw new TypeError('secure-storage: value must be a string')
  if (isEncryptionEnabled() && !getSessionKey()) {
    throw new Error(`secure-storage: vault locked, cannot save "${key}"`)
  }
  if (isWipingInThisTab()) {
    // Wipe is in flight in this tab. Refuse the write — wipe's
    // `drainWriteChain()` already settled all in-flight persists
    // before clearing disk, but wipe's body yields on async OPFS /
    // signal calls. A setItem that queues during those yields
    // would persist AFTER the wipe sweep, leaving a ghost entry on
    // disk that hydrates as cached state under the next reload.
    // Wipe callers reload immediately, so the rejected setItem is
    // discarded with the page — non-fatal in the only legitimate
    // call path.
    throw new Error(`secure-storage: wipe in progress, cannot save "${key}"`)
  }
  // Snapshot for rollback. Captured BEFORE we mutate the cache so
  // a failed persist can restore exactly what we had pre-call.
  const hadPrevious = cache.has(key)
  const previousValue = cache.get(key)
  cache.set(key, value)
  // Pin the optimistic value so a hydrate firing mid-flight (sibling
  // storage event, vault state change) preserves our cache entry
  // instead of reverting to the disk's still-old contents.
  pendingValues.set(key, value)
  const prev = writeChain.get(key) ?? Promise.resolve()
  // Chain even on prior failures so a transient error doesn't
  // permanently break the per-key queue. The `.catch(() => {})`
  // before chaining the next persist swallows the prior throw so
  // our `persist` always runs.
  const clearPendingIfMine = () => {
    // Only clear pendingValues if no LATER setItem has come and
    // overwritten our pin; otherwise we'd un-pin the newer value
    // and a concurrent hydrate would silently revert it.
    if (pendingValues.get(key) === value) pendingValues.delete(key)
  }
  const next = prev
    .catch(() => {})
    .then(() => persist(key, value))
    .then(
      () => clearPendingIfMine(),
      (err) => {
        clearPendingIfMine()
        // Only roll back if no LATER set has overwritten our entry.
        // Subtle but important: if the user fired setItem(A) and
        // then setItem(B) before either persist completed, A's
        // failure shouldn't clobber B's already-cached value.
        if (cache.get(key) === value) {
          if (hadPrevious) cache.set(key, previousValue)
          else cache.delete(key)
        }
        throw err
      },
    )
  writeChain.set(key, next.catch(() => {}))
  await next
}

export async function removeItem(key) {
  // Coordinate with in-flight setItem persists. A bare removal clears
  // cache + disk immediately, but a still-pending persist from an
  // earlier setItem then writes the value back to localStorage —
  // silently resurrecting it — and a hydrate landing in the gap
  // re-caches it. Pin a per-call tombstone in pendingValues so a
  // concurrent hydrate SKIPS this key until our removal runs (clearing
  // the pin would re-open that race), and chain the disk removal behind
  // any queued persist so it is the last writer.
  const tombstone = Symbol('secure-storage:removed')
  cache.delete(key)
  pendingValues.set(key, tombstone)
  const prev = writeChain.get(key) ?? Promise.resolve()
  const finishRemoval = () => {
    try { localStorage.removeItem(key) } catch {}
    // Only clear the pin + cache if no LATER setItem/removeItem replaced
    // our tombstone — a writer that landed after us owns the key now, so
    // its optimistic cache value + pin must survive (mirrors setItem's
    // clearPendingIfMine). Without this guard the unconditional
    // cache.delete would clobber a later setItem's value, diverging
    // cache from disk until the next hydrate.
    if (pendingValues.get(key) === tombstone) {
      pendingValues.delete(key)
      cache.delete(key)
    }
  }
  const next = prev.catch(() => {}).then(() => finishRemoval())
  writeChain.set(key, next.catch(() => {}))
  await next
}

async function persist(key, value) {
  const sessionKey = getSessionKey()
  if (sessionKey) {
    const sealed = await sealEnvelope(sessionKey, encodeUtf8(value), aadFor(key))
    localStorage.setItem(key, sealed.toBase64())
  } else {
    localStorage.setItem(key, value)
  }
}

// Hydrate the cache from localStorage. Called by view.js's
// `continueBoot` post-unlock. The lock overlay blocks all
// interaction until unlock, so hydrate either runs with the vault
// disabled (plaintext fast path) or unlocked (decrypt path).
// Re-runs on every vault-state-change to pick up sibling-tab
// disables.
//
// Self-heal: if a key is on disk as PLAINTEXT while the vault is
// enabled+unlocked, schedule a re-seal. This happens when a prior
// enable migration was interrupted (browser kill, quota exceeded
// on a later key) and left some keys plaintext. Without self-heal,
// those keys would sit plaintext indefinitely under an enabled
// vault — breaking the "everything is encrypted at rest under an
// enabled vault" invariant. The audit flagged this concrete leak.
export async function hydrate() {
  if (!hydratedOnce) {
    // Vault-state listener is registered here rather than at module
    // init to keep the passkey-vault ↔ secure-storage cycle benign:
    // passkey-vault statically imports `drainWriteChain` from this
    // module, so a top-level `onVaultStateChange(...)` call would
    // execute before passkey-vault's `listeners` const is reached,
    // hitting a TDZ. By the time `hydrate()` is invoked from
    // continueBoot, both modules are fully evaluated.
    onVaultStateChange(() => {
      hydrate().catch((err) => console.warn('secure-storage rehydrate:', err))
    })
  }
  hydratedOnce = true
  // Preserve in-flight optimistic writes. Without this, a hydrate
  // firing between a `setItem`'s sync cache.set and its persist
  // completion would yank the new value out of the cache and
  // replace it with the disk's still-stale read — subsequent reads
  // and RMWs would silently drop the optimistic update.
  for (const k of [...cache.keys()]) {
    if (!pendingValues.has(k)) cache.delete(k)
  }
  const sessionKey = getSessionKey()
  const needsSelfHeal = []
  for (const key of SECURE_KEYS) {
    if (pendingValues.has(key)) continue  // optimistic write protected
    const raw = localStorage.getItem(key)
    if (raw === null) continue
    const envelopeBytes = tryDecodeEnvelope(raw)
    if (envelopeBytes) {
      if (!sessionKey) continue  // locked vault — leave un-cached
      try {
        const plain = await openEnvelope(sessionKey, envelopeBytes, aadFor(key))
        // Re-check after the async open: a user setItem may have pinned
        // a newer value for this key during the await. Overwriting the
        // cache with the decrypted stale-disk value would clobber that
        // optimistic write — the same re-check migrateKeyAtomic applies
        // after its transform, honoring the in-flight-writes invariant.
        if (pendingValues.has(key)) continue
        cache.set(key, decodeUtf8(plain))
      } catch (err) {
        // AEAD failure — wrong key, tampered ciphertext, or wrong
        // AAD (e.g. backup restored from a different vault that
        // happens to share the content key but not the userId tag).
        // Cache stays empty for this key so consumers see "no data".
        console.warn(`secure-storage: decrypt failed for "${key}":`, err)
      }
    } else {
      cache.set(key, raw)
      if (sessionKey && isEncryptionEnabled()) needsSelfHeal.push([key, raw])
    }
  }
  fireAfterHydrate()
  if (needsSelfHeal.length > 0) {
    // Run self-heal AFTER hydrate returns so consumers see the
    // populated cache immediately. Each re-seal goes through
    // `setItem` to inherit the write-chain serialisation +
    // rollback semantics; concurrent in-tab writes for these keys
    // are correctly ordered.
    //
    // Guard against the cache having been mutated between the
    // hydrate read and the microtask running. If a user `setItem`
    // landed in that window, the cache holds V_NEW while our
    // captured `value` is V_OLD — re-sealing V_OLD would chain
    // BEHIND the user's persist in the writeChain and clobber the
    // fresh write on disk with the stale value. Skipping is safe:
    // the user's own setItem is responsible for sealing V_NEW;
    // there's nothing left to heal.
    queueMicrotask(() => {
      for (const [key, value] of needsSelfHeal) {
        if (cache.get(key) !== value) continue
        setItem(key, value).catch((err) => {
          console.warn(`secure-storage: self-heal failed for "${key}":`, err)
        })
      }
    })
  }
}

// Migration helpers — invoked from passkey-vault's
// enable/disableEncryption flow (see migrate callback shape). MUST
// be called from inside an exclusive VAULT_LOCK acquisition.
//
// Each per-key migration is wrapped in an ATOMIC writeChain entry:
// read-disk + transform + write-disk in a single chain slot, so a
// concurrent user `setItem` for the same key queues either entirely
// BEFORE us (we see their write on disk and no-op via the envelope/
// plaintext check) or entirely AFTER us (their persist runs once we
// yield the chain). The prior `await setItem(...)`-based migration
// lacked this: a user `setItem(K, V_NEW)` landing during migrate's
// decrypt/encrypt await would cache+pin V_NEW, then migrate's own
// setItem would `cache.set(V_OLD_transformed)` over it and queue a
// stale persist — V_NEW silently lost in both cache and disk.
//
// Additional safety: each transform re-checks `pendingValues` AFTER
// any awaits within it and skips entirely if a user write has
// landed — the user's persist will produce the correct final state
// either way (encryptedEncrypted enable, plaintext during disable).
//
// Disable note: `passkey-vault.disableEncryption` keeps the
// `sessionIdentityTag` set during migrate so `aadFor(key)` builds
// the AAD that matches the existing envelopes on disk. Without
// that ordering invariant, every `open()` here would AEAD-fail.
async function migrateKeyAtomic(key, transform) {
  const prev = writeChain.get(key) ?? Promise.resolve()
  const runner = async () => {
    // Fast path: a user write is in-flight for this key. Their
    // persist (queued after us in the chain) will land the correct
    // final state under the prevailing vault state — we don't need
    // to transform anything.
    if (pendingValues.has(key)) return
    const raw = localStorage.getItem(key)
    if (raw === null) return
    const result = await transform(raw)
    if (result === null) return
    // Re-check after the async transform: a user setItem may have
    // pinned a newer value during the await. Writing our
    // transformed-from-stale-disk value now would clobber theirs.
    if (pendingValues.has(key)) return
    localStorage.setItem(key, result.storageValue)
    cache.set(key, result.cacheValue)
  }
  const next = prev.catch(() => {}).then(runner)
  writeChain.set(key, next.catch(() => {}))
  await next
}

export async function migrateToEncrypted({ seal: _seal }) {
  for (const key of SECURE_KEYS) {
    await migrateKeyAtomic(key, async (raw) => {
      if (tryDecodeEnvelope(raw)) return null  // already enveloped
      const sessionKey = getSessionKey()
      if (!sessionKey) return null  // vault state mutated mid-migrate
      const sealed = await sealEnvelope(sessionKey, encodeUtf8(raw), aadFor(key))
      return { storageValue: sealed.toBase64(), cacheValue: raw }
    })
  }
}

export async function migrateToPlaintext({ open }) {
  for (const key of SECURE_KEYS) {
    await migrateKeyAtomic(key, async (raw) => {
      const envelopeBytes = tryDecodeEnvelope(raw)
      if (!envelopeBytes) return null  // already plaintext
      const plain = await open(envelopeBytes, aadFor(key))
      const text = decodeUtf8(plain)
      return { storageValue: text, cacheValue: text }
    })
  }
}

// Cross-tab serialised read-modify-write for a single key. Without
// this, a saveRepoUrlFor / counts setItem pattern (read cache,
// modify, setItem) racing a sibling-tab write for the same key
// silently clobbers the sibling's value:
//   1. Tab A: read cache {a:urlA}.
//   2. Tab B: setItem({b:urlB}). Tab A receives storage event.
//   3. Tab A's hydrate skips K (pendingValues protects A's
//      in-flight write — necessary to prevent the opposite
//      in-tab data loss).
//   4. Tab A's persist completes: writes {a:urlA} to disk.
//      Tab B's write is overwritten.
//   5. Tab A: subsequent saveRepoUrlFor('c', urlC) reads cache
//      {a:urlA}, merges to {a:urlA, c:urlC} — never observes B's
//      'b' entry. B's write is permanently lost.
//
// `mutate(key, updater)` wraps the entire RMW in a per-key Web
// Lock and hydrates inside the lock so the updater sees the
// freshest disk state. The setItem inside the lock is then the
// only writer for K until we release. Updater can return null /
// undefined / the current value to skip; otherwise its string
// return becomes the new value.
const MUTATE_LOCK_PREFIX = 'deepview.secure.v1.mutate:'
export function mutate(key, updater) {
  if (!SECURE_KEYS.includes(key)) {
    return Promise.reject(new Error(`secure-storage: mutate() called with non-secure key "${key}"`))
  }
  return navigator.locks.request(MUTATE_LOCK_PREFIX + key, async () => {
    // Drain any in-flight setItem for THIS key BEFORE hydrating so
    // the in-lock hydrate sees the fully-persisted state on disk
    // and isn't blinded by this tab's own pendingValues pin from a
    // just-fired sync setItem (the common pattern for callers that
    // want both in-tab sync semantics AND cross-tab reconciliation).
    // Without this drain, hydrate would skip K because pendingValues
    // has it, leaving the updater operating on the stale in-tab
    // cache instead of the freshest disk view.
    const pending = writeChain.get(key)
    if (pending) await pending.catch(() => {})
    await hydrate()
    const current = getItem(key)
    const next = await updater(current)
    if (next === null || next === undefined || next === current) return
    if (typeof next !== 'string') {
      throw new TypeError(`secure-storage: mutate updater for "${key}" must return a string`)
    }
    await setItem(key, next)
  })
}

// Drain any pending persist chain so a caller (currently
// `wipeAllVaultData`) can be sure no setItem-induced
// `localStorage.setItem` will land AFTER its cleanup runs. Without
// this, a background `setItem` queued JUST before the wipe lock
// acquired would persist its plaintext value to disk AFTER the
// wipe's `removeItem` sweep, producing a ghost entry that survives
// across reload.
//
// Settled, not just resolved: a failed persist still completes the
// chain entry, and we don't want to block forever on a queue that
// can't make progress. `pendingValues` is cleared explicitly
// because failed persists may leave entries pinned briefly.
export async function drainWriteChain() {
  await Promise.allSettled([...writeChain.values()])
  pendingValues.clear()
  writeChain.clear()
}

// Cross-tab propagation: a sibling tab's setItem fires a storage
// event in this tab. Re-hydrate the affected key so the next
// getItem reflects the sibling's write.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!hydratedOnce || !e.key || !SECURE_KEYS.includes(e.key)) return
    hydrate().catch(() => {})
  })
}

// Test-only reset — clears the cache + hydratedOnce flag so a
// `node:test` cache-busted import of a consumer module starts from
// a known state. Mirrors `__test__.reset` in passkey-vault.js.
export const __test__ = {
  reset() {
    cache.clear()
    pendingValues.clear()
    writeChain.clear()
    hydratedOnce = false
  },
}
