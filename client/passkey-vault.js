// Passkey vault — opt-in encryption-at-rest for triage + OPFS data.
//
// Manages three pieces of state:
//   1. Persistent metadata in `localStorage['deepview.passkey.v1']`:
//      `{ enabled, credentialId, prfSalt, userId, rpId, createdAt }`.
//      The bytes here are NOT secrets — they're the credential
//      handle and the PRF salt; both must travel verbatim to assert
//      and they alone can't decrypt anything without the
//      authenticator. `rpId` is stored explicitly so subsequent
//      `assertPasskey` and `signalUnknownCredential` calls target the
//      same RP the credential was bound to.
//   2. In-memory session key (`AES-GCM CryptoKey`) — derived from the
//      PRF output on unlock, held in memory for the tab's lifetime.
//      One `assertPasskey` ceremony per tab; tab close drops the key.
//   3. AAD context strings — bind ciphertexts to their use
//      (triage / per-OPFS-filename) AND to the vault identity (via
//      the userId-derived tag). A ciphertext can't be swapped
//      between contexts (triage vs OPFS), between files within OPFS
//      (filename in AAD), or between vault instances (different
//      users / restored backups).
//
// `triage.js` and `storage.js` call `getSessionKey()` to decide
// whether to wrap the next write in the envelope, and route any
// detected envelope through the matching open helper. Modules
// tolerate a vault that's disabled (no-op plaintext path) and a
// vault that's enabled-but-not-yet-unlocked (envelope reads throw,
// the UI surfaces the boot-time unlock prompt).

import { assertPasskey, deriveContentKey, hasEnvelopeMagic, importContentKey, isPasskeySupported, openEnvelope, probePrfSupport, registerPasskey, sealEnvelope } from './passkey-crypto.ts'
import { encodeUtf8 } from '../common/utf8.js'

// `secure-storage` imports from this module (vault state), so a
// static import here would form a cycle that breaks the
// module-level `onVaultStateChange(...)` registration in
// secure-storage (it accesses `listeners` before this module
// finishes evaluating its `const` declaration). Dynamic-import the
// drain helper from `wipeAllVaultData` instead — the cycle resolves
// because by the time `wipeAllVaultData` is invoked, both modules
// are fully evaluated.
async function drainSecureStorageWriteChain() {
  const mod = await import('./secure-storage.js')
  await mod.drainWriteChain()
}

const VAULT_KEY = 'deepview.passkey.v1'
// Separate from VAULT_KEY so it survives a disableEncryption cycle.
// `disableEncryption` removes VAULT_KEY entirely (credential is
// gone from the authenticator on Chrome 132+; orphan otherwise), but
// preserving the user.id across re-enables lets a subsequent
// registerPasskey re-bind to the same authenticator "user account"
// slot rather than stacking a fresh OS-level entry on every cycle.
// See `enableEncryption` for the read-or-generate dance.
const USER_ID_KEY = 'deepview.passkey.userId'
// Marker set by `disableEncryption` on a successful clean disable
// and cleared by `enableEncryption` / `wipeAllVaultData`. Lets
// `hasOrphanedUserId()` distinguish the benign "user just disabled"
// state (USER_ID_KEY present + no metadata + everything is plaintext)
// from the dangerous "metadata wiped out-of-band" state (USER_ID_KEY
// present + no metadata + envelopes stranded on disk). Without the
// marker, the orphan heuristic fires its destructive
// wipe-acknowledgement on every benign post-disable re-enable —
// and clearing USER_ID_KEY instead would defeat the OS-slot reuse
// that makes the persistent userId worthwhile in the first place.
const CLEAN_DISABLE_KEY = 'deepview.passkey.cleanDisable'
export const VAULT_LOCK = 'deepview.passkey.v1.write'
// AAD prefix domain-separators — every encrypted blob is bound to
// its use AND to the vault identity (userId tag). A triage envelope
// rebased into the OPFS layer (or vice versa) fails AEAD verification
// because the AAD differs; per-file OPFS AAD also folds in the
// filename so a same-vault file-rename swap fails; and the userId
// component prevents grafting envelopes from one vault's backup onto
// another vault's data.
const AAD_TRIAGE_PREFIX = 'deepview.triage.v1|'
const AAD_OPFS_PREFIX = 'deepview.opfs.v1|'
// Bundles get their own domain-separated prefix so a bundle envelope
// can't be swapped into the reports slot (or vice versa). The slot
// argument is either a bundle's SRI integrity (`sha512-...`) for
// bundle bytes, or `__meta__` for `_meta.json`.
const AAD_BUNDLE_PREFIX = 'deepview.bundle.v1|'

