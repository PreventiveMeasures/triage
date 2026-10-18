// The package versions a pull request's lockfiles lock that they didn't
// before it, as the code viewer's Pull requests tab shows them on an open
// one's tile and its popup on any (GET
// /api/admin/repositories/pull-dependencies): read only where it changes a
// lockfile of npm's ecosystem that @preventive/lockfile reads
// (package-lock.json and npm-shrinkwrap.json of `lockfileVersion: 3`,
// pnpm-lock.yaml of pnpm 9 to 12 and Yarn 1's yarn.lock, locked-packages.ts),
// and Bun's, which it doesn't (bun.lock and bun.lockb, its directory told
// `lockfile-unsupported`); none under a node_modules nor a test's fixtures
// (isTestFixture), which no install takes. Its files are GitHub's comparison of its base with its head
// (GET /repos/:owner/:repo/compare/:base...:head), which names where its
// branch left its base, its merge base, as GitHub's own Files changed
// compares from it, and lists as many as a commit's files are read
// (repository-changes.ts MAX_FILES, 300, the most it lists); one changing as
// many, from its own list of them, a page at a time, as many as PULL_FILES.
// Each directory's lockfiles it changes are read at its merge base and at its
// head, a lockfile replaced by another, Yarn's by pnpm's say, read as the
// one it replaced; a version new to a directory is one its lockfiles lock at
// the head that none of them locked at the merge base, from where it is
// installed: a package new to it, or a version of one they locked others of,
// a bump's, told with those (`was`). What a pair of commits holds never
// changes, so what is told of one is kept by them (`kept`), and each
// lockfile read is kept in this instance's memory by its commit
// (`lockfileReads`): the pull requests branching off the same commit, as a
// bot's do, read their base's once.
import { createClient } from '@preventive/upstream/github.js'
import { GithubApiError, githubJson } from './github-app.ts'
import { upstreamGithub } from './github-errors.ts'
import { compareVersions, isExactVersion } from '@preventive/upstream/semver.js'
import { type LockedPackage, isTestFixture, lockedPackages } from './locked-packages.ts'
import { type Lru, lru } from './lru.ts'
import { type ChangedFile, commitChanges } from './repository-changes.ts'

// The files of a pull request read from its own list past those compared,
// FILES_PAGE a page, as many as GitHub lists (3,000).
const FILES_PAGE = 100
export const PULL_FILES = 3000
// The directories whose lockfiles are read, those past them left out
// (`cut`), and the packages told new of each, those past them counted.
export const MAX_DIRECTORIES = 20
export const MAX_ADDED = 200
// The versions a directory's lockfiles lock at the head kept with what they
// add, as many as MAX_LOCKED, those past them counted, for those not new to
// be reviewed as well (pull-dependency-reviews.ts).
export const MAX_LOCKED = 20_000
// Lockfiles read at once.
const READ_PARALLEL = 4
// The rules what is told was told by, kept with it (http.ts
// pullDependencyKept): one told by others is told again.
export const PULL_DEPENDENCIES_READ = 3
const SHA = /^[a-f\d]{40}$/u

type Format = 'npm' | 'pnpm' | 'yarn' | 'bun'

// The format of the lockfile of npm's ecosystem at `path`, as
// findRepoLockfiles names it (with pnpm's of a branch,
// pnpm-lock.<branch>.yaml, and of before pnpm 3, shrinkwrap.yaml, which its
// reader refuses); null for another file, and for one under a node_modules or
// of a test's fixtures. Bun's alone isn't read.
export function lockfileFormat(path: string): Format | null {
  const dirs = path.split('/')
  const name = dirs.pop() ?? ''
  if (dirs.includes('node_modules') || isTestFixture(path)) return null
  if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') return 'npm'
  if (/^pnpm-lock(?:\..+)?\.yaml$/u.test(name) || name === 'shrinkwrap.yaml') return 'pnpm'
  if (name === 'bun.lock' || name === 'bun.lockb') return 'bun'
  return name === 'yarn.lock' ? 'yarn' : null
}

// Whether a pull request changing `paths` changes a lockfile read here: null
// where none of them is one but they are fewer than it changes
// (`changed`), which it may yet.
export function touchesLockfile(paths: string[], changed: number): boolean | null {
  if (paths.some(path => lockfileFormat(path) !== null)) return true
  return changed > paths.length ? null : false
}

