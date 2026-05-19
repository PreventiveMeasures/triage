// Unit tests for `client/objstore-content-crypto.ts`. Covers the
// pure-CPU surface (HKDF derivation, HMAC tag computation, AEAD
// encrypt/decrypt with AAD binding) without spinning up a relay.
// The server-driven path is exercised separately in
// `tests/client-objstore.test.js`.

import './_polyfills.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Buffer } from 'node:buffer'

import {
  computeBundleResourceTag,
  computeResourceTag,
  decryptObjstorePayload,
  deriveObjstoreKeys,
  encryptObjstorePayload,
  unwrapBundleContent,
  wrapBundleContent,
} from '../client/sync/objstore-content-crypto.ts'
import { deriveSigningKeypair } from '../client/sync/sync-crypto.ts'

const FIXED_KEY_BASE64 = Buffer.alloc(32, 0xaa).toString('base64')

describe('client/objstore-content-crypto', () => {
  describe('deriveObjstoreKeys', () => {
    it('produces deterministic keys for the same (privateKey, workspaceId)', async () => {
      const wsId = 'fixed-workspace-id'
      const a = await deriveObjstoreKeys(FIXED_KEY_BASE64, wsId)
      const b = await deriveObjstoreKeys(FIXED_KEY_BASE64, wsId)
      assert.equal(a.workspaceTag, b.workspaceTag)
      assert.deepEqual(Array.from(a.contentKey), Array.from(b.contentKey))
      assert.deepEqual(Array.from(a.tagKey), Array.from(b.tagKey))
    })

    it('produces distinct keys for different workspaceIds (same private key)', async () => {
      const a = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws-a')
      const b = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws-b')
      // contentKey + tagKey only depend on the private key, NOT on
      // workspaceId — that's an intentional design choice (so a
      // share-by-link recipient under a renamed workspace still
      // decrypts the chain). signing key + workspaceTag DO bind
      // workspaceId.
      assert.deepEqual(Array.from(a.contentKey), Array.from(b.contentKey))
      assert.deepEqual(Array.from(a.tagKey), Array.from(b.tagKey))
      assert.notEqual(a.workspaceTag, b.workspaceTag, 'workspaceTag is keyed on workspaceId')
    })

    it('rejects a private key that is not 32 bytes', async () => {
      const tooShort = Buffer.alloc(16).toString('base64')
      await assert.rejects(deriveObjstoreKeys(tooShort, 'any'), /32 bytes/u)
    })

    it('content and tag keys are domain-separated (HKDF info distinct)', async () => {
      const { contentKey, tagKey } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'any')
      assert.notDeepEqual(Array.from(contentKey), Array.from(tagKey),
        'content + tag keys must differ — distinct HKDF info strings')
    })

    it('workspaceTag matches sync-crypto.deriveSigningKeypair (cross-protocol identity)', async () => {
      // Audit round-1 H1: a silent info-string drift between this
      // module and sync-crypto's signing-key derivation would mean
      // an objstore session and a triage-sync session for the same
      // workspace use different `workspaceTag`s at the relay. This
      // pin will catch any future regression — when one moves, both
      // must move together (and ideally share a constant).
      const wsId = 'identity-match-test'
      const objstore = await deriveObjstoreKeys(FIXED_KEY_BASE64, wsId)
      const sync = await deriveSigningKeypair(FIXED_KEY_BASE64, wsId)
      assert.equal(objstore.workspaceTag, sync.publicKeyB64,
        'objstore.workspaceTag MUST equal sync-crypto.publicKeyB64')
    })
  })

  describe('computeResourceTag', () => {
    it('is deterministic per (tagKey, fileName)', async () => {
      const { tagKey } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws-1')
      const a = await computeResourceTag(tagKey, 'report.json')
      const b = await computeResourceTag(tagKey, 'report.json')
      assert.equal(a, b)
    })

    it('produces a 43-char base64url string (HMAC-SHA-256 → no padding)', async () => {
      const { tagKey } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws-1')
      const tag = await computeResourceTag(tagKey, 'report.json')
      assert.match(tag, /^[\w-]{43}$/u)
    })

    it('different fileNames produce different tags (PRF property)', async () => {
      const { tagKey } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws-1')
      const a = await computeResourceTag(tagKey, 'a.json')
      const b = await computeResourceTag(tagKey, 'b.json')
      assert.notEqual(a, b)
    })

    it('different tagKeys produce different tags for the same fileName', async () => {
      const x = await deriveObjstoreKeys(Buffer.alloc(32, 1).toString('base64'), 'ws')
      const y = await deriveObjstoreKeys(Buffer.alloc(32, 2).toString('base64'), 'ws')
      const tagX = await computeResourceTag(x.tagKey, 'report.json')
      const tagY = await computeResourceTag(y.tagKey, 'report.json')
      assert.notEqual(tagX, tagY)
    })

    it('the tag does NOT leak the plaintext fileName', async () => {
      const { tagKey } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws-1')
      const tag = await computeResourceTag(tagKey, 'super-secret-filename.json')
      assert.ok(!tag.includes('secret'), 'tag must not embed the plaintext')
      assert.ok(!tag.includes('filename'), 'tag must not embed the plaintext')
    })
  })

  describe('computeBundleResourceTag', () => {
    it('is deterministic per (tagKey, integrity)', async () => {
      const { tagKey } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws-1')
      const a = await computeBundleResourceTag(tagKey, 'sha512-AAAA')
      const b = await computeBundleResourceTag(tagKey, 'sha512-AAAA')
      assert.equal(a, b)
    })

    it('produces a 43-char base64url string (HMAC-SHA-256 → no padding)', async () => {
      const { tagKey } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws-1')
      const tag = await computeBundleResourceTag(tagKey, 'sha512-AAAA')
      assert.match(tag, /^[\w-]{43}$/u)
    })

    it('different integrities produce different tags', async () => {
      const { tagKey } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws-1')
      const a = await computeBundleResourceTag(tagKey, 'sha512-AAAA')
      const b = await computeBundleResourceTag(tagKey, 'sha512-BBBB')
      assert.notEqual(a, b)
    })

    it('bundle and report tags are disjoint for the same input string', async () => {
      // Domain separation: a report named "foo" and a (hypothetical)
      // bundle with integrity "foo" must produce different wire tags
      // under the same tagKey. Without the distinct HMAC prefixes
      // (`objstore-tag\n` vs. `objstore-bundle-tag\n`) the same
      // string would HMAC to the same value and the report and
      // bundle namespaces would collide on the relay's storage.
      const { tagKey } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws-1')
      const sameInput = 'sha512-COLLIDE'
      const reportTag = await computeResourceTag(tagKey, sameInput)
      const bundleTag = await computeBundleResourceTag(tagKey, sameInput)
      assert.notEqual(reportTag, bundleTag,
        'report and bundle tag derivations must be disjoint for the same input')
    })

    it('different tagKeys produce different bundle tags for the same integrity', async () => {
      const x = await deriveObjstoreKeys(Buffer.alloc(32, 1).toString('base64'), 'ws')
      const y = await deriveObjstoreKeys(Buffer.alloc(32, 2).toString('base64'), 'ws')
      const tagX = await computeBundleResourceTag(x.tagKey, 'sha512-AAAA')
      const tagY = await computeBundleResourceTag(y.tagKey, 'sha512-AAAA')
      assert.notEqual(tagX, tagY)
    })

    it('the bundle tag does NOT leak the plaintext integrity', async () => {
      const { tagKey } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws-1')
      const tag = await computeBundleResourceTag(tagKey, 'sha512-SECRET-INTEGRITY-AAAA')
      assert.ok(!tag.includes('SECRET'), 'tag must not embed the plaintext')
      assert.ok(!tag.includes('INTEGRITY'), 'tag must not embed the plaintext')
    })
  })

  describe('wrapBundleContent + unwrapBundleContent', () => {
    it('round-trips (name, content) through wrap → unwrap', () => {
      const content = Buffer.from('the actual bundle bytes go here')
      const wrapped = wrapBundleContent('my-app.bundle.js', content)
      const got = unwrapBundleContent(wrapped)
      assert.equal(got.name, 'my-app.bundle.js')
      assert.equal(Buffer.compare(Buffer.from(got.content), content), 0)
    })

    it('handles empty content', () => {
      const wrapped = wrapBundleContent('empty.js', new Uint8Array(0))
      const got = unwrapBundleContent(wrapped)
      assert.equal(got.name, 'empty.js')
      assert.equal(got.content.length, 0)
    })

    it('handles UTF-8 names with multi-byte characters', () => {
      const content = Buffer.from('x')
      const wrapped = wrapBundleContent('日本語.bundle.js', content)
      const got = unwrapBundleContent(wrapped)
      assert.equal(got.name, '日本語.bundle.js')
    })

    it('refuses to wrap a name longer than 65535 bytes', () => {
      // The u16BE length prefix caps the name at 0xffff bytes.
      const tooLong = 'a'.repeat(0x10000)
      assert.throws(() => wrapBundleContent(tooLong, new Uint8Array(0)), /name too long/u)
    })

    it('refuses to unwrap a truncated payload', () => {
      assert.throws(() => unwrapBundleContent(new Uint8Array(1)), /truncated/u)
      // Length-prefix claims more bytes than present.
      const bad = new Uint8Array([0xff, 0xff, 0x00])
      assert.throws(() => unwrapBundleContent(bad), /overflows/u)
    })
  })

  describe('encryptObjstorePayload + decryptObjstorePayload', () => {
    it('round-trips (fileName, content) through encrypt → decrypt', async () => {
      const { contentKey, tagKey, workspaceTag } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws')
      const fileName = 'round-trip.json'
      const content = Buffer.from(JSON.stringify({ findings: [{ id: 1 }] }))
      const tag = await computeResourceTag(tagKey, fileName)
      const blob = encryptObjstorePayload(contentKey, fileName, content, workspaceTag, tag)
      const { fileName: outName, content: outContent } = decryptObjstorePayload(contentKey, blob, workspaceTag, tag)
      assert.equal(outName, fileName)
      assert.equal(Buffer.compare(Buffer.from(outContent), content), 0)
    })

    it('two encrypts of the same plaintext produce different ciphertexts (random AEAD nonce)', async () => {
      const { contentKey, tagKey, workspaceTag } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws')
      const tag = await computeResourceTag(tagKey, 'file.json')
      const a = encryptObjstorePayload(contentKey, 'file.json', Buffer.from('content'), workspaceTag, tag)
      const b = encryptObjstorePayload(contentKey, 'file.json', Buffer.from('content'), workspaceTag, tag)
      assert.notDeepEqual(Array.from(a), Array.from(b),
        'ciphertexts must differ — AEAD nonce reuse would be a key-recovery flaw')
    })

    it('decrypt fails when the workspaceTag in AAD differs', async () => {
      const { contentKey, tagKey, workspaceTag } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws')
      const tag = await computeResourceTag(tagKey, 'aad.json')
      const blob = encryptObjstorePayload(contentKey, 'aad.json', Buffer.from('payload'), workspaceTag, tag)
      assert.throws(() => decryptObjstorePayload(contentKey, blob, 'WRONG-WORKSPACE-TAG', tag))
    })

    it('decrypt fails when the resourceTag in AAD differs', async () => {
      const { contentKey, tagKey, workspaceTag } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws')
      const tag = await computeResourceTag(tagKey, 'aad.json')
      const blob = encryptObjstorePayload(contentKey, 'aad.json', Buffer.from('payload'), workspaceTag, tag)
      assert.throws(() => decryptObjstorePayload(contentKey, blob, workspaceTag, `${tag.slice(0, -1)}A`))
    })

    it('decrypt fails when the contentKey differs (different workspace)', async () => {
      const a = await deriveObjstoreKeys(Buffer.alloc(32, 1).toString('base64'), 'ws')
      const b = await deriveObjstoreKeys(Buffer.alloc(32, 2).toString('base64'), 'ws')
      const tag = await computeResourceTag(a.tagKey, 'cross.json')
      const blob = encryptObjstorePayload(a.contentKey, 'cross.json', Buffer.from('payload'), a.workspaceTag, tag)
      // Wrong contentKey — chacha20-poly1305.decrypt raises.
      assert.throws(() => decryptObjstorePayload(b.contentKey, blob, a.workspaceTag, tag))
    })

    it('decrypt fails when a single ciphertext byte is flipped (AEAD tag rejects)', async () => {
      const { contentKey, tagKey, workspaceTag } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws')
      const tag = await computeResourceTag(tagKey, 'tampered.json')
      const blob = encryptObjstorePayload(contentKey, 'tampered.json', Buffer.from('payload'), workspaceTag, tag)
      // Flip a byte in the middle of the ciphertext (past the 12-byte
      // nonce so we mutate the encrypted content, not the public
      // nonce).
      const tampered = new Uint8Array(blob)
      tampered[20] ^= 0x01
      assert.throws(() => decryptObjstorePayload(contentKey, tampered, workspaceTag, tag))
    })

    it('plaintext layout encodes the fileName before the content (binding)', async () => {
      // Sanity check the inner frame structure: a decrypted blob
      // surfaces BOTH the fileName and the content, so a peer
      // accidentally decrypting a tampered (but valid-AEAD) blob
      // can't get confused about which file they're looking at.
      const { contentKey, tagKey, workspaceTag } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws')
      const fileName = 'utf-8-name-名前.json'  // multi-byte UTF-8 to stress the length prefix
      const content = Buffer.from('contents')
      const tag = await computeResourceTag(tagKey, fileName)
      const blob = encryptObjstorePayload(contentKey, fileName, content, workspaceTag, tag)
      const decoded = decryptObjstorePayload(contentKey, blob, workspaceTag, tag)
      assert.equal(decoded.fileName, fileName)
      assert.equal(Buffer.from(decoded.content).toString('utf8'), 'contents')
    })

    it('decrypt rejects a too-short payload (< nonce + AEAD tag)', async () => {
      const { contentKey, workspaceTag } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws')
      const tooShort = new Uint8Array(10)
      assert.throws(() => decryptObjstorePayload(contentKey, tooShort, workspaceTag, 'sometag'),
        /too short/u)
    })

    it('rejects a fileName larger than the 16-bit length prefix can hold', async () => {
      const { contentKey, tagKey, workspaceTag } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws')
      const huge = 'x'.repeat(70_000)
      const tag = await computeResourceTag(tagKey, huge)
      assert.throws(() => encryptObjstorePayload(contentKey, huge, Buffer.from('c'), workspaceTag, tag),
        /fileName too long/u)
    })

    it('fetchByTag binding: tag derived from decrypted fileName catches a tag-name swap (audit round-1 M2)', async () => {
      // The `fetchByTag` path in `client/objstore.ts` decrypts the
      // wire blob, then re-derives the tag from the decoded
      // fileName and asserts it matches the requested tag. This is
      // the in-process defense against a workspace member (anyone
      // with the tagKey) PUTting an AAD-valid blob whose inner
      // fileName HMACs to a DIFFERENT tag — AAD covers the tag, so
      // AEAD decryption alone would happily succeed.
      //
      // We can't reach `fetchByTag`'s rebinding step directly (it's
      // private inside `createObjstoreSession`), but the invariant
      // it relies on is testable here: a forged blob encrypted at
      // `tag(realName)` with inner-encoded `forgedName` decrypts
      // cleanly, but `computeResourceTag(tagKey, forgedName) !==
      // tag(realName)`. That inequality is exactly what
      // `fetchByTag` checks.
      const { contentKey, tagKey, workspaceTag } = await deriveObjstoreKeys(FIXED_KEY_BASE64, 'ws')
      const realTag = await computeResourceTag(tagKey, 'real.json')
      // Forge an AEAD blob at realTag whose plaintext encodes a
      // different fileName.
      const blob = encryptObjstorePayload(
        contentKey, 'other.json', Buffer.from('mismatched'),
        workspaceTag, realTag,
      )
      // AEAD decrypt at realTag succeeds — AAD matches.
      const decoded = decryptObjstorePayload(contentKey, blob, workspaceTag, realTag)
      assert.equal(decoded.fileName, 'other.json')
      // The rebinding check: the decoded fileName must HMAC back
      // to the tag we asked for. It doesn't — `fetchByTag` would
      // raise here.
      const reboundTag = await computeResourceTag(tagKey, decoded.fileName)
      assert.notEqual(reboundTag, realTag,
        'rebinding catches the swap: decoded fileName HMACs to a different tag than the wire tag')
    })
  })
})
