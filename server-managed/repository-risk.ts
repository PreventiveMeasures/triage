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
// makes spare assessments.
import { setTimeout as delay } from 'node:timers/promises'
import { LockfileError, parseNpmLockfile } from '@preventive/lockfile/npm.js'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'
import type { LockfileFormat, RepoLockfile } from '@preventive/upstream/github.js'
import { NpmRiskError, SEVERITIES, type Severity } from '../risk/index.js'
import { isNpmPackageName, isNpmPackageSpec } from '../common/managed/npm-packages.js'
import { GithubApiError } from './github-errors.ts'
import { NpmPackageError, type NpmVersionDocument } from './npm-packages.ts'
import { MAX_SPARE_ASSESSMENTS } from './npm-risk.ts'

// The formats of npm's ecosystem, as findRepoLockfiles names them, and those
// of them read here.
const NPM_LOCKFILE_FORMATS: ReadonlySet<LockfileFormat> = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno'])
const READ_FORMATS: ReadonlySet<LockfileFormat> = new Set(['npm', 'pnpm', 'yarn'])

// An assessment refused as busy (`npm-busy`, by npm-risk.ts or the npm reads
// beneath it) is asked again after a wait, up to this many times.
const BUSY_RETRIES = 20
const BUSY_WAIT_MS = 1000

export interface LockedPackage {
  name: string
  // None for a git dependency whose package.json has none.
  version: string | null
  // Where it is installed from: npm's registry, another host's tarball with
  // an integrity, such as a company's mirror of npm's, a git repository, a
  // tarball with none, or a file of the project.
  source: 'registry' | 'mirror' | 'git' | 'tarball' | 'file'
  // Where one from elsewhere than npm's registry comes from, without any
  // credentials its URL has.
  from?: string
  // A mirror's tarball's, as the lockfile has it: npm's package of its name
  // and version only where npm's integrity is among it.
  integrity?: string
}

// The most severe of `findings`, or null for none.
export function highestSeverity(findings: readonly { severity: Severity }[]): Severity | null {
  return SEVERITIES.find(severity => findings.some(finding => finding.severity === severity)) ?? null
}

// A package as each reader resolves one, its name the one it is published
// under, and a registry tarball's URL held to its name and version.
type Resolution =
  | { type: 'tarball'; tarball: string | undefined; integrity: string | undefined; gitHosted?: boolean }
  | { type: 'git'; repo: string }
  | { type: 'directory' }
interface ReadPackage { name: string; version: string | undefined; resolution: Resolution | undefined }

// The packages of a lockfile of `format`, as its reader resolves them.
// Versions go unchecked against ranges, as only what is locked is asked for.
function packagesOf(format: LockfileFormat, text: string): ReadPackage[] {
  if (format === 'npm') return Object.values(parseNpmLockfile(text, { checkVersions: false }).packages)
  if (format === 'pnpm') {
    const { lockfile, env } = parsePnpmLockfile(text)
    return [...Object.values(env?.packages ?? {}), ...Object.values(lockfile?.packages ?? {})]
  }
  if (format !== 'yarn') throw new TypeError(`lockedPackages: ${format} lockfiles are not read`)
  // Yarn 2 and later write another format, which only the text tells apart.
  if (/^__metadata:/mu.test(text)) throw new LockfileError('a yarn.lock of Yarn 2 or later, which is not read')
  // Yarn 1 names an alias, `my-q@npm:q@^1.5.1`, by its own name.
  return Object.values(parseYarn1Lockfile(text, { checkVersions: false }).packages)
    .map(pkg => ({ ...pkg, name: /@npm:((?:@[^/@]+\/)?[^/@]+)/u.exec(pkg.patterns[0] ?? '')?.[1] ?? pkg.name }))
}

// npm's registry, by either of its names, and yarn's mirror of it, as
// @preventive/lockfile holds their tarballs to a package's name and version.
const REGISTRY_HOSTS = new Set(['registry.npmjs.org', 'registry.npmjs.com', 'registry.yarnpkg.com'])
const isRegistry = (url: URL) => url.protocol === 'https:' && !url.port && !url.username && !url.password
  && REGISTRY_HOSTS.has(url.hostname.replace(/\.+$/u, ''))
// Where a URL is, as it may be shown: its credentials, query and fragment
// left out.
const shown = (url: URL | null) => url ? { from: `${url.protocol}//${url.host}${url.pathname}` } : {}

// Where a package read comes from (LockedPackage); null for one a package
// bundles, with no resolution, or one of the project's own directories.
function locked({ name, version, resolution }: ReadPackage): LockedPackage | null {
  const at = { name, version: version ?? null }
  if (resolution === undefined || resolution.type === 'directory') return null
  if (resolution.type === 'git') return { ...at, source: 'git', ...shown(URL.parse(resolution.repo)) }
  const { tarball, integrity } = resolution
  if (resolution.gitHosted) return { ...at, source: 'git', ...shown(URL.parse(tarball ?? '')) }
  if (tarball === undefined) return { ...at, source: 'registry' }
  if (tarball.startsWith('file:')) return { ...at, source: 'file' }
  const url = URL.parse(tarball)
  if (url && isRegistry(url)) return { ...at, source: 'registry' }
  return integrity ? { ...at, ...shown(url), source: 'mirror', integrity } : { ...at, ...shown(url), source: 'tarball' }
}

