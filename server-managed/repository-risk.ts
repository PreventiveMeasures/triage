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
// makes spare assessments. A lockfile's packages of npm's registry or a
// mirror are asked of npm's advisories all at once, as `npm audit` asks, each
// advisory told with whether it is of malware (risk's npmMalwareAdvisory),
// which alone is a supply chain's risk; the rest are vulnerabilities, told
// beside.
import { setTimeout as delay } from 'node:timers/promises'
import type { Advisory } from '@preventive/upstream/advisories.js'
import type { LockfileFormat, RepoLockfile } from '@preventive/upstream/github.js'
import { isExactVersion } from '@preventive/upstream/semver.js'
import { NpmRiskError, SEVERITIES, type Severity, npmMalwareAdvisory } from '../risk/index.js'
import { isNpmPackageName, isNpmPackageSpec } from '../common/managed/npm-packages.js'
import { GithubApiError } from './github-errors.ts'
import { NpmPackageError, type NpmVersionDocument } from './npm-packages.ts'
import { type Lru, lru } from './lru.ts'
import type { KeptStore } from './npm-kept.ts'
import { MAX_SPARE_ASSESSMENTS } from './npm-risk.ts'
import { type LockedPackage, lockedPackages } from './locked-packages.ts'
import { type Queue, queue } from './queue.ts'
import { type DownloadsSource, type ReadyingDownloads, readyingDownloads } from './scan-downloads.ts'

// The formats of npm's ecosystem, as findRepoLockfiles names them, and those
// of them read here.
const NPM_LOCKFILE_FORMATS: ReadonlySet<LockfileFormat> = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno'])
const READ_FORMATS: ReadonlySet<LockfileFormat> = new Set(['npm', 'pnpm', 'yarn'])

// An assessment refused as busy (`npm-busy`, by npm-risk.ts or the npm reads
// beneath it), or that npm asked to ask later (risk's `upstream-busy`, as its
// downloads API answers past a burst of requests), is asked again after a
// wait, up to this many times.
const BUSY_RETRIES = 20
const BUSY_WAIT_MS = 1000

// The most severe of `findings`, or null for none.
export function highestSeverity(findings: readonly { severity: Severity }[]): Severity | null {
  return SEVERITIES.find(severity => findings.some(finding => finding.severity === severity)) ?? null
}

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

type Assessment = { published: string | null; findings: { id: string; severity: Severity; takenDown?: unknown }[]; score: { score: number } }

export interface RepositoryRiskSource<R extends RepositoryRiskRepo> {
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
  // npm's registry's advisories of these packages' versions, asked at once.
  advisories(packages: { name: string; versions: string[] }[], signal: AbortSignal): Promise<Advisory[]>
  // Where risk lines are kept beyond this instance, as RiskCaches keeps them
  // in it (npm-kept.ts riskLineStore, the database's).
  risks?: KeptStore<RiskLine>
  // Readies npm's downloads of packages before they are assessed
  // (scan-downloads.ts); without it, each assessment asks its own.
  downloads?: DownloadsSource
}

type AdvisoryRow = Advisory & { malware: boolean }

// Why a step failed, as a line says it: an error's code, and for a lockfile
// refused, what of it its reader refused.
type RiskFailure = { error: string; detail?: string }

// A risk line is of npm's package of its name and version, or, with an
// `integrity`, of a mirror's that its lockfiles hold to it; its `score` risk's
// of it, out of 100 (assessNpm `score`, risk/npm/score.js).
export type RepositoryRiskLine =
  | { type: 'repos'; repos: { id: number; fullName: string }[] }
  | ({ type: 'repo'; id: number } & ({ commit: string; lockfiles: { path: string; format: LockfileFormat }[] } | RiskFailure))
  | ({ type: 'lockfile'; repo: number; path: string; format: LockfileFormat } & ({ packages: LockedPackage[] } | RiskFailure))
  | ({ type: 'risk'; name: string; version: string; integrity?: string }
    & ({ published: string | null; severity: Severity | null; score: number; findings: { id: string; severity: Severity; takenDown?: true }[] } | RiskFailure))
  | ({ type: 'advisories'; repo: number; path: string } & ({ advisories: AdvisoryRow[] } | RiskFailure))
  | { type: 'done' }

// What an error is known by: a GitHub or npm failure's code, or `failed`;
// GitHub not reached with what failed (githubUnreachable), while `doing` what
// of a repository, and risk's with what it asked of npm and how that failed,
// where they say.
function failureOf(error: unknown, doing?: string): RiskFailure {
  if (error instanceof GithubApiError && error.detail) return { error: error.message, detail: doing ? `${doing}: ${error.detail}` : error.detail }
  if (error instanceof GithubApiError || error instanceof NpmPackageError) return { error: error.message }
  if (!(error instanceof NpmRiskError)) return { error: 'failed' }
  return error.message === error.code ? { error: error.code } : { error: error.code, detail: error.message }
}

