// Every connected repository's npm packages, as its lockfiles lock them, each
// assessed by risk (npm-risk.ts), for admins: GET /api/admin/repositories/risk
// answers a line at a time as each is found and assessed, and stops once its
// reader leaves (`signal`).
//
// A repository's lockfiles are listed at its default branch's head by
// @preventive/upstream's findRepoLockfiles; of them, those of npm's ecosystem
// that @preventive/lockfile reads (package-lock.json and npm-shrinkwrap.json
// of `lockfileVersion: 3`, pnpm-lock.yaml of pnpm 9 to 12, and Yarn 1's
// yarn.lock) are read for their packages. A package from npm's registry is
// assessed once a scan, however many lockfiles lock it; one from another
// host with an integrity, such as a company's mirror of npm's, as npm's
// package of its name and version where npm's integrity is among it; one
// from elsewhere (git, a tarball with no integrity, a file) is listed, not
// assessed. Repositories are read one at a time, as GitHub's limits are the
// caller's; packages are assessed meanwhile, as many at a time as npm-risk.ts
// makes spare assessments, those only devDependencies need in every lockfile
// that locks them (LockedPackage `dev`) once all the rest are, as an install
// of no devDependencies leaves them out. A lockfile's packages of npm's
// registry or a mirror are asked of npm's advisories all at once, as `npm
// audit` asks, each advisory told with whether it is of malware (risk's
// npmMalwareAdvisory), which alone is a supply chain's risk; the rest are
// vulnerabilities, told beside.
import type { LockfileFormat, RepoLockfile } from '@preventive/upstream/github.js'
import type { Severity } from '../risk/index.js'
import { isNpmPackageName, isNpmPackageSpec } from '../common/managed/npm-packages.js'
import type { NpmVersionDocument } from './npm-packages.ts'
import { type Lru, lru } from './lru.ts'
import type { KeptStore } from './npm-kept.ts'
import { MAX_SPARE_ASSESSMENTS } from './npm-risk.ts'
import { type LockedPackage, lockedPackages } from './locked-packages.ts'
import { type Queue, queue } from './queue.ts'
import { type DownloadsSource, readyingDownloads } from './scan-downloads.ts'
import { type AssessedPackage, type Assessment, BUSY_RETRIES, BUSY_WAIT_MS, RISK_KEPT_MS, type RiskFailure, assessPackage, failureOf, isBusy } from './repository-risk-assess.ts'
import { type AdvisoryRow, type Audit, type AuditSource, auditLockfile } from './repository-risk-audit.ts'

export { RISK_KEPT_MS, highestSeverity } from './repository-risk-assess.ts'

// The formats of npm's ecosystem, as findRepoLockfiles names them, and those
// of them read here.
const NPM_LOCKFILE_FORMATS: ReadonlySet<LockfileFormat> = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno'])
const READ_FORMATS: ReadonlySet<LockfileFormat> = new Set(['npm', 'pnpm', 'yarn'])

// A repository to read: where `paths` are given, a team's directories in it,
// only the lockfiles in them or above them, as a workspace's root lockfile
// locks them too.
export interface RepositoryRiskRepo { repoId: number; fullName: string; paths?: readonly string[] }

// Whether a lockfile at `path` is of `paths` (RepositoryRiskRepo).
function lockfileOf(path: string, paths: readonly string[] | undefined) {
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), 0))
  return !paths || paths.some(scope => dir === '' || dir === scope || dir.startsWith(`${scope}/`) || scope.startsWith(`${dir}/`))
}

type ListedLockfile = Pick<RepoLockfile, 'path' | 'format' | 'sha'>

// A repository opened at its default branch's head (`commit`): its lockfiles,
// as findRepoLockfiles lists them, each with its blob's id, and a file's
// text; `recheck` checks access to it again, throwing where it is gone.
export interface OpenedRepository {
  commit: string
  lockfiles(): Promise<ListedLockfile[]>
  file(path: string): Promise<string>
  recheck(): Promise<void>
}

