import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { bundleSourcesAsMap } from '../common/bundle-sources.js'
import { loadManagedFindings } from '../common/managed/report-content.ts'
import { type ViewerPermissions, filterReportContent } from '../common/managed/report-filter.ts'
import { readBundleDetails } from './bundle-cache.ts'
import type { BlobStore } from './blob-store.ts'
import type { BundleStore } from './bundle-store.ts'
import type { ManagedBundle, ManagedDb, ReportRecord } from './db.ts'

const compress = promisify(gzip)

// Match the report's spelling exactly, then an unambiguous path suffix. Never
// guess between duplicate basenames or treat a bundle path as a disk pathname.
function selectSources(findings: unknown[], sources: Map<string, string>) {
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
  for (const finding of findings) {
    const f = finding as { file?: unknown; evidence?: { file?: unknown }[] }
    add(f.file)
    if (Array.isArray(f.evidence)) for (const evidence of f.evidence) add(evidence?.file)
  }
  return { files: [...files], paths: [...paths] }
}

// Immutable report hashes share a derivative across duplicate uploads. Bundle
// identity and visibility are part of the key: a broader viewer's sources must
// never populate a restricted response. A report-hash directory groups every
// format/permission variant for cleanup once its last report is deleted.
export function createReportSourcesCache(dir: string, db: ManagedDb, reports: BlobStore, bundles: BundleStore) {
  const pending = new Map<string, Promise<boolean>>()
  let queue = Promise.resolve()
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const job = queue.then(work)
    queue = job.then(() => undefined, () => undefined)
    return job
  }
  function directory(id: string) {
    if (!/^[a-f\d-]{36}$/iu.test(id)) throw new Error('Invalid bundle id')
    return join(dir, id)
  }
  function reportDirectory(bundleId: string, sha256: string) {
    return join(directory(bundleId), `v1-${createHash('sha256').update(sha256).digest('hex')}`)
  }
  function filename(report: ReportRecord, bundle: ManagedBundle, permissions: ViewerPermissions) {
    const key = createHash('sha256').update(JSON.stringify([
      extname(report.filename).toLowerCase(), bundle.integrity, bundle.kind,
      permissions.dependencies, permissions.security,
    ])).digest('hex')
    return join(reportDirectory(bundle.id, report.sha256), `${key}.json.gz`)
  }
  async function build(target: string, report: ReportRecord, bundle: ManagedBundle, permissions: ViewerPermissions) {
    const bytes = await reports.get(report.id)
    if (!bytes) return false
    const parsed = await loadManagedFindings(filterReportContent(bytes.toString('utf8'), permissions, report.filename), report.filename)
    if (!parsed) return false
    const details = await readBundleDetails(bundle, bundles)
    if (!details) return false
    const selection = selectSources(parsed.findings, bundleSourcesAsMap(details))
    const body = await compress(Buffer.from(JSON.stringify({ integrity: bundle.integrity, ...selection })), { level: 6 })
    const current = await db.getReport(report.id)
    if (current?.bundleId !== bundle.id || current.sha256 !== report.sha256 || !(await db.getBundle(bundle.id))) return false
    await mkdir(reportDirectory(bundle.id, report.sha256), { recursive: true })
    const temp = `${target}.${randomUUID()}.tmp`
    try { await writeFile(temp, body); await rename(temp, target) }
    finally { await rm(temp, { force: true }) }
    return true
  }
  async function ensure(target: string, report: ReportRecord, bundle: ManagedBundle, permissions: ViewerPermissions) {
    const existing = pending.get(target)
    if (existing) return existing
    const job = (async () => {
      try { await stat(target); return true }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
      // Serial cold builds bound peak decompression/parsing memory.
      return enqueue(() => build(target, report, bundle, permissions))
    })()
    pending.set(target, job)
    try { return await job } finally { if (pending.get(target) === job) pending.delete(target) }
  }
  return {
    async open(report: ReportRecord, bundle: ManagedBundle, permissions: ViewerPermissions) {
      const target = filename(report, bundle, permissions)
      if (!(await ensure(target, report, bundle, permissions))) return null
      const file = await open(target, 'r')
      try { return { size: (await file.stat()).size, stream: file.createReadStream() } }
      catch (err) { await file.close(); throw err }
    },
    async deleteBundle(id: string) {
      const prefix = `${directory(id)}/`
      await Promise.allSettled([...pending].filter(([key]) => key.startsWith(prefix)).map(([, job]) => job))
      await rm(directory(id), { recursive: true, force: true })
    },
    async deleteReport(report: Pick<ReportRecord, 'bundleId' | 'sha256'>) {
      const { bundleId, sha256 } = report
      if (bundleId === null) return
      // Called after metadata deletion. Serialize with builders so a cold
      // request cannot recreate a derivative after its cleanup has finished.
      await enqueue(async () => {
        if (await db.hasReportWithBundleHash(bundleId, sha256)) return
        await rm(reportDirectory(bundleId, sha256), { recursive: true, force: true })
      })
    },
  }
}
export type ReportSourcesCache = ReturnType<typeof createReportSourcesCache>