let sessionKey = null
// Identity tag (= the userId base64url string from metadata) for
// AAD construction. Captured on enable / unlock so the seal/open
// helpers don't have to re-read localStorage on every call. Null
// when the vault is disabled / not-yet-unlocked.
let sessionIdentityTag = null
// Credential identifier (= the base64url credentialId from
// metadata) that this tab's `sessionKey` is derived from. Used by
// the cross-tab storage handler to detect a sibling-tab
// disable-then-re-enable: with userId persistence, the new
// metadata's `userId` matches the old (so `sessionIdentityTag`
// doesn't differ), but the `credentialId` is always fresh from
// `registerPasskey` (the authenticator assigns it per ceremony).
// A mismatch tells us our in-memory key won't open the new
// envelopes — drop it so the user re-unlocks under the new
// credential.
let sessionCredentialId = null
// Refcount of in-progress `disableEncryption` / `wipeAllVaultData`
// calls in THIS tab. Both transition the vault from
// enabled-and-unlocked to disabled, and both fire the same
// vault-state-change at the end. `view.js` consults this when
// reacting to that transition: when this tab triggered the change,
// the user clicked Disable / Wipe here and either expects to
// continue (disable) or expects to reload via the caller path
// (wipe) — either way, the cross-tab "encryption was disabled in
// another tab" alert is wrong. Refcount instead of a boolean so
// nested / overlapping calls behave correctly.
let disablingInThisTab = 0
export function isDisablingInThisTab() {
  return disablingInThisTab > 0
}
// Separate refcount specifically for `wipeAllVaultData`. The wipe
// body yields on `await navigator.storage.getDirectory()` and on
// `await root.removeEntry(...)`. During those yields, a background
// macrotask (triage-sync WS frame, presence broadcast, the
// after-hydrate listener fired by `fireVaultStateChange()` inside
// the lock body) can call `secureStorage.setItem`, which queues a
// fresh persist after the writeChain was already drained. That
// persist runs the localStorage write AFTER the wipe sweep
// finishes, producing a ghost entry that survives reload. The
// `secure-storage` setItem checks this flag and refuses with a
// non-fatal error — wipe callers reload immediately after wipe
// resolves, so the refused write is discarded with the page.
let wipingInThisTab = 0
export function isWipingInThisTab() {
  return wipingInThisTab > 0
}