export interface RepositoryRiskSource<R extends RepositoryRiskRepo> extends AuditSource {
  repos(): Promise<R[]>
  open(repo: R): Promise<OpenedRepository>
  // Whether a team lists a package's scope, its own packages.
  teamScoped(name: string): Promise<boolean>
  // npm's document of a version; an NpmPackageError where npm has none.
  version(name: string, version: string, signal: AbortSignal): Promise<NpmVersionDocument>
  assess(doc: NpmVersionDocument, teamScoped: boolean, signal: AbortSignal): Promise<Assessment>
  // A version npm has no document of, as risk tells one npm removed: its
  // malware alone, its package taken down by npm; an NpmRiskError where
  // nothing tells of it (npm-risk.ts npmRiskRemoved).
  removed(name: string, version: string, teamScoped: boolean, signal: AbortSignal): Promise<Assessment>
  // Where risk lines are kept beyond this instance, as RiskCaches keeps them
  // in it (npm-kept.ts riskLineStore, the database's).
  risks?: KeptStore<RiskLine>
  // Where a repository's lockfiles as listed at a commit, and a lockfile's
  // packages by its blob, are kept beyond this instance, as RiskCaches keeps
  // them in it (npm-kept.ts scanReadStore, the database's), each read for
  // SCAN_READ_KEPT_MS: a scan answered in parts (`partMs`) goes on from
  // where the last stopped on whichever instance answers the next.
  listings?: KeptStore<ListedLockfile[]>
  lockfiles?: KeptStore<LockfileRead>
  // Where a scan answered in parts keeps, from one part to the next, the
  // repositories it told whole (`partMs`): the next tells none of them again,
  // nor asks GitHub of them, but looks up their packages' risks as their
  // lockfiles are kept (`lockfiles`), as the reader has the rest already.
  progress?: { read(): Promise<ScanProgress | null>; write(progress: ScanProgress): Promise<void> } | undefined
  // Readies npm's downloads of packages before they are assessed
  // (scan-downloads.ts); without it, each assessment asks its own.
  downloads?: DownloadsSource
}



// A risk line is of npm's package of its name and version, or, with an
// `integrity`, of a mirror's that its lockfiles hold to it; its `score` risk's
// of it, out of 100 (assessNpm `score`, risk/npm/score.js).
export type RepositoryRiskLine =
  | { type: 'repos'; repos: { id: number; fullName: string }[] }
  | ({ type: 'repo'; id: number } & ({ commit: string; lockfiles: { path: string; format: LockfileFormat }[] } | RiskFailure))
  | ({ type: 'lockfile'; repo: number; path: string; format: LockfileFormat } & ({ packages: LockedPackage[] } | RiskFailure))
  | ({ type: 'risk'; name: string; version: string; integrity?: string; stale?: { assessedAt: number } }
    & ({ published: string | null; severity: Severity | null; score: number; findings: { id: string; severity: Severity; takenDown?: true }[] } | RiskFailure))
  | ({ type: 'advisories'; repo: number; path: string } & ({ advisories: AdvisoryRow[] } | RiskFailure))
  | { type: 'done' }
  // The scan stopped for its part's time (repositoryRiskLines `partMs`), what
  // it told kept: to be asked again, from where it stopped.
  | { type: 'continue' }

// The repositories a scan answered in parts told whole by a part's end, by
// id, each with its lockfiles' keys (`${format}\0${sha}`) of those read.
export interface ScanProgress { repos: [id: number, lockfiles: string[]][] }

type RiskLine = Extract<RepositoryRiskLine, { type: 'risk' }>
type LockfileRead = { packages: LockedPackage[] } | RiskFailure

// What scans keep between them, in this instance's memory: a repository's
// lockfiles as listed at a commit, and a lockfile's packages by its blob,
// neither of which changes; a lockfile's advisories, asked again after
// RISK_KEPT_MS, as npm publishes advisories; and a package's risk line,
// told stale after RISK_KEPT_MS and assessed again, as risk tells again what
// of a package changes in time (a deprecation, its age, its downloads). A
// lockfile's, and its packages' lines, are told only once access to its
// repository is checked as when it was read.
export interface RiskCaches {
  listings: Lru<ListedLockfile[]>
  lockfiles: Lru<LockfileRead>
  risks: Lru<{ at: number; line: RiskLine }>
  advisories: Lru<{ at: number; audit: Audit }>
}
export const riskCaches = (): RiskCaches => ({
  listings: lru(1000),
  // By the packages they hold, a few hundred bytes each.
  lockfiles: lru(200_000, read => 'packages' in read ? read.packages.length + 1 : 1),
  risks: lru(50_000),
  advisories: lru(50_000, kept => Array.isArray(kept.audit) ? kept.audit.length + 1 : 1),
})
// How long the source's `listings` and `lockfiles` are read for: what
// GitHub has at a commit or a blob doesn't change, how it is read here may.
export const SCAN_READ_KEPT_MS = 24 * 60 * 60_000
// How many kept risk lines are read of the source's `risks` at once.
const KEPT_READ = 500
const shared = riskCaches()

