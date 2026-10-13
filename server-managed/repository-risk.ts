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
// assessed once a scan, however many lockfiles lock it; one from elsewhere
// (git, another tarball, a file) is listed, not assessed. Repositories are
// read one at a time, as GitHub's limits are the caller's; packages are
// assessed ASSESSING at a time meanwhile, leaving room among the server's
// assessments for viewers' own.
import { setTimeout as delay } from 'node:timers/promises'
import { LockfileError, parseNpmLockfile } from '@preventive/lockfile/npm.js'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'
import type { Severity } from '../risk/index.js'
import { isNpmPackageName, isNpmPackageSpec } from '../common/managed/npm-packages.js'

// The formats of npm's ecosystem, as findRepoLockfiles names them, and those
// of them read here.
export const NPM_LOCKFILE_FORMATS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno'])
const READ_FORMATS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn'])

// Assessments made at once: npm-risk.ts allows four across the server.
const ASSESSING = 2
// An assessment refused as busy (`npm-busy`, by npm-risk.ts or the npm reads
// beneath it) is asked again after a wait, up to this many times.
const BUSY_RETRIES = 20
const BUSY_WAIT_MS = 1000

// Where a package locked is installed from: npm's registry, another
// registry by npm's paths, such as a company's mirror of npm's, a git
// repository, a tarball elsewhere, or a file of the project.
export type LockedSource = 'registry' | 'mirror' | 'git' | 'tarball' | 'file'

export interface LockedPackage {
  name: string
  // None for a git dependency whose package.json has none.
  version: string | null
  source: LockedSource
  // Where one from elsewhere than npm's registry comes from, without any
  // credentials its URL has.
  from?: string
  // A mirror's package's, as the lockfile has it: it is npm's package of its
  // name and version only where npm's integrity is among them.
  integrity?: string
}

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'moderate', 'low', 'notice']

// The most severe of `findings`, or null for none.
export function highestSeverity(findings: readonly { severity: Severity }[]): Severity | null {
  return SEVERITIES.find(severity => findings.some(finding => finding.severity === severity)) ?? null
}

const REGISTRY_HOSTS = new Set(['registry.npmjs.org', 'registry.yarnpkg.com'])

// The package and version a tarball by npm's paths is, by its URL ending
// `/<name>/-/<unscoped name>-<version>.tgz`, and whether it is a mirror's,
// of another host than npm's registry, where the path may start with the
// mirror's own; null for any other URL. Yarn 1 names an alias by its own
// name, which only its tarball's URL tells apart.
export function registryTarball(tarball: string): { name: string; version: string; mirror: boolean } | null {
  let url
  try { url = new URL(tarball) } catch { return null }
  if (!['https:', 'http:'].includes(url.protocol)) return null
  const mirror = !REGISTRY_HOSTS.has(url.hostname) || url.port !== '' || url.username !== '' || url.password !== ''
  const match = /\/((?:@[^/]+(?:\/|%2f))?[^/@]+)\/-\/([^/]+)\.tgz$/iu.exec(url.pathname)
  if (!match || (!mirror && match.index !== 0)) return null
  let name
  try { name = decodeURIComponent(match[1]!) } catch { return null }
  const unscoped = name.slice(name.lastIndexOf('/') + 1)
  const version = match[2]!.startsWith(`${unscoped}-`) ? match[2]!.slice(unscoped.length + 1) : null
  return isNpmPackageName(name) && isNpmPackageSpec(version) ? { name, version, mirror } : null
}

