// Pin the HKDF info-string contract that domain-separates every
// key derived from a workspace's 32-byte privateKey. Empty salt is
// RFC 5869-acceptable because the IKM is a uniform CSPRNG output
// (see Soatok's "Understanding HKDF", §3) — but that posture rests
// ENTIRELY on the info string being pairwise distinct across every
// call site. A future refactor that accidentally collides info
// strings (e.g. drops the `|${workspaceId}` suffix from the signing
// derivation) would silently produce identical key bytes for what
// should be distinct keys.
//
// Two-layer assertion:
//   1. Source-level: scan `client/sync-crypto.ts` and
//      `client/objstore-content-crypto.ts` for HKDF info-string
//      LITERALS and assert pairwise-distinctness + presence of the
//      expected canonical values.
//   2. Behavioral: actually derive all four keys (content,
//      signing-seed, objstore-content, objstore-tag) from a fixed
//      IKM and assert byte-level pairwise distinctness — the
//      runtime contract a colliding-info refactor would break.
//
// A test that only checked behavioral distinctness would miss the
// case where someone TYPES the same literal in two places by
// accident; a test that only checked source literals would miss
// the case where the constants are imported from a shared module
// that changes one value. Both layers together pin both vectors.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'

// Polyfill localStorage for the client modules' import graph.
if (globalThis.localStorage === undefined) {
  globalThis.localStorage = (() => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)) },
      removeItem: (k) => { m.delete(k) },
      clear: () => { m.clear() },
      get length() { return m.size },
      key: (i) => [...m.keys()][i] ?? null,
    }
  })()
}

const { deriveSessionKey, deriveSigningKeypair } = await import('../client/sync-crypto.ts')
const { deriveObjstoreKeys } = await import('../client/objstore-content-crypto.ts')

const SYNC_CRYPTO_PATH = fileURLToPath(new URL('../client/sync-crypto.ts', import.meta.url))
const OBJSTORE_CRYPTO_PATH = fileURLToPath(new URL('../client/objstore-content-crypto.ts', import.meta.url))

// Extract every literal info string the source files declare. The
// regex matches `'deepview-...'` constants — the literal form used
// at every call site today. If a future refactor switches to a
// dynamically-built info string, this scrape will under-count and
// the constants-expected check below will catch it.
function scrapeInfoLiterals(path) {
  const src = readFileSync(path, 'utf8')
  // Match literal info-string constants of the form
  // 'deepview-<segment>.v1.<role>' inside single quotes. The
  // signing call site builds its info via `${SIGN_INFO}|${workspaceId}`
  // at runtime — only the constant prefix appears as a literal in
  // source, which is what we want to pin here.
  const matches = src.matchAll(/'(deepview-[\w.-]+)'/gu)
  return [...matches].map((m) => m[1])
}

