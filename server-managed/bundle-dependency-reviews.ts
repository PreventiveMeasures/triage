// What a bundle's npm dependencies want of review, in a repository that
// reviews dependencies (repository-dependency-reviews.ts), as its Overview
// tells it: the package versions it bundles (bundle-advisory-inventory.ts),
// each as the lockfiles that install it lock it at the commit it was built
// from, whence their integrities, sources and patches, which reviews are held
// to (pull-dependency-reviews.ts), judged as the other versions a pull
// request's lockfiles lock are: by reviews of them whole or compared with any
// version of their package, else passed by the commit it is reviewed since
// or the host's reviewed dependencies.
//
// Its lockfiles are those its review holds to (lockfile-scope.ts) in its
// directory or a directory above it, as an install of it reads one there, a
// workspace's at its root; each version as the nearest of their directories
// that locks it locks it, every integrity and patch it locks it with. One no
// lockfile there locks (`unlocked`) can't be reviewed, as there is nothing to
// hold its reviews to: it fails the review, as one that can't be reviewed
// does. Where its review holds to none of the lockfiles there, but there are
// some, its dependencies aren't reviewed (`reviewedIn`).
import { type CommitLockfiles, lockedIn } from './commit-lockfiles.ts'
import type { LockedPackage } from './locked-packages.ts'
import { MAX_LOCKED, type PullDependencies, lockedWith, lockfileFormat } from './pull-dependencies.ts'
import { MAX_UNREVIEWED } from './pull-dependency-reviews.ts'

// A version a bundle holds: its package's name and its version.
export interface BundledVersion { name: string; version: string }

// The directory a lockfile at `path` is in, '' for the repository's root.
const directoryOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
// A bundle's directory as one is compared: without the slashes either end.
const bundleDirectory = (directory: string) => directory.replaceAll(/^\/+|\/+$/gu, '')
const depth = (dir: string) => dir === '' ? 0 : dir.split('/').length

// Whether the lockfile at `path` may install the bundle in `directory`: one
// in it, or in a directory above it.
export function installsBundle(path: string, directory: string): boolean {
  const at = bundleDirectory(directory), dir = directoryOf(path)
  return dir === '' || at === dir || at.startsWith(`${dir}/`)
}

// The versions `bundled` as `read`'s lockfiles (those installing the bundle,
// read at `commit`) lock them, as one directory of a pull request's
// lockfiles (pull-dependencies.ts) whose versions it adds none of, each as
// the nearest of their directories locking it locks it, those past
// MAX_LOCKED counted (`moreLocked`), and each lockfile left unread a
// directory of its own failing the review; with those none lock
// (`unlocked`, as many as MAX_UNREVIEWED, how many more `moreUnlocked`) and
// how many versions it bundles (`versions`), each once.
export function bundleDependencies(bundled: BundledVersion[], read: CommitLockfiles, commit: string) {
  const versions = [...new Map(bundled.map(one => [`${one.name}@${one.version}`, one])).values()]
  const byDirectory = new Map<string, string[]>()
  for (const { path } of read.lockfiles) byDirectory.set(directoryOf(path), [...byDirectory.get(directoryOf(path)) ?? [], path])
  // Each directory's versions by their name and version, the nearest first.
  const nearest = [...byDirectory].toSorted(([a], [b]) => depth(b) - depth(a)).map(([dir, paths]) => {
    const locked = new Map<string, LockedPackage[]>()
    for (const pkg of lockedIn(read, path => directoryOf(path) === dir).packages) {
      const key = `${pkg.name}@${pkg.version ?? ''}`
      locked.set(key, [...locked.get(key) ?? [], pkg])
    }
    return { paths, locked }
  })
  const found = new Map<string, LockedPackage>()
  const unlocked: BundledVersion[] = []
  for (const one of versions) {
    const variants = nearest.find(({ locked }) => locked.has(`${one.name}@${one.version}`))?.locked.get(`${one.name}@${one.version}`)
    if (!variants) { unlocked.push(one); continue }
    for (const pkg of variants) if (!found.has(lockedWith(pkg))) found.set(lockedWith(pkg), pkg)
  }
  const locked = [...found.values()]
  const told: PullDependencies = { base: commit, head: commit, cut: false, lockfiles: [
    { paths: nearest.flatMap(({ paths }) => paths), added: [], more: 0, locked: locked.slice(0, MAX_LOCKED), moreLocked: Math.max(0, locked.length - MAX_LOCKED) },
    ...read.unread.map(path => ({ paths: [path], error: lockfileFormat(path) === 'bun' ? 'lockfile-unsupported' : 'lockfile-unreadable' })),
  ] }
  return { told, versions: versions.length, unlocked: unlocked.slice(0, MAX_UNREVIEWED), moreUnlocked: Math.max(0, unlocked.length - MAX_UNREVIEWED) }
}
