import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Buffer } from 'node:buffer'
import { hkdfSync, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { STORAGE_CHUNK_BYTES as CHUNK, STORAGE_HEADER_BYTES as HEADER, decryptStorageStream, encryptStorageStream, parseStorageKey } from '../server-common/storage-crypto.ts'

const key = parseStorageKey(Buffer.alloc(32, 42).toString('base64'))
const identity = 'bundles/15e86a19-9d50-4df3-a49e-eb3509480f22'
const source = bytes => Readable.from([bytes])
async function collect(stream) { const parts = []; for await (const part of stream) parts.push(part); return Buffer.concat(parts) }
function encode(bytes, size = bytes.length) { return collect(encryptStorageStream(source(bytes), key, identity, size)) }
async function decode(bytes, name = identity, cryptoKey = key) {
  const opened = await decryptStorageStream(source(bytes), cryptoKey, name)
  return { size: opened.size, bytes: await collect(opened.stream) }
}

test('storage key parsing requires exactly 32 canonical base64 bytes without disclosing the supplied value', () => {
  assert.equal(parseStorageKey(undefined), null)
  assert.equal(parseStorageKey(''), null)
  for (const bad of ['password', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), `${key.bytes.toString('base64')}\n`, '!'.repeat(44)]) {
    assert.throws(() => parseStorageKey(bad), err => !err.message.includes(bad) && /32 random bytes/u.test(err.message))
  }
})

for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 2, CHUNK * 3 + 17]) {
  test(`ChaCha storage round-trip at ${size} bytes, with independent noble verification`, async () => {
    const bytes = randomBytes(size), encrypted = await encode(bytes)
    assert.deepEqual(await decode(encrypted), { size, bytes })
    assert.notDeepEqual(encrypted, await encode(bytes), 'each write has a fresh key derivation salt')
    const header = encrypted.subarray(0, HEADER)
    const derived = Buffer.from(hkdfSync('sha256', key.bytes, header.subarray(17, 49),
      Buffer.from(JSON.stringify(['deepview.storage.v1', identity])), 32))
    const parts = []
    for (let index = 0, offset = HEADER; offset < encrypted.length; offset += CHUNK + 16, index++) {
      const frame = encrypted.subarray(offset, offset + CHUNK + 16)
      const nonce = Buffer.alloc(12); nonce.writeUInt32BE(index, 7); nonce[11] = offset + frame.length === encrypted.length ? 1 : 0
      parts.push(Buffer.from(chacha20poly1305(derived, nonce, header).decrypt(frame)))
    }
    assert.deepEqual(Buffer.concat(parts), bytes)
  })
}

test('framing is independent of transport chunk boundaries and supports unknown sizes', async () => {
  const bytes = randomBytes(CHUNK * 2 + 31), encoded = await encode(bytes, null)
  const pieces = Array.from({ length: Math.ceil(encoded.length / 73) }, (_, i) => encoded.subarray(i * 73, (i + 1) * 73))
  const opened = await decryptStorageStream(Readable.from(pieces), key, identity)
  assert.equal(opened.size, null)
  assert.deepEqual(await collect(opened.stream), bytes)
  await assert.rejects(encode(bytes, bytes.length + 1), /size changed/u)
})

test('rejects corruption, truncation, appended bytes, reordered chunks, wrong keys and object substitution', async () => {
  const encoded = await encode(randomBytes(CHUNK * 3 + 23))
  for (const offset of [0, 16, 17, 49, 57, HEADER, HEADER + CHUNK + 16, encoded.length - 1]) {
    const bad = Buffer.from(encoded); bad[offset] ^= 1
    await assert.rejects(decode(bad), `corruption at ${offset}`)
  }
  for (const end of [0, HEADER - 1, HEADER, HEADER + CHUNK + 16, encoded.length - 1]) await assert.rejects(decode(encoded.subarray(0, end)))
  await assert.rejects(decode(Buffer.concat([encoded, Buffer.from([0])])) )
  const a = HEADER, b = a + CHUNK + 16, c = b + CHUNK + 16
  await assert.rejects(decode(Buffer.concat([encoded.subarray(0, a), encoded.subarray(b, c), encoded.subarray(a, b), encoded.subarray(c)])))
  await assert.rejects(decode(Buffer.concat([encoded.subarray(0, b), encoded.subarray(a, b), encoded.subarray(b)])))
  await assert.rejects(decode(encoded, `${identity}.map.br`))
  await assert.rejects(decode(encoded, identity, parseStorageKey(randomBytes(32).toString('base64'))))
})

test('never emits unauthenticated chunk contents and closes the source on failure or HEAD cancellation', async () => {
  const bytes = randomBytes(CHUNK * 3), encoded = await encode(bytes)
  encoded[HEADER + CHUNK + 16 + 7] ^= 1
  const raw = source(encoded)
  const opened = await decryptStorageStream(raw, key, identity), seen = []
  await assert.rejects(async () => { for await (const part of opened.stream) seen.push(part) })
  assert.deepEqual(Buffer.concat(seen), bytes.subarray(0, CHUNK))
  assert.equal(raw.destroyed, true)
  const headSource = source(await encode(bytes))
  const head = await decryptStorageStream(headSource, key, identity)
  head.stream.destroy()
  await new Promise(resolve => { head.stream.once('close', resolve) })
  assert.equal(headSource.destroyed, true)
})

test('streaming backpressure bounds read-ahead instead of accumulating the input', async () => {
  const block = randomBytes(CHUNK), size = CHUNK * 128
  let ahead = 0, consumed = 0, generated = 0
  const input = Readable.from((async function* () {
    while (generated < size) { generated += CHUNK; ahead = Math.max(ahead, generated - consumed); yield block }
  })(), { objectMode: false })
  const decoded = await decryptStorageStream(encryptStorageStream(input, key, identity, size), key, identity)
  for await (const part of decoded.stream) consumed += part.length
  assert.equal(consumed, size)
  assert.ok(ahead <= 16 * CHUNK, `bounded read-ahead: ${ahead} bytes`)
})
