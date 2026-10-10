import { bundleCodeStats } from './bundle-stats.js'
import { bundleCommitHash } from './bundle-commit.js'
import { Bundle } from '@exodus/stasis-core/bundle'
import { computeFileHash } from '@preventive/report'
import { utf8ByteLength } from './utf8.js'
import { bundleFileSizes, bundleSourcesAsMap, bundleUnsizedFiles } from './bundle-sources.js'
import { bundleSourcemapEdges, parseSourcemap, sourcemapEntries } from './bundle-sourcemap.js'

// Version 2 sizes every file by its bytes, resources included. A version 1
// index sized by what the source map held when it was written: before the
// map asked each entry's format, that took a directory capture for a file
// and a base64 resource for its spelling; after, it left every resource
// out. Either way its sizes are not file sizes, so it is read for its
// hashes alone and rebuilt on open.
// Version 3 also retains the bundle's repository and package origin metadata.
// Version 4 retains dependency repositories as well.
// Version 5 counts lines of code, leaving blank lines out.
// Version 6 reads a sourcemap whole (bundle-sourcemap.js): an index map's
// files too, each once, keyed with `sourceRoot` in front, and the edges
// between them.
export const BUNDLE_METADATA_VERSION = 6
const INDEX_VERSION = BUNDLE_METADATA_VERSION
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

