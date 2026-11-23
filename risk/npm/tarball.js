// A package's files from its tarball, as it holds them, whatever installs it
// (npm renames a .gitignore .npmignore, pnpm and yarn keep it): gunzipped and
// read as a tar archive by @preventive/archive, which refuses one malformed, a
// name or a symlink that would climb out of it, and a name repeated as another
// entry; each file at the path installers put it (npmTarLayout); a text
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

// Where npm and pnpm install a tar entry's file in its package: its name as
// stored past its first component, whatever that is (`package/`, a release's
// own `ejs-v3.1.10/`, `.` where it was packed from within the package), its
// `.` segments dropped, as each drops one component of the name it reads; a
// file under no directory at that name, as pnpm installs it (npm leaves it
// out, and fails on a tarball of such files alone, its package.json gone).
// '' where no name is left, the package's own place.
export function npmTarPath(storedName) {
  const segments = storedName.split('/')
  return segments.length === 1 ? storedName : segments.slice(1).filter(segment => segment !== '.').join('/')
}

const sameBytes = (a, b) => a.length === b.length && a.every((byte, at) => byte === b[at])

// The files a tar archive's entries install, by package path (npmTarPath):
// their bytes. Where installers would install other than these, or one of
// several, it is refused as `tarball-conflict`, rather than read as one of
// them: two files at one path, unless their bytes are the same (npm and pnpm
// install the last, so a file under another top directory, or at the top,
// replaces one under `package/` there); a file where another lies within it,
// as in a directory (npm keeps the file, pnpm the directory); a file at the
// package's own place; and a hard link (pnpm 10 and 11 write an empty file,
// npm and pnpm 12 none). Directories, symlinks and devices hold no file and
// are skipped, as every installer skips them. Past `maxFiles` files or
// `maxBytes` bytes, `package-too-large`. `refuse(code)` throws.
export function npmTarLayout(entries, { maxFiles, maxBytes }, refuse) {
  const files = new Map()
  // The paths laid out as a tree, each name a file's bytes or a directory's
  // Map, so each path is walked once to find a file and a directory at one place.
  const root = new Map()
  let total = 0
  for (const { storedName, type, data } of entries) {
    if (type === 'hardlink') refuse('tarball-conflict')
    if (type !== 'file' && type !== 'contiguous-file') continue
    const path = npmTarPath(storedName)
    if (path === '') refuse('tarball-conflict')
    const segments = path.split('/')
    let at = root
    for (let i = 0; i < segments.length - 1; i++) {
      let next = at.get(segments[i])
      if (next === undefined) at.set(segments[i], next = new Map())
      else if (!(next instanceof Map)) refuse('tarball-conflict')
      at = next
    }
    const seen = at.get(segments.at(-1))
    if (seen !== undefined) {
      if (seen instanceof Map || !sameBytes(seen, data)) refuse('tarball-conflict')
      continue
    }
    at.set(segments.at(-1), data)
    files.set(path, data)
    total += data.length
    if (files.size > maxFiles || total > maxBytes) refuse('package-too-large')
  }
  return files
}

// The files of a tar archive, by path: their bytes, as installers lay them
// out (npmTarLayout). Past MAX_TAR_ENTRIES it is given up on as
// `package-too-large`, before any more of it is read.
function npmTarFiles(tar) {
  let entries
  try {
    entries = unpack(tar, { maxEntries: MAX_TAR_ENTRIES })
  } catch (error) {
    if (error instanceof ArchiveError && error.limited) throw new Error('package-too-large', { cause: error })
    throw error
  }
  return npmTarLayout(entries, { maxFiles: MAX_PACKAGE_FILES, maxBytes: MAX_PACKAGE_BYTES }, code => { throw new Error(code) })
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
