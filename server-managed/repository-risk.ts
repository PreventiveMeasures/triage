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
// assessed. Repositories are read a few at a time (READ_AHEAD), each told in
// turn, as GitHub's limits are the caller's; packages are assessed meanwhile, as many at a time as npm-risk.ts
// makes spare assessments, those only devDependencies need in every lockfile
// that locks them (LockedPackage `dev`) once all the rest are, as an install
// of no devDependencies leaves them out. A lockfile's packages of npm's
// registry or a mirror are asked of npm's advisories all at once, as `npm
// audit` asks, each advisory told with whether it is of malware (risk's
// npmMalwareAdvisory), which alone is a supply chain's risk; the rest are
// vulnerabilities, told beside. A repository's Dependabot alerts of npm's, open or dismissed,
// are told once its lockfiles' advisories are, each with the versions its
// lockfile locks that it covers, for the page to blend them into npm's; one
// whose alerts couldn't be had tells why, and the scan goes on. Where the
// source lists a repository's workflows, they and the actions of its own
// they use are told once its lockfiles are, each read for what it calls for
// (repository-actions.ts), and the actions and reusable workflows of others
// they name resolved on GitHub as the scan goes on (`actions`), each once,
// before it is done.
import type { LockfileFormat } from '@preventive/upstream/github.js'
import { type Severity, npmMalwareAdvisory } from '../risk/index.js'
import { isNpmPackageName, isNpmPackageSpec } from '../common/managed/npm-packages.js'
import type { NpmVersionDocument } from './npm-packages.ts'
import { type Lru, lru } from './lru.ts'
import type { KeptStore } from './npm-kept.ts'
import { MAX_SPARE_ASSESSMENTS } from './npm-risk.ts'
import type { LockedPackage } from './locked-packages.ts'
import { type Queue, queue } from './queue.ts'
import { type DownloadsSource, readyingDownloads } from './scan-downloads.ts'
import { type AssessedPackage, type Assessment, BUSY_RETRIES, BUSY_WAIT_MS, RISK_KEPT_MS, type RiskFailure, assessPackage, failureOf, isBusy } from './repository-risk-assess.ts'
import { type AdvisoryRow, type Audit, type AuditSource, auditLockfile } from './repository-risk-audit.ts'
import { type DependabotRead, type ListedLockfile, type LockfileRead, type OpenedRepository, type RepositoryFailure, type RepositoryRead, SCAN_READ_KEPT_MS,
  readRepository } from './repository-risk-read.ts'
import { type DependabotAlert, alertVersions } from './dependabot-alerts.ts'
import type { ActionsSource } from '../risk/index.js'
import { type ActionAnswers, type ActionLine, type ActionRef, type WorkflowLine, type WorkflowsLine, type WorkflowsRead, actionsLines, answerWeight,
  lockedNames, resolvingActions } from './repository-actions.ts'

export { RISK_KEPT_MS, highestSeverity } from './repository-risk-assess.ts'
export { type OpenedRepository, SCAN_READ_KEPT_MS } from './repository-risk-read.ts'

// A repository to read: where `paths` are given, a team's directories in it,
// only the lockfiles in them or above them, as a workspace's root lockfile
// locks them too.
export interface RepositoryRiskRepo { repoId: number; fullName: string; paths?: readonly string[] }

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
  progress?: { read(): Promise<{ at: number; value: ScanProgress } | null>; write(progress: ScanProgress): Promise<void> } | undefined
  // Readies npm's downloads of packages before they are assessed
  // (scan-downloads.ts); without it, each assessment asks its own.
  downloads?: DownloadsSource
  // Resolves the actions and reusable workflows of others that repositories'
  // workflows name, on GitHub; without it, none is resolved.
  actions?: ActionsSource
  // Where a repository's Actions' files as read at a commit, and a reference
  // resolved, are kept beyond this instance.
  actionFiles?: KeptStore<WorkflowsRead>
  actionLines?: KeptStore<ActionLine>
}



// A Dependabot alert as a scan tells it: with the versions of its package
// the lockfile it is of locks that it covers, none where it is of none read
// (a package.json, bun's lockfile), and whether it is of malware, as an
// advisory's is told.
export type DependabotAlertRow = DependabotAlert & { versions: string[]; malware: boolean }

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
  | ({ type: 'dependabot'; repo: number } & ({ alerts: DependabotAlertRow[] } | RiskFailure))
  | WorkflowsLine | WorkflowLine | ActionLine
  | { type: 'done' }
  // The scan stopped for its part's time (repositoryRiskLines `partMs`), what
  // it told kept: to be asked again, from where it stopped.
  | { type: 'continue' }

// The repositories a scan answered in parts told whole by a part's end: each
// by its id, its name and a team's directories in it then, and its
// lockfiles' keys (`${format}\0${sha}`) of those read, and the references
// its Actions make, to resolve.
export interface ScanProgress { repos: ToldRepository[] }
interface ToldRepository { id: number; name: string; paths: readonly string[] | null; lockfiles: string[]; actions?: ActionRef[] }