// Count lines of code: lines with anything but whitespace on them, comments
// included for now, split at \r\n, \r or \n. A match runs from a line's
// first non-whitespace character to its end, so there is one per such line.
// The source map intentionally excludes non-text resources, so a null entry
// remains the metadata marker for images, fonts, and other binary payloads.
export function bundleSourceLineCount(content) {
  if (typeof content !== 'string') return 0
  const code = /\S[^\r\n]*/gu
  let lines = 0
  while (code.test(content)) lines++
  return lines
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
  const result = { version: INDEX_VERSION, integrity: details.integrity, kind: details.kind, size: details.size, codeStats: bundleCodeStats(sourceLines, sizes),
    files: [...sizes].map(([path, size]) => [path, size, hashes.get(path) ?? null, sourceLines.get(path) ?? null]) }
  const unsized = bundleUnsizedFiles(details)
  if (unsized.size > 0) result.unsized = [...unsized]
  if (details.kind === 'sourcemap') {
    const { version, file, sourceRoot, names } = details.json
    const entries = sourcemapEntries(details)
    result.json = { version, file, sourceRoot, sources: entries.map(([path]) => path) }
    // A map's arrays as written can repeat a path with different/absent
    // content. Keep the Overview's positional inventory, alongside the
    // path-keyed graph index.
    result.sourceSizes = entries.map(([, content]) => typeof content === 'string' ? utf8ByteLength(content) : null)
    result.namesCount = details.namesCount ?? names?.length ?? null
    // `[from, to]`, each a row of `files`.
    const rows = new Map(result.files.map(([path], i) => [path, i]))
    result.edges = [...bundleSourcemapEdges(details)].flatMap(([from, targets]) => [...targets].map((to) => [rows.get(from), rows.get(to)]))
  } else {
    const b = details.bundle
    const bundle = { version: b.version, config: b.config, repo: b.repo, package: b.package, formats: mapObject(b.formats), imports: mapObject(b.imports), reason: b.reason, executable: [...b.executable] }
    if (b.version === 0) {
      bundle.sources = Object.fromEntries([...sizes.keys()].map((path) => [path, null]))
    } else {
      const modules = {}, sources = {}
      for (const [dir, info] of b.modules) {
        const target = dir.split('/').includes('node_modules') ? modules : sources
        Object.defineProperty(target, dir, { enumerable: true, value: {
          name: info.name, version: info.version, ecosystem: info.ecosystem, repo: info.repo,
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

// Catalogs need counts without the per-file inventory. Match scan inputs:
// textual resources count as files (with zero LoC); binary resources do not
// count as Code inputs, and missing source bodies/directories are not files.
export function createBundleSummary(details, metadata) {
  const files = (metadata?.files ?? [...bundleFileSizes(details)]).filter(([, size]) => size !== null)
  const formats = details.kind === 'stasis' ? details.bundle.formats : null
  const lines = metadata?.codeStats.lines ?? [...bundleSourcesAsMap(details).values()].reduce((sum, source) => sum + bundleSourceLineCount(source), 0)
  const commit = details.kind === 'stasis' ? bundleCommitHash(details.bundle.repo?.commit) : null
  return { files: files.length, lines,
    codeFiles: files.filter(([path]) => !['resource:base64', 'directory'].includes(formats?.get(path))).length,
    ...(commit ? { commit } : {}),
    // The Stasis format version: 0 for legacy bundles, which record no package versions.
    ...(details.kind === 'stasis' ? { stasisVersion: details.bundle.version } : {}) }
}

// `stale` marks an index this version did not write: its hashes still
// answer report lookups, but an open rebuilds it for current sizes, line
// counts and origin metadata.
export function parseBundleMetadata(data, integrity) {
  if (![1, 2, 3, 4, 5, INDEX_VERSION].includes(data?.version) || data.integrity !== integrity || !['stasis', 'sourcemap'].includes(data.kind)
      || !Number.isSafeInteger(data.size) || data.size < 0 || !Array.isArray(data.files)) throw new Error('Invalid bundle metadata')
  const stale = data.version !== INDEX_VERSION
  const legacySizes = data.version === 1
  const fileHashes = new Map(), fileSizes = new Map(), lineCounts = new Map()
  for (const row of data.files) {
    // Version 1 rows predate the line count, and gave every sized entry a hash.
    if (!Array.isArray(row) || (row.length !== 4 && !(legacySizes && row.length === 3))) throw new Error('Invalid bundle metadata file')
    const [path, size, hash, lines] = row
    if (typeof path !== 'string' || fileSizes.has(path) || (size !== null && (!Number.isSafeInteger(size) || size < 0))
        || (hash !== null && (typeof hash !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(hash)))
        || (size === null && hash !== null) || (legacySizes && size !== null && hash === null)
        || (lines !== undefined && lines !== null && (!Number.isSafeInteger(lines) || lines < 0))) throw new Error('Invalid bundle metadata file')
    fileSizes.set(path, size)
    if (hash !== null) fileHashes.set(path, hash)
    if (lines !== undefined && lines !== null) lineCounts.set(path, lines)
  }
  // Only a sizeless row can name a mounted file with no size, and only once.
  const unsized = new Set(data.unsized ?? [])
  if ((data.unsized !== undefined && (legacySizes || !Array.isArray(data.unsized) || unsized.size !== data.unsized.length))
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
    if (!legacySizes && [...fileSizes].some(([path, size]) => fileHashes.has(path) !== (size !== null && !Bundle.isResourceFormat(formats.get(path))))) {
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
    // An index before version 6 has none: the view reads no edges for it.
    if (data.edges !== undefined) details.edges = parseSourcemapEdges(data.edges, data.files)
  }
  if (data.codeStats === undefined) details.codeStats = bundleCodeStats(lineCounts, fileSizes)
  else {
    const stats = data.codeStats
    const validCount = value => Number.isSafeInteger(value) && value >= 0
    if (!stats || ![stats.files, stats.lines, stats.bytes].every(validCount) || !Array.isArray(stats.languages)
        || stats.languages.some(row => !row || typeof row.key !== 'string' || typeof row.label !== 'string'
          || ![row.files, row.lines, row.bytes].every(validCount))) throw new Error('Invalid bundle code stats')
    details.codeStats = stats
  }
  return details
}

function parseSourcemapEdges(rows, files) {
  if (!Array.isArray(rows)) throw new Error('Invalid sourcemap edges')
  const edges = new Map()
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2 || row[0] === row[1]
        || row.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= files.length)) throw new Error('Invalid sourcemap edges')
    const [from, to] = row.map((i) => files[i][0])
    if (!edges.has(from)) edges.set(from, new Set())
    edges.get(from).add(to)
  }
  return edges
}

// HTTP content encoding handles compression before this shared JSON parser.
export function parseBundleContents(text, { integrity, kind, size }) {
  if (kind === 'stasis') return { integrity, kind, size, bundle: Bundle.parse(text) }
  if (kind !== 'sourcemap') throw new Error('Unsupported bundle format')
  return { integrity, kind, size, ...parseSourcemap(text) }
}