function readMetadata() {
  try {
    const raw = localStorage.getItem(VAULT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // Require non-empty userId. An empty string would slot into the
    // AAD as `deepview.triage.v1|` — bit-identical to the
    // locked-vault default returned by `getEnvelopeAadForTriage()`
    // when `sessionIdentityTag` is null. Reject up front so a
    // corrupted / hostile metadata entry can't collide AADs across
    // the two contexts.
    if (parsed && typeof parsed === 'object'
      && parsed.enabled === true
      && typeof parsed.credentialId === 'string' && parsed.credentialId.length > 0
      && typeof parsed.prfSalt === 'string' && parsed.prfSalt.length > 0
      && typeof parsed.userId === 'string' && parsed.userId.length > 0) {
      return parsed
    }
    return null
  } catch { return null }
}

function writeMetadata(meta) {
  localStorage.setItem(VAULT_KEY, JSON.stringify(meta))
}

function clearMetadata() {
  localStorage.removeItem(VAULT_KEY)
}

// Read the persistent user.id, generating + storing one on first
// call. Survives `clearMetadata` so disable/enable cycles re-use
// the same identifier. Returned as a fresh Uint8Array so callers
// can hand it to WebAuthn without sharing the internal buffer.
function readOrCreateUserId() {
  try {
    const stored = localStorage.getItem(USER_ID_KEY)
    if (stored) {
      const bytes = Uint8Array.fromBase64(stored, { alphabet: 'base64url' })
      if (bytes.length === 16) return bytes
    }
  } catch {}
  const fresh = new Uint8Array(16)
  crypto.getRandomValues(fresh)
  try {
    localStorage.setItem(USER_ID_KEY, fresh.toBase64({ alphabet: 'base64url', omitPadding: true }))
  } catch {}
  return fresh
}

// rp.id we ask the authenticator to bind the credential to. Stored
// in metadata at registration time and reused for every subsequent
// assertPasskey + signalUnknownCredential, so the three calls agree
// even if the page later moves between subdomains where the browser
// would have computed a different default.
function currentRpId() {
  if (typeof location === 'undefined') return ''
  return location.hostname
}

export function isEncryptionEnabled() {
  return readMetadata() !== null
}

export function isUnlocked() {
  return sessionKey !== null
}

export function isPasskeyEnvironmentSupported() {
  if (!isPasskeySupported()) return false
  // Web Locks are required for every vault-state mutation
  // (enable / disable / unlock / wipe) and for the shared lock
  // wrapping saveFile / saveTriage. An environment that has
  // WebAuthn but no `navigator.locks` (some restricted iframe /
  // extension contexts, locked-down enterprise policies) would
  // surface the UI affordance only to throw `TypeError: Cannot
  // read properties of undefined (reading 'request')` on the
  // first user action. Refuse up-front.
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return false
  // WebAuthn rejects empty rp.id, which `currentRpId()` returns on
  // `file://` (hostname is empty). The vault offered enable would
  // fail late with a confusing `SecurityError` from the OS prompt.
  // Refuse up-front so the lock icon / setup dialog stay hidden.
  if (!currentRpId()) return false
  return true
}

// Exposed for secure-storage's AAD construction. Returns the
// current vault identity tag (= the userId base64url string from
// metadata) when unlocked, or null when locked / disabled. Same
// value triage / OPFS AADs fold in via `getEnvelopeAadForTriage` /
// `getEnvelopeAadForOpfs`.
export function getCurrentIdentityTag() {
  return sessionIdentityTag
}

// Detect a USER_ID_KEY orphan — the user wiped vault metadata
// (devtools, profile reset, manual clear) but USER_ID_KEY survived,
// leaving envelopes on disk that no future credential can decrypt.
// Re-enabling without warning would reuse the userId but create a
// FRESH credential (different PRF output → different content key).
// All previously-encrypted envelopes on disk would silently become
// unreadable. Surface to the UI so the user can consciously choose
// "yes, wipe the old data" or "wait, I want to recover it first".
//
// A clean `disableEncryption` migrated everything to plaintext
// before clearing metadata — there's no abandoned encrypted data
// to warn about. We disambiguate that benign state from the real
// orphan by checking `CLEAN_DISABLE_KEY`: present means the last
// vault transition was a successful disable, so the absent
// metadata is intentional and the persistent USER_ID_KEY is just
// the OS-slot-reuse hint waiting for the next enable.
export function hasOrphanedUserId() {
  if (readMetadata() !== null) return false
  try {
    if (localStorage.getItem(CLEAN_DISABLE_KEY) === '1') return false
    return localStorage.getItem(USER_ID_KEY) !== null
  } catch { return false }
}

// In-memory session key access — `triage.js` and `storage.js` call
// this on every save/load to decide whether to wrap. Returns null
// when:
//   - encryption is disabled (legacy plaintext path), OR
//   - encryption is enabled but the user hasn't unlocked this tab
//     yet (envelopes round-trip unchanged; reads of legacy plaintext
//     still work; reads of envelopes throw via openEnvelope).
export function getSessionKey() {
  return sessionKey
}

export function getEnvelopeAadForTriage() {
  // Identity tag folded in so two vaults with different userIds
  // can't accidentally cross-decrypt each other's triage. When the
  // vault is locked / disabled, the tag is empty — but the caller
  // shouldn't be sealing anything at that point, and openEnvelope
  // would also be passed an empty-tag AAD that won't match anything
  // sealed-with-a-tag, surfacing as a clean AEAD failure.
  return encodeUtf8(AAD_TRIAGE_PREFIX + (sessionIdentityTag ?? ''))
}

export function getEnvelopeAadForOpfs(filename) {
  if (typeof filename !== 'string') {
    throw new TypeError('passkey vault: OPFS AAD requires a filename string')
  }
  return encodeUtf8(AAD_OPFS_PREFIX + (sessionIdentityTag ?? '') + '|' + filename)
}

// Bundles use a separate AAD prefix so swapping a bundle envelope
// into the reports slot (or vice versa) fails AEAD. `slot` is the
// bundle's SRI integrity for bytes (`sha512-...`) or the literal
// `'__meta__'` for the bundle-index file — the two share the prefix
// + identity tag binding but bind to different slots so the index
// envelope can't be replayed as a bundle and vice versa.
export function getEnvelopeAadForBundle(slot) {
  if (typeof slot !== 'string') {
    throw new TypeError('passkey vault: bundle AAD requires a slot string')
  }
  return encodeUtf8(AAD_BUNDLE_PREFIX + (sessionIdentityTag ?? '') + '|' + slot)
}

// Cross-tab + cross-render listener registry. The triage / storage
// layers subscribe to refresh their views when the vault transitions
// (unlock → lock, disable → enable). Fired AFTER the state change
// settles. Mirrors the pattern in workspaces.js's listener registry.
const listeners = new Set()
export function onVaultStateChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function fireVaultStateChange() {
  for (const cb of listeners) {
    try { cb() } catch (err) { console.warn('passkey vault listener:', err) }
  }
}

// Unlock the vault from existing metadata — runs the WebAuthn
// assertion against the stored credentialId + PRF salt, derives the
// session key via HKDF, holds it in memory for the lifetime of the
// tab. Tab close (or refresh) discards the key; the user is
// re-prompted on next load. There is no in-app re-lock affordance —
// dropping the key while keeping the tab open would mean every
// subsequent triage / report read fails until the user assents to
// another biometric prompt, which is friction without security
// benefit (a malicious script already in this realm could have
// exfiltrated the plaintext earlier; locking now closes nothing).
//
// Returns true on success, false on user-cancel / no credential. A
// hard failure (PRF unsupported, AEAD mismatch on first read) bubbles
// the error up — the UI surfaces a friendly message and the user can
// retry. The caller is responsible for re-reading triage / report
// data after a successful unlock so encrypted blobs surface their
// plaintext through the new key.
export async function unlockEncryption({ signal } = {}) {
  // Pre-read metadata so we can fail fast on disabled vaults
  // (cheap, no prompt). The authoritative read happens INSIDE the
  // exclusive lock below — a sibling-tab wipe/disable that lands
  // during the WebAuthn ceremony would otherwise leave us with a
  // stale `meta` reference, setting `sessionKey` + `sessionIdentityTag`
  // from a credential that no longer exists. Subsequent saves would
  // seal envelopes under a vault whose metadata is gone, producing
  // permanently-unreadable orphan blobs.
  const initialMeta = readMetadata()
  if (!initialMeta) return false
  let prfOutput
  try {
    prfOutput = await assertPasskey({
      credentialId: initialMeta.credentialId,
      prfSalt: initialMeta.prfSalt,
      rpId: initialMeta.rpId ?? currentRpId(),
      ...(signal ? { signal } : {}),
    })
  } catch (err) {
    if (err && /** @type {{ name?: string }} */ (err).name === 'NotAllowedError') return false
    if (err && /** @type {{ name?: string }} */ (err).name === 'AbortError') return false
    if (err && /** @type {{ message?: string }} */ (err).message?.includes('PRF')) {
      throw friendlyPrfUnsupportedError(err)
    }
    throw err
  }
  if (!prfOutput || prfOutput.length < 32) {
    throw friendlyPrfUnsupportedError()
  }
  const raw = await deriveContentKey(prfOutput)
  prfOutput.fill(0)
  return navigator.locks.request(VAULT_LOCK, async () => {
    // Re-read inside the lock and verify the credential is still
    // the one we just authenticated against. Without this check, a
    // sibling-tab wipe + re-enable racing our WebAuthn prompt would
    // leave us in a state where this tab's `sessionKey` is bound to
    // the OLD credential while disk metadata points at the NEW one.
    const currentMeta = readMetadata()
    if (!currentMeta || currentMeta.credentialId !== initialMeta.credentialId) {
      raw.fill(0)
      throw new Error(
        'passkey: vault state changed during unlock (another tab '
        + 'wiped or re-enabled it). Reload this page and try again.',
      )
    }
    sessionKey = await importContentKey(raw)
    raw.fill(0)
    sessionIdentityTag = currentMeta.userId
    sessionCredentialId = currentMeta.credentialId
    fireVaultStateChange()
    return true
  })
}

function friendlyPrfUnsupportedError(cause) {
  // Surfaced verbatim to the unlock / setup dialog. Cause is
  // chained so devtools still shows the original error.
  const e = new Error(
    'Your browser or authenticator doesn\'t support passkey-derived '
    + 'encryption keys (the WebAuthn PRF extension). Try Chrome 116+, '
    + 'Safari 18+, or Firefox 130+ on a device with a platform '
    + 'authenticator (TouchID / Windows Hello).',
  )
  if (cause) /** @type {{ cause?: unknown }} */ (e).cause = cause
  return e
}

// Enable encryption from scratch. Steps:
//   1. Verify environment + run registerPasskey with an explicit
//      rpId so subsequent assert / signal calls target the same RP.
//   2. If create-time PRF didn't return output (Safari quirks, some
//      authenticators), follow up with an immediate assertion to
//      probe. If that probe fails (cancelled, PRF unsupported), we
//      signal the orphaned credential for OS-level cleanup before
//      re-throwing.
//   3. Derive the session key, hold it in memory, capture identity
//      tag.
//   4. Persist metadata BEFORE running migration. A migration
//      failure mid-way then leaves a recoverable state: vault
//      enabled, metadata persisted, some files sealed and some
//      plaintext. The read path tolerates both shapes; the next
//      save automatically seals; and the next page load can unlock
//      with the same passkey and re-derive the same key. Writing
//      metadata AFTER migration would brick the partially-sealed
//      files: vault appears disabled, but the on-disk envelope is
//      undecryptable without the key that was just discarded.
//   5. Run the supplied `migrate(seal)` callback inside the lock so
//      sibling tabs can't observe a half-migrated state.
//   6. Fire vault-state-change listeners.
//
// Migration callback receives a `seal(bytes, aad)` helper that
// returns the enveloped bytes for the just-derived key — no need
// for callers to re-import it. On migration failure we re-throw; the
// vault stays enabled and the session key is preserved so the user
// can retry the migration (or new saves will pick up where it left
// off naturally, sealing un-enveloped files as they're rewritten).
export function enableEncryption({ migrate, userName, rpName, signal, acknowledgeOrphan }) {
  if (!isPasskeySupported()) {
    throw new Error('passkey: WebAuthn unavailable in this environment')
  }
  // Orphan-USER_ID_KEY guard: metadata is absent but USER_ID_KEY is
  // present, meaning a previous vault on this device was abandoned
  // (devtools wipe, profile reset, partial migration). Re-using the
  // stored userId silently makes any old envelopes on disk
  // unreadable under the freshly-derived content key. Refuse to
  // proceed unless the caller explicitly acknowledges. The setup
  // dialog surfaces a confirm when it detects `hasOrphanedUserId()`
  // and passes `acknowledgeOrphan: true` if the user opts to wipe
  // the prior state.
  if (hasOrphanedUserId() && !acknowledgeOrphan) {
    throw new Error(
      'passkey: a previous vault exists on this device with no metadata. '
      + 'Any data encrypted under the old passkey will be unreadable after '
      + 'a new setup. Call enableEncryption({acknowledgeOrphan: true}) to '
      + 'proceed, or wipeAllVaultData() to start clean first.',
    )
  }
  // The actual enabled-check + userId read happen INSIDE the lock
  // below. A pre-lock check would race a sibling tab: both tabs
  // pass the check, both call registerPasskey, one's credential
  // ends up orphaned. The early-return in the lock body covers the
  // same UX without the race.
  const rpId = currentRpId()
  return navigator.locks.request(VAULT_LOCK, async () => {
    if (isEncryptionEnabled()) {
      throw new Error('passkey: encryption is already enabled')
    }
    // PRF capability pre-flight. When the browser can tell us
    // up-front that PRF isn't supported (Chrome 133+, expanding),
    // bail BEFORE registering a passkey so we don't leave an
    // orphan credential on the authenticator. Unknown / older
    // browsers fall through to the existing register+probe path,
    // which orphan-cleans on the post-register PRF failure.
    const prfSupported = await probePrfSupport()
    if (prfSupported === false) {
      throw friendlyPrfUnsupportedError()
    }
    // 16-byte user.id — persistent across disable/enable cycles via
    // `USER_ID_KEY` so OS-level passkey managers don't accumulate a
    // fresh entry every cycle. WebAuthn defines user.id as the
    // identifier the authenticator binds a credential to within an
    // RP; re-using it on re-register lets the authenticator
    // overwrite the slot (where supported — Apple platform, Windows
    // Hello, Chrome password manager). Hardware security keys
    // (YubiKey etc.) may stack a fresh credential per ceremony
    // regardless of user.id; `signalUnknownCredential` on disable
    // is the only cleanup path for those, and is itself best-effort
    // (Chrome 132+).
    //
    // The `CLEAN_DISABLE_KEY` marker (cleared at the end of this
    // function) is the companion mechanism that keeps the orphan
    // heuristic accurate: persistent userId without the marker means
    // metadata was wiped out-of-band and envelopes may be stranded;
    // persistent userId WITH the marker means the prior disable
    // already migrated everything to plaintext.
    //
    // Read INSIDE the lock so concurrent enable attempts share the
    // same value (the first writer wins; the second observes the
    // just-written value).
    const userId = readOrCreateUserId()
    const reg = await registerPasskey({
      userName: userName || 'DeepView user',
      userId,
      rpName: rpName || 'DeepView',
      rpId,
      ...(signal ? { signal } : {}),
    })
    let prfBytes = reg.prfOutput
    if (!prfBytes) {
      // create-time PRF was empty — probe with an immediate get(). If
      // THAT also fails or returns empty, the authenticator doesn't
      // support PRF. Clean up the orphan credential AND the stale
      // userId before re-throwing so the user's OS passkey manager
      // doesn't accumulate dead entries every time they try to
      // enable on an unsupported device, and a fresh retry starts
      // from a clean slate (a stale USER_ID_KEY paired with a
      // signalled-removed credential could confuse some
      // authenticators on the next attempt). Both cleanups are
      // best-effort; older browsers / hardware keys ignore the
      // signal but the userId clear always lands.
      try {
        prfBytes = await assertPasskey({
          credentialId: reg.credentialId,
          prfSalt: reg.prfSalt,
          rpId,
          ...(signal ? { signal } : {}),
        })
      } catch (err) {
        const userIdB64 = userId.toBase64({ alphabet: 'base64url', omitPadding: true })
        await signalCredentialRemovedFor({ credentialId: reg.credentialId, rpId, userId: userIdB64 }).catch(() => {})
        try { localStorage.removeItem(USER_ID_KEY) } catch {}
        if (err && /** @type {{ message?: string }} */ (err).message?.includes('PRF')) {
          throw friendlyPrfUnsupportedError(err)
        }
        throw err
      }
    }
    if (!prfBytes || prfBytes.length < 32) {
      const userIdB64 = userId.toBase64({ alphabet: 'base64url', omitPadding: true })
      await signalCredentialRemovedFor({ credentialId: reg.credentialId, rpId, userId: userIdB64 }).catch(() => {})
      try { localStorage.removeItem(USER_ID_KEY) } catch {}
      throw friendlyPrfUnsupportedError()
    }
    const raw = await deriveContentKey(prfBytes)
    prfBytes.fill(0)
    const key = await importContentKey(raw)
    raw.fill(0)
    const userIdB64 = userId.toBase64({ alphabet: 'base64url', omitPadding: true })
    const meta = {
      enabled: true,
      credentialId: reg.credentialId,
      prfSalt: reg.prfSalt,
      userId: userIdB64,
      rpId,
      createdAt: Date.now(),
    }
    // Persist metadata + activate the session key BEFORE migration.
    // A partial-migration failure then leaves a recoverable state
    // instead of a brick: subsequent loads unlock with the same
    // passkey, re-derive the same key, and reads of both
    // already-sealed and still-plaintext files succeed.
    //
    // `fireVaultStateChange()` is intentionally deferred until AFTER
    // migrate completes. Firing it now would wake secure-storage's
    // state-change handler, which re-hydrates from disk while disk
    // is still partially plaintext — the hydrate would capture
    // pre-migration plaintext into a self-heal queue that races any
    // concurrent setItem and silently overwrites fresh writes with
    // the just-captured stale value.
    sessionKey = key
    sessionIdentityTag = userIdB64
    sessionCredentialId = reg.credentialId
    writeMetadata(meta)
    if (typeof migrate === 'function') {
      const sealForKey = (bytes, aad) => sealEnvelope(key, bytes, aad)
      await migrate({ seal: sealForKey })
    }
    // Clear the clean-disable marker — we're enabled again, so the
    // next time metadata disappears it'll be a real out-of-band wipe
    // (orphan) until another successful disableEncryption sets it.
    try { localStorage.removeItem(CLEAN_DISABLE_KEY) } catch {}
    fireVaultStateChange()
    return true
  })
}

// Disable encryption — requires the vault to be unlocked so we can
// decrypt every existing envelope first. Steps mirror enable in
// reverse: unwrap-everything (via the supplied `migrate(open)`
// callback), then drop the metadata + session key, then hint the
// authenticator that the credential is no longer used so the
// OS-level passkey manager can offer to delete it (Chrome 132+).
// The signal step is best-effort: older browsers / hardware keys
// silently ignore it, and a thrown error doesn't undo the local
// teardown (the metadata is already gone, the credential just
// stays orphaned on the authenticator).
//
// `meta` is captured INSIDE the lock so a sibling-tab disable
// racing the read can't observe a stale credentialId. If a sibling
// already cleared metadata before we acquired the lock, the
// short-circuit at the top of the lock body skips the signal +
// migration entirely (the sibling has done it).
export async function disableEncryption({ migrate }) {
  if (!isEncryptionEnabled()) return { disabled: false, signalAttempted: false }
  if (!isUnlocked()) throw new Error('passkey: must unlock before disabling encryption')
  disablingInThisTab += 1
  try {
    return await navigator.locks.request(VAULT_LOCK, async () => {
      const meta = readMetadata()
      if (!meta) return { disabled: false, signalAttempted: false }
      // Capture `key` INSIDE the lock — a sibling tab disable+re-key
      // racing our lock wait would have null'd our module-level
      // sessionKey via the storage-event handler; capturing pre-lock
      // would leave us with an obsolete CryptoKey reference.
      const key = sessionKey
      if (!key) return { disabled: false, signalAttempted: false }
      // Tear down metadata + session key UP-FRONT so any concurrent
      // setItem during migration writes plaintext (the post-disable
      // invariant). Without this, a setItem that lands mid-migration
      // would seal under the about-to-be-discarded session key and
      // become permanently unreadable once the metadata is cleared.
      //
      // CRITICAL: `sessionIdentityTag` is intentionally KEPT until
      // after migrate. Triage / OPFS / secure-storage AAD builders
      // all read it; clearing it pre-migrate produces AAD
      // `…|<empty>|<key>` that never matches the
      // `…|<userIdB64>|<key>` AAD the existing envelopes were
      // sealed with — every `open` throws and the entire disable
      // flow data-losses. (Found in audit re-run round-N P0.)
      //
      // `fireVaultStateChange()` stays at the end so UI listeners see
      // the disabled state once everything is plaintext on disk, not
      // mid-migration when half the data is still enveloped.
      clearMetadata()
      sessionKey = null
      sessionCredentialId = null
      if (typeof migrate === 'function') {
        const openForKey = (bytes, aad) => openEnvelope(key, bytes, aad)
        try {
          await migrate({ open: openForKey })
        } catch (err) {
          // Migrate failed partway. Some keys may be plaintext on disk,
          // others still enveloped. Without rollback, the user is left
          // with metadata cleared, no sessionKey, and undecryptable
          // envelope keys/files — permanent data loss with no in-app
          // recovery.
          //
          // Restore vault state so the user can retry the disable. The
          // partially-plaintext keys re-seal via secure-storage's
          // hydrate self-heal on the next listener cycle (covers
          // SECURE_KEYS; triage / OPFS layers see no self-heal but
          // their plaintext-under-enabled-vault state can be
          // re-decrypted on retry, then re-written).
          writeMetadata(meta)
          sessionKey = key
          sessionCredentialId = meta.credentialId
          // sessionIdentityTag was never cleared (still set).
          fireVaultStateChange()
          throw err
        }
      }
      sessionIdentityTag = null
      // Set the clean-disable marker BEFORE the signal call. Keeping
      // USER_ID_KEY intact (its persistence across cycles is the OS
      // slot-reuse hint that avoids accumulating a fresh authenticator
      // entry on every disable/enable), the marker is what tells
      // `hasOrphanedUserId()` that the absent metadata is intentional
      // — every envelope was already migrated to plaintext by the
      // `migrate()` call above, so the next `enableEncryption` can
      // skip the destructive wipe acknowledgement and re-bind to the
      // same user.handle slot. Cleared by `enableEncryption` /
      // `wipeAllVaultData`.
      try { localStorage.setItem(CLEAN_DISABLE_KEY, '1') } catch {}
      // Signal cleanup AFTER migration: doing it earlier would surface
      // the OS-level "remove this passkey?" prompt while we're still
      // decrypting envelopes — if the user accidentally removes the
      // passkey before migration finishes, any remaining envelope keys
      // would be unrecoverable. Signal is best-effort; failures
      // swallowed.
      const signalAttempted = await signalCredentialRemovedFor(meta).catch(() => false)
      fireVaultStateChange()
      return { disabled: true, signalAttempted }
    })
  } finally {
    disablingInThisTab -= 1
  }
}

// Hint the authenticator(s) that the given credential is no longer
// known to this RP. Two complementary WebAuthn Signal API methods,
// both Chrome 132+ only, tried in sequence (each failure swallowed):
//
//   1. `signalUnknownCredential({rpId, credentialId})` — tells the
//      OS the specific credential is unknown. Chrome's password
//      manager surfaces a "remove?" prompt; iCloud Keychain, 1Password,
//      Bitwarden, hardware keys (YubiKey etc.) IGNORE this entirely.
//
//   2. `signalAllAcceptedCredentials({rpId, userId, allAcceptedCredentialIds: []})`
//      — tells the OS the user has NO valid credentials. A broader
//      hint; same coverage limitations.
//
// REALITY: this is best-effort scaffolding. Most users will need to
// manually delete the passkey from their OS / password manager
// settings — that's why the disable-confirm dialog in the UI says
// so. Returns true when SOMETHING was attempted (caller surfaces a
// follow-up nudge), false when neither method exists.
async function signalCredentialRemovedFor({ credentialId, rpId, userId }) {
  if (typeof PublicKeyCredential === 'undefined') return false
  if (!rpId) return false
  const PKC = /** @type {{
    signalUnknownCredential?: (opts: { rpId: string, credentialId: string }) => Promise<void>,
    signalAllAcceptedCredentials?: (opts: { rpId: string, userId: string, allAcceptedCredentialIds: string[] }) => Promise<void>,
  }} */ (/** @type {unknown} */ (PublicKeyCredential))
  let attempted = false
  if (typeof PKC.signalUnknownCredential === 'function') {
    attempted = true
    try { await PKC.signalUnknownCredential({ rpId, credentialId }) } catch {}
  }
  if (typeof PKC.signalAllAcceptedCredentials === 'function' && userId) {
    attempted = true
    try {
      await PKC.signalAllAcceptedCredentials({
        rpId,
        userId,
        allAcceptedCredentialIds: [],
      })
    } catch {}
  }
  return attempted
}

// Lost-passkey escape hatch: nuke EVERYTHING this origin holds for
// DeepView so the user can start fresh. Used by the lock overlay's
// "I lost my passkey" affordance when the user is permanently
// locked out (factory-reset device, no iCloud backup, etc.) and
// has no other way to recover. Also useful when a USER_ID_KEY
// orphan is detected and the user knowingly wants to abandon the
// old credential.
//
// Scope:
//   - Vault metadata + USER_ID_KEY: cleared.
//   - All secure-storage keys: cleared (most are unreadable
//     envelopes anyway when the passkey is lost).
//   - `deepview.triage` + pending: cleared.
//   - `deepview.report:*` localStorage entries (the OPFS fallback
//     storage path used when OPFS isn't available — file://,
//     private-mode in some browsers): cleared via prefix scan.
//   - OPFS reports directory: cleared.
//   - OPFS bundles directory: cleared.
//   - In-memory session state: cleared.
//   - Sync sessions: cleared (covered by secure-storage wipe).
//
// Held under `VAULT_LOCK` (exclusive) so a sibling tab can't observe
// a partial wipe and a sibling `enableEncryption` can't be running
// concurrently — wiping a freshly-enabled vault would destroy the
// other tab's just-encrypted data.
//
// `refuseIfEnabled` opt-in for the orphan-resolve path: when the
// user clicked "Wipe and continue" because there was an orphaned
// USER_ID_KEY but no metadata, and a sibling tab raced between the
// dialog open and our lock acquisition by completing a fresh
// enableEncryption — wiping would destroy the sibling's data
// against the user's actual intent. The lost-passkey overlay path
// passes no option (the user explicitly chose "wipe everything").
//
// Best-effort per item: a single OPFS failure doesn't abort the
// rest. Caller is expected to `location.reload()` after this
// resolves so the page restarts with no residual state.
//
// Also signals credential removal for the orphaned passkey, where
// supported (Chrome 132+).
async function removeOpfsDirectory(root, dirName) {
  try {
    await root.removeEntry(dirName, { recursive: true })
    return null
  } catch (err) {
    if (err?.name === 'NotFoundError') return null  // benign
    return `${dirName}: ${err?.message ?? String(err)}`
  }
}
async function wipeOpfsDirectories(dirNames) {
  const failures = []
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return failures
  let root
  try {
    root = await navigator.storage.getDirectory()
  } catch (err) {
    failures.push(`storage root: ${err?.message ?? String(err)}`)
    return failures
  }
  for (const dirName of dirNames) {
    const failure = await removeOpfsDirectory(root, dirName)
    if (failure) failures.push(failure)
  }
  return failures
}

export async function wipeAllVaultData({ refuseIfEnabled = false } = {}) {
  disablingInThisTab += 1
  wipingInThisTab += 1
  try {
      return await navigator.locks.request(VAULT_LOCK, async () => {
      if (refuseIfEnabled && isEncryptionEnabled()) {
        throw new Error(
          'passkey: encryption was just enabled in another tab. Reload this '
          + 'page to unlock instead of wiping.',
        )
      }
      // Drain any in-flight secure-storage persists BEFORE clearing
      // disk. Otherwise a background `setItem` queued just before we
      // acquired the lock would complete its `localStorage.setItem`
      // AFTER our cleanup, producing a ghost entry that survives
      // the wipe (and reload — secure-storage's hydrate would cache
      // it from disk under the disabled vault).
      await drainSecureStorageWriteChain()
      const meta = readMetadata()
      // Best-effort signal first (while metadata is still readable).
      if (meta) {
        try {
          await signalCredentialRemovedFor({
            credentialId: meta.credentialId,
            rpId: meta.rpId ?? currentRpId(),
            userId: meta.userId,
          })
        } catch {}
      }
      // Clear localStorage keys FIRST so listeners triggered by the
      // vault-state-change fire see a fully-cleared disk and don't
      // race with the subsequent `removeItem` calls. Order: vault
      // metadata + USER_ID_KEY first (so `isEncryptionEnabled()`
      // returns false for any handler that runs), then the data keys.
      try { localStorage.removeItem(VAULT_KEY) } catch {}
      try { localStorage.removeItem(USER_ID_KEY) } catch {}
      try { localStorage.removeItem(CLEAN_DISABLE_KEY) } catch {}
      for (const k of [
        'deepview.workspaces',
        'deepview.sync.sessions',
        'deepview.sync.userEnabled',
        'deepview.repoUrls',
        'deepview.fileCounts',
        'deepview.lastFile',
        'deepview.triage',
        'deepview.triage.pending',
        'deepview.passkey.firstImportPrompted',
        'deepview.viewMode',
      ]) {
        try { localStorage.removeItem(k) } catch {}
      }
      // The `deepview.report:*` keys are the OPFS-fallback storage
      // path used by `client/storage.js` when OPFS is unavailable
      // (file://, some private-browsing modes). Without this sweep
      // they survive a wipe and resurface as undecryptable ghost
      // entries under the next vault. Snapshot the keys first since
      // we mutate the store inside the loop.
      try {
        const keys = []
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i)
          if (k && k.startsWith('deepview.report:')) keys.push(k)
        }
        for (const k of keys) {
          try { localStorage.removeItem(k) } catch {}
        }
      } catch {}
      // Clear in-memory vault state AFTER the disk state so any
      // listener triggered by the state change reads a clean disk.
      sessionKey = null
      sessionIdentityTag = null
      sessionCredentialId = null
      fireVaultStateChange()
      // Clear OPFS report and bundle directories. Track per-directory
      // failures so the caller can surface them — without this signal,
      // a wipe that succeeded on localStorage but failed on OPFS (the
      // browser quota-locked the dir, an extension blocked the
      // removeEntry) leaves orphan encrypted files invisible to the
      // user under the next vault. The user has no in-app affordance
      // to find them; only DevTools can recover.
      const opfsFailures = await wipeOpfsDirectories(['deepview-reports', 'deepview-bundles'])
      if (opfsFailures.length > 0) {
        throw new Error(
          'passkey: wipe partially succeeded — localStorage cleared but the '
          + `following OPFS paths could not be removed: ${opfsFailures.join('; ')}. `
          + 'Open DevTools → Application → Storage → Origin Private File System '
          + 'to inspect, or use the browser\'s site-data clear tool to finish.',
        )
    }
    })
  } finally {
    disablingInThisTab -= 1
    wipingInThisTab -= 1
  }
}

