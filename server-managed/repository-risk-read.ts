// A repository as a repository risk scan reads it of GitHub
// (repository-risk.ts): opened at its default branch's head, its lockfiles
// of npm's ecosystem listed (findRepoLockfiles), those of its `paths` alone,
// each read for its packages (@preventive/lockfile), and access to it checked
// again before they are told (`recheck`); and its open Dependabot alerts of
// npm's, where the source asks them (dependabot-alerts.ts), asked meanwhile
// and never kept, a failure to have them its own. A listing is kept by the commit it was listed at, and
// a lockfile's packages by its blob, neither of which changes: in the
// instance's memory, and the source's `listings` and `lockfiles` for
// SCAN_READ_KEPT_MS, so that only opening a repository and checking access
// to it again ask GitHub where all else is kept.
import type { LockfileFormat, RepoLockfile } from '@preventive/upstream/github.js'
import type { DependabotAlert } from './dependabot-alerts.ts'
import { type LockedPackage, isTestFixture, lockedPackages } from './locked-packages.ts'
import type { Lru } from './lru.ts'
import type { KeptStore } from './npm-kept.ts'
import { type RiskFailure, failureOf } from './repository-risk-assess.ts'
import type { RepositoryRiskLine, RepositoryRiskRepo } from './repository-risk.ts'

// The formats of npm's ecosystem, as findRepoLockfiles names them, and those
// of them read here.
const NPM_LOCKFILE_FORMATS: ReadonlySet<LockfileFormat> = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno'])
const READ_FORMATS: ReadonlySet<LockfileFormat> = new Set(['npm', 'pnpm', 'yarn'])

// How long the source's `listings` and `lockfiles` are read for: what
// GitHub has at a commit or a blob doesn't change, how it is read here may.
export const SCAN_READ_KEPT_MS = 24 * 60 * 60_000

export type ListedLockfile = Pick<RepoLockfile, 'path' | 'format' | 'sha'>
export type LockfileRead = { packages: LockedPackage[] } | RiskFailure
// A repository's Dependabot alerts, those of its `paths` alone, or why they
// couldn't be had.
export type DependabotRead = { alerts: DependabotAlert[] } | RiskFailure
type LockfileLine = Extract<RepositoryRiskLine, { type: 'lockfile' }>
export type RepositoryFailure = Extract<RepositoryRiskLine, { type: 'repo'; error: string }>

// A repository opened at its default branch's head (`commit`): its lockfiles,
// as findRepoLockfiles lists them, each with its blob's id, and a file's
// text; `recheck` checks access to it again, throwing where it is gone; and
// `dependabot`, where asked, its open Dependabot alerts of npm's, as GitHub
// has them now.
export interface OpenedRepository {
  commit: string
  lockfiles(): Promise<ListedLockfile[]>
  file(path: string): Promise<string>
  recheck(): Promise<void>
  dependabot?(): Promise<DependabotAlert[]>
}

// What a repository is read with: the scan's source and caches, and its
// signal.
export interface RepositoryReading<R extends RepositoryRiskRepo> {
  source: { open(repo: R): Promise<OpenedRepository>; listings?: KeptStore<ListedLockfile[]>; lockfiles?: KeptStore<LockfileRead> }
  caches: { listings: Lru<ListedLockfile[]>; lockfiles: Lru<LockfileRead> }
  signal: AbortSignal
}

// A repository read: its commit, its lockfiles' lines, each with its blob's
// id, its Dependabot alerts where asked, and access to it to check again just
// before they are told (OpenedRepository `recheck`), as GitHub may have
// withdrawn it meanwhile.
export interface RepositoryRead {
  commit: string
  lockfiles: { sha: string; line: LockfileLine }[]
  dependabot: DependabotRead | null
  recheck(): Promise<void>
}

// Whether a lockfile at `path` is of `paths` (RepositoryRiskRepo).
function lockfileOf(path: string, paths: readonly string[] | undefined) {
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), 0))
  return !paths || paths.some(scope => dir === '' || dir === scope || dir.startsWith(`${scope}/`) || scope.startsWith(`${dir}/`))
}

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
async function readLockfile({ source, caches }: RepositoryReading<RepositoryRiskRepo>, repo: number, opened: OpenedRepository,
  { path, format, sha }: ListedLockfile): Promise<LockfileLine> {
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

// A repository opened and its lockfiles of npm's ecosystem listed, as kept
// for its commit or else from GitHub, those of its `paths` alone; its line
// telling why where either failed; null where the scan stopped.
async function listLockfiles<R extends RepositoryRiskRepo>(reading: RepositoryReading<R>, repo: R) {
  let doing = 'opening it'
  try {
    const opened = await reading.source.open(repo)
    if (reading.signal.aborted) return null
    doing = 'listing its lockfiles'
    const listed = await keptRead(reading.caches.listings, reading.source.listings, `${repo.repoId}@${opened.commit}`, () => opened.lockfiles())
    const lockfiles = listed.filter(({ path, format }) => NPM_LOCKFILE_FORMATS.has(format) && lockfileOf(path, repo.paths))
    return { opened, lockfiles }
  } catch (error) {
    return reading.signal.aborted ? null : { type: 'repo', id: repo.repoId, ...failureOf(error, doing) } as const
  }
}

// A repository's Dependabot alerts of its `paths` (RepositoryRiskRepo), as
// its lockfiles are, or why they couldn't be had; null where they aren't
// asked.
async function readDependabot(opened: OpenedRepository, paths: readonly string[] | undefined): Promise<DependabotRead | null> {
  if (!opened.dependabot) return null
  try { return { alerts: (await opened.dependabot()).filter(alert => lockfileOf(alert.manifest, paths)) } } catch (error) {
    return failureOf(error, 'asking its Dependabot alerts')
  }
}

// A repository read: its lockfiles listed and read, its Dependabot alerts
// asked meanwhile; its line telling why where listing failed; null where the
// scan stopped. A test's
// fixture or example its reader refuses (isTestFixture) is left out, as a
// test may keep one so on purpose.
export async function readRepository<R extends RepositoryRiskRepo>(reading: RepositoryReading<R>, repo: R): Promise<RepositoryRead | RepositoryFailure | null> {
  const listed = await listLockfiles(reading, repo)
  if (!listed || 'type' in listed) return listed
  const alerting = readDependabot(listed.opened, repo.paths)
  const lockfiles: RepositoryRead['lockfiles'] = []
  for (const lockfile of listed.lockfiles) {
    if (reading.signal.aborted) return null
    const line = await readLockfile(reading, repo.repoId, listed.opened, lockfile)
    if (!('error' in line && line.error === 'lockfile-unreadable' && isTestFixture(line.path))) lockfiles.push({ sha: lockfile.sha, line })
  }
  const dependabot = await alerting
  return reading.signal.aborted ? null : { commit: listed.opened.commit, lockfiles, dependabot, recheck: () => listed.opened.recheck() }
}