describe('HKDF info-string uniqueness (RFC 5869 §3.1 — empty salt with uniform IKM)', () => {
  it('source-level: every HKDF info string is pairwise-distinct + matches the expected canonical set', () => {
    const fromSync = scrapeInfoLiterals(SYNC_CRYPTO_PATH)
    const fromObj = scrapeInfoLiterals(OBJSTORE_CRYPTO_PATH)
    const allLiterals = [...fromSync, ...fromObj]
    const unique = new Set(allLiterals)
    assert.equal(unique.size, allLiterals.length, `HKDF info strings collide: ${JSON.stringify(allLiterals)}`)
    // Same domain-separation contract applies to the HMAC prefixes
    // that derive tag namespaces from the SHARED `tagKey` — the
    // report tag (`objstore-tag\n`) and bundle tag (`objstore-
    // bundle-tag\n`) prefixes are byte-strings concatenated with the
    // identifier before HMAC-SHA-256. They MUST be pairwise distinct
    // AND no prefix must be a prefix of another (otherwise an
    // identifier crafted to align across prefixes could produce the
    // same HMAC input — defeating the namespace split). The regex
    // matches every `'objstore-…\n'` literal in the source (both
    // const declarations and doc-comment quotes), so we dedupe
    // before counting.
    const objSrc = readFileSync(OBJSTORE_CRYPTO_PATH, 'utf8')
    const hmacPrefixMatches = objSrc.matchAll(/'(objstore-[\w-]+\\n)'/gu)
    const hmacPrefixes = [...new Set([...hmacPrefixMatches].map((m) => m[1]))]
    assert.ok(hmacPrefixes.length >= 2, `expected at least two HMAC prefixes, found ${hmacPrefixes.length}`)
    for (const a of hmacPrefixes) {
      for (const b of hmacPrefixes) {
        if (a === b) continue
        assert.ok(!a.startsWith(b) && !b.startsWith(a),
          `HMAC prefix is a prefix of another: ${JSON.stringify({ a, b })}`)
      }
    }
    // Pin the expected canonical set so a future refactor that
    // adds a third namespace prompts an explicit decision.
    const expectedPrefixes = new Set(['objstore-tag\\n', 'objstore-bundle-tag\\n'])
    for (const want of expectedPrefixes) {
      assert.ok(hmacPrefixes.includes(want), `expected HMAC prefix '${want}' not found in source`)
    }
    // The canonical four are what every protocol participant
    // expects. A drift in any of these is a wire-protocol v2.
    const expected = new Set([
      'deepview-triage-sync.v1.content-key',
      'deepview-triage-sync.v1.sign-key',
      'deepview-objstore.v1.content',
      'deepview-objstore.v1.tag',
    ])
    for (const want of expected) {
      assert.ok(unique.has(want), `expected canonical info string '${want}' not found in source — wire-protocol breaking change`)
    }
  })

  it('behavioral: four distinct keys derived from one IKM are pairwise byte-different', async () => {
    // Fixed test IKM (32 deterministic bytes, base64url-encoded).
    // Real privateKeys are CSPRNG-uniform; this fixture is only
    // for the distinctness assertion — we don't care about its
    // entropy, only that it round-trips through every derivation.
    const ikm = Buffer.from('01020304050607080910111213141516171819202122232425262728293031'.padStart(64, '0'), 'hex')
    const ikmB64 = Buffer.from(ikm).toString('base64url')

    const sessionKey = await deriveSessionKey(ikmB64)
    const signing = await deriveSigningKeypair(ikmB64, 'workspace-A')
    const { contentKey, tagKey } = await deriveObjstoreKeys(ikmB64, 'workspace-A')

    const keys = {
      sessionKey: Buffer.from(sessionKey).toString('hex'),
      signingPublicKey: signing.publicKeyB64,
      objstoreContentKey: Buffer.from(contentKey).toString('hex'),
      objstoreTagKey: Buffer.from(tagKey).toString('hex'),
    }

    // Each of the four 32-byte derivations must produce different
    // bytes. With pairwise-distinct info strings and the same IKM,
    // HKDF guarantees independence; this assertion would fail if a
    // future refactor accidentally collided info strings.
    const values = Object.entries(keys)
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        assert.notEqual(
          values[i][1],
          values[j][1],
          `HKDF derivations collide: ${values[i][0]} == ${values[j][0]} — info-string domain separation broken`,
        )
      }
    }
  })

  it('behavioral: signing keypair is per-workspaceId (workspaceId suffix in info string is load-bearing)', async () => {
    const ikm = Buffer.from('01020304050607080910111213141516171819202122232425262728293031'.padStart(64, '0'), 'hex')
    const ikmB64 = Buffer.from(ikm).toString('base64url')
    const a = await deriveSigningKeypair(ikmB64, 'workspace-A')
    const b = await deriveSigningKeypair(ikmB64, 'workspace-B')
    assert.notEqual(
      a.publicKeyB64,
      b.publicKeyB64,
      'signing keys for distinct workspaceIds must differ — the `|${workspaceId}` suffix in the HKDF info string is load-bearing',
    )
  })

  it('behavioral: objstore content+tag keys are bound to privateKey ONLY, not workspaceId (peers sharing the key converge regardless of local workspaceId label)', async () => {
    // Documented contract: a share-link recipient may attach the
    // workspace under a different LOCAL workspaceId label than the
    // sender, but as long as they hold the same 32-byte privateKey
    // they must derive the same content+tag keys so they can read
    // each other's objstore blobs. Only the signing keypair is
    // bound to workspaceId (so workspaceTag = derived pubkey acts
    // as the server-facing identifier).
    const ikm = Buffer.from('01020304050607080910111213141516171819202122232425262728293031'.padStart(64, '0'), 'hex')
    const ikmB64 = Buffer.from(ikm).toString('base64url')
    const a = await deriveObjstoreKeys(ikmB64, 'workspace-A')
    const b = await deriveObjstoreKeys(ikmB64, 'workspace-B')
    assert.equal(
      Buffer.from(a.contentKey).toString('hex'),
      Buffer.from(b.contentKey).toString('hex'),
      'objstore contentKey is privateKey-only by contract — pins shared-link recipient convergence',
    )
    assert.equal(
      Buffer.from(a.tagKey).toString('hex'),
      Buffer.from(b.tagKey).toString('hex'),
      'objstore tagKey is privateKey-only by contract',
    )
  })
})
