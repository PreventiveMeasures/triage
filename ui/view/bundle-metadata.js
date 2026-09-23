import { Bundle } from '@exodus/stasis-core/bundle'
import { computeFileHash } from '../../report/index.js'
import { utf8ByteLength } from '../../common/utf8.js'
import { bundleFileSizes, bundleSourcesAsMap, bundleUnsizedFiles } from './bundle-sources.js'

// Version 2 sizes every file by its bytes, resources included. A version 1
// index sized by what the source map held when it was written: before the
// map asked each entry's format, that took a directory capture for a file
// and a base64 resource for its spelling; after, it left every resource
// out. Either way its sizes are not file sizes, so it is read for its
// hashes alone and rebuilt on open.
const INDEX_VERSION = 2
const hashJobs = new WeakMap()
const SOURCE_TABS = new Set(['terminal', 'code', 'search', 'compare'])

export function bundleNeedsSources(tab, sourceFile = null) {
  return Boolean(sourceFile) || SOURCE_TABS.has(tab)
}

// Bound outstanding WebCrypto jobs: serial awaits incur one task round-trip
// per file, while an unbounded Promise.all holds every encoded body at once.
export function computeBundleFileHashes(details) {
  if (details.fileHashes) return Promise.resolve(details.fileHashes)
  if (hashJobs.has(details)) return hashJobs.get(details)
  const job = (async () => {
    const entries = [...bundleSourcesAsMap(details)]
    const result = new Map()
    for (let i = 0; i < entries.length; i += 32) {
      const hashes = await Promise.all(entries.slice(i, i + 32).map(async ([file, content]) => [file, await computeFileHash(content)]))
      for (const [file, hash] of hashes) result.set(file, hash)
    }
    details.fileHashes = result
    return result
  })()
  hashJobs.set(details, job)
  job.catch(() => hashJobs.delete(details))
  return job
}

// Count source lines without charging a trailing newline as an extra line.
// The source map intentionally excludes non-text resources, so a null entry
// remains the metadata marker for images, fonts, and other binary payloads.
export function bundleSourceLineCount(content) {
  if (typeof content !== 'string' || content.length === 0) return 0
  const breaks = content.match(/\r\n|\r|\n/gu)?.length ?? 0
  return breaks + (/[\r\n]$/u.test(content) ? 0 : 1)
}

function mapObject(value) {
  return value instanceof Map ? Object.fromEntries([...value].map(([key, v]) => [key, mapObject(v)])) : value
}

// A private, versioned derivative of the bundle, not a Stasis lock. Source
// bodies are omitted; file sizes and hashes keep metadata views self-contained.
// A row is `[path, bytes, hash, lines]`: a resource has bytes but no hash or
// lines, since it is no source; a directory capture has none of the three.
// `unsized` names the mounted files with no bytes to give (a base64 spelling
// that does not decode), which a null size alone cannot tell from no file.
export async function createBundleMetadata(details) {
  const hashes = await computeBundleFileHashes(details)
  const sizes = bundleFileSizes(details)
  const sourceLines = details.lineCounts ??= new Map([...bundleSourcesAsMap(details)]
    .map(([path, content]) => [path, bundleSourceLineCount(content)]))
  const result = { version: INDEX_VERSION, integrity: details.integrity, kind: details.kind, size: details.size,
    files: [...sizes].map(([path, size]) => [path, size, hashes.get(path) ?? null, sourceLines.get(path) ?? null]) }
  const unsized = bundleUnsizedFiles(details)
  if (unsized.size > 0) result.unsized = [...unsized]
  if (details.kind === 'sourcemap') {
    const { version, file, sourceRoot, names, sources = [], sourcesContent = [] } = details.json
    result.json = { version, file, sourceRoot, sources }
    // Sourcemaps can repeat a path with different/absent content. Keep the
    // Overview's positional inventory, alongside the path-keyed graph index.
    result.sourceSizes = sources.map((_, i) => typeof sourcesContent[i] === 'string' ? utf8ByteLength(sourcesContent[i]) : null)
    result.namesCount = names?.length ?? null
  } else {
    const b = details.bundle
    const bundle = { version: b.version, config: b.config, formats: mapObject(b.formats), imports: mapObject(b.imports), reason: b.reason }
    if (b.version === 0) {
      bundle.sources = Object.fromEntries([...sizes.keys()].map((path) => [path, null]))
    } else {
      const modules = {}, sources = {}
      for (const [dir, info] of b.modules) {
        const target = dir.split('/').includes('node_modules') ? modules : sources
        Object.defineProperty(target, dir, { enumerable: true, value: {
          name: info.name, version: info.version, ecosystem: info.ecosystem,
          files: Object.fromEntries(Object.keys(info.files).map((path) => [path, null])),
        } })
      }
      bundle.modules = modules
      if (b.config.scope === 'full') { bundle.sources = sources; bundle.entries = [...b.entries] }
    }
    result.bundle = bundle
  }
  return result
}