// Helpers wrapping the low-level crypto with the in-memory key + the
// AAD lookup — triage.js / storage.js never touch the CryptoKey
// directly. They call these and let the vault decide. Always return
// a Promise (rejected on the locked-vault path) so callers can rely
// on a uniform `await` shape regardless of vault state. A
// synchronous throw here would surprise call sites that already
// schedule the result as a Promise (await, .then, Promise.all, …).
export function sealForTriage(bytes) {
  if (!sessionKey) return Promise.reject(new Error('passkey: vault locked, cannot seal triage'))
  return sealEnvelope(sessionKey, bytes, getEnvelopeAadForTriage())
}

export function openForTriage(bytes) {
  if (!sessionKey) return Promise.reject(new Error('passkey: vault locked, cannot open triage'))
  return openEnvelope(sessionKey, bytes, getEnvelopeAadForTriage())
}

export function sealForOpfs(bytes, filename) {
  if (!sessionKey) return Promise.reject(new Error('passkey: vault locked, cannot seal OPFS file'))
  return sealEnvelope(sessionKey, bytes, getEnvelopeAadForOpfs(filename))
}

export function openForOpfs(bytes, filename) {
  if (!sessionKey) return Promise.reject(new Error('passkey: vault locked, cannot open OPFS file'))
  return openEnvelope(sessionKey, bytes, getEnvelopeAadForOpfs(filename))
}

