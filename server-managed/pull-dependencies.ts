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
// bot's do, read their base's once. One read as a commit lists it, with its
// blob's id (commit-lockfiles.ts), is kept by its blob instead, and beyond
// this instance where its reader keeps it (LockfileStore): what a blob holds
// never changes either, and a push changing no lockfile changes none.
import { createClient } from '@preventive/upstream/github.js'
import { GithubApiError, upstreamGithub } from './github-errors.ts'
import { USER_AGENT, githubJson, repoApi } from './github-requests.ts'
import { branchName } from './bundle-build.ts'
import { SHA } from './github-values.ts'
import { compareVersions, isExactVersion } from '@preventive/upstream/semver.js'
import { type LockedPackage, isTestFixture, lockedPackages, patchedIn } from './locked-packages.ts'
import { isStasisConfig } from './lockfile-scope.ts'
import { type Lru, lru } from './lru.ts'
import { eachOf } from './queue.ts'
import { type ChangedFile, commitChanges } from './repository-changes.ts'

// The files of a pull request read from its own list past those compared,
// FILES_PAGE a page, as many as GitHub lists (3,000).
const FILES_PAGE = 100
const PULL_FILES = 3000
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
// pullDependencyKept), and the lockfiles read for it (lockfileKept): one
// told or read by others is told or read again, as those read before pnpm's
// patches' files were, and those told before their lockfiles' directories,
// or read with the files of patches pnpm 9 names by an md5.
export const PULL_DEPENDENCIES_READ = 6

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

// Whether a pull request changing `paths` changes a lockfile read here, or
// a stasis.config.json, which a review may hold to: null where none of them
// is one but they are fewer than it changes (`changed`), which it may yet.
export function touchesLockfile(paths: string[], changed: number): boolean | null {
  if (paths.some(path => lockfileFormat(path) !== null || isStasisConfig(path))) return true
  return changed > paths.length ? null : false
}

// A package version new to a directory, as its lockfile locks it, with its
// integrity, which its reviews are held to; of a package its lockfiles locked
// before, the versions of it they did (`was`, the highest first), none of one
// new to it; and the version the host names to review it against (`base`).
export type AddedPackage = LockedPackage & { was?: string[]; base?: { name: string; version: string } }
// A directory's lockfiles the pull request changes (`paths`, those it adds,
// modifies, removes or renames, by either name): the package versions they
// lock new to it, by name and version (as many as MAX_LOCKED, told as many
// as MAX_ADDED, `more` past them), and all they lock (`locked`, as many as MAX_LOCKED, how many more
// `moreLocked`); or why they couldn't be told, a lockfile's reader refusing one
// (`lockfile-unreadable`, with what it said), one of a format not read
// (`lockfile-unsupported`, Bun's) or GitHub having none at a commit compared.
// A stasis.config.json a review holds to is told as one too, by its own path
// (stasis-dependencies.ts stasisDirectory), or as `stasis-pending` or `stasis-failed`.
export type DirectoryDependencies = { paths: string[]; builds?: StasisBuild[] } & ({ added: AddedPackage[]; more: number; locked: LockedPackage[]; moreLocked: number }
  | { error: string; detail?: string })
// A Stasis build a stasis.config.json's directory reads (stasis-dependencies.ts
// stasisDirectory): of the commit, and whether it is made, or failed, as kept.
export interface StasisBuild { commit: string; built: boolean }
// What a pull request's lockfiles add: the commits compared (`base`, its
// merge base, and `head`); each directory's, of those it changes a lockfile
// in; and `cut` where it changes more files than GitHub lists, or lockfiles
// in more directories than are read, with, where only those cut it and they
// are few enough, the paths of those directories' lockfiles (`omitted`), for
// a review holding to none of them to fail in nothing; and whether it was
// read without its merge base (`baseless`), every version new to it.
export interface PullDependencies { base: string; head: string; lockfiles: DirectoryDependencies[]; cut: boolean; omitted?: string[]; baseless?: true }
const MAX_OMITTED = 1000

// What is told of a pull request, by the commits it is of, `${base}...${head}`,
// read without its merge base apart (pullKey).
export const pullKey = (commits: string, baseless: boolean) => baseless ? `${commits}\0baseless` : commits
export interface PullDependencyStore {
  read(key: string): Promise<PullDependencies | null>
  write(key: string, value: PullDependencies): Promise<void>
}

