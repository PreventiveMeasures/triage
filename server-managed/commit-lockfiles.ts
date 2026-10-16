// The versions a repository's lockfiles of npm's ecosystem lock at a commit,
// as their review reads them (pull-dependency-reviews.ts): every lockfile
// there (findRepoLockfiles) read as a pull request's are (pull-dependencies.ts
// readLockfile), as many as MAX_LOCKFILES, each version once by what its
// reviews are held to (lockedWith), dev only where it is wherever it is
// locked; with the lockfiles read (`paths`), and those its reader refuses,
// of Bun's, or past MAX_LOCKFILES (`unread`). GitHub having none of a
// lockfile it lists there fails the whole, as it would for any file. What a
// commit holds never changes: kept in this instance by it.
import { createClient } from '@preventive/upstream/github.js'
import { upstreamGithub } from './github-errors.ts'
import { GithubApiError } from './github-app.ts'
import type { LockedPackage } from './locked-packages.ts'
import { type Lru, lru } from './lru.ts'
import { lockedWith, lockfileFormat, readLockfile } from './pull-dependencies.ts'

export const MAX_LOCKFILES = 100

export interface CommitLockfiles { packages: LockedPackage[]; paths: string[]; unread: string[] }
const commits: Lru<CommitLockfiles> = lru(200_000, read => read.packages.length + read.paths.length + 1)

export async function lockedAt(fullName: string, token: string, sha: string): Promise<CommitLockfiles> {
  const key = `${fullName}\0${sha}`
  const known = commits.get(key)
  if (known) return known
  const { lockfiles } = await upstreamGithub(() => createClient({ token, userAgent: 'deepview-triage' }).findRepoLockfiles({ repo: fullName, sha }))
  const listed = lockfiles.flatMap(({ path }) => { const format = lockfileFormat(path); return format ? [{ path, format }] : [] })
  const unread = listed.slice(MAX_LOCKFILES).map(({ path }) => path)
  const packages = new Map<string, LockedPackage>()
  const paths: string[] = []
  for (const lockfile of listed.slice(0, MAX_LOCKFILES)) {
    const read = await readLockfile(fullName, token, sha, lockfile)
    if ('error' in read && read.error === 'github-not-found') throw new GithubApiError(404, 'github-not-found')
    if ('error' in read) { unread.push(lockfile.path); continue }
    paths.push(lockfile.path)
    for (const pkg of read.packages) {
      const held = packages.get(lockedWith(pkg))
      if (!held) packages.set(lockedWith(pkg), { ...pkg })
      else if (held.dev && !pkg.dev) delete held.dev
    }
  }
  const read = { packages: [...packages.values()], paths, unread: unread.toSorted() }
  commits.set(key, read)
  return read
}