interface Scan {
  source: RepositoryRiskSource<RepositoryRiskRepo>
  caches: RiskCaches
  signal: AbortSignal
  lines: Queue<RepositoryRiskLine>
  // Each lockfile's packages not yet seen, to look up as kept (lookUp); those
  // already seen, by seenKey, each with whether only devDependencies need it
  // so far; those of them with none kept, put off as long as that holds, by
  // seenKey; and those told stale, to assess again once those with none kept
  // are.
  lookups: Queue<AssessedPackage[]>
  seen: Map<string, boolean>
  dev: Map<string, AssessedPackage>
  stale: AssessedPackage[]
  // The repositories told whole, this part or one before (ScanProgress).
  told: Map<number, string[]>
}

// A package as a scan meets it: by its name, version and a mirror's integrity.
const seenKey = (pkg: AssessedPackage) => `${pkg.name}@${pkg.version}\0${pkg.integrity ?? ''}`

// A package's key, as its risk line is kept: its name, version and a
// mirror's integrity, and whether a team lists its scope.
const riskKey = (pkg: AssessedPackage, teamScoped: boolean) => `${pkg.name}@${pkg.version}\0${pkg.integrity ?? ''}\0${teamScoped}`
// Whether a line kept `at` is told as it is: within RISK_KEPT_MS, and kept
// since risk told a score (assessNpm `score`).
const isFresh = ({ at, line }: { at: number; line: RiskLine }) => Date.now() - at < RISK_KEPT_MS && ('error' in line || typeof line.score === 'number')

// A package assessed (assess), its line kept, in RiskCaches and the source's
// `risks`, where it tells what risk found, or that a mirror's copy isn't npm's.
async function assessed(scan: Scan, pkg: AssessedPackage): Promise<RiskLine | null> {
  let teamScoped
  try { teamScoped = await scan.source.teamScoped(pkg.name) } catch (error) { return { type: 'risk', ...pkg, ...failureOf(error) } }
  const key = riskKey(pkg, teamScoped)
  const line = await assessPackage(scan.source, scan.signal, pkg, teamScoped)
  if (line && (!('error' in line) || line.error === 'integrity-mismatch')) {
    const at = Date.now()
    scan.caches.risks.set(key, { at, line })
    await scan.source.risks?.write(key, line, at)
  }
  return line
}

// Risk lines kept of `keys`, by key: in this instance's memory, else the
// source's `risks`, KEPT_READ at a time.
async function keptLines({ source, caches }: Scan, keys: string[]) {
  const kept = new Map<string, { at: number; line: RiskLine }>()
  const left = keys.filter(key => { const hit = caches.risks.get(key); if (hit) kept.set(key, hit); return !hit })
  for (let from = 0; source.risks && from < left.length; from += KEPT_READ) {
    for (const [key, { at, value }] of await source.risks.readMany(left.slice(from, from + KEPT_READ))) {
      caches.risks.set(key, { at, line: value })
      kept.set(key, { at, line: value })
    }
  }
  return kept
}