// A package version new to a directory, as its lockfile locks it, with its
// integrity, which its reviews are held to; of a package its lockfiles locked
// before, the versions of it they did (`was`, the highest first), none of one
// new to it.
export type AddedPackage = LockedPackage & { was?: string[] }
// A directory's lockfiles the pull request changes (`paths`, those it adds,
// modifies, removes or renames, by either name): the package versions they
// lock new to it, by name and version (as many as MAX_LOCKED, told as many
// as MAX_ADDED, `more` past them), and all they lock (`locked`, as many as MAX_LOCKED, how many more
// `moreLocked`); or why they couldn't be told, a lockfile's reader refusing one
// (`lockfile-unreadable`, with what it said), one of a format not read
// (`lockfile-unsupported`, Bun's) or GitHub having none at a commit compared.
export type DirectoryDependencies = { paths: string[] } & ({ added: AddedPackage[]; more: number; locked: LockedPackage[]; moreLocked: number }
  | { error: string; detail?: string })
// What a pull request's lockfiles add: the commits compared (`base`, its
// merge base, and `head`); each directory's, of those it changes a lockfile
// in; and `cut` where it changes more files than GitHub lists, or lockfiles
// in more directories than are read, with, where only those cut it and they
// are few enough, the paths of those directories' lockfiles (`omitted`), for
// a review holding to none of them to fail in nothing.
export interface PullDependencies { base: string; head: string; lockfiles: DirectoryDependencies[]; cut: boolean; omitted?: string[] }
const MAX_OMITTED = 1000

// What is told of a pull request, by the commits it is of, `${base}...${head}`.
export interface PullDependencyStore {
  read(key: string): Promise<PullDependencies | null>
  write(key: string, value: PullDependencies): Promise<void>
}

// A lockfile's packages, or why its reader refused it, by its repository,
// commit and path, read in this instance; by the packages each holds, as the
// scan's are (repository-risk.ts riskCaches).
type LockfileRead = { packages: LockedPackage[] } | { error: string; detail?: string }
const lockfileReads: Lru<LockfileRead> = lru(200_000, read => 'packages' in read ? read.packages.length + 1 : 1)
// Those being read, by the token reading them too, lest each asking at once read them.
const lockfilesReading = new Map<string, Promise<LockfileRead>>()

const api = (fullName: string) => `https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`

// The pull request's base's and head's commits, as GitHub has them now: its
// base's moving on as it does, its head's with each push, both kept once it
// is merged or closed.
async function pullCommits(fullName: string, token: string, number: number, fetchImpl: typeof fetch) {
  const pull = await githubJson(`${api(fullName)}/pulls/${number}`, token, fetchImpl) as
    { number?: unknown; base?: { sha?: unknown; repo?: { full_name?: unknown } | null }; head?: { sha?: unknown } } | null
  const base = pull?.base?.sha, head = pull?.head?.sha, repo = pull?.base?.repo?.full_name
  if (pull?.number !== number || typeof base !== 'string' || !SHA.test(base) || typeof head !== 'string' || !SHA.test(head)
    || typeof repo !== 'string' || repo.toLowerCase() !== fullName.toLowerCase()) throw new GithubApiError(502, 'github-malformed')
  return { base, head }
}

// The pull request's merge base and the files it changes from it: as GitHub
// compares its base with its head, else, where that lists as many as it lists
// at most, from the pull request's own list, a page at a time; `cut` where
// that lists as many as it lists at most, too.
async function pullFiles(fullName: string, token: string, number: number, base: string, head: string, fetchImpl: typeof fetch) {
  const compared = await githubJson(`${api(fullName)}/compare/${base}...${head}?per_page=1`, token, fetchImpl) as { merge_base_commit?: { sha?: unknown } } | null
  const mergeBase = compared?.merge_base_commit?.sha
  if (typeof mergeBase !== 'string' || !SHA.test(mergeBase)) throw new GithubApiError(502, 'github-malformed')
  const { files, more } = commitChanges(compared)
  if (!more) return { mergeBase, files, cut: false }
  const listed: ChangedFile[] = []
  for (let page = 1; listed.length < PULL_FILES; page++) {
    const data = await githubJson(`${api(fullName)}/pulls/${number}/files?per_page=${FILES_PAGE}&page=${page}`, token, fetchImpl)
    if (!Array.isArray(data)) throw new GithubApiError(502, 'github-malformed')
    listed.push(...commitChanges({ files: data }).files)
    if (data.length < FILES_PAGE) return { mergeBase, files: listed, cut: false }
  }
  return { mergeBase, files: listed, cut: true }
}