type RiskLine = Extract<RepositoryRiskLine, { type: 'risk' }>

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
  actionFiles: Lru<WorkflowsRead>
  actions: Lru<{ at: number; line: ActionLine }>
  actionAnswers: ActionAnswers
}
export const riskCaches = (): RiskCaches => ({
  listings: lru(1000),
  // By the packages they hold, a few hundred bytes each.
  lockfiles: lru(200_000, read => 'packages' in read ? read.packages.length + 1 : 1),
  risks: lru(50_000),
  advisories: lru(50_000, kept => Array.isArray(kept.audit) ? kept.audit.length + 1 : 1),
  // By their text, a kilobyte at a time.
  actionFiles: lru(64 * 1024, read => 'files' in read ? read.files.reduce((sum, file) => sum + ('text' in file ? Math.ceil(file.text.length / 1024) : 1), 1) : 1),
  actions: lru(10_000),
  // What GitHub answered of public repositories' actions, by answerWeight.
  actionAnswers: lru(200_000, answerWeight),
})
// How many repositories are read at once (repository-risk-read.ts), ahead of
// the one told: each asks GitHub one thing after another (opening it, and
// its head) even where all else is kept.
const READ_AHEAD = 6
// How long a part's progress, written as it ends (`progress`), is waited on.
const PROGRESS_WRITE_MS = 5000
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
  told: Map<number, ToldRepository>
  // Resolves the references repositories' Actions make, where the source
  // does.
  actions: ReturnType<typeof resolvingActions> | null
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

type AdvisoriesLine = Extract<RepositoryRiskLine, { type: 'advisories' }>
type LockfileLine = Extract<RepositoryRiskLine, { type: 'lockfile' }>

// A lockfile's advisories line (repository-risk-audit.ts auditLockfile);
// null where it locks none, or once the scan stops.
async function readAdvisories(scan: Scan, { repo, path, format, packages }: LockfileLine & { packages: LockedPackage[] }, sha: string): Promise<AdvisoriesLine | null> {
  const audit = await auditLockfile(scan.source, scan.caches.advisories, scan.signal, `${format}\0${sha}`, packages)
  const at = { type: 'advisories', repo, path } as const
  return audit === null ? null : Array.isArray(audit) ? { ...at, advisories: audit } : { ...at, ...audit }
}

type DependabotLine = Extract<RepositoryRiskLine, { type: 'dependabot' }>

// A repository's Dependabot alerts' line, each alert with the versions the
// lockfile it is of locks that it covers (`lockfiles`, a repository read's),
// or why they couldn't be had.
function dependabotLine(repo: number, read: DependabotRead, lockfiles: RepositoryRead['lockfiles']): DependabotLine {
  if ('error' in read) return { type: 'dependabot', repo, ...read }
  const locked = new Map(lockfiles.flatMap(({ line }) => 'packages' in line ? [[line.path, line.packages] as const] : []))
  return { type: 'dependabot', repo, alerts: read.alerts.map(alert => ({ ...alert, versions: alertVersions(alert, locked.get(alert.manifest)),
    malware: npmMalwareAdvisory({ id: alert.ghsa, aliases: alert.aliases, cwe: alert.cwe, title: alert.title }) })) }
}

// A repository's alerts checked again just before they are told, as access to
// the repository is (DependabotRead `recheck`): why not, where the user's
// access to them is withdrawn since they were read.
async function rechecked(read: DependabotRead): Promise<DependabotRead> {
  if (!('alerts' in read) || !read.recheck) return read
  try { await read.recheck() } catch (error) { return failureOf(error, 'checking access to its Dependabot alerts again') }
  return read
}

// A repository read (repository-risk-read.ts readRepository) told: its
// line, or why it couldn't be read, then its lockfiles', and their
// advisories, its packages assessed meanwhile, then its Dependabot alerts.
// Access to it is checked again
// just before, however long ago it was read, as GitHub may have withdrawn it.
async function tellRepository(scan: Scan, repo: RepositoryRiskRepo, read: RepositoryRead | RepositoryFailure | null) {
  if (!read || scan.signal.aborted) return
  if ('type' in read) { scan.lines.add(read); return }
  try { await read.recheck() } catch (error) {
    if (!scan.signal.aborted) scan.lines.add({ type: 'repo', id: repo.repoId, ...failureOf(error, 'checking access to it again') })
    return
  }
  if (scan.signal.aborted) return
  const { commit, lockfiles } = read
  scan.lines.add({ type: 'repo', id: repo.repoId, commit, lockfiles: lockfiles.map(({ line: { path, format } }) => ({ path, format })) })
  for (const { line } of lockfiles) {
    scan.lines.add(line)
    if ('packages' in line) assessLater(scan, line.packages)
  }
  const refs = read.actions ? tellActions(scan, repo, read.actions, lockfiles) : []
  for (const { sha, line } of lockfiles) {
    if (scan.signal.aborted) return
    const advisories = 'packages' in line ? await readAdvisories(scan, line, sha) : null
    if (advisories) scan.lines.add(advisories)
  }
  if (scan.signal.aborted) return
  const dependabot = read.dependabot && await rechecked(read.dependabot)
  if (scan.signal.aborted) return
  if (dependabot) scan.lines.add(dependabotLine(repo.repoId, dependabot, lockfiles))
  scan.told.set(repo.repoId, { id: repo.repoId, name: repo.fullName, paths: repo.paths ?? null,
    lockfiles: lockfiles.flatMap(({ sha, line }) => 'packages' in line ? [`${line.format}\0${sha}`] : []), ...refs.length > 0 ? { actions: refs } : {} })
}