// Each lockfile's packages, as assessLater gives them: their risk lines as
// kept, however old, told at once, a fresh one as it is and an older one as
// stale (`stale`, when it was assessed), its package assessed again once
// those with none kept are (`scan.stale`); those with none given to `assess`,
// but those only devDependencies need so far, put off (`scan.dev`).
async function lookUp(scan: Scan, assess: (packages: AssessedPackage[]) => void) {
  for (let packages = await scan.lookups.take(); packages !== undefined; packages = await scan.lookups.take()) {
    const keyed: { pkg: AssessedPackage; key: string }[] = []
    for (const pkg of packages) {
      try { keyed.push({ pkg, key: riskKey(pkg, await scan.source.teamScoped(pkg.name)) }) } catch (error) { scan.lines.add({ type: 'risk', ...pkg, ...failureOf(error) }) }
    }
    const kept = await keptLines(scan, keyed.map(({ key }) => key))
    const missing: AssessedPackage[] = []
    for (const { pkg, key } of keyed) {
      const hit = kept.get(key)
      if (hit && isFresh(hit)) scan.lines.add(hit.line)
      else if (hit) { scan.lines.add({ ...hit.line, stale: { assessedAt: hit.at } }); scan.stale.push(pkg) }
      else if (scan.seen.get(seenKey(pkg)) === true) scan.dev.set(seenKey(pkg), pkg)
      else missing.push(pkg)
    }
    if (missing.length > 0) assess(missing)
  }
}

async function assessor(scan: Scan, pending: Queue<AssessedPackage>) {
  for (let next = await pending.take(); next !== undefined; next = await pending.take()) {
    const line = await assessed(scan, next)
    if (line) scan.lines.add(line)
  }
}

// The packages `feed` gives assessed, each given to the assessors once its
// downloads are readied, where the source readies them (scan-downloads.ts):
// once all it gives are told, or the scan stops.
async function assessing(scan: Scan, feed: (assess: (packages: AssessedPackage[]) => void) => Promise<void>) {
  const pending = queue<AssessedPackage>(scan.signal)
  const readying = scan.source.downloads
    ? readyingDownloads<AssessedPackage>(scan.source.downloads, scan.signal, pkg => { pending.add(pkg) }, { busy: isBusy, retries: BUSY_RETRIES, waitMs: BUSY_WAIT_MS }) : null
  const assessors = Array.from({ length: MAX_SPARE_ASSESSMENTS }, () => assessor(scan, pending))
  try { await feed(packages => { if (readying) readying.add(packages); else for (const pkg of packages) pending.add(pkg) }) } finally {
    await readying?.close()
    pending.close()
  }
  await Promise.all(assessors)
}

type LockfileLine = Extract<RepositoryRiskLine, { type: 'lockfile' }>

// What is kept by `key`: in this instance's memory, else in `store` within
// SCAN_READ_KEPT_MS, else `read` and kept in both.
async function keptRead<T>(memory: Lru<T>, store: KeptStore<T> | undefined, key: string, read: () => Promise<T>) {
  const known = memory.get(key)
  if (known !== undefined) return known
  const kept = await store?.read(key)
  if (kept && Date.now() - kept.at < SCAN_READ_KEPT_MS) { memory.set(key, kept.value); return kept.value }
  const value = await read()
  memory.set(key, value)
  await store?.write(key, value, Date.now())
  return value
}

// A lockfile's line, its packages or why they couldn't be had: as kept by its
// blob, else read from GitHub and kept.
async function readLockfile({ source, caches }: Scan, repo: number, opened: OpenedRepository, { path, format, sha }: ListedLockfile): Promise<LockfileLine> {
  const at = { type: 'lockfile', repo, path, format } as const
  if (!READ_FORMATS.has(format)) return { ...at, error: 'unsupported-format' }
  try {
    return { ...at, ...await keptRead(caches.lockfiles, source.lockfiles, `${format}\0${sha}`, async (): Promise<LockfileRead> => {
      const text = await opened.file(path)
      try { return { packages: lockedPackages(format, text) } } catch (error) {
        return { error: 'lockfile-unreadable', ...error instanceof Error ? { detail: error.message.slice(0, 500) } : {} }
      }
    }) }
  } catch (error) { return { ...at, ...failureOf(error) } }
}

// A lockfile's packages of npm's registry or a mirror not yet seen this scan,
// to look up as kept (lookUp), and assess where none is; and one seen as only
// devDependencies need it, and put off, that this lockfile needs otherwise,
// to look up again and assess now.
function assessLater(scan: Scan, packages: LockedPackage[]) {
  const fresh: AssessedPackage[] = []
  for (const { name, version, source, integrity, dev = false } of packages) {
    if ((source !== 'registry' && source !== 'mirror') || version === null || !isNpmPackageName(name) || !isNpmPackageSpec(version)) continue
    const pkg = { name, version, ...integrity === undefined ? {} : { integrity } }
    const key = seenKey(pkg)
    const was = scan.seen.get(key)
    if (was === false || (was && dev)) continue
    scan.seen.set(key, dev)
    if (was === undefined || scan.dev.delete(key)) fresh.push(pkg)
  }
  if (fresh.length > 0) scan.lookups.add(fresh)
}