// The lockfiles read here a pull request changes (`files`), by directory:
// each as it was (`before`, one modified or removed, or a rename's path
// before) and as it is (`after`, one added or modified, or a rename's path
// now), and every path of them (`paths`), as many directories as
// MAX_DIRECTORIES.
function lockfilesChanged(files: ChangedFile[]) {
  type Directory = { before: { path: string; format: Format }[]; after: { path: string; format: Format }[]; paths: Set<string> }
  const directories = new Map<string, Directory>()
  const take = (side: 'before' | 'after', path: string | undefined) => {
    const format = path ? lockfileFormat(path) : null
    if (!path || !format) return
    const dir = path.slice(0, Math.max(path.lastIndexOf('/'), 0))
    const directory = directories.get(dir) ?? directories.set(dir, { before: [], after: [], paths: new Set() }).get(dir)!
    directory[side].push({ path, format })
    directory.paths.add(path)
  }
  for (const [path, status, from] of files) {
    take('before', status === 'R' ? from : status === 'A' ? undefined : path)
    take('after', status === 'D' ? undefined : path)
  }
  const all = [...directories.entries()].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return { directories: all.slice(0, MAX_DIRECTORIES).map(([, directory]) => directory), cut: all.length > MAX_DIRECTORIES,
    omitted: all.slice(MAX_DIRECTORIES).flatMap(([, directory]) => [...directory.paths]).toSorted() }
}

// A lockfile's packages at `ref`, as read in this instance, else shared with
// a read of it with the same token still under way, else of GitHub; a
// lockfile its reader refuses, why. Any failure to read it of GitHub but its
// having none there is the whole answer's, as it would be every file's.
export function readLockfile(fullName: string, token: string, ref: string, lockfile: { path: string; format: Format }): Promise<LockfileRead> {
  if (lockfile.format === 'bun') return Promise.resolve({ error: 'lockfile-unsupported' })
  const key = `${fullName}\0${ref}\0${lockfile.path}`
  const known = lockfileReads.get(key)
  if (known) return Promise.resolve(known)
  const shared = `${token}\0${key}`
  const reading = lockfilesReading.get(shared) ?? readOf(fullName, token, ref, lockfile, key).finally(() => lockfilesReading.delete(shared))
  lockfilesReading.set(shared, reading)
  return reading
}
async function readOf(fullName: string, token: string, ref: string, { path, format }: { path: string; format: Format }, key: string): Promise<LockfileRead> {
  let text: string
  try {
    text = await upstreamGithub(() => createClient({ token, userAgent: 'deepview-triage' }).getRepoFile({ repo: fullName, path, ref }))
  } catch (err) {
    if (err instanceof GithubApiError && err.message === 'github-not-found') return { error: 'github-not-found' }
    throw err
  }
  let read: LockfileRead
  try { read = { packages: lockedPackages(format, text, { review: true }) } } catch (error) {
    read = { error: 'lockfile-unreadable', ...error instanceof Error ? { detail: error.message.slice(0, 500) } : {} }
  }
  lockfileReads.set(key, read)
  return read
}

// Runs `run` for each of `items`, as many at once as `parallel`, each's
// result in its place.
export async function eachOf<T, R>(items: T[], parallel: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, async () => {
    while (next < items.length) {
      const at = next++
      results[at] = await run(items[at]!)
    }
  }))
  return results
}

