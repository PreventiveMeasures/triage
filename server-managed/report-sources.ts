import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { bundleSourcesAsMap } from '../common/bundle-sources.js'
import { bundleSourceImports } from '../common/bundle-source-links.js'
import { loadManagedFindings, managedFindingSourcePaths } from '../common/managed/report-content.ts'
import { type ViewerPermissions, filterReportContent } from '../common/managed/report-filter.ts'
import type { CacheStorage } from './cache-storage.ts'
import { readBundleDetails } from './bundle-cache.ts'
import type { BlobStore } from './blob-store.ts'
import type { BundleStore } from './bundle-store.ts'
import type { ManagedBundle, ManagedDb, ReportRecord } from './db.ts'

const compress = promisify(gzip)
const reportFormat = (filename: string) => extname(filename).toLowerCase()

function bundleDirectory(id: string) {
  if (!/^[a-f\d-]{36}$/iu.test(id)) throw new Error('Invalid bundle id')
  return id
}
function reportDirectory(bundleId: string, sha256: string) {
  return `${bundleDirectory(bundleId)}/v1-${createHash('sha256').update(sha256).digest('hex')}`
}
function formatDirectory(bundleId: string, sha256: string, name: string) {
  return `${reportDirectory(bundleId, sha256)}/${createHash('sha256').update(reportFormat(name)).digest('hex')}`
}
function sourceCacheFilename(report: ReportRecord, bundle: ManagedBundle, permissions: ViewerPermissions, repo: { github: string | null }, sourcePaths?: Set<string>) {
  const key = createHash('sha256').update(JSON.stringify([
    'finding-access-v5', sourcePaths ? [...sourcePaths].toSorted() : null, bundle.integrity, bundle.kind, permissions.dependencies, permissions.security, repo,
  ])).digest('hex')
  return `${formatDirectory(bundle.id, report.sha256, report.filename)}/${key}.json.gz`
}

// Match the report's spelling exactly, then an unambiguous path suffix. Never
// guess between duplicate basenames or treat a bundle path as a disk pathname.
function selectSources(sourcePaths: Set<string>, sources: Map<string, string>) {
  const byBasename = new Map<string, string[]>()
  for (const file of sources.keys()) {
    const basename = file.split('/').at(-1)!
    const candidates = byBasename.get(basename) ?? []
    candidates.push(file)
    byBasename.set(basename, candidates)
  }
  const files = new Map<string, string>(), paths = new Map<string, string>()
  function add(path: unknown) {
    if (typeof path !== 'string' || !path || paths.has(path)) return
    let file = sources.has(path) ? path : null
    if (file === null) {
      const suffix = path.startsWith('/') ? path : `/${path}`
      const matches = byBasename.get(path.split('/').at(-1)!)?.filter(candidate => candidate.endsWith(suffix)) ?? []
      if (matches.length === 1) file = matches[0]!
    }
    if (file === null) return
    paths.set(path, file)
    files.set(file, sources.get(file)!)
  }
  for (const path of sourcePaths) add(path)
  return { files: [...files], paths: [...paths] }
}