// A repository opened and its lockfiles of npm's ecosystem listed, as kept
// for its commit or else from GitHub, those of its `paths` alone; null, with
// its line telling why, where either failed, or where the scan stopped.
async function listLockfiles(scan: Scan, repo: RepositoryRiskRepo) {
  let doing = 'opening it'
  try {
    const opened = await scan.source.open(repo)
    if (scan.signal.aborted) return null
    doing = 'listing its lockfiles'
    const listed = await keptRead(scan.caches.listings, scan.source.listings, `${repo.repoId}@${opened.commit}`, () => opened.lockfiles())
    const lockfiles = listed.filter(({ path, format }) => NPM_LOCKFILE_FORMATS.has(format) && lockfileOf(path, repo.paths))
    return { opened, lockfiles }
  } catch (error) {
    if (!scan.signal.aborted) scan.lines.add({ type: 'repo', id: repo.repoId, ...failureOf(error, doing) })
    return null
  }
}

type AdvisoriesLine = Extract<RepositoryRiskLine, { type: 'advisories' }>

// A lockfile's advisories line (repository-risk-audit.ts auditLockfile);
// null where it locks none, or once the scan stops.
async function readAdvisories(scan: Scan, { repo, path, format, packages }: LockfileLine & { packages: LockedPackage[] }, sha: string): Promise<AdvisoriesLine | null> {
  const audit = await auditLockfile(scan.source, scan.caches.advisories, scan.signal, `${format}\0${sha}`, packages)
  const at = { type: 'advisories', repo, path } as const
  return audit === null ? null : Array.isArray(audit) ? { ...at, advisories: audit } : { ...at, ...audit }
}

// A repository's line, its lockfiles or why they couldn't be listed, and
// then its lockfiles', and their advisories: told once they are all read
// and access to the repository is checked again, as GitHub may have
// withdrawn it meanwhile.
async function readRepository(scan: Scan, repo: RepositoryRiskRepo) {
  const listed = await listLockfiles(scan, repo)
  if (!listed) return
  const lockfiles: LockfileLine[] = []
  for (const lockfile of listed.lockfiles) {
    if (scan.signal.aborted) return
    lockfiles.push(await readLockfile(scan, repo.repoId, listed.opened, lockfile))
  }
  try { await listed.opened.recheck() } catch (error) {
    if (!scan.signal.aborted) scan.lines.add({ type: 'repo', id: repo.repoId, ...failureOf(error, 'checking access to it again') })
    return
  }
  if (scan.signal.aborted) return
  scan.lines.add({ type: 'repo', id: repo.repoId, commit: listed.opened.commit, lockfiles: listed.lockfiles.map(({ path, format }) => ({ path, format })) })
  for (const line of lockfiles) {
    scan.lines.add(line)
    if ('packages' in line) assessLater(scan, line.packages)
  }
  for (const [at, line] of lockfiles.entries()) {
    if (scan.signal.aborted) return
    const advisories = 'packages' in line ? await readAdvisories(scan, line, listed.lockfiles[at]!.sha) : null
    if (advisories) scan.lines.add(advisories)
  }
  if (scan.signal.aborted) return
  scan.told.set(repo.repoId, lockfiles.flatMap((line, at) => 'packages' in line ? [`${line.format}\0${listed.lockfiles[at]!.sha}`] : []))
}

// A repository an earlier part told whole, its packages looked up as its
// lockfiles are kept, GitHub asked nothing of it: false where one isn't.
async function lookUpTold(scan: Scan, keys: string[]) {
  const reads: LockedPackage[][] = []
  for (const key of keys) {
    const read = scan.caches.lockfiles.get(key) ?? (await scan.source.lockfiles?.read(key))?.value
    if (!read || !('packages' in read)) return false
    reads.push(read.packages)
  }
  for (const packages of reads) assessLater(scan, packages)
  return true
}