// Versions by semver, the highest first, any semver can't read after them.
function byVersion(a: string, b: string) {
  const [exactA, exactB] = [isExactVersion(a), isExactVersion(b)]
  if (exactA && exactB) return compareVersions(b, a)
  if (exactA === exactB) return a < b ? -1 : a > b ? 1 : 0
  return exactA ? -1 : 1
}
const byName = (a: AddedPackage, b: AddedPackage) => a.name < b.name ? -1 : a.name > b.name ? 1 : -byVersion(a.version ?? '', b.version ?? '')
// A package as it is installed: its name and version, where from, and its
// patch, a patched version's new where its patch is; and as it is locked,
// with what its reviews are held to too.
export const lockedAs = (pkg: LockedPackage) => `${pkg.source}\0${pkg.name}@${pkg.version ?? ''}\0${pkg.from ?? ''}\0${pkg.patchHash ?? ''}`
export const lockedWith = (pkg: LockedPackage) => `${lockedAs(pkg)}\0${pkg.integrity ?? ''}\0${pkg.shasum ?? ''}\0${pkg.lockfile ?? ''}`

// What a directory's lockfiles add, from each read before and after: the
// package versions after none before has, each once, by name and version,
// each with the versions of its name before, those past MAX_ADDED counted
// (`more`), not told but reviewed as they are; and every one after, each
// integrity it is locked with (`locked`), as many as MAX_LOCKED; or the first
// failure among them.
function addedIn(paths: string[], before: LockfileRead[], after: LockfileRead[]): DirectoryDependencies {
  const failed = [...before, ...after].find(read => 'error' in read)
  if (failed && 'error' in failed) return { paths, error: failed.error, ...failed.detail ? { detail: failed.detail } : {} }
  const known = new Set<string>()
  const versions = new Map<string, Set<string>>()
  for (const pkg of before.flatMap(read => 'packages' in read ? read.packages : [])) {
    known.add(lockedAs(pkg))
    const of = versions.get(pkg.name) ?? versions.set(pkg.name, new Set()).get(pkg.name)!
    if (pkg.version) of.add(pkg.version)
  }
  const added = new Map<string, AddedPackage>()
  const locked = new Map<string, LockedPackage>()
  for (const read of after) {
    for (const pkg of 'packages' in read ? read.packages : []) {
      const key = lockedAs(pkg)
      const held = locked.get(lockedWith(pkg))
      if (!held) locked.set(lockedWith(pkg), { ...pkg })
      else if (held.dev && !pkg.dev) delete held.dev
      if (known.has(key)) continue
      const had = added.get(key)
      const was = versions.get(pkg.name)
      if (!had) added.set(key, { ...pkg, ...was ? { was: [...was].toSorted(byVersion) } : {} })
      else if (had.dev && !pkg.dev) delete had.dev
    }
  }
  const all = [...added.values()].toSorted(byName)
  return { paths, added: all.slice(0, MAX_LOCKED), more: Math.max(0, all.length - MAX_ADDED),
    locked: [...locked.values()].slice(0, MAX_LOCKED), moreLocked: Math.max(0, locked.size - MAX_LOCKED) }
}

// What pull request `number` adds to its lockfiles' packages (PullDependencies),
// kept by its base's and head's commits, else read of GitHub and kept; none
// where it changes no lockfile read here.
export async function pullDependencies(fullName: string, token: string, number: number, kept: PullDependencyStore,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<PullDependencies> {
  const { base, head } = await pullCommits(fullName, token, number, fetchImpl)
  const key = `${base}...${head}`
  const held = await kept.read(key)
  if (held) return held
  const { mergeBase, files, cut: filesCut } = await pullFiles(fullName, token, number, base, head, fetchImpl)
  const { directories, cut, omitted } = lockfilesChanged(files)
  const reads = directories.flatMap(({ before, after }) => [...before.map(lockfile => [mergeBase, lockfile] as const), ...after.map(lockfile => [head, lockfile] as const)])
  const read = await eachOf(reads, READ_PARALLEL, ([ref, lockfile]) => readLockfile(fullName, token, ref, lockfile))
  let at = 0
  const lockfiles = directories.map(({ before, after, paths }) => {
    const readBefore = read.slice(at, at += before.length)
    return addedIn([...paths].toSorted(), readBefore, read.slice(at, at += after.length))
  })
  const told = { base: mergeBase, head, lockfiles, cut: filesCut || cut, ...cut && !filesCut && omitted.length <= MAX_OMITTED ? { omitted } : {} }
  await kept.write(key, told)
  return told
}
