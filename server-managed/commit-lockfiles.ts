// The versions a repository's lockfiles of npm's ecosystem lock at a commit,
// as their review reads them (pull-dependency-reviews.ts): every lockfile
// there (findRepoLockfiles) a review holds to (`held`, lockfile-scope.ts),
// read as a pull request's are (pull-dependencies.ts readLockfile), but kept
// by its blob, in this instance and beyond it (`kept`), as many as
// MAX_LOCKFILES of those, each's versions (`lockfiles`), and those its reader
// refuses, of Bun's, or past MAX_LOCKFILES (`unread`), as many read at once
// as READ_AT_ONCE; and those of some of them (lockedIn), each version once by
// what its reviews are held to (lockedWith), dev only where it is wherever it
// is locked. GitHub having none of a lockfile it lists there fails the
// whole, as it would for any file.
import { createClient } from '@preventive/upstream/github.js'
import { upstreamGithub } from './github-errors.ts'
import { GithubApiError } from './github-app.ts'
import { type LockedPackage, patchedIn } from './locked-packages.ts'
import { type Lru, lru } from './lru.ts'
import { type GithubAsked, type ListedLockfile, type LockfileStore, eachOf, lockedWith, lockfileFormat, readLockfile } from './pull-dependencies.ts'

export const MAX_LOCKFILES = 100
const READ_AT_ONCE = 4

export interface CommitLockfiles { lockfiles: { path: string; packages: LockedPackage[] }[]; unread: string[] }

// The lockfiles at commit `sha` its review reads, by their paths, each with
// its format (pull-dependencies.ts lockfileFormat) and its blob's id, kept by
// the commit, in this instance and beyond it (`kept`); `asked` told where
// GitHub was.
const listings: Lru<ListedLockfile[]> = lru(20_000, listed => listed.length + 1)
export async function lockfilesAt(fullName: string, token: string, sha: string, kept: LockfileStore | null, asked?: GithubAsked) {
  const key = `${fullName}\0${sha}`
  const known = listings.get(key)
  if (known) return known
  const stored = await kept?.listings.read(sha)
  if (stored) { listings.set(key, stored); return stored }
  if (asked) asked.github = true
  const { lockfiles } = await upstreamGithub(() => createClient({ token, userAgent: 'deepview-triage' }).findRepoLockfiles({ repo: fullName, sha }))
  const listed = lockfiles.flatMap(({ path, sha: blob }) => { const format = lockfileFormat(path); return format ? [{ path, format, sha: blob }] : [] })
  listings.set(key, listed)
  await kept?.listings.write(sha, listed)
  return listed
}

export async function lockedAt(fullName: string, token: string, sha: string, kept: LockfileStore | null, held: (path: string) => boolean = () => true,
  asked?: GithubAsked): Promise<CommitLockfiles> {
  const listed = (await lockfilesAt(fullName, token, sha, kept, asked)).filter(({ path }) => held(path))
  const unread = listed.slice(MAX_LOCKFILES).map(({ path }) => path)
  const lockfiles: CommitLockfiles['lockfiles'] = []
  const reading = listed.slice(0, MAX_LOCKFILES)
  const reads = await eachOf(reading, READ_AT_ONCE, lockfile => readLockfile(fullName, token, sha, lockfile, kept, asked))
  for (const [at, lockfile] of reading.entries()) {
    const read = reads[at]!
    if ('error' in read && read.error === 'github-not-found') throw new GithubApiError(404, 'github-not-found')
    if ('error' in read) unread.push(lockfile.path)
    else lockfiles.push({ path: lockfile.path, packages: read.packages })
  }
  return { lockfiles, unread: unread.toSorted() }
}

// The versions those of `read`'s lockfiles `held` holds to lock, each once,
// each patch's file from the repository's root (patchedIn), the first of
// them that names one there, and their paths.
export function lockedIn(read: CommitLockfiles, held: (path: string) => boolean = () => true) {
  const packages = new Map<string, LockedPackage>()
  const paths: string[] = []
  for (const lockfile of read.lockfiles.filter(({ path }) => held(path))) {
    paths.push(lockfile.path)
    for (const pkg of lockfile.packages) {
      const found = patchedIn(lockfile.path, { ...pkg })
      const kept = packages.get(lockedWith(pkg))
      if (!kept) { packages.set(lockedWith(pkg), found); continue }
      if (kept.dev && !pkg.dev) delete kept.dev
      if (kept.patchPath === undefined && found.patchPath !== undefined) kept.patchPath = found.patchPath
    }
  }
  return { packages: [...packages.values()], paths }
}