// A lockfile's packages, or why its reader refused it, by its repository and
// readKey, read in this instance; by the packages each holds, as the scan's
// are (repository-risk.ts riskCaches).
export type LockfileRead = { packages: LockedPackage[] } | { error: string; detail?: string }
const lockfileReads: Lru<LockfileRead> = lru(200_000, read => 'packages' in read ? read.packages.length + 1 : 1)
// Those being read, by the token reading them too, lest each asking at once
// read them, with whether GitHub was asked.
const lockfilesReading = new Map<string, Promise<{ read: LockfileRead; github: boolean }>>()
// A lockfile at a commit as findRepoLockfiles lists it, by its path, with its
// format (lockfileFormat) and its blob's id (`sha`).
export interface ListedLockfile { path: string; format: Format; sha: string }
// What a repository's lockfiles read for its dependency review keep beyond
// this instance (http.ts lockfileKept), by what never changes: a commit's
// lockfiles as listed (`listings`, by the commit), and a lockfile's read
// (`lockfiles`, by its readKey). A read GitHub failed is kept nowhere.
export interface LockfileStore {
  listings: { read(commit: string): Promise<ListedLockfile[] | null>; write(commit: string, listed: ListedLockfile[]): Promise<void> }
  lockfiles: { read(key: string): Promise<LockfileRead | null>; write(key: string, read: LockfileRead): Promise<void> }
}
// Set where GitHub was asked for what a read reads (`github`), not all of it
// held in this instance or kept beyond it.
export interface GithubAsked { github: boolean }

// A lockfile's read, by its blob where it is listed with its id (`sha`),
// which with its format alone tell how it reads; else by the commit and its
// path.
const readKey = (ref: string, { path, format, sha }: { path: string; format: Format; sha?: string }) =>
  sha ? `blob\0${format}\0${sha}` : `commit\0${ref}\0${path}`

// The pull request's base's and head's commits, as GitHub has them now: its
// base's moving on as it does, its head's with each push, both kept once it
// is merged or closed. With the branches they are of, where told: its base's
// (`baseRef`), whose history holds its merge base, and its head's
// (`headRef`) where that is the repository's own, not a fork's; and that an
// open one's head is a fork's (`fork`), a commit of none of the repository's
// branches till it is merged, which Stasis builds nothing of.
export interface PullRefs { baseRef?: string; headRef?: string; fork?: true }
export interface PullCommits extends PullRefs { base: string; head: string }
// Those of `base` and `head` that are a branch's name, and `fork` where it is told.
export const pullRefs = (base: unknown, head: unknown, fork?: unknown): PullRefs =>
  ({ ...branchName(base) ? { baseRef: base } : {}, ...branchName(head) ? { headRef: head } : {}, ...fork === true ? { fork } : {} })
async function pullCommits(fullName: string, token: string, number: number, fetchImpl: typeof fetch): Promise<PullCommits> {
  const pull = await githubJson(`${repoApi(fullName)}/pulls/${number}`, token, fetchImpl) as
    { number?: unknown; state?: unknown; base?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } | null }
      head?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } | null } } | null
  const base = pull?.base?.sha, head = pull?.head?.sha, repo = pull?.base?.repo?.full_name
  if (pull?.number !== number || typeof base !== 'string' || !SHA.test(base) || typeof head !== 'string' || !SHA.test(head)
    || typeof repo !== 'string' || repo.toLowerCase() !== fullName.toLowerCase()) throw new GithubApiError(502, 'github-malformed')
  const from = pull.head?.repo?.full_name
  const own = typeof from === 'string' && from.toLowerCase() === repo.toLowerCase()
  return { base, head, ...pullRefs(pull.base?.ref, own ? pull.head?.ref : undefined, pull.state === 'open' && !own) }
}