const isBusy = (error: unknown) => (error instanceof NpmPackageError && error.status === 429) || (error instanceof NpmRiskError && error.code === 'upstream-busy')

type RiskLine = Extract<RepositoryRiskLine, { type: 'risk' }>
type LockfileRead = { packages: LockedPackage[] } | RiskFailure

// What scans keep between them, in this instance's memory: a repository's
// lockfiles as listed at a commit, and a lockfile's packages by its blob,
// neither of which changes; and a package's risk line and a lockfile's
// advisories, asked again after RISK_KEPT_MS, as risk tells again what of a
// package changes in time (a deprecation, its age, its downloads) and npm
// publishes advisories. Each is told only once access to its repository is
// checked as when it was read.
export interface RiskCaches {
  listings: Lru<ListedLockfile[]>
  lockfiles: Lru<LockfileRead>
  risks: Lru<{ at: number; line: RiskLine }>
  advisories: Lru<{ at: number; rows: AdvisoryRow[] }>
}
export const riskCaches = (): RiskCaches => ({
  listings: lru(1000),
  // By the packages they hold, a few hundred bytes each.
  lockfiles: lru(200_000, read => 'packages' in read ? read.packages.length + 1 : 1),
  risks: lru(50_000),
  advisories: lru(50_000, kept => kept.rows.length + 1),
})
export const RISK_KEPT_MS = 60 * 60_000
const shared = riskCaches()

// A package to assess: npm's of its name and version, or, with an
// `integrity`, a mirror's held to it.
interface AssessedPackage { name: string; version: string; integrity?: string }

interface Scan {
  source: RepositoryRiskSource<RepositoryRiskRepo>
  caches: RiskCaches
  signal: AbortSignal
  lines: Queue<RepositoryRiskLine>
  // Packages to assess, and those already asked for, by name, version and a
  // mirror's integrity; those whose downloads are readied first, where the
  // source readies them.
  pending: Queue<AssessedPackage>
  seen: Set<string>
  readying: ReadyingDownloads<AssessedPackage> | null
}

// A package's risk line, its version's document kept and the assessment asked
// again after a wait while the server is busy; null once the scan stops. A
// version npm has no document of is told as risk tells one npm removed
// (removedOf), its malware keeping whether its package was taken down.
async function assess({ source, signal }: Scan, pkg: AssessedPackage, teamScoped: boolean): Promise<RiskLine | null> {
  const at = { type: 'risk', ...pkg } as const
  let doc: NpmVersionDocument | NpmPackageError | undefined
  for (let attempt = 0; ; attempt++) {
    try {
      const read = doc ??= await documentOf(source, pkg, signal)
      if (!(read instanceof NpmPackageError) && pkg.integrity !== undefined && !pkg.integrity.split(/\s+/u).includes(read.dist.integrity)) return { ...at, error: 'integrity-mismatch' }
      const { published, findings, score } = read instanceof NpmPackageError ? await removedOf(source, pkg, teamScoped, signal, read) : await assessedOf(source, pkg, teamScoped, signal, read)
      const told = findings.map(({ id, severity, takenDown }) => ({ id, severity, ...takenDown === true ? { takenDown: true as const } : {} }))
      return { ...at, published, severity: highestSeverity(told), score: score.score, findings: told }
    } catch (error) {
      if (signal.aborted) return null
      if (!isBusy(error) || attempt >= BUSY_RETRIES) return { ...at, ...failureOf(error) }
      try { await delay(BUSY_WAIT_MS * Math.min(attempt + 1, 5), undefined, { signal }) } catch { return null }
    }
  }
}

// npm's document of a version, or its answer that it has none (a 404).
async function documentOf(source: Scan['source'], pkg: AssessedPackage, signal: AbortSignal): Promise<NpmVersionDocument | NpmPackageError> {
  try { return await source.version(pkg.name, pkg.version, signal) } catch (error) {
    if (error instanceof NpmPackageError && error.status === 404) return error
    throw error
  }
}

// A version's assessment; where risk finds npm no longer has it, as a document
// read from where versions' are kept doesn't tell, as one npm removed.
async function assessedOf(source: Scan['source'], pkg: AssessedPackage, teamScoped: boolean, signal: AbortSignal, doc: NpmVersionDocument): Promise<Assessment> {
  try { return await source.assess(doc, teamScoped, signal) } catch (error) {
    if (!(error instanceof NpmRiskError && error.code === 'version-not-found')) throw error
    return removedOf(source, pkg, teamScoped, signal, new NpmPackageError(404, 'package-not-found'))
  }
}

