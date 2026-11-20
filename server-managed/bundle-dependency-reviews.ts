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
import { MAX_UNREVIEWED, hashesOf } from './pull-dependency-reviews.ts'

// A version a bundle holds: its package's name and its version; and, as a
// Stasis lockfile tells one (stasis-dependencies.ts), how it was installed:
// its tarball's integrity, and pnpm's hash of the patch applied to it.
export interface BundledVersion { name: string; version: string; integrity?: string; patch?: string }

// The directory a file at `path` is in, '' for the repository's root.
export const directoryOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
// A bundle's directory as one is compared: without the slashes either end.
const bundleDirectory = (directory: string) => directory.replaceAll(/^\/+|\/+$/gu, '')
const depth = (dir: string) => dir === '' ? 0 : dir.split('/').length

// Whether the lockfile at `path` may install the bundle in `directory`: one
// in it, or in a directory above it.
export function installsBundle(path: string, directory: string): boolean {
  const at = bundleDirectory(directory), dir = directoryOf(path)
  return dir === '' || at === dir || at.startsWith(`${dir}/`)
}

// Whether `pkg` is locked as `one` was installed, where it tells how: with
// its tarball's integrity among its own, and its patch, or none.
const lockedAsInstalled = (one: BundledVersion, pkg: LockedPackage) => one.integrity !== undefined
  && hashesOf(pkg).includes(one.integrity) && (pkg.patchHash ?? '') === (one.patch ?? '')

// The versions `bundled` as `read`'s lockfiles lock them (`locked`), each as
// the nearest of their directories locking it locks it; one told with how it
// was installed, as the nearest locking it so does, where one does. With
// those none lock (`unlocked`), how many versions there are (`versions`),
// and the lockfiles' paths, the nearest first.
export function lockedVersions(bundled: BundledVersion[], read: CommitLockfiles) {
  const byDirectory = Map.groupBy(read.lockfiles.map(({ path }) => path), directoryOf)
  // Each directory's versions by their name and version, the nearest first.
  const nearest = [...byDirectory].toSorted(([a], [b]) => depth(b) - depth(a)).map(([dir, paths]) =>
    ({ paths, locked: Map.groupBy(lockedIn(read, path => directoryOf(path) === dir).packages, pkg => `${pkg.name}@${pkg.version ?? ''}`) }))
  const found = new Map<string, LockedPackage>()
  const unlocked = new Map<string, BundledVersion>()
  for (const one of bundled) {
    const key = `${one.name}@${one.version}`
    const locking = nearest.flatMap(({ locked }) => locked.has(key) ? [locked.get(key)!] : [])
    const variants = locking.map(locks => locks.filter(pkg => lockedAsInstalled(one, pkg))).find(locks => locks.length > 0) ?? locking[0]
    if (!variants) { unlocked.set(key, { name: one.name, version: one.version }); continue }
    for (const pkg of variants) if (!found.has(lockedWith(pkg))) found.set(lockedWith(pkg), pkg)
  }
  return { locked: [...found.values()], unlocked: [...unlocked.values()], versions: new Set(bundled.map(one => `${one.name}@${one.version}`)).size,
    paths: nearest.flatMap(({ paths }) => paths) }
}

// The versions `bundled` as `read`'s lockfiles (those installing the bundle,
// read at `commit`) lock them (lockedVersions), as one directory of a pull
// request's lockfiles (pull-dependencies.ts) whose versions it adds none of,
// those past MAX_LOCKED counted (`moreLocked`), and each lockfile left
// unread a directory of its own failing the review; with those none lock
// (`unlocked`, as many as MAX_UNREVIEWED, how many more `moreUnlocked`) and
// how many versions it bundles (`versions`), each once.
export function bundleDependencies(bundled: BundledVersion[], read: CommitLockfiles, commit: string) {
  const { locked, unlocked, versions, paths } = lockedVersions(bundled, read)
  const told: PullDependencies = { base: commit, head: commit, cut: false, lockfiles: [
    { paths, added: [], more: 0, locked: locked.slice(0, MAX_LOCKED), moreLocked: Math.max(0, locked.length - MAX_LOCKED) },
    ...read.unread.map(path => ({ paths: [path], error: lockfileFormat(path) === 'bun' ? 'lockfile-unsupported' : 'lockfile-unreadable' })),
  ] }
  return { told, versions, unlocked: unlocked.slice(0, MAX_UNREVIEWED), moreUnlocked: Math.max(0, unlocked.length - MAX_UNREVIEWED) }
}