// `stale` marks an index this version did not write: its hashes still
// answer report lookups, but its sizes and line counts are not trusted,
// and an open rebuilds it.
export function parseBundleMetadata(data, integrity) {
  if ((data?.version !== 1 && data?.version !== INDEX_VERSION) || data.integrity !== integrity || !['stasis', 'sourcemap'].includes(data.kind)
      || !Number.isSafeInteger(data.size) || data.size < 0 || !Array.isArray(data.files)) throw new Error('Invalid bundle metadata')
  const stale = data.version !== INDEX_VERSION
  const fileHashes = new Map(), fileSizes = new Map(), lineCounts = new Map()
  for (const row of data.files) {
    // Version 1 rows predate the line count, and gave every sized entry a hash.
    if (!Array.isArray(row) || (row.length !== 4 && !(stale && row.length === 3))) throw new Error('Invalid bundle metadata file')
    const [path, size, hash, lines] = row
    if (typeof path !== 'string' || fileSizes.has(path) || (size !== null && (!Number.isSafeInteger(size) || size < 0))
        || (hash !== null && (typeof hash !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(hash)))
        || (size === null && hash !== null) || (stale && size !== null && hash === null)
        || (lines !== undefined && lines !== null && (!Number.isSafeInteger(lines) || lines < 0))) throw new Error('Invalid bundle metadata file')
    fileSizes.set(path, size)
    if (hash !== null) fileHashes.set(path, hash)
    if (lines !== undefined && lines !== null) lineCounts.set(path, lines)
  }
  // Only a sizeless row can name a mounted file with no size, and only once.
  const unsized = new Set(data.unsized ?? [])
  if ((data.unsized !== undefined && (stale || !Array.isArray(data.unsized) || unsized.size !== data.unsized.length))
      || [...unsized].some((path) => typeof path !== 'string' || !fileSizes.has(path) || fileSizes.get(path) !== null)) throw new Error('Invalid bundle metadata')
  const details = { integrity, kind: data.kind, size: data.size, metadataOnly: true, fileSizes, fileHashes, lineCounts, unsizedFiles: unsized, stale }
  if (data.kind === 'stasis') {
    details.bundle = Bundle.parse(JSON.stringify(data.bundle))
    const paths = details.bundle.sources
    if (paths.size !== fileSizes.size || [...paths.keys()].some((path) => !fileSizes.has(path))) throw new Error('Invalid bundle metadata inventory')
    // A file is hashed exactly when it is source: a resource has bytes and
    // no hash. And only a base64 resource can be mounted without a size.
    // Both are checked against the formats, which only the bundle carries.
    const formats = details.bundle.formats
    if (!stale && [...fileSizes].some(([path, size]) => fileHashes.has(path) !== (size !== null && !Bundle.isResourceFormat(formats.get(path))))) {
      throw new Error('Invalid bundle metadata inventory')
    }
    if ([...unsized].some((path) => formats.get(path) !== 'resource:base64')) throw new Error('Invalid bundle metadata inventory')
  } else {
    if (!data.json || typeof data.json !== 'object' || ![null, undefined].includes(data.namesCount) && (!Number.isSafeInteger(data.namesCount) || data.namesCount < 0)) throw new Error('Invalid sourcemap metadata')
    if (!Array.isArray(data.json.sources) || data.json.sources.some((path) => !fileSizes.has(path))
        || !Array.isArray(data.sourceSizes) || data.sourceSizes.length !== data.json.sources.length
        || data.sourceSizes.some((size) => size !== null && (!Number.isSafeInteger(size) || size < 0))
        || [...fileSizes].some(([path, size]) => fileHashes.has(path) !== (size !== null)) || unsized.size > 0) throw new Error('Invalid sourcemap inventory')
    details.json = data.json
    details.sourceSizes = data.sourceSizes
    details.namesCount = data.namesCount
  }
  return details
}
