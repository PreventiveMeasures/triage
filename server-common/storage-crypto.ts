// Storage envelope v1: header, then 64 KiB plaintext chunks with full AEAD tags.
// The nonce layout follows age's STREAM construction (counter || final flag).
// Every write derives a new key, including rewrites of the same logical object.
import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'

export const STORAGE_MAGIC = Buffer.from('DeepView.storage')
const VERSION = 1
export const STORAGE_CHUNK_BYTES = 65_536
export const STORAGE_HEADER_BYTES = 57
const TAG_BYTES = 16
const UNKNOWN_SIZE = 0xffff_ffff_ffff_ffffn

export interface StorageKey { bytes: Buffer; id: string }

export function parseStorageKey(value: string | null | undefined): StorageKey | null {
  if (value == null || value === '') return null
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== 32 || bytes.toString('base64') !== value) {
    throw new Error('MANAGED_STORAGE_ENCRYPTION_KEY must be canonical base64 encoding of 32 random bytes')
  }
  const id = createHash('sha256').update('deepview.storage.key.v1\0').update(bytes).digest('hex').slice(0, 32)
  return { bytes, id }
}

// Re-chunk without accumulating a file, regardless of the input's read sizes.
async function* chunks(source: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Buffer> {
  let length = 0, pending: Buffer[] = []
  for await (const value of source) {
    const input = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    for (let offset = 0; offset < input.length;) {
      const n = Math.min(size - length, input.length - offset)
      pending.push(input.subarray(offset, offset + n)); length += n; offset += n
      if (length === size) { yield Buffer.concat(pending, length); pending = []; length = 0 }
    }
  }
  if (length) yield Buffer.concat(pending, length)
}

async function* frames(source: AsyncIterable<Uint8Array>, size: number) {
  const iterator = chunks(source, size)[Symbol.asyncIterator]()
  try {
    let current = await iterator.next()
    if (current.done) { yield { bytes: Buffer.alloc(0), last: true }; return }
    while (!current.done) {
      const next = await iterator.next()
      yield { bytes: current.value, last: next.done === true }
      current = next
    }
  } finally { await iterator.return(undefined) }
}

function nonce(index: number, last: boolean): Buffer {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff) throw new Error('Storage object has too many chunks')
  const value = Buffer.alloc(12)
  value.writeUInt32BE(index, 7)
  value[11] = last ? 1 : 0
  return value
}

function objectKey(key: Uint8Array, header: Buffer, identity: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, header.subarray(17, 49),
    Buffer.from(JSON.stringify(['deepview.storage.v1', identity])), 32))
}

function makeHeader(size: number | null): Buffer {
  if (size !== null && (!Number.isSafeInteger(size) || size < 0)) throw new Error('Invalid storage size')
  const header = Buffer.alloc(STORAGE_HEADER_BYTES)
  STORAGE_MAGIC.copy(header); header[16] = VERSION
  randomBytes(32).copy(header, 17)
  header.writeBigUInt64BE(size === null ? UNKNOWN_SIZE : BigInt(size), 49)
  return header
}

export function encryptStorageStream(source: Readable, key: Uint8Array, identity: string, size: number | null): Readable {
  async function* encrypt() {
    const header = makeHeader(size)
    const derived = objectKey(key, header, identity)
    let index = 0, length = 0
    try {
      yield header
      for await (const { bytes, last } of frames(source, STORAGE_CHUNK_BYTES)) {
        length += bytes.length
        if (last && size !== null && length !== size) throw new Error('Storage size changed while encrypting')
        const cipher = createCipheriv('chacha20-poly1305', derived, nonce(index++, last), { authTagLength: TAG_BYTES })
        cipher.setAAD(header)
        yield Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
      }
    } finally { derived.fill(0); source.destroy() }
  }
  const stream = Readable.from(encrypt(), { objectMode: false })
  stream.once('close', () => source.destroy())
  return stream
}

