import { Bundle } from '@exodus/stasis-core/bundle'
import { computeFileHash } from '../../report/index.js'
import { bundleSourceSizes, bundleSourcesAsMap } from './bundle-sources.js'

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

function mapObject(value) {
  return value instanceof Map ? Object.fromEntries([...value].map(([key, v]) => [key, mapObject(v)])) : value
}

// A private, versioned derivative of the bundle, not a Stasis lock. Source
// bodies are omitted; file sizes and hashes keep metadata views self-contained.
export async function createBundleMetadata(details) {
  const hashes = await computeBundleFileHashes(details)
  const sizes = bundleSourceSizes(details)
  const result = { version: 1, integrity: details.integrity, kind: details.kind, size: details.size,
    files: [...sizes].map(([path, size]) => [path, size, hashes.get(path) ?? null]) }
  if (details.kind === 'sourcemap') {
    const { version, file, sourceRoot, names, sources = [], sourcesContent = [] } = details.json
    result.json = { version, file, sourceRoot, sources }
    // Sourcemaps can repeat a path with different/absent content. Keep the
    // Overview's positional inventory, alongside the path-keyed graph index.
    const encoder = new TextEncoder()
    result.sourceSizes = sources.map((_, i) => typeof sourcesContent[i] === 'string' ? encoder.encode(sourcesContent[i]).byteLength : null)
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

export function parseBundleMetadata(data, integrity) {
  if (data?.version !== 1 || data.integrity !== integrity || !['stasis', 'sourcemap'].includes(data.kind)
      || !Number.isSafeInteger(data.size) || data.size < 0 || !Array.isArray(data.files)) throw new Error('Invalid bundle metadata')
  const fileHashes = new Map(), fileSizes = new Map()
  for (const row of data.files) {
    if (!Array.isArray(row) || row.length !== 3) throw new Error('Invalid bundle metadata file')
    const [path, size, hash] = row
    if (typeof path !== 'string' || fileSizes.has(path) || (size !== null && (!Number.isSafeInteger(size) || size < 0))
        || (size === null ? hash !== null : typeof hash !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(hash))) throw new Error('Invalid bundle metadata file')
    fileSizes.set(path, size)
    if (hash !== null) fileHashes.set(path, hash)
  }
  const details = { integrity, kind: data.kind, size: data.size, metadataOnly: true, fileSizes, fileHashes }
  if (data.kind === 'stasis') {
    details.bundle = Bundle.parse(JSON.stringify(data.bundle))
    const paths = details.bundle.sources
    if (paths.size !== fileSizes.size || [...paths.keys()].some((path) => !fileSizes.has(path))) throw new Error('Invalid bundle metadata inventory')
  } else {
    if (!data.json || typeof data.json !== 'object' || ![null, undefined].includes(data.namesCount) && (!Number.isSafeInteger(data.namesCount) || data.namesCount < 0)) throw new Error('Invalid sourcemap metadata')
    if (!Array.isArray(data.json.sources) || data.json.sources.some((path) => !fileSizes.has(path))
        || !Array.isArray(data.sourceSizes) || data.sourceSizes.length !== data.json.sources.length
        || data.sourceSizes.some((size) => size !== null && (!Number.isSafeInteger(size) || size < 0))) throw new Error('Invalid sourcemap inventory')
    details.json = data.json
    details.sourceSizes = data.sourceSizes
    details.namesCount = data.namesCount
  }
  return details
}
