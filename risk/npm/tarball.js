// A package's files from its tarball, as it holds them, whatever installs it
// (npm renames a .gitignore .npmignore, pnpm and yarn keep it): gunzipped and
// read as a tar archive by @preventive/archive, which refuses one malformed, a
// name or a symlink that would climb out of it, and a name repeated as another
// entry; each file by its path there, its first component dropped; a text
// where it is UTF-8 with no NUL, else null. Held to the npm viewer's bounds
// (server-managed/npm-packages.ts readNpmTar).
import { CompressionError, decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'

const MAX_PACKAGE_FILES = 20_000
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024
// The entries its tar stream may hold, a directory's too, read before any is
// counted as a file, as npm-packages.ts bounds them (MAX_NPM_TAR_ENTRIES).
export const MAX_TAR_ENTRIES = 2 * MAX_PACKAGE_FILES
// What its tar stream may unpack to, its headers and padding beside its
// files, as npm-loads.ts bounds it (MAX_TAR_BYTES).
export const MAX_TAR_BYTES = 96 * 1024 * 1024

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The files of a tar archive, by path: their bytes. A file at its top is not
// extracted, and one under another top directory at the same path replaces
// an earlier one, as extraction would. Past MAX_TAR_ENTRIES it is given up on
// as `package-too-large`, before any more of it is read.
function npmTarFiles(tar) {
  let entries
  try {
    entries = unpack(tar, { maxEntries: MAX_TAR_ENTRIES })
  } catch (error) {
    if (error instanceof ArchiveError && error.limited) throw new Error('package-too-large', { cause: error })
    throw error
  }
  const files = new Map()
  let total = 0
  for (const { name, type, data } of entries) {
    const slash = name.indexOf('/')
    if ((type !== 'file' && type !== 'contiguous-file') || slash === -1) continue
    const path = name.slice(slash + 1)
    total += data.length - (files.get(path)?.length ?? 0)
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

// A gzipped tarball's tar stream, through @preventive/archive's gzip, given up
// on as `package-too-large` once it unpacks past MAX_TAR_BYTES, before any
// more of it is held.
async function gunzip(gzipped) {
  try {
    return await decompress(gzipped, 'gzip', { limit: MAX_TAR_BYTES })
  } catch (error) {
    if (error instanceof CompressionError && error.limited) throw new Error('package-too-large', { cause: error })
    throw error
  }
}

// Whether a file that isn't text may run as JavaScript all the same, as node
// decodes it as UTF-8 (npm/files.js npmLoadedScripts): only where its first
// character no UTF-8 encodes, or its first NUL, which JavaScript holds only
// in a string, a template, a regular expression or a comment, may sit in
// one, after a quote, a backtick, a slash, a `<` or `-` (an HTML-like
// comment, `<!--`, `-->`) or on a hashbang's line. An image's, a font's or
// WebAssembly's is in its first bytes, before any.
const OPENS = [0x27, 0x22, 0x60, 0x2F, 0x3C, 0x2D]
function npmRunnable(bytes) {
  const start = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0
  if (bytes[start] === 0x23 && bytes[start + 1] === 0x21) return true
  const opens = Math.min(...OPENS.map(byte => bytes.indexOf(byte, start)).filter(at => at !== -1))
  return Number.isFinite(opens) && npmFileText(bytes.subarray(0, opens)) !== null
}

// A file's bytes' digest, as the managed server gives one of a file that
// isn't text (server-managed/npm-packages.ts).
const sha256 = async bytes => `sha256-${btoa(String.fromCodePoint(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))))}`

// A gzipped tarball's files as a version holds them for risk, as the npm
// viewer holds a version (ui/view/npm-package.js npmPackageDetails), a source
// map listing them (`kind: 'sourcemap'`): `json.sources` their paths, sorted,
// `json.sourcesContent` their texts, `fileSizes` by path, and `npmBinaries`,
// those that aren't text, `{ size, digest, runnable }` by path (npmRunnable),
// which compare.js and
// diff.js tell them by.
export async function npmTarballVersion(gzipped) {
  const files = [...npmTarFiles(await gunzip(gzipped))].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const texts = files.map(([, bytes]) => npmFileText(bytes))
  const binaries = await Promise.all(files.filter((_, at) => texts[at] === null).map(async ([path, bytes]) => [path, { size: bytes.length, digest: await sha256(bytes), runnable: npmRunnable(bytes) }]))
  return { kind: 'sourcemap', json: { version: 3, sources: files.map(([path]) => path), sourcesContent: texts }, fileSizes: new Map(files.map(([path, bytes]) => [path, bytes.length])), npmBinaries: new Map(binaries) }
}
