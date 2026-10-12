// A package's files from its tarball, as npm installs them: gunzipped, read as
// a tar archive (ustar, pax and GNU long names), each file by the path npm
// installs it at, its first component dropped, none escaping the package; a
// text where it is UTF-8 with no NUL, else null. Held to the npm viewer's
// bounds (server-managed/npm-packages.ts readNpmTar).
export const MAX_PACKAGE_FILES = 20_000
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024
// What its tar stream may unpack to, its headers and padding beside its
// files, as npm-loads.ts bounds it (MAX_TAR_BYTES).
export const MAX_TAR_BYTES = 96 * 1024 * 1024

const latin1 = new TextDecoder('latin1')
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const utf8Lenient = bytes => new TextDecoder().decode(bytes)
// A header's text field, to its first NUL.
const textOf = (bytes, start, length) => {
  const field = bytes.subarray(start, start + length)
  const end = field.indexOf(0)
  return utf8Lenient(end === -1 ? field : field.subarray(0, end))
}

// A header's size field: octal, or GNU base-256 past its 11 digits.
function sizeOf(bytes, offset) {
  if (bytes[offset] & 0x80) {
    let size = bytes[offset] & 0x7f
    for (let i = 1; i < 12; i++) size = size * 256 + bytes[offset + i]
    return size
  }
  const text = textOf(bytes, offset, 12).trim()
  return /^[0-7]+$/u.test(text) ? Number.parseInt(text, 8) : Number.NaN
}

// A pax header's path: records `<length> <key>=<value>\n`, their lengths in
// bytes.
function paxPath(data) {
  let at = 0, path = null
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    const length = Number.parseInt(latin1.decode(data.subarray(at, space)), 10)
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0) break
    const record = utf8Lenient(data.subarray(space + 1, at + length - 1))
    if (record.startsWith('path=')) path = record.slice(5)
    at += length
  }
  return path
}

const packagePath = raw => {
  const parts = raw.split('/').slice(1).filter(part => part !== '' && part !== '.')
  return parts.length === 0 || parts.includes('..') ? null : parts.join('/')
}

// The files of a tar archive, by path: their bytes.
export function npmTarFiles(tar) {
  const files = new Map()
  let longName = null, offset = 0, total = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const size = sizeOf(header, 124), start = offset + 512, type = String.fromCodePoint(header[156])
    if (!Number.isSafeInteger(size) || size < 0 || start + size > tar.length) throw new Error('bad-tarball')
    const data = tar.subarray(start, start + size)
    offset = start + Math.ceil(size / 512) * 512
    if (type === 'x' || type === 'L') { longName = type === 'x' ? paxPath(data) : textOf(data, 0, data.length); continue }
    if (type === 'g' || type === 'K') continue
    const prefix = textOf(header, 257, 6) === 'ustar' ? textOf(header, 345, 155) : ''
    const name = longName ?? (prefix ? `${prefix}/${textOf(header, 0, 100)}` : textOf(header, 0, 100))
    longName = null
    const path = ['0', '\0', '7'].includes(type) ? packagePath(name) : null
    if (path === null) continue
    total += size - (files.get(path)?.length ?? 0)
    files.set(path, data)
    if (files.size > MAX_PACKAGE_FILES || total > MAX_PACKAGE_BYTES) throw new Error('package-too-large')
  }
  return files
}

// A file's text: UTF-8 with no NUL, else null.
export function npmFileText(bytes) {
  if (bytes.includes(0)) return null
  try { return utf8.decode(bytes) } catch { return null }
}

// A gzipped tarball's tar stream, given up on as `package-too-large` once it
// unpacks past MAX_TAR_BYTES, before any more of it is held.
async function gunzip(gzipped) {
  const reader = new Blob([gzipped]).stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  const chunks = []
  let size = 0
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength
    if (size > MAX_TAR_BYTES) { await reader.cancel(); throw new Error('package-too-large') }
    chunks.push(read.value)
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer())
}

// A gzipped tarball's files as a version holds them for risk, as a source map
// lists them (`kind: 'sourcemap'`, as the npm viewer holds a version):
// `json.sources` their paths, sorted, `json.sourcesContent` their texts, and
// `fileSizes` by path.
export async function npmTarballVersion(gzipped) {
  const files = [...npmTarFiles(await gunzip(gzipped))].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return { kind: 'sourcemap', json: { version: 3, sources: files.map(([path]) => path), sourcesContent: files.map(([, bytes]) => npmFileText(bytes)) }, fileSizes: new Map(files.map(([path, bytes]) => [path, bytes.length])) }
}