// A version npm has no document of, as risk tells one npm removed, as it
// removes every one it finds malware in (`removed`): `gone`, npm's answer of
// none, thrown where nothing tells of it.
async function removedOf(source: Scan['source'], pkg: AssessedPackage, teamScoped: boolean, signal: AbortSignal, gone: NpmPackageError): Promise<Assessment> {
  try { return await source.removed(pkg.name, pkg.version, teamScoped, signal) } catch (error) {
    throw error instanceof NpmRiskError && (error.code === 'version-not-found' || error.code === 'package-not-found') ? gone : error
  }
}

// A package's risk line as kept (RiskCaches, else the source's `risks`), else
// assessed and kept, in both, where it tells what risk found, or that a
// mirror's copy isn't npm's.
async function assessed(scan: Scan, pkg: AssessedPackage): Promise<RiskLine | null> {
  let teamScoped
  try { teamScoped = await scan.source.teamScoped(pkg.name) } catch (error) { return { type: 'risk', ...pkg, ...failureOf(error) } }
  const key = `${pkg.name}@${pkg.version}\0${pkg.integrity ?? ''}\0${teamScoped}`
  const kept = scan.caches.risks.get(key) ?? await keptLine(scan, key)
  // One kept before risk told a score (assessNpm `score`) is asked again.
  if (kept && Date.now() - kept.at < RISK_KEPT_MS && ('error' in kept.line || typeof kept.line.score === 'number')) return kept.line
  const line = await assess(scan, pkg, teamScoped)
  if (line && (!('error' in line) || line.error === 'integrity-mismatch')) {
    const at = Date.now()
    scan.caches.risks.set(key, { at, line })
    await scan.source.risks?.write(key, line, at)
  }
  return line
}

async function keptLine({ source, caches }: Scan, key: string) {
  const hit = await source.risks?.read(key)
  if (!hit) return null
  caches.risks.set(key, { at: hit.at, line: hit.value })
  return { at: hit.at, line: hit.value }
}

async function assessor(scan: Scan) {
  for (let next = await scan.pending.take(); next !== undefined; next = await scan.pending.take()) {
    const line = await assessed(scan, next)
    if (line) scan.lines.add(line)
  }
}

type LockfileLine = Extract<RepositoryRiskLine, { type: 'lockfile' }>

// A lockfile's line, its packages or why they couldn't be had: as kept by its
// blob, else read from GitHub and kept.
async function readLockfile({ caches }: Scan, repo: number, opened: OpenedRepository, { path, format, sha }: ListedLockfile): Promise<LockfileLine> {
  const at = { type: 'lockfile', repo, path, format } as const
  if (!READ_FORMATS.has(format)) return { ...at, error: 'unsupported-format' }
  const key = `${format}\0${sha}`
  let read = caches.lockfiles.get(key)
  if (!read) {
    let text
    try { text = await opened.file(path) } catch (error) { return { ...at, ...failureOf(error) } }
    try { read = { packages: lockedPackages(format, text) } } catch (error) {
      read = { error: 'lockfile-unreadable', ...error instanceof Error ? { detail: error.message.slice(0, 500) } : {} }
    }
    caches.lockfiles.set(key, read)
  }
  return { ...at, ...read }
}

// A lockfile's packages of npm's registry or a mirror not yet seen this scan,
// given to the assessors, once their downloads are readied where the source
// readies them.
function assessLater(scan: Scan, packages: LockedPackage[]) {
  const fresh: AssessedPackage[] = []
  for (const { name, version, source, integrity } of packages) {
    const key = `${name}@${version}\0${integrity ?? ''}`
    if ((source !== 'registry' && source !== 'mirror') || version === null || scan.seen.has(key) || !isNpmPackageName(name) || !isNpmPackageSpec(version)) continue
    scan.seen.add(key)
    fresh.push({ name, version, ...integrity === undefined ? {} : { integrity } })
  }
  if (scan.readying) scan.readying.add(fresh)
  else for (const pkg of fresh) scan.pending.add(pkg)
}