// The pull request's merge base and the files it changes from it: as GitHub
// compares its base with its head, else, where that lists as many as it lists
// at most, from the pull request's own list, a page at a time; `cut` where
// that lists as many as it lists at most, too. That list is of its commits
// now: null where they are no longer `base` and `head` (`current`).
async function pullFiles(fullName: string, token: string, number: number, base: string, head: string, fetchImpl: typeof fetch,
  current: () => Promise<boolean>) {
  const compared = await githubJson(`${repoApi(fullName)}/compare/${base}...${head}?per_page=1`, token, fetchImpl) as { merge_base_commit?: { sha?: unknown } } | null
  const mergeBase = compared?.merge_base_commit?.sha
  if (typeof mergeBase !== 'string' || !SHA.test(mergeBase)) throw new GithubApiError(502, 'github-malformed')
  const { files, more } = commitChanges(compared)
  if (!more) return { mergeBase, files, cut: false }
  if (!await current()) return null
  const listed: ChangedFile[] = []
  for (let page = 1; listed.length < PULL_FILES; page++) {
    const data = await githubJson(`${repoApi(fullName)}/pulls/${number}/files?per_page=${FILES_PAGE}&page=${page}`, token, fetchImpl)
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

// The text of the file at `path` of repository `fullName` at `ref`; null
// where GitHub has none there.
export async function repositoryFile(fullName: string, token: string, path: string, ref: string): Promise<string | null> {
  try { return await upstreamGithub(() => createClient({ token, userAgent: USER_AGENT }).getRepoFile({ repo: fullName, path, ref })) } catch (err) {
    if (err instanceof GithubApiError && err.message === 'github-not-found') return null
    throw err
  }
}

// A lockfile's packages at `ref`, as read in this instance, else as kept
// beyond it (`kept`), else shared with a read of it with the same token still
// under way, else of GitHub, and kept; a lockfile its reader refuses, why,
// kept as well, its reader refusing it again; `asked` told where GitHub was.
// Any failure to read it of GitHub but its having none there is the whole
// answer's, as it would be every file's; neither is kept.
export async function readLockfile(fullName: string, token: string, ref: string, lockfile: { path: string; format: Format; sha?: string },
  kept: LockfileStore | null = null, asked?: GithubAsked): Promise<LockfileRead> {
  if (lockfile.format === 'bun') return { error: 'lockfile-unsupported' }
  const key = readKey(ref, lockfile)
  const known = lockfileReads.get(`${fullName}\0${key}`)
  if (known) return known
  const shared = `${token}\0${fullName}\0${key}`
  const reading = lockfilesReading.get(shared) ?? readOf(fullName, token, ref, lockfile, key, kept).finally(() => lockfilesReading.delete(shared))
  lockfilesReading.set(shared, reading)
  // One failing was asked of GitHub too, though a caller swallows its
  // failure, as a baseline's does: its access is asked again all the same.
  let told
  try { told = await reading } catch (err) {
    if (asked) asked.github = true
    throw err
  }
  if (told.github && asked) asked.github = true
  return told.read
}
async function readOf(fullName: string, token: string, ref: string, { path, format }: { path: string; format: Format }, key: string,
  kept: LockfileStore | null): Promise<{ read: LockfileRead; github: boolean }> {
  const stored = await kept?.lockfiles.read(key)
  if (stored) { lockfileReads.set(`${fullName}\0${key}`, stored); return { read: stored, github: false } }
  const text = await repositoryFile(fullName, token, path, ref)
  if (text === null) return { read: { error: 'github-not-found' }, github: true }
  let read: LockfileRead
  try { read = { packages: lockedPackages(format, text, { review: true }) } } catch (error) {
    read = { error: 'lockfile-unreadable', ...error instanceof Error ? { detail: error.message.slice(0, 500) } : {} }
  }
  lockfileReads.set(`${fullName}\0${key}`, read)
  await kept?.lockfiles.write(key, read)
  return { read, github: true }
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

// What a directory's lockfiles add, from each read before and after
// (addedBetween), each patch's file from the repository's root, and its
// lockfile's directory (patchedIn); or the first failure among them.
function addedIn(paths: string[], before: LockfileRead[], after: LockfileRead[]): DirectoryDependencies {
  const failed = [...before, ...after].find(read => 'error' in read)
  if (failed) return { paths, error: failed.error, ...failed.detail ? { detail: failed.detail } : {} }
  const packages = (reads: LockfileRead[]) => reads.flatMap(read => 'packages' in read ? read.packages : [])
  return addedBetween(paths, packages(before), packages(after).map(pkg => patchedIn(paths[0]!, pkg)))
}

// What the versions locked `after` add to those locked `before`, as a
// directory's lockfiles' at `paths`: the package versions after none before
// has, each once, by name and version, each with the versions of its name
// before, those past MAX_ADDED counted (`more`), not told but reviewed as
// they are; and every one after, each integrity it is locked with
// (`locked`), as many as MAX_LOCKED.
export function addedBetween(paths: string[], before: LockedPackage[], after: LockedPackage[]): DirectoryDependencies {
  const known = new Set<string>()
  const versions = new Map<string, Set<string>>()
  for (const pkg of before) {
    known.add(lockedAs(pkg))
    const of = versions.get(pkg.name) ?? versions.set(pkg.name, new Set()).get(pkg.name)!
    if (pkg.version) of.add(pkg.version)
  }
  const added = new Map<string, AddedPackage>()
  const locked = new Map<string, LockedPackage>()
  for (const pkg of after) {
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
  const all = [...added.values()].toSorted(byName)
  return { paths, added: all.slice(0, MAX_LOCKED), more: Math.max(0, all.length - MAX_ADDED),
    locked: [...locked.values()].slice(0, MAX_LOCKED), moreLocked: Math.max(0, locked.size - MAX_LOCKED) }
}

// What pull request `number` adds to its lockfiles' packages (PullDependencies),
// kept by its base's and head's commits, else read of GitHub and kept; none
// where it changes no lockfile read here.
export async function pullDependencies(fullName: string, token: string, number: number, kept: PullDependencyStore,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<PullDependencies> {
  return (await pullDependenciesAt(fullName, token, number, kept, fetchImpl)).told
}
// The same, with the commits it is kept by (`commits`), its base's and
// head's, by which `kept` reads it (pullKey): those `given`, as a page of its
// repository's open pull requests read them (repository-issues.ts), else as
// GitHub has them now; and the branches they are of, where told (PullRefs).
// Commits given that its own list of its files is no longer of are read as
// GitHub has them now. One into branch `baselessInto` is read without its
// merge base's lockfiles (`baseless`).
export async function pullDependenciesAt(fullName: string, token: string, number: number, kept: PullDependencyStore,
  fetchImpl: typeof fetch = globalThis.fetch, given?: PullCommits, baselessInto: string | null = null): Promise<PullRefs & { commits: string; told: PullDependencies }> {
  const { base, head, ...refs } = given ?? await pullCommits(fullName, token, number, fetchImpl)
  const baseless = baselessInto !== null && refs.baseRef === baselessInto, commits = `${base}...${head}`, key = pullKey(commits, baseless)
  const held = await kept.read(key)
  if (held) return { ...refs, commits, told: held }
  const current = async () => {
    const now = given && await pullCommits(fullName, token, number, fetchImpl)
    return !now || (now.base === base && now.head === head)
  }
  const pulled = await pullFiles(fullName, token, number, base, head, fetchImpl, current)
  if (!pulled) return pullDependenciesAt(fullName, token, number, kept, fetchImpl, undefined, baselessInto)
  const { mergeBase, files, cut: filesCut } = pulled
  const { directories, cut, omitted } = lockfilesChanged(files)
  const reads = directories.flatMap(({ before, after }) => [...baseless ? [] : before.map(lockfile => [mergeBase, lockfile] as const),
    ...after.map(lockfile => [head, lockfile] as const)])
  const read = await eachOf(reads, READ_PARALLEL, ([ref, lockfile]) => readLockfile(fullName, token, ref, lockfile))
  let at = 0
  const lockfiles = directories.map(({ before, after, paths }) => {
    const readBefore = baseless ? [] : read.slice(at, at += before.length)
    return addedIn([...paths].toSorted(), readBefore, read.slice(at, at += after.length))
  })
  const told = { base: mergeBase, head, lockfiles, cut: filesCut || cut, ...cut && !filesCut && omitted.length <= MAX_OMITTED ? { omitted } : {},
    ...baseless ? { baseless: true as const } : {} }
  await kept.write(key, told)
  return { ...refs, commits, told }
}