// A repository's Actions told, npx held to its lockfiles' packages, and the
// references they make given to resolve: those references.
function tellActions(scan: Scan, repo: RepositoryRiskRepo, read: WorkflowsRead, lockfiles: RepositoryRead['lockfiles']) {
  const locked = lockfiles.flatMap(({ line }) => 'packages' in line ? [lockedNames(line.path, line.packages)] : [])
  const { lines, refs } = actionsLines(repo.repoId, repo.fullName.split('/')[0]!, read, locked)
  for (const line of lines) scan.lines.add(line)
  scan.actions?.add(refs)
  return refs
}

// Whether an earlier part told `repo` whole, by its name and a team's
// directories in it as they are now, its packages then looked up as its
// lockfiles are kept, GitHub asked nothing of it: not where one isn't. It is
// told as read then, its default branch's head not asked again.
async function toldBefore(scan: Scan, repo: RepositoryRiskRepo) {
  const told = scan.told.get(repo.repoId)
  if (!told || told.name !== repo.fullName || JSON.stringify(told.paths) !== JSON.stringify(repo.paths ?? null)) return false
  const reads: LockedPackage[][] = []
  for (const key of told.lockfiles) {
    const read = scan.caches.lockfiles.get(key) ?? (await scan.source.lockfiles?.read(key))?.value
    if (!read || !('packages' in read)) return false
    reads.push(read.packages)
  }
  for (const packages of reads) assessLater(scan, packages)
  scan.actions?.add(told.actions ?? [])
  return true
}

// Each repository, READ_AHEAD read at a time, each told in turn, but those an
// earlier part told whole (ScanProgress), read of none.
async function readRepositories(scan: Scan) {
  const repos = await scan.source.repos()
  scan.lines.add({ type: 'repos', repos: repos.map(repo => ({ id: repo.repoId, fullName: repo.fullName })) })
  // Those still listed: one no longer is read again should it be once more.
  const listed = new Set(repos.map(repo => repo.repoId))
  // Those within SCAN_READ_KEPT_MS, as their lockfiles are kept that long.
  const kept = await scan.source.progress?.read()
  const progress = kept && Date.now() - kept.at < SCAN_READ_KEPT_MS ? kept.value.repos : []
  for (const told of progress) if (listed.has(told.id)) scan.told.set(told.id, told)
  const reads: Promise<RepositoryRead | RepositoryFailure | null>[] = []
  const read = (at: number) => {
    if (reads[at]) return reads[at]
    const repo = repos[at]!
    const started = reads[at] = toldBefore(scan, repo).then(told => told ? null : readRepository(scan, repo))
    // One read ahead and no longer waited on, as the scan stopped, fails alone.
    started.catch(() => {})
    return started
  }
  for (const [at, repo] of repos.entries()) {
    if (scan.signal.aborted) return
    for (let ahead = at; ahead < Math.min(at + READ_AHEAD, repos.length); ahead++) void read(ahead)
    await tellRepository(scan, repo, await read(at))
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
  // What repositories' Actions name is resolved alongside the assessments,
  // and waited on before the scan is done.
  const actions = source.actions ? resolvingActions({ source: source.actions, signal: running, tell: line => { lines.add(line) }, memory: caches.actions,
    answers: caches.actionAnswers, store: source.actionLines }) : null
  const scan: Scan = { source, caches, signal: running, lines, lookups: queue(running), seen: new Map(), dev: new Map(), stale: [], told: new Map(), actions }
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
      await actions?.close()
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
      // Not waited on past PROGRESS_WRITE_MS, within what Vercel's limit
      // leaves past the part's: the next part then goes on from less.
      let timer
      await Promise.race([source.progress?.write({ repos: [...scan.told.values()] }), new Promise(resolve => { timer = setTimeout(resolve, PROGRESS_WRITE_MS) })])
      clearTimeout(timer)
      yield { type: 'continue' }
    }
    else if (failed.length > 0) throw failed[0]
  } finally {
    // A GitHub request under way isn't waited on: it settles on its own.
    clearTimeout(parting)
    stopped.abort()
  }
}