// A repository opened and its lockfiles of npm's ecosystem listed, as kept
// for its commit or else from GitHub, those of its `paths` alone; null, with
// its line telling why, where either failed, or where the scan stopped.
async function listLockfiles(scan: Scan, repo: RepositoryRiskRepo) {
  let doing = 'opening it'
  try {
    const opened = await scan.source.open(repo)
    if (scan.signal.aborted) return null
    const key = `${repo.repoId}@${opened.commit}`
    let listed = scan.caches.listings.get(key)
    doing = 'listing its lockfiles'
    if (!listed) scan.caches.listings.set(key, listed = await opened.lockfiles())
    const lockfiles = listed.filter(({ path, format }) => NPM_LOCKFILE_FORMATS.has(format) && lockfileOf(path, repo.paths))
    return { opened, lockfiles }
  } catch (error) {
    if (!scan.signal.aborted) scan.lines.add({ type: 'repo', id: repo.repoId, ...failureOf(error, doing) })
    return null
  }
}

type AdvisoriesLine = Extract<RepositoryRiskLine, { type: 'advisories' }>

// A lockfile's advisories line: npm's registry's advisories of its packages
// of the registry or a mirror, by its blob as kept, else asked at once and
// kept; null where it locks none, or once the scan stops.
async function readAdvisories(scan: Scan, { repo, path, format, packages }: LockfileLine & { packages: LockedPackage[] }, sha: string): Promise<AdvisoriesLine | null> {
  const at = { type: 'advisories', repo, path } as const
  const key = `${format}\0${sha}`
  const kept = scan.caches.advisories.get(key)
  if (kept && Date.now() - kept.at < RISK_KEPT_MS) return { ...at, advisories: kept.rows }
  const asked = new Map<string, Set<string>>()
  for (const { name, version, source } of packages) {
    if ((source !== 'registry' && source !== 'mirror') || !isNpmPackageName(name) || !isExactVersion(version)) continue
    if (!asked.has(name)) asked.set(name, new Set())
    asked.get(name)!.add(version)
  }
  if (asked.size === 0) return null
  try {
    const rows = (await scan.source.advisories([...asked].map(([name, versions]) => ({ name, versions: [...versions] })), scan.signal))
      .map(advisory => ({ ...advisory, malware: npmMalwareAdvisory(advisory) }))
    scan.caches.advisories.set(key, { at: Date.now(), rows })
    return { ...at, advisories: rows }
  } catch (error) {
    return scan.signal.aborted ? null : { ...at, ...failureOf(error) }
  }
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
}

// Each repository, a repository at a time.
async function readRepositories(scan: Scan) {
  const repos = await scan.source.repos()
  scan.lines.add({ type: 'repos', repos: repos.map(repo => ({ id: repo.repoId, fullName: repo.fullName })) })
  for (const repo of repos) {
    if (scan.signal.aborted) return
    await readRepository(scan, repo)
  }
}

// The scan's lines, in the order they are found: the repositories first,
// then each repository's lockfiles and their packages once read and access
// is checked again, and each package's risk once assessed, while the
// repositories are still being read; `done` last. Ends at once, the work
// under way given up on, where `signal` aborts or the lines are no longer read. A failure of
// a repository, a lockfile or a package is told in its line; one of the scan
// itself is thrown, the lines before it told. What it reads is kept in
// `caches` (RiskCaches), the instance's own unless given.
export async function* repositoryRiskLines<R extends RepositoryRiskRepo>(source: RepositoryRiskSource<R>, signal: AbortSignal, caches = shared): AsyncGenerator<RepositoryRiskLine> {
  const stopped = new AbortController()
  const running = AbortSignal.any([signal, stopped.signal])
  const scan: Scan = { source, caches, signal: running, lines: queue(signal), pending: queue(running), seen: new Set(), readying: null }
  scan.readying = source.downloads ? readyingDownloads(source.downloads, running, pkg => { scan.pending.add(pkg) }, { busy: isBusy, retries: BUSY_RETRIES, waitMs: BUSY_WAIT_MS }) : null
  const failed: unknown[] = []
  void (async () => {
    const assessors = Array.from({ length: MAX_SPARE_ASSESSMENTS }, () => assessor(scan))
    try {
      // Stopped at once where reading fails, the downloads being readied with it.
      try { await readRepositories(scan) } catch (error) { failed.push(error); stopped.abort() } finally {
        await scan.readying?.close()
        scan.pending.close()
      }
      await Promise.all(assessors)
      if (!running.aborted) scan.lines.add({ type: 'done' })
    } catch (error) {
      failed.push(error)
      stopped.abort()
    } finally { scan.lines.close() }
  })()
  try {
    for (let line = await scan.lines.take(); line !== undefined; line = await scan.lines.take()) yield line
    if (failed.length > 0 && !signal.aborted) throw failed[0]
  } finally {
    // A GitHub request under way isn't waited on: it settles on its own.
    stopped.abort()
  }
}