// The packages a lockfile of `format` (npm, pnpm or yarn, as
// findRepoLockfiles names them) locks, each once, in the lockfile's order.
// Throws the reader's LockfileError or YamlError for one it refuses.
export function lockedPackages(format: LockfileFormat, text: string): LockedPackage[] {
  const found = new Map<string, LockedPackage>()
  for (const pkg of packagesOf(format, text)) {
    const one = locked(pkg)
    const key = one && `${one.source}\0${one.name}@${one.version ?? ''}\0${one.from ?? ''}\0${one.integrity ?? ''}`
    if (one && key && !found.has(key)) found.set(key, one)
  }
  return [...found.values()]
}

export interface RepositoryRiskRepo { repoId: number; fullName: string }

// A repository opened at its default branch's head (`commit`): its lockfiles,
// as findRepoLockfiles lists them, and a file's text; `recheck` checks access
// to it again, throwing where it is gone.
export interface OpenedRepository {
  commit: string
  lockfiles(): Promise<Pick<RepoLockfile, 'path' | 'format'>[]>
  file(path: string): Promise<string>
  recheck(): Promise<void>
}

export interface RepositoryRiskSource<R extends RepositoryRiskRepo> {
  repos(): Promise<R[]>
  open(repo: R): Promise<OpenedRepository>
  // npm's document of a version; an NpmPackageError where npm has none.
  version(name: string, version: string, signal: AbortSignal): Promise<NpmVersionDocument>
  assess(doc: NpmVersionDocument, signal: AbortSignal): Promise<{ published: string | null; findings: { id: string; severity: Severity }[] }>
}

// Why a step failed, as a line says it: an error's code, and for a lockfile
// refused, what of it its reader refused.
type RiskFailure = { error: string; detail?: string }

// A risk line is of npm's package of its name and version, or, with an
// `integrity`, of a mirror's that its lockfiles hold to it.
export type RepositoryRiskLine =
  | { type: 'repos'; repos: { id: number; fullName: string }[] }
  | ({ type: 'repo'; id: number } & ({ commit: string; lockfiles: { path: string; format: LockfileFormat }[] } | RiskFailure))
  | ({ type: 'lockfile'; repo: number; path: string; format: LockfileFormat } & ({ packages: LockedPackage[] } | RiskFailure))
  | ({ type: 'risk'; name: string; version: string; integrity?: string }
    & ({ published: string | null; severity: Severity | null; findings: { id: string; severity: Severity }[] } | RiskFailure))
  | { type: 'done' }

// What an error is known by: a GitHub or npm failure's code, or `failed`.
function failureOf(error: unknown): RiskFailure {
  if (error instanceof GithubApiError || error instanceof NpmPackageError) return { error: error.message }
  return { error: error instanceof NpmRiskError ? error.code : 'failed' }
}

const isBusy = (error: unknown) => error instanceof NpmPackageError && error.status === 429

// Items in the order they are added, each taken once by whichever reader asks
// first: none once closed and all taken, or once `signal` aborts.
interface Queue<T> { add(item: T): void; close(): void; take(): Promise<T | undefined> }
function queue<T>(signal: AbortSignal): Queue<T> {
  const items: T[] = []
  const waiting: (() => void)[] = []
  let closed = false
  const wake = () => { for (const resolve of waiting.splice(0)) resolve() }
  signal.addEventListener('abort', wake, { once: true })
  return {
    add(item) { items.push(item); wake() },
    close() { closed = true; wake() },
    async take() {
      for (;;) {
        if (signal.aborted) return undefined
        const item = items.shift()
        if (item !== undefined || closed) return item
        await new Promise<void>(resolve => { waiting.push(resolve) })
      }
    },
  }
}

// A package to assess: npm's of its name and version, or, with an
// `integrity`, a mirror's held to it.
interface AssessedPackage { name: string; version: string; integrity?: string }

interface Scan {
  source: RepositoryRiskSource<RepositoryRiskRepo>
  signal: AbortSignal
  lines: Queue<RepositoryRiskLine>
  // Packages to assess, and those already asked for, by name, version and a
  // mirror's integrity.
  pending: Queue<AssessedPackage>
  seen: Set<string>
}