// Each repository, a repository at a time, but those an earlier part told
// whole (ScanProgress).
async function readRepositories(scan: Scan) {
  const repos = await scan.source.repos()
  scan.lines.add({ type: 'repos', repos: repos.map(repo => ({ id: repo.repoId, fullName: repo.fullName })) })
  for (const [id, keys] of (await scan.source.progress?.read())?.repos ?? []) scan.told.set(id, keys)
  for (const repo of repos) {
    if (scan.signal.aborted) return
    const keys = scan.told.get(repo.repoId)
    if (!keys || !await lookUpTold(scan, keys)) await readRepository(scan, repo)
  }
}

// What is left to assess once the repositories are read, a turn at a time:
// the stale ones that more than devDependencies need, then those only
// devDependencies need, those with none kept before the stale ones.
function leftOver(scan: Scan): AssessedPackage[][] {
  const dev = (pkg: AssessedPackage) => scan.seen.get(seenKey(pkg)) === true
  return [scan.stale.filter(pkg => !dev(pkg)), [...scan.dev.values(), ...scan.stale.filter(dev)]]
}

// The scan's lines, in the order they are found: the repositories first,
// then each repository's lockfiles and their packages once read and access
// is checked again, and each package's risk: as kept, however old, at once
// (lookUp), then those with none kept once assessed, while the repositories
// are still being read, then those told stale once assessed again, and those
// only devDependencies need after all the rest (leftOver); `done`
// last. Ends at once, the work
// under way given up on, where `signal` aborts or the lines are no longer read. A failure of
// a repository, a lockfile or a package is told in its line; one of the scan
// itself is thrown, the lines before it told. What it reads is kept in
// `caches` (RiskCaches), the instance's own unless given. Given `partMs`, it
// stops once that long, as a function time-limited must (Vercel's), the work
// under way given up on, its last line `continue`, for its reader to ask
// again: those it assessed are kept, and told at once then, and the
// repositories it told whole kept as its source's `progress`.
export async function* repositoryRiskLines<R extends RepositoryRiskRepo>(source: RepositoryRiskSource<R>, signal: AbortSignal, caches = shared,
  { partMs = null }: { partMs?: number | null } = {}): AsyncGenerator<RepositoryRiskLine> {
  const part = new AbortController(), stopped = new AbortController()
  const parting = partMs === null ? undefined : setTimeout(() => { part.abort() }, partMs)
  const running = AbortSignal.any([signal, stopped.signal, part.signal])
  // The lines told until the part's time is up, those found by then told, and
  // none waited for: the work under way, such as a request to GitHub, which
  // isn't given up on at once, outlasting it.
  const lines = queue<RepositoryRiskLine>(AbortSignal.any([signal, part.signal]), { drain: true })
  const scan: Scan = { source, caches, signal: running, lines, lookups: queue(running), seen: new Map(), dev: new Map(), stale: [], told: new Map() }
  const failed: unknown[] = []
  void (async () => {
    try {
      // Those with no risk line kept assessed first, as their lockfiles are read,
      await assessing(scan, async assess => {
        const looking = lookUp(scan, assess)
        // stopped at once where reading fails;
        try { await readRepositories(scan) } catch (error) { failed.push(error); stopped.abort() } finally { scan.lookups.close() }
        await looking
      })
      // then those told stale, and those only devDependencies need, in turn.
      for (const left of leftOver(scan)) {
        if (!running.aborted && left.length > 0) await assessing(scan, assess => { assess(left); return Promise.resolve() })
      }
      if (!running.aborted) scan.lines.add({ type: 'done' })
    } catch (error) {
      failed.push(error)
      stopped.abort()
    } finally { scan.lines.close() }
  })()
  try {
    let done = false
    for (let line = await scan.lines.take(); line !== undefined; line = await scan.lines.take()) {
      done ||= line.type === 'done'
      yield line
    }
    if (done || signal.aborted) return
    if (part.signal.aborted) {
      await source.progress?.write({ repos: [...scan.told] })
      yield { type: 'continue' }
    }
    else if (failed.length > 0) throw failed[0]
  } finally {
    // A GitHub request under way isn't waited on: it settles on its own.
    clearTimeout(parting)
    stopped.abort()
  }
}