// A URL as it may be shown: its credentials, query and fragment left out.
function shownUrl(text: string): string | undefined {
  try {
    const url = new URL(text)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch { return undefined }
}

// A package locked by a tarball's URL, or by none, as npm's registry gives
// one for its name and version. A mirror's with no integrity to hold it to
// npm's is any tarball.
function fromTarball(name: string, version: string | undefined, tarball: string | undefined, integrity: string | undefined): LockedPackage {
  if (tarball === undefined) return { name, version: version ?? null, source: 'registry' }
  if (tarball.startsWith('file:')) return { name, version: version ?? null, source: 'file' }
  const registry = registryTarball(tarball)
  const from = shownUrl(tarball)
  const shown = from === undefined ? {} : { from }
  if (registry && !registry.mirror) return { name: registry.name, version: registry.version, source: 'registry' }
  if (registry && integrity) return { name: registry.name, version: registry.version, source: 'mirror', ...shown, integrity }
  return { name, version: version ?? null, source: 'tarball', ...shown }
}

function fromGit(name: string, version: string | undefined, repo: string): LockedPackage {
  const from = shownUrl(repo)
  return { name, version: version ?? null, source: 'git', ...from === undefined ? {} : { from } }
}

// The packages a lockfile of `format` (npm, pnpm or yarn, as
// findRepoLockfiles names them) locks, each once, in the lockfile's order:
// those a package bundles, and the project's own directories and workspaces,
// left out. Versions go unchecked against ranges, as only what is locked is
// asked for. Throws the reader's LockfileError or YamlError for one it
// refuses.
export function lockedPackages(format: string, text: string): LockedPackage[] {
  const found = new Map<string, LockedPackage>()
  const add = (locked: LockedPackage | null) => {
    if (!locked) return
    const key = `${locked.source}\0${locked.name}@${locked.version ?? ''}\0${locked.from ?? ''}`
    if (!found.has(key)) found.set(key, locked)
  }
  if (format === 'npm') {
    for (const pkg of Object.values(parseNpmLockfile(text, { checkVersions: false }).packages)) {
      const { resolution } = pkg
      add(resolution === undefined ? null : resolution.type === 'git' ? fromGit(pkg.name, pkg.version, resolution.repo)
        : fromTarball(pkg.name, pkg.version, resolution.tarball, resolution.integrity))
    }
  } else if (format === 'pnpm') {
    const { lockfile, env } = parsePnpmLockfile(text)
    for (const pkg of [...Object.values(env?.packages ?? {}), ...Object.values(lockfile?.packages ?? {})]) {
      const { resolution } = pkg
      add(resolution.type === 'directory' ? null : resolution.type === 'git' ? fromGit(pkg.name, pkg.version, resolution.repo)
        : resolution.gitHosted ? fromGit(pkg.name, pkg.version, resolution.tarball ?? '') : fromTarball(pkg.name, pkg.version, resolution.tarball, resolution.integrity))
    }
  } else if (format === 'yarn') {
    // Yarn 2 and later write another format, which only the text tells apart.
    if (/^__metadata:/mu.test(text)) throw new LockfileError('a yarn.lock of Yarn 2 or later, which is not read')
    for (const pkg of new Set(Object.values(parseYarn1Lockfile(text, { checkVersions: false }).packages))) {
      const { resolution } = pkg
      add(resolution === undefined ? null : resolution.type === 'git' ? fromGit(pkg.name, pkg.version, resolution.repo)
        : fromTarball(pkg.name, pkg.version, resolution.tarball, resolution.integrity))
    }
  } else {
    throw new TypeError(`lockedPackages: ${format} lockfiles are not read`)
  }
  return [...found.values()]
}

export interface RepositoryRiskRepo { repoId: number; fullName: string }

// A repository opened at its default branch's head (`commit`): its lockfiles,
// each `{ path, format }` as findRepoLockfiles lists them, and a file's text.
export interface OpenedRepository {
  commit: string
  lockfiles(): Promise<{ path: string; format: string }[]>
  file(path: string): Promise<string>
}

// A package to assess: npm's of its name and version, held, where given, to
// a mirror's `integrity` (LockedPackage).
export interface AssessedPackage { name: string; version: string; integrity?: string }

export interface RepositoryRiskSource<R extends RepositoryRiskRepo> {
  repos(): Promise<R[]>
  open(repo: R): Promise<OpenedRepository>
  assess(pkg: AssessedPackage, signal: AbortSignal): Promise<{ published: string | null; findings: { id: string; severity: Severity }[] }>
}

// Why a step failed, as a line says it: an error's code, and for a lockfile
// refused, what of it its reader refused.
export type RiskFailure = { error: string; detail?: string }

export type RepositoryRiskLine =
  | { type: 'repos'; repos: { id: number; fullName: string }[] }
  | ({ type: 'repo'; id: number } & ({ commit: string; lockfiles: { path: string; format: string; npm: boolean }[] } | RiskFailure))
  | ({ type: 'lockfile'; repo: number; path: string; format: string } & ({ packages: Omit<LockedPackage, 'integrity'>[] } | RiskFailure))
  | ({ type: 'risk'; name: string; version: string } & ({ published: string | null; severity: Severity | null; findings: { id: string; severity: Severity }[] } | RiskFailure))
  | { type: 'done' }

// What an error is known by: a GitHub or npm failure's code (github-errors.ts
// GithubApiError, npm-packages.ts NpmPackageError, risk's NpmRiskError), or
// `failed`.
function failureOf(error: unknown): RiskFailure {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[a-z][a-z\d-]{0,63}$/u.test(code)) return { error: code }
  const message = error instanceof Error ? error.message : null
  if (message !== null && /^[a-z][a-z\d-]{0,63}$/u.test(message)) return { error: message }
  return { error: 'failed' }
}