// A package's risk line, its version's document kept and the assessment asked
// again after a wait while the server is busy; null once the scan stops.
async function assessed({ source, signal }: Scan, pkg: AssessedPackage): Promise<RepositoryRiskLine | null> {
  const at = { type: 'risk', ...pkg } as const
  let doc: NpmVersionDocument | undefined
  for (let attempt = 0; ; attempt++) {
    try {
      doc ??= await source.version(pkg.name, pkg.version, signal)
      if (pkg.integrity !== undefined && !pkg.integrity.split(/\s+/u).includes(doc.dist.integrity)) return { ...at, error: 'integrity-mismatch' }
      const { published, findings } = await source.assess(doc, signal)
      const told = findings.map(({ id, severity }) => ({ id, severity }))
      return { ...at, published, severity: highestSeverity(told), findings: told }
    } catch (error) {
      if (signal.aborted) return null
      if (!isBusy(error) || attempt >= BUSY_RETRIES) return { ...at, ...failureOf(error) }
      try { await delay(BUSY_WAIT_MS * Math.min(attempt + 1, 5), undefined, { signal }) } catch { return null }
    }
  }
}

async function assessor(scan: Scan) {
  for (let next = await scan.pending.take(); next !== undefined; next = await scan.pending.take()) {
    const line = await assessed(scan, next)
    if (line) scan.lines.add(line)
  }
}

type LockfileLine = Extract<RepositoryRiskLine, { type: 'lockfile' }>

// A lockfile's line, its packages or why they couldn't be had.
async function readLockfile(repo: number, opened: OpenedRepository, { path, format }: { path: string; format: LockfileFormat }): Promise<LockfileLine> {
  const at = { type: 'lockfile', repo, path, format } as const
  if (!READ_FORMATS.has(format)) return { ...at, error: 'unsupported-format' }
  let text
  try { text = await opened.file(path) } catch (error) { return { ...at, ...failureOf(error) } }
  try { return { ...at, packages: lockedPackages(format, text) } } catch (error) {
    return { ...at, error: 'lockfile-unreadable', ...error instanceof Error ? { detail: error.message.slice(0, 500) } : {} }
  }
}

// A lockfile's packages of npm's registry or a mirror not yet seen this scan,
// given to the assessors.
function assessLater(scan: Scan, packages: LockedPackage[]) {
  for (const { name, version, source, integrity } of packages) {
    const key = `${name}@${version}\0${integrity ?? ''}`
    if ((source !== 'registry' && source !== 'mirror') || version === null || scan.seen.has(key) || !isNpmPackageName(name) || !isNpmPackageSpec(version)) continue
    scan.seen.add(key)
    scan.pending.add({ name, version, ...integrity === undefined ? {} : { integrity } })
  }
}

// A repository opened and its lockfiles of npm's ecosystem listed; null, with
// its line telling why, where either failed, or where the scan stopped.
async function listLockfiles(scan: Scan, repo: RepositoryRiskRepo) {
  try {
    const opened = await scan.source.open(repo)
    if (scan.signal.aborted) return null
    const lockfiles = (await opened.lockfiles()).filter(({ format }) => NPM_LOCKFILE_FORMATS.has(format))
    return { opened, lockfiles }
  } catch (error) {
    if (!scan.signal.aborted) scan.lines.add({ type: 'repo', id: repo.repoId, ...failureOf(error) })
    return null
  }
}

// A repository's line, its lockfiles or why they couldn't be listed, and
// then its lockfiles': told once they are all read and access to the
// repository is checked again, as GitHub may have withdrawn it meanwhile.
async function readRepository(scan: Scan, repo: RepositoryRiskRepo) {
  const listed = await listLockfiles(scan, repo)
  if (!listed) return
  const lockfiles: LockfileLine[] = []
  for (const lockfile of listed.lockfiles) {
    if (scan.signal.aborted) return
    lockfiles.push(await readLockfile(repo.repoId, listed.opened, lockfile))
  }
  try { await listed.opened.recheck() } catch (error) {
    if (!scan.signal.aborted) scan.lines.add({ type: 'repo', id: repo.repoId, ...failureOf(error) })
    return
  }
  if (scan.signal.aborted) return
  scan.lines.add({ type: 'repo', id: repo.repoId, commit: listed.opened.commit, lockfiles: listed.lockfiles.map(({ path, format }) => ({ path, format })) })
  for (const line of lockfiles) {
    scan.lines.add(line)
    if ('packages' in line) assessLater(scan, line.packages)
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
// repositories are still being read; `done` last. Ends at once, the work under way given
// up on, where `signal` aborts or the lines are no longer read. A failure of
// a repository, a lockfile or a package is told in its line; one of the scan
// itself is thrown, the lines before it told.
export async function* repositoryRiskLines<R extends RepositoryRiskRepo>(source: RepositoryRiskSource<R>, signal: AbortSignal): AsyncGenerator<RepositoryRiskLine> {
  const stopped = new AbortController()
  const running = AbortSignal.any([signal, stopped.signal])
  const scan: Scan = { source, signal: running, lines: queue(signal), pending: queue(running), seen: new Set() }
  const failed: unknown[] = []
  void (async () => {
    const assessors = Array.from({ length: MAX_SPARE_ASSESSMENTS }, () => assessor(scan))
    try {
      try { await readRepositories(scan) } finally { scan.pending.close() }
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