// Read just the envelope and authenticate the first frame before returning.
// In particular, never trust a corrupted size or release update() output
// before final() authenticates the complete chunk.
export async function decryptStorageStream(source: Readable, key: Uint8Array, identity: string) {
  const iterator = source[Symbol.asyncIterator]()
  let done = false
  let peek: Buffer = Buffer.alloc(0), remainder: Buffer = Buffer.alloc(0)
  async function read(size: number): Promise<Buffer> {
    const parts: Buffer[] = peek.length > 0 ? [peek] : []
    let length = peek.length
    peek = Buffer.alloc(0)
    while (length < size) {
      if (remainder.length === 0 && !done) {
        const next = await iterator.next(); done = next.done === true
        remainder = done ? Buffer.alloc(0) : next.value
      }
      if (remainder.length === 0 && done) break
      const n = Math.min(size - length, remainder.length)
      parts.push(remainder.subarray(0, n)); remainder = remainder.subarray(n); length += n
    }
    return Buffer.concat(parts, length)
  }
  let derived: Buffer | undefined
  try {
    const header = await read(STORAGE_HEADER_BYTES)
    if (header.length !== STORAGE_HEADER_BYTES || !header.subarray(0, 16).equals(STORAGE_MAGIC) || header[16] !== VERSION) {
      throw new Error('Invalid encrypted storage envelope')
    }
    const rawSize = header.readBigUInt64BE(49)
    if (rawSize !== UNKNOWN_SIZE && rawSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid encrypted storage size')
    const size = rawSize === UNKNOWN_SIZE ? null : Number(rawSize)
    derived = objectKey(key, header, identity)
    const derivedKey = derived
    let index = 0, length = 0
    const nextFrame = async () => {
      const bytes = await read(STORAGE_CHUNK_BYTES + TAG_BYTES)
      // Peek beyond the frame: EOF authenticates the final flag, including
      // exact chunk boundaries. Keep the byte for the next read.
      peek = await read(1)
      const last = peek.length === 0
      if (bytes.length < TAG_BYTES || (index > 0 && bytes.length === TAG_BYTES)) throw new Error('Truncated encrypted storage object')
      const decipher = createDecipheriv('chacha20-poly1305', derivedKey, nonce(index++, last), { authTagLength: TAG_BYTES })
      decipher.setAAD(header); decipher.setAuthTag(bytes.subarray(-TAG_BYTES))
      const plain = Buffer.concat([decipher.update(bytes.subarray(0, -TAG_BYTES)), decipher.final()])
      length += plain.length
      if (size !== null && (length > size || (last && length !== size))) throw new Error('Encrypted storage size mismatch')
      return { plain, last }
    }
    const first = await nextFrame()
    const decrypt = async function* () {
      try {
        yield first.plain
        let last = first.last
        while (!last) { const frame = await nextFrame(); last = frame.last; yield frame.plain }
      } finally { derivedKey.fill(0); await iterator.return?.(); source.destroy() }
    }
    const stream = Readable.from(decrypt(), { objectMode: false })
    stream.once('close', () => { derivedKey.fill(0); source.destroy() })
    return { size, stream }
  } catch (err) { derived?.fill(0); source.destroy(); throw err }
}

// Small SQL values (data keys, OAuth tokens and the installation sentinel).
// Fresh salt derives a one-use wrapping key, so the nonce can be all zeroes.
// The version and master-key ID are authenticated along with the row/field.
export function wrapStorageValue(key: StorageKey, identity: string, value: Uint8Array): string {
  const header = Buffer.concat([Buffer.from([1]), Buffer.from(key.id, 'hex'), randomBytes(32)])
  const derived = Buffer.from(hkdfSync('sha256', key.bytes, header.subarray(17), 'deepview.wrap.v1', 32))
  try {
    const cipher = createCipheriv('chacha20-poly1305', derived, Buffer.alloc(12), { authTagLength: TAG_BYTES })
    cipher.setAAD(Buffer.concat([header, Buffer.from(identity)]))
    return Buffer.concat([header, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64')
  } finally { derived.fill(0) }
}

export function unwrapStorageValue(key: StorageKey, identity: string, value: string): Buffer {
  const bytes = Buffer.from(value, 'base64'), header = bytes.subarray(0, 49)
  if (bytes.length < 65 || bytes.toString('base64') !== value || header[0] !== 1
    || header.subarray(1, 17).toString('hex') !== key.id) throw new Error('Invalid wrapped storage value or encryption key')
  const derived = Buffer.from(hkdfSync('sha256', key.bytes, header.subarray(17), 'deepview.wrap.v1', 32))
  try {
    const decipher = createDecipheriv('chacha20-poly1305', derived, Buffer.alloc(12), { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.concat([header, Buffer.from(identity)])); decipher.setAuthTag(bytes.subarray(-TAG_BYTES))
    return Buffer.concat([decipher.update(bytes.subarray(49, -TAG_BYTES)), decipher.final()])
  } finally { derived.fill(0) }
}
