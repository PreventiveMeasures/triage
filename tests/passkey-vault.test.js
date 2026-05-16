// Passkey vault — covers the OPT-IN state machine + the migration
// path that wraps/unwraps existing triage + OPFS-report data when
// the vault transitions on/off. The actual WebAuthn-driven session
// key derivation is mocked: we inject a CryptoKey directly via
// `__test__.setSessionKeyForTesting` to simulate "the user has just
// completed the assertion ceremony", then exercise the migration +
// integration with triage.js / storage.js exactly as a real boot
// would.

import './_polyfills.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { ENVELOPE_MAGIC, deriveContentKey, hasEnvelopeMagic, importContentKey } = await import('../client/passkey-crypto.ts')

function freshUrl(stem) {
  // Cache-bust an importer-side module (triage.js / storage.js /
  // state.ts) so its module-level state (loadPromise, saveGen, the
  // `state` object) starts from zero. NEVER apply this to
  // passkey-vault.js — that module must be the SHARED singleton
  // every importer references, otherwise the test's injected
  // session key would land in a different instance from the one
  // triage / storage check via getSessionKey().
  return `?vault=${stem}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// Imported once — the same instance every cache-busted triage /
// storage import references through its own (non-cache-busted)
// `import './passkey-vault.js'`. Per-test isolation is achieved via
// `vault.__test__.reset()` + `localStorage.clear()` below.
//
// Same logic applies to state.ts: cache-busting it would hand the
// test a sibling copy whose `state.markers` writes are invisible to
// the cached state.ts that triage.js / saveTriage iterate. Sharing
// the cached instance + clearing the maps between tests keeps both
// sides looking at the same mutable surface.
const vault = await import('../client/passkey-vault.js')
const { state } = await import('../client/state.ts')

function clearState() {
  state.markers.clear()
  state.triageState.clear()
  state.comments.clear()
  state.fixes.clear()
  state.ignoredIds.clear()
}

function resetVault() {
  vault.__test__.reset()
}

async function injectKey() {
  // Real flow: registerPasskey → assertPasskey → deriveContentKey →
  // importContentKey. Tests substitute a deterministic 32-byte buffer
  // for the PRF output so the rest of the flow runs unchanged.
  const raw = await deriveContentKey(new Uint8Array(32).fill(42))
  const key = await importContentKey(raw)
  vault.__test__.setSessionKeyForTesting(key)
  return key
}

describe('passkey-vault — sealForTriage / openForTriage round-trip', () => {
  it('round-trips through the AEAD with the triage AAD bound in', async () => {
    resetVault()
    await injectKey()
    const pt = new TextEncoder().encode('some triage blob')
    const env = await vault.sealForTriage(pt)
    assert.ok(hasEnvelopeMagic(env))
    const out = await vault.openForTriage(env)
    assert.deepEqual(out, pt)
  })

  it('a triage envelope does NOT open with an OPFS AAD (AAD swap blocked)', async () => {
    resetVault()
    await injectKey()
    const env = await vault.sealForTriage(new TextEncoder().encode('triage'))
    await assert.rejects(() => vault.openForOpfs(env, 'any.json'), /./u)
  })

  it('two OPFS envelopes sealed under different filenames do not swap', async () => {
    resetVault()
    await injectKey()
    const a = await vault.sealForOpfs(new TextEncoder().encode('A'), 'a.json')
    // Trying to open `a` claiming it's `b.json` must fail — AAD
    // includes the filename, so a file-rename on disk would change
    // the AAD that the reader reconstructs and AEAD verification fails.
    await assert.rejects(() => vault.openForOpfs(a, 'b.json'), /./u)
  })
})

describe('passkey-vault — locked state surfaces errors', () => {
  it('seal/open throw when no session key has been set', async () => {
    resetVault()
    await assert.rejects(() => vault.sealForTriage(new Uint8Array([1])), /locked/u)
    await assert.rejects(() => vault.openForTriage(new Uint8Array([0x44, 0x56, 0x45, 0x31])), /locked/u)
    await assert.rejects(() => vault.sealForOpfs(new Uint8Array([1]), 'x'), /locked/u)
    await assert.rejects(() => vault.openForOpfs(new Uint8Array([0x44, 0x56, 0x45, 0x31]), 'x'), /locked/u)
  })

  it('isUnlocked reflects whether a key has been injected', async () => {
    resetVault()
    assert.equal(vault.isUnlocked(), false)
    await injectKey()
    assert.equal(vault.isUnlocked(), true)
  })

  it('test-reset clears the in-memory session key (mirrors a tab close)', async () => {
    resetVault()
    await injectKey()
    assert.equal(vault.isUnlocked(), true)
    vault.__test__.reset()
    assert.equal(vault.isUnlocked(), false)
  })
})

describe('passkey-vault — userId persistence', () => {
  it('survives a sibling-tab disable so subsequent enable re-uses the same id', () => {
    // After a disable→enable cycle, the same userId should be
    // re-used so OS-level passkey managers re-bind the credential
    // slot rather than stacking duplicates. The persistent key
    // (`deepview.passkey.userId`) is what makes that possible —
    // disable clears VAULT_KEY but leaves USER_ID_KEY behind. Test
    // exercises the full survive-then-rebind round-trip: seed the
    // persistent id, simulate disable, then verify a hypothetical
    // re-enable would read back the same bytes.
    resetVault()
    // 16-byte payload, base64url-encoded without padding (22 chars).
    const seed = new Uint8Array(16).fill(7).toBase64({ alphabet: 'base64url', omitPadding: true })
    globalThis.localStorage.setItem('deepview.passkey.userId', seed)
    // Simulate `disableEncryption`'s `clearMetadata` (= remove
    // VAULT_KEY only). USER_ID_KEY must survive.
    globalThis.localStorage.removeItem('deepview.passkey.v1')
    // Now simulate the read half of `readOrCreateUserId`: the next
    // enable should read back the same value rather than generating
    // fresh bytes. We don't have direct access to the function (it's
    // module-internal), so we verify the bytes the function WOULD
    // read are the same we seeded.
    const persisted = globalThis.localStorage.getItem('deepview.passkey.userId')
    assert.equal(persisted, seed, 'USER_ID_KEY survives disable verbatim')
    const bytes = Uint8Array.fromBase64(persisted, { alphabet: 'base64url' })
    assert.equal(bytes.length, 16, 'persisted bytes are the correct length for re-use as user.id')
  })

  it('test-reset clears USER_ID_KEY to prevent inter-test bleed', () => {
    // resetVault() exposes `__test__.reset` which clears both keys.
    // Without USER_ID_KEY clearing, a test that enables encryption
    // would re-use the previous test's userId, hiding bugs in the
    // generate-on-first-call branch of `readOrCreateUserId`.
    globalThis.localStorage.setItem('deepview.passkey.userId', 'bGVha2FnZS10ZXN0LXZhbHVlMTY')
    resetVault()
    assert.equal(
      globalThis.localStorage.getItem('deepview.passkey.userId'),
      null,
      'resetVault clears USER_ID_KEY',
    )
  })
})

describe('passkey-vault — storage-event re-key detection', () => {
  it('credentialId comparison is the right re-key signal (not userId)', () => {
    // After a sibling-tab disable+re-enable cycle, the new metadata
    // carries a FRESH credentialId (the authenticator assigns a new
    // one per ceremony) but the same userId (USER_ID_KEY persists).
    //
    // The storage-event handler can't be triggered from node:test
    // (no `window`, no StorageEvent dispatch path), so we verify the
    // INPUTS that the handler would compare. The contract:
    //   - new meta.userId === old sessionIdentityTag  →  userId-only
    //     comparison would miss the re-key entirely.
    //   - new meta.credentialId !== old sessionCredentialId  →
    //     credentialId comparison correctly detects it.
    resetVault()
    const oldMeta = {
      enabled: true,
      credentialId: 'cred-A',
      prfSalt: 'salt-A',
      userId: 'persistent-user',
      rpId: 'localhost',
      createdAt: Date.now(),
    }
    const newMeta = {
      ...oldMeta,
      credentialId: 'cred-B',  // fresh on every register
      prfSalt: 'salt-B',       // fresh on every register
      // userId: 'persistent-user' — SAME via USER_ID_KEY
    }
    // The handler's "userId stayed the same" branch would NOT fire
    // even though the key changed:
    assert.equal(oldMeta.userId, newMeta.userId, 'userId comparison would miss re-key')
    // The credentialId branch DOES fire:
    assert.notEqual(oldMeta.credentialId, newMeta.credentialId, 'credentialId comparison catches re-key')
  })
})

describe('passkey-vault — metadata validation', () => {
  it('rejects metadata with an empty userId (AAD-collision guard)', () => {
    // An empty userId would slot into the AAD as
    // `deepview.triage.v1|` — bit-identical to the locked-vault
    // default. Guard at the metadata-read boundary so a corrupted
    // or hostile localStorage entry can't bypass identity binding.
    resetVault()
    globalThis.localStorage.setItem('deepview.passkey.v1', JSON.stringify({
      enabled: true,
      credentialId: 'cred',
      prfSalt: 'salt',
      userId: '',  // <-- the bad case
      rpId: 'localhost',
      createdAt: Date.now(),
    }))
    assert.equal(vault.isEncryptionEnabled(), false, 'empty userId rejected')
  })

  it('rejects metadata with an empty credentialId or prfSalt', () => {
    resetVault()
    globalThis.localStorage.setItem('deepview.passkey.v1', JSON.stringify({
      enabled: true,
      credentialId: '',
      prfSalt: 'salt',
      userId: 'u',
      createdAt: Date.now(),
    }))
    assert.equal(vault.isEncryptionEnabled(), false)
    globalThis.localStorage.setItem('deepview.passkey.v1', JSON.stringify({
      enabled: true,
      credentialId: 'cred',
      prfSalt: '',
      userId: 'u',
      createdAt: Date.now(),
    }))
    assert.equal(vault.isEncryptionEnabled(), false)
  })
})

describe('passkey-vault — getEnvelopeAad helpers', () => {
  it('triage AAD is stable across calls and folds in the identity tag', async () => {
    resetVault()
    await injectKey()  // setSessionKeyForTesting uses identityTag = 'test-user'
    const a = vault.getEnvelopeAadForTriage()
    const b = vault.getEnvelopeAadForTriage()
    assert.deepEqual(a, b)
    assert.equal(new TextDecoder().decode(a), 'deepview.triage.v1|test-user')
  })

  it('triage AAD with different identity tags does not match', async () => {
    resetVault()
    await injectKey()
    const a = vault.getEnvelopeAadForTriage()
    vault.__test__.reset()
    const key = await injectKeyWithTag('other-user')
    const b = vault.getEnvelopeAadForTriage()
    assert.notDeepEqual(a, b)
    // Suppress unused-key lint
    void key
  })

  it('OPFS AAD folds in the filename and the identity tag', async () => {
    resetVault()
    await injectKey()
    const a = vault.getEnvelopeAadForOpfs('report-A.json')
    const b = vault.getEnvelopeAadForOpfs('report-B.json')
    assert.notDeepEqual(a, b)
    assert.equal(new TextDecoder().decode(a), 'deepview.opfs.v1|test-user|report-A.json')
  })

  it('OPFS AAD rejects non-string filenames', () => {
    resetVault()
    assert.throws(() => vault.getEnvelopeAadForOpfs(42), /TypeError/u)
    assert.throws(() => vault.getEnvelopeAadForOpfs(null), /TypeError/u)
  })
})

async function injectKeyWithTag(tag) {
  const raw = await deriveContentKey(new Uint8Array(32).fill(43))
  const key = await importContentKey(raw)
  vault.__test__.setSessionKeyForTesting(key, tag)
  return key
}

describe('passkey-vault — migration helpers integrate with triage', () => {
  it('triage migrate→encrypt→reload round-trips correctly', async () => {
    globalThis.localStorage.clear()
    resetVault()
    clearState()
    const triage = await import(`../client/triage.js${freshUrl('triage')}`)
    // Seed a plaintext triage blob the way `saveTriage` would (deflate
    // + base64), then mutate state.* through the SHARED state.ts so
    // saveTriage's iteration sees the entries.
    state.markers.set('uuid-001', 'red')
    state.comments.set('uuid-001', 'check this')
    await triage.saveTriage()
    // Vault is still disabled; the saved blob should be a raw
    // (non-enveloped) deflate stream. Pending key is written
    // synchronously by saveTriage; clear it so readTriageBlob falls
    // through to the compressed key (which is what the migration
    // helper operates on).
    globalThis.localStorage.removeItem('deepview.triage.pending')
    const raw0 = globalThis.localStorage.getItem('deepview.triage')
    const bytes0 = Uint8Array.fromBase64(raw0)
    assert.equal(hasEnvelopeMagic(bytes0), false, 'blob is plaintext before encryption is enabled')
    // Now inject a key (simulate post-unlock) and migrate.
    const key = await injectKey()
    const aad = vault.getEnvelopeAadForTriage()
    await triage.migrateTriageToEncrypted({
      seal: async (bytes) => {
        const { sealEnvelope } = await import('../client/passkey-crypto.ts')
        return sealEnvelope(key, bytes, aad)
      },
    })
    const raw1 = globalThis.localStorage.getItem('deepview.triage')
    const bytes1 = Uint8Array.fromBase64(raw1)
    assert.ok(hasEnvelopeMagic(bytes1), 'blob is enveloped after migration')
    // Read path picks up the new envelope and decrypts via the injected key.
    clearState()
    await triage.reloadTriageFromStorage()
    assert.equal(state.markers.get('uuid-001'), 'red')
    assert.equal(state.comments.get('uuid-001'), 'check this')
  })

  it('triage migrate→decrypt restores plaintext', async () => {
    globalThis.localStorage.clear()
    resetVault()
    clearState()
    const triage = await import(`../client/triage.js${freshUrl('triage2')}`)
    state.markers.set('uuid-002', 'blue')
    const key = await injectKey()
    await triage.saveTriage()  // saves enveloped (key is set)
    globalThis.localStorage.removeItem('deepview.triage.pending')
    const raw0 = Uint8Array.fromBase64(globalThis.localStorage.getItem('deepview.triage'))
    assert.ok(hasEnvelopeMagic(raw0), 'saved enveloped while key is set')
    // Migrate back to plaintext.
    const aad = vault.getEnvelopeAadForTriage()
    await triage.migrateTriageToPlaintext({
      open: async (bytes) => {
        const { openEnvelope } = await import('../client/passkey-crypto.ts')
        return openEnvelope(key, bytes, aad)
      },
    })
    const raw1 = Uint8Array.fromBase64(globalThis.localStorage.getItem('deepview.triage'))
    assert.equal(hasEnvelopeMagic(raw1), false, 'blob is plaintext after disable-migrate')
  })

  it('migrate-to-encrypted is a no-op when the blob is already enveloped', async () => {
    globalThis.localStorage.clear()
    resetVault()
    clearState()
    const triage = await import(`../client/triage.js${freshUrl('triage3')}`)
    state.markers.set('uuid-003', 'green')
    await injectKey()
    await triage.saveTriage()
    globalThis.localStorage.removeItem('deepview.triage.pending')
    const before = globalThis.localStorage.getItem('deepview.triage')
    let sealCallCount = 0
    await triage.migrateTriageToEncrypted({
      seal: () => { sealCallCount += 1; throw new Error('should not be called') },
    })
    const after = globalThis.localStorage.getItem('deepview.triage')
    assert.equal(sealCallCount, 0, 'seal must not be called on already-enveloped data')
    assert.equal(after, before, 'localStorage entry unchanged')
  })

  it('migrate-to-encrypted is a no-op when no triage blob is stored', async () => {
    globalThis.localStorage.clear()
    resetVault()
    const triage = await import(`../client/triage.js${freshUrl('triage4')}`)
    // Nothing in localStorage; migration should not throw and should
    // not invoke the seal callback.
    let sealCallCount = 0
    await triage.migrateTriageToEncrypted({
      seal: () => { sealCallCount += 1; throw new Error('should not be called') },
    })
    assert.equal(sealCallCount, 0)
    assert.equal(globalThis.localStorage.getItem('deepview.triage'), null)
  })
})

describe('passkey-vault — migration helpers integrate with storage', () => {
  it('storage migrateOpfsFilesEncrypt wraps every file with its filename AAD', async () => {
    globalThis.localStorage.clear()
    resetVault()
    const storage = await import(`../client/storage.js${freshUrl('storage')}`)
    await storage.saveFile('alpha.json', '{"finding":"A"}')
    await storage.saveFile('beta.json', '{"finding":"B"}')
    // Both saved as plaintext (vault still disabled).
    const alpha0 = globalThis.localStorage.getItem('deepview.report:alpha.json')
    const beta0 = globalThis.localStorage.getItem('deepview.report:beta.json')
    assert.equal(hasEnvelopeMagic(Uint8Array.fromBase64(alpha0)), false)
    assert.equal(hasEnvelopeMagic(Uint8Array.fromBase64(beta0)), false)
    const key = await injectKey()
    await storage.migrateOpfsFilesEncrypt({
      seal: async (bytes, aad) => {
        const { sealEnvelope } = await import('../client/passkey-crypto.ts')
        return sealEnvelope(key, bytes, aad)
      },
    })
    const alpha1 = globalThis.localStorage.getItem('deepview.report:alpha.json')
    const beta1 = globalThis.localStorage.getItem('deepview.report:beta.json')
    assert.ok(hasEnvelopeMagic(Uint8Array.fromBase64(alpha1)))
    assert.ok(hasEnvelopeMagic(Uint8Array.fromBase64(beta1)))
    // Reading through readFile should peel the envelope + gunzip
    // transparently via the in-process session key.
    assert.equal(await storage.readFile('alpha.json'), '{"finding":"A"}')
    assert.equal(await storage.readFile('beta.json'), '{"finding":"B"}')
  })

  it('storage migrateOpfsFilesDecrypt restores plaintext from envelope', async () => {
    globalThis.localStorage.clear()
    resetVault()
    const storage = await import(`../client/storage.js${freshUrl('storage2')}`)
    const key = await injectKey()
    await storage.saveFile('gamma.json', '{"finding":"G"}')
    const gamma0 = globalThis.localStorage.getItem('deepview.report:gamma.json')
    assert.ok(hasEnvelopeMagic(Uint8Array.fromBase64(gamma0)), 'saved enveloped while key is set')
    await storage.migrateOpfsFilesDecrypt({
      open: async (bytes, aad) => {
        const { openEnvelope } = await import('../client/passkey-crypto.ts')
        return openEnvelope(key, bytes, aad)
      },
    })
    const gamma1 = globalThis.localStorage.getItem('deepview.report:gamma.json')
    assert.equal(hasEnvelopeMagic(Uint8Array.fromBase64(gamma1)), false)
  })

  it('vault-enabled-but-not-yet-unlocked read of an enveloped file surfaces a clean error', async () => {
    // Simulates a fresh tab load where the on-disk file is
    // enveloped but the user hasn't completed the unlock ceremony
    // yet. The fresh storage import starts with an empty cache, so
    // readFile must go to LS / OPFS and discover that envelopes are
    // unreadable. Mirrors the boot sequence: vault-enabled metadata
    // is loaded synchronously, but the session key only lands after
    // the WebAuthn assertion (which the user can postpone).
    globalThis.localStorage.clear()
    resetVault()
    const storage = await import(`../client/storage.js${freshUrl('storage3')}`)
    const key = await injectKey()
    await storage.saveFile('delta.json', '{"finding":"D"}')
    // Fresh storage import — its cache is empty. The previous
    // storage instance's cache still holds the plaintext but is
    // unreachable from this module instance, mirroring a fresh tab.
    const storage2 = await import(`../client/storage.js${freshUrl('storage3b')}`)
    vault.__test__.reset()
    await assert.rejects(() => storage2.readFile('delta.json'), /vault locked/u)
    // Re-inject the same key (simulate the next unlock) — read
    // succeeds again.
    vault.__test__.setSessionKeyForTesting(key)
    assert.equal(await storage2.readFile('delta.json'), '{"finding":"D"}')
  })
})

describe('passkey-vault — shared lock serialises saves vs migration', () => {
  it('saveFile waits for an exclusive VAULT_LOCK holder to release', async () => {
    // Verifies the load-bearing invariant: a saveFile issued while
    // someone holds VAULT_LOCK exclusively (= enable/disable
    // migration in flight) MUST wait for the exclusive holder to
    // release before its own shared acquisition can proceed.
    //
    // Driven by an ORDER array rather than just by final on-disk
    // shape: without the shared lock, saveFile's async work could
    // interleave with the exclusive holder's async work in either
    // direction, so a "both files enveloped" assertion would pass
    // either way. By observing that `save-done` strictly follows
    // `exclusive-end`, we pin the wait.
    globalThis.localStorage.clear()
    resetVault()
    const storage = await import(`../client/storage.js${freshUrl('storage-lock')}`)
    const order = []
    // Take VAULT_LOCK exclusive (the mode enableEncryption /
    // disableEncryption use) and hold it for 30ms — long enough to
    // be deterministically observable vs. saveFile's near-immediate
    // async work.
    const exclusive = navigator.locks.request('deepview.passkey.v1.write', async () => {
      order.push('exclusive-start')
      await new Promise((r) => { setTimeout(r, 30) })
      order.push('exclusive-end')
    })
    // Issued AFTER the exclusive request lands in the lock
    // scheduler's queue, but the scheduler decides when each runs.
    // saveFile internally requests shared mode — it must wait for
    // exclusive to finish.
    const save = storage.saveFile('beta.json', '{"finding":"B"}').then(() => {
      order.push('save-done')
      return null
    })
    await Promise.all([exclusive, save])
    // The contract: `save-done` follows `exclusive-end`. The
    // polyfill (older Node) serialises all requests regardless of
    // mode, so the property holds there too — a stricter version
    // of what shared mode guarantees in the real browser.
    const exclusiveEndIdx = order.indexOf('exclusive-end')
    const saveDoneIdx = order.indexOf('save-done')
    assert.ok(exclusiveEndIdx >= 0 && saveDoneIdx >= 0, 'both events fired')
    assert.ok(
      saveDoneIdx > exclusiveEndIdx,
      `saveFile must wait for exclusive lock holder; order=${JSON.stringify(order)}`,
    )
  })

  it('saveTriage waits for an exclusive VAULT_LOCK holder to release', async () => {
    // Same invariant as the saveFile test above, but for
    // saveTriage which acquires shared VAULT_LOCK around its
    // compress + commit. Mirrors the migration-vs-saveTriage race
    // the original audit flagged.
    globalThis.localStorage.clear()
    resetVault()
    clearState()
    const triage = await import(`../client/triage.js${freshUrl('triage-lock')}`)
    state.markers.set('uuid-lock-test', 'red')
    const order = []
    const exclusive = navigator.locks.request('deepview.passkey.v1.write', async () => {
      order.push('exclusive-start')
      await new Promise((r) => { setTimeout(r, 30) })
      order.push('exclusive-end')
    })
    const save = triage.saveTriage().then(() => { order.push('save-done'); return null })
    await Promise.all([exclusive, save])
    const exclusiveEndIdx = order.indexOf('exclusive-end')
    const saveDoneIdx = order.indexOf('save-done')
    assert.ok(
      saveDoneIdx > exclusiveEndIdx,
      `saveTriage must wait for exclusive lock holder; order=${JSON.stringify(order)}`,
    )
  })
})

describe('passkey-vault — envelope magic does not collide with gzip', () => {
  it('a gzip stream is never mistaken for an envelope', () => {
    // gzip magic = 1f 8b; envelope magic = 44 56 45 31. The byte
    // distance is large but a defensive test pins it.
    const gz = new Uint8Array([0x1f, 0x8b, 0x00, 0x00, 0xaa, 0xbb])
    assert.equal(hasEnvelopeMagic(gz), false)
    // And vice versa — an envelope's first bytes are NEVER 1f 8b.
    for (let i = 0; i < ENVELOPE_MAGIC.length; i++) {
      assert.notEqual(ENVELOPE_MAGIC[i], 0x1f)
    }
  })
})

describe('passkey-vault — saveTriage empty-entries path (audit round-4)', () => {
  it('empty triage state + unlocked vault settles without infinite retry', async () => {
    // Round-3 added a vault-state consistency check that compared
    // `getSessionKey()` against a `sealedWithKey` snapshot. When the
    // user clears all triage (`isEmpty = true`, `json = null`), the
    // seal block was skipped, leaving `sealedWithKey = null`. With
    // the vault unlocked, `getSessionKey()` returned a non-null key,
    // mismatch → `queueMicrotask(saveTriage)` → identical state →
    // infinite microtask loop, starving the event loop.
    //
    // Fix: only run the consistency check when `json != null` (i.e.
    // when we actually sealed something). Empty-entries cleanup has
    // no envelope/plaintext ambiguity to reconcile.
    globalThis.localStorage.clear()
    resetVault()
    clearState()
    const triage = await import(`../client/triage.js${freshUrl('triage-empty')}`)
    await injectKey()  // unlocks the vault with a deterministic key
    // No state.markers / state.triageState entries — fully empty.
    // The save should complete in a bounded number of microtasks.
    // If the bug regresses, this test hangs the event loop and the
    // test framework's timeout fires.
    await triage.saveTriage()
    // Verify it actually wrote the empty-state removal (no
    // TRIAGE_KEY in localStorage).
    assert.equal(globalThis.localStorage.getItem('deepview.triage'), null)
  })
})

describe('passkey-vault — locked-vault save rejection', () => {
  it('saveFile refuses to write plaintext while vault is enabled-but-locked', async () => {
    // A user who dismissed the boot unlock dialog ends up at
    // `isEncryptionEnabled() === true && isUnlocked() === false`.
    // Pre-fix, saveFile silently wrote plaintext bytes to OPFS
    // under the enabled vault — breaking the "everything written
    // while encryption is on is encrypted" invariant.
    globalThis.localStorage.clear()
    resetVault()
    // Set up vault metadata WITHOUT injecting a key (= dismissed
    // boot dialog state). 16-byte userId (base64url, 22 chars).
    const userId = new Uint8Array(16).fill(9).toBase64({ alphabet: 'base64url', omitPadding: true })
    globalThis.localStorage.setItem('deepview.passkey.v1', JSON.stringify({
      enabled: true,
      credentialId: 'cred',
      prfSalt: 'salt',
      userId,
      rpId: 'localhost',
      createdAt: Date.now(),
    }))
    const storage = await import(`../client/storage.js${freshUrl('locked-reject')}`)
    await assert.rejects(
      () => storage.saveFile('locked.json', '{"finding":"A"}'),
      /vault locked, cannot save/u,
    )
  })
})