// Immutable report hashes share a derivative across duplicate uploads. Bundle
// identity and visibility are part of the key: a broader viewer's sources must
// never populate a restricted response. Group derivatives by hash and filename
// format so each format's permissions can be removed after its last deletion.
export function createReportSourcesCache(storage: CacheStorage, db: ManagedDb, reports: BlobStore, bundles: BundleStore) {
  const pending = new Map<string, { reportId: string; job: Promise<boolean> }>()
  let queue = Promise.resolve()
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const job = queue.then(work)
    queue = job.then(() => undefined, () => undefined)
    return job
  }
  async function referenced(report: ReportRecord, bundle: ManagedBundle) {
    const names = await db.listReportFilenamesWithBundleHash(bundle.id, report.sha256)
    return names.some(name => reportFormat(name) === reportFormat(report.filename)) && await db.getBundle(bundle.id) != null
  }
  async function build(target: string, report: ReportRecord, bundle: ManagedBundle, permissions: ViewerPermissions, repo: { github: string | null }, sourcePaths?: Set<string>) {
    // Team requests supply paths from their already-filtered members. Reopening
    // the original report by ID would conflate visible and hidden occurrences.
    if (!sourcePaths) {
      const bytes = await reports.get(report.id)
      if (!bytes) return false
      const parsed = await loadManagedFindings(filterReportContent(bytes.toString('utf8'), permissions, report.filename, repo), report.filename)
      if (!parsed) return false
      sourcePaths = managedFindingSourcePaths(parsed.findings)
    }
    const details = await readBundleDetails(bundle, bundles)
    if (!details) return false
    const selection = selectSources(sourcePaths, bundleSourcesAsMap(details))
    const imports = [...bundleSourceImports(details, new Map(selection.files))].map(([parent, targets]) => [parent, [...targets]])
    const body = await compress(Buffer.from(JSON.stringify({ integrity: bundle.integrity, ...selection, imports })), { level: 6 })
    // A duplicate with the same hash AND format can use these parsed bytes.
    // Another format must not keep a deleted variant's late build alive.
    if (!(await referenced(report, bundle))) return false
    await storage.put(target, body)
    // Another instance may finish deletion while this write is in flight.
    // Recheck after publishing so a late builder cannot resurrect its cache.
    if (!(await referenced(report, bundle))) {
      await storage.delete(formatDirectory(bundle.id, report.sha256, report.filename))
      return false
    }
    return true
  }
  async function ensure(target: string, report: ReportRecord, bundle: ManagedBundle, permissions: ViewerPermissions, repo: { github: string | null }, sourcePaths?: Set<string>): Promise<boolean> {
    const existing = pending.get(target)
    if (existing) {
      const ready = await existing.job
      if (ready || existing.reportId === report.id) return ready
      // Deletion can also win before the initiator reads its blob. Retry with
      // this request's row instead of caching that other row's miss as 204.
      const initiator = await db.getReport(existing.reportId)
      if (initiator?.bundleId === bundle.id && initiator.sha256 === report.sha256) return false
      if (pending.get(target) === existing) pending.delete(target)
      return ensure(target, report, bundle, permissions, repo, sourcePaths)
    }
    const job = (async () => {
      if (await storage.exists(target)) return true
      // Serial cold builds bound peak decompression/parsing memory.
      return enqueue(() => build(target, report, bundle, permissions, repo, sourcePaths))
    })()
    const entry = { reportId: report.id, job }
    pending.set(target, entry)
    try { return await job } finally { if (pending.get(target) === entry) pending.delete(target) }
  }
  return {
    async open(report: ReportRecord, bundle: ManagedBundle, permissions: ViewerPermissions, sourcePaths?: Set<string>) {
      const repo = { github: (await db.listAllRepos()).find(entry => entry.repoId === report.repoId)?.fullName ?? null }
      const target = sourceCacheFilename(report, bundle, permissions, repo, sourcePaths)
      if (!(await ensure(target, report, bundle, permissions, repo, sourcePaths))) return null
      const opened = await storage.open(target)
      return { ...opened, repo }
    },
    async deleteBundle(id: string) {
      const prefix = `${bundleDirectory(id)}/`
      await Promise.allSettled([...pending].filter(([key]) => key.startsWith(prefix)).map(([, entry]) => entry.job))
      await storage.delete(bundleDirectory(id))
    },
    async deleteReport(report: Pick<ReportRecord, 'bundleId' | 'sha256' | 'filename'>) {
      const { bundleId, sha256 } = report
      if (bundleId === null) return
      // Called after metadata deletion. Serialize with builders so a cold
      // request cannot recreate a derivative after its cleanup has finished.
      await enqueue(async () => {
        const names = await db.listReportFilenamesWithBundleHash(bundleId, sha256)
        if (names.length === 0) {
          await storage.delete(reportDirectory(bundleId, sha256))
        } else if (!names.some(name => reportFormat(name) === reportFormat(report.filename))) {
          await storage.delete(formatDirectory(bundleId, sha256, report.filename))
        }
      })
    },
  }
}
export type ReportSourcesCache = ReturnType<typeof createReportSourcesCache>