export function sealForBundle(bytes, slot) {
  if (!sessionKey) return Promise.reject(new Error('passkey: vault locked, cannot seal bundle'))
  return sealEnvelope(sessionKey, bytes, getEnvelopeAadForBundle(slot))
}

export function openForBundle(bytes, slot) {
  if (!sessionKey) return Promise.reject(new Error('passkey: vault locked, cannot open bundle'))
  return openEnvelope(sessionKey, bytes, getEnvelopeAadForBundle(slot))
}

// Re-export the magic detection so callers can sniff bytes at the
// storage boundary without importing the low-level module too. Saves
// triage.js / storage.js from another import path.
export { hasEnvelopeMagic }

// Test-only reset — clears in-memory + persisted state. NOT exported
// to anything outside the test suite (the `__test__` namespace is the
// convention used by `triage-sync.ts` for the same need).
export const __test__ = {
  reset() {
    sessionKey = null
    sessionIdentityTag = null
    sessionCredentialId = null
    listeners.clear()
    clearMetadata()
    // Clear the persistent user.id too — without this, a test that
    // exercises enableEncryption twice would re-use the previous
    // test's id, which can hide bugs in the read-or-generate path.
    try { localStorage.removeItem(USER_ID_KEY) } catch {}
    // Clear the clean-disable marker so each test starts with
    // `hasOrphanedUserId()` reflecting only what THIS test set up.
    try { localStorage.removeItem(CLEAN_DISABLE_KEY) } catch {}
  },
  setSessionKeyForTesting(key, identityTag = 'test-user', credentialId = 'test-cred') {
    sessionKey = key
    sessionIdentityTag = identityTag
    sessionCredentialId = credentialId
  },
}