const isBusy = (error: unknown) => error instanceof Error && error.message === 'npm-busy'

// Lines in the order they are pushed, read as they come until `end`, and
// then the scan's failure thrown where it failed.
class LineQueue<T> {
  #lines: T[] = []
  #wake = () => {}
  #ended = false
  #failure: unknown[] = []

  push(line: T) { this.#lines.push(line); this.#wake() }

  end(failure: unknown[] = []) {
    this.#ended = true
    this.#failure = failure
    this.#wake()
  }

  // Ends at once where `signal` aborts, the lines not yet read left.
  async *read(signal: AbortSignal): AsyncGenerator<T> {
    signal.addEventListener('abort', () => { this.#wake() }, { once: true })
    for (;;) {
      if (signal.aborted) return
      const line = this.#lines.shift()
      if (line !== undefined) { yield line; continue }
      if (this.#ended) break
      await new Promise<void>(resolve => { this.#wake = resolve })
    }
    if (this.#failure.length > 0) throw this.#failure[0]
  }
}

// What is still to do, each taken once by whichever worker asks first: none
// once closed and all taken, or once `signal` aborts.
interface WorkQueue<T> { add(item: T): void; close(): void; take(): Promise<T | undefined> }
function workQueue<T>(signal: AbortSignal): WorkQueue<T> {
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

interface Scan<R extends RepositoryRiskRepo> {
  source: RepositoryRiskSource<R>
  signal: AbortSignal
  lines: LineQueue<RepositoryRiskLine>
  // Registry packages to assess, and those already asked for.
  pending: WorkQueue<AssessedPackage>
  seen: Set<string>
}

// A registry package's risk line, asked again after a wait while the server
// is busy; null once the scan stops.
async function assessed<R extends RepositoryRiskRepo>({ source, signal }: Scan<R>, pkg: AssessedPackage): Promise<RepositoryRiskLine | null> {
  const { name, version } = pkg
  for (let attempt = 0; ; attempt++) {
    try {
      const { published, findings } = await source.assess(pkg, signal)
      const told = findings.map(({ id, severity }) => ({ id, severity }))
      return { type: 'risk', name, version, published, severity: highestSeverity(told), findings: told }
    } catch (error) {
      if (signal.aborted) return null
      if (!isBusy(error) || attempt >= BUSY_RETRIES) return { type: 'risk', name, version, ...failureOf(error) }
      try { await delay(BUSY_WAIT_MS * Math.min(attempt + 1, 5), undefined, { signal }) } catch { return null }
    }
  }
}

async function assessor<R extends RepositoryRiskRepo>(scan: Scan<R>) {
  for (let next = await scan.pending.take(); next !== undefined; next = await scan.pending.take()) {
    const line = await assessed(scan, next)
    if (line) scan.lines.push(line)
  }
}

// A lockfile's line, its packages or why they couldn't be had, its packages
// of npm's registry or a mirror of it not yet seen this scan given to the
// assessors.
async function readLockfile<R extends RepositoryRiskRepo>(scan: Scan<R>, repo: R, opened: OpenedRepository, { path, format }: { path: string; format: string }) {
  const at = { type: 'lockfile', repo: repo.repoId, path, format } as const
  if (!READ_FORMATS.has(format)) { scan.lines.push({ ...at, error: 'unsupported-format' }); return }
  let text
  try { text = await opened.file(path) } catch (error) { scan.lines.push({ ...at, ...failureOf(error) }); return }
  let packages
  try { packages = lockedPackages(format, text) } catch (error) {
    scan.lines.push({ ...at, error: 'lockfile-unreadable', ...error instanceof Error ? { detail: error.message.slice(0, 500) } : {} })
    return
  }
  scan.lines.push({ ...at, packages: packages.map(({ integrity: _integrity, ...shown }) => shown) })
  for (const { name, version, source, integrity } of packages) {
    const key = `${name}@${version}`
    if ((source !== 'registry' && source !== 'mirror') || version === null || scan.seen.has(key) || !isNpmPackageName(name) || !isNpmPackageSpec(version)) continue
    scan.seen.add(key)
    scan.pending.add({ name, version, ...integrity === undefined ? {} : { integrity } })
  }
}

// Each repository's line, its lockfiles or why they couldn't be listed, and
// then its lockfiles' of npm's ecosystem, a repository at a time.
async function readRepositories<R extends RepositoryRiskRepo>(scan: Scan<R>) {
  const repos = await scan.source.repos()
  scan.lines.push({ type: 'repos', repos: repos.map(repo => ({ id: repo.repoId, fullName: repo.fullName })) })
  for (const repo of repos) {
    if (scan.signal.aborted) return
    const listed = await scan.source.open(repo).then(async opened => ({ opened, lockfiles: await opened.lockfiles() }), (error: unknown) => ({ error }))
    if (scan.signal.aborted) return
    if ('error' in listed) { scan.lines.push({ type: 'repo', id: repo.repoId, ...failureOf(listed.error) }); continue }
    const { opened, lockfiles } = listed
    scan.lines.push({ type: 'repo', id: repo.repoId, commit: opened.commit,
      lockfiles: lockfiles.map(({ path, format }) => ({ path, format, npm: NPM_LOCKFILE_FORMATS.has(format) })) })
    for (const lockfile of lockfiles.filter(({ format }) => NPM_LOCKFILE_FORMATS.has(format))) {
      if (scan.signal.aborted) return
      await readLockfile(scan, repo, opened, lockfile)
    }
  }
}

// The scan's lines, in the order they are found: the repositories first,
// then each repository's lockfiles once listed, each lockfile's packages
// once read, and each registry package's risk once assessed, ASSESSING at a
// time while the repositories are still being read; `done` last. Ends at
// once, the work under way given up on, where `signal` aborts or the lines
// are no longer read. A failure of a repository, a lockfile or a package is
// told in its line; one of the scan itself is thrown, the lines before it
// told.
export async function* repositoryRiskLines<R extends RepositoryRiskRepo>(source: RepositoryRiskSource<R>, signal: AbortSignal): AsyncGenerator<RepositoryRiskLine> {
  const stopped = new AbortController()
  const running = AbortSignal.any([signal, stopped.signal])
  const scan: Scan<R> = { source, signal: running, lines: new LineQueue(), pending: workQueue(running), seen: new Set() }
  void (async () => {
    const assessors = Array.from({ length: ASSESSING }, () => assessor(scan))
    try {
      try { await readRepositories(scan) } finally { scan.pending.close() }
      await Promise.all(assessors)
      if (!running.aborted) scan.lines.push({ type: 'done' })
      scan.lines.end()
    } catch (error) {
      stopped.abort()
      scan.lines.end([error])
    }
  })()
  try { yield* scan.lines.read(signal) } finally {
    // A GitHub request under way isn't waited on: it settles on its own.
    stopped.abort()
  }
}