// Cross-tab propagation: a sibling tab's enable/disable fires a
// `storage` event in this tab. We surface vault-state-change so the
// UI can refresh (a sibling enable shouldn't leave this tab thinking
// nothing's encrypted; a sibling disable shouldn't leave this tab
// thinking the vault is still on). The in-memory session key is
// dropped when either:
//   - the sibling disabled the vault (no metadata anymore), OR
//   - the sibling re-keyed (new credentialId in metadata) — our
//     key can't open envelopes sealed by the new one.
// Keeping a stale key around would let in-flight writes seal data
// the next load can't open.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== VAULT_KEY) return
    const meta = readMetadata()
    if (!meta && sessionKey) {
      // sibling disabled the vault while this tab was unlocked —
      // drop the now-useless session key so we don't try sealing
      // writes that won't be unwrapped on next load.
      sessionKey = null
      sessionIdentityTag = null
      sessionCredentialId = null
    } else if (meta && sessionKey && meta.credentialId !== sessionCredentialId) {
      // Sibling-tab disable-then-re-enable produced a NEW credential
      // (`credentialId` is freshly assigned by the authenticator on
      // every register, regardless of whether `user.id` was re-used
      // from USER_ID_KEY). Our in-memory AES-GCM key is derived from
      // the OLD credential's PRF output — it can't open envelopes
      // sealed by the new key, and writes sealed under it would be
      // unreadable post-reload. Drop the session — the user must
      // re-unlock with the freshly registered passkey.
      //
      // Comparing `credentialId` rather than `userId` matters because
      // USER_ID_KEY persistence means `meta.userId === sessionIdentityTag`
      // even after a re-key; only `credentialId` reliably distinguishes
      // the two credential generations.
      sessionKey = null
      sessionIdentityTag = null
      sessionCredentialId = null
    }
    fireVaultStateChange()
  })
}
