// The packages a lockfile of npm's ecosystem locks, as @preventive/lockfile
// reads package-lock.json and npm-shrinkwrap.json of `lockfileVersion: 3`,
// pnpm-lock.yaml of pnpm 9 to 12 and Yarn 1's yarn.lock, each with where it
// is installed from and whether only devDependencies need it
// (repository-risk.ts).
import { LockfileError, parseNpmLockfile } from '@preventive/lockfile/npm.js'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'
import type { LockfileFormat } from '@preventive/upstream/github.js'
import type { ReviewedLockfile } from './reviewed-dependencies.ts'

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
  // As the lockfile has it: a mirror's tarball's, npm's package of its name
  // and version only where npm's integrity is among it; and, where its
  // reviews ask (`review`), npm's registry's too.
  integrity?: string
  // Where its reviews ask: the sha1 Yarn 1 writes after a tarball's `#`, in
  // hex (`shasum`); the hash of the patch pnpm applies to it
  // (`patchHash`, its patchedDependencies'), and the patch's file, where the
  // lockfile names one (`patchPath`, pnpm 9's and 10's): from the lockfile's
  // directory as read, from the repository's root once that is known
  // (patchedIn); and the lockfile's format.
  shasum?: string
  patchHash?: string
  patchPath?: string
  lockfile?: ReviewedLockfile
  // Where only the importers' devDependencies reach it, as npm's `dev` flag
  // says, and an install of no devDependencies leaves it out: in npm's and
  // pnpm's lockfiles. Yarn 1's says nothing of it, which only the
  // package.json files do, and none of its are.
  dev?: true
}

// A package as each reader resolves one, its name the one it is published
// under, and a registry tarball's URL held to its name and version.
type Resolution =
  | { type: 'tarball'; tarball: string | undefined; integrity: string | undefined; sha1?: string | undefined; gitHosted?: boolean }
  | { type: 'git'; repo: string }
  | { type: 'directory' }
interface ReadPackage { name: string; version: string | undefined; resolution: Resolution | undefined; dev?: boolean | undefined; patchHash?: string | undefined
  patchPath?: string | undefined }

// The packages of a lockfile of `format`, as its reader resolves them, a
// patched one of pnpm's with its patch's file where the lockfile names it.
// Versions go unchecked against ranges, as only what is locked is asked for.
function packagesOf(format: LockfileFormat, text: string): ReadPackage[] {
  if (format === 'npm') return Object.values(parseNpmLockfile(text, { checkVersions: false }).packages)
  if (format === 'pnpm') {
    const { lockfile, env } = parsePnpmLockfile(text)
    const files = new Map(Object.values(lockfile?.patchedDependencies ?? {}).flatMap(({ hash, path }) => path ? [[hash, path] as const] : []))
    return [...Object.values(env?.packages ?? {}), ...Object.values(lockfile?.packages ?? {})]
      .map(pkg => pkg.patchHash !== undefined && files.has(pkg.patchHash) ? { ...pkg, patchPath: files.get(pkg.patchHash) } : pkg)
  }
  if (format !== 'yarn') throw new TypeError(`lockedPackages: ${format} lockfiles are not read`)
  // Yarn 2 and later write another format, which only the text tells apart.
  if (/^__metadata:/mu.test(text)) throw new LockfileError('a yarn.lock of Yarn 2 or later, which is not read')
  // Yarn 1 names an alias, `my-q@npm:q@^1.5.1`, by its own name.
  return Object.values(parseYarn1Lockfile(text, { checkVersions: false }).packages)
    .map(pkg => ({ ...pkg, name: /@npm:((?:@[^/@]+\/)?[^/@]+)/u.exec(pkg.patterns[0] ?? '')?.[1] ?? pkg.name }))
}

// npm's registry, by either of its names, and yarn's mirror of it, as
// @preventive/lockfile holds their tarballs to a package's name and version:
// its link to one, as it names it, a hash after it alone (Yarn 1's sha1).
const REGISTRY_HOSTS = new Set(['registry.npmjs.org', 'registry.npmjs.com', 'registry.yarnpkg.com'])
const isRegistry = (url: URL) => url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search
  && REGISTRY_HOSTS.has(url.hostname.replace(/\.+$/u, ''))
// Where a URL is, as it may be shown: its credentials, query and fragment
// left out.
const shown = (url: URL | null) => url ? { from: `${url.protocol}//${url.host}${url.pathname}` } : {}

// Where a package read comes from (LockedPackage), with npm's registry's
// integrity where `review`; null for one a package bundles, with no
// resolution, or one of the project's own directories.
function located({ name, version, resolution }: ReadPackage, review: boolean): LockedPackage | null {
  const at = { name, version: version ?? null }
  if (resolution === undefined || resolution.type === 'directory') return null
  if (resolution.type === 'git') return { ...at, source: 'git', ...shown(URL.parse(resolution.repo)) }
  const { tarball, integrity } = resolution
  if (resolution.gitHosted) return { ...at, source: 'git', ...shown(URL.parse(tarball ?? '')) }
  const registry = { ...at, source: 'registry' as const, ...review && integrity ? { integrity } : {} }
  if (tarball === undefined) return registry
  if (tarball.startsWith('file:')) return { ...at, source: 'file' }
  const url = URL.parse(tarball)
  if (url && isRegistry(url)) return registry
  return integrity ? { ...at, ...shown(url), source: 'mirror', integrity } : { ...at, ...shown(url), source: 'tarball' }
}
// As above, and with what its reviews ask (LockedPackage `shasum`,
// `patchHash`, `patchPath`, `lockfile`) where `review`.
function locked(pkg: ReadPackage, format: LockfileFormat, review: boolean): LockedPackage | null {
  const one = located(pkg, review)
  if (!one || !review) return one
  const sha1 = pkg.resolution?.type === 'tarball' ? pkg.resolution.sha1 : undefined
  return { ...one, ...sha1 ? { shasum: sha1 } : {}, ...pkg.patchHash ? { patchHash: pkg.patchHash, ...pkg.patchPath ? { patchPath: pkg.patchPath } : {} } : {},
    lockfile: format === 'yarn' ? 'yarn1' : format as ReviewedLockfile }
}

// The packages a lockfile of `format` (npm, pnpm or yarn, as
// findRepoLockfiles names them) locks, each once, in the lockfile's order:
// `dev` only where it is wherever it is installed, at each path of npm's
// tree, and with each of pnpm's peers; with `review`, each with what its
// reviews hold it to (LockedPackage `integrity`, `shasum`, `patchHash`),
// each patch of it apart. Throws the reader's LockfileError or YamlError for
// one it refuses.
export function lockedPackages(format: LockfileFormat, text: string, { review = false } = {}): LockedPackage[] {
  const found = new Map<string, LockedPackage>()
  for (const pkg of packagesOf(format, text)) {
    const one = locked(pkg, format, review)
    if (!one) continue
    if (pkg.dev === true) one.dev = true
    const key = `${one.source}\0${one.name}@${one.version ?? ''}\0${one.from ?? ''}\0${one.integrity ?? ''}\0${one.shasum ?? ''}\0${one.patchHash ?? ''}`
    const had = found.get(key)
    if (!had) found.set(key, one)
    else if (had.dev && !one.dev) delete had.dev
  }
  return [...found.values()]
}

// `pkg` as a lockfile at `path` locks it, read with its patch's file from
// the lockfile's directory (LockedPackage `patchPath`): that file from the
// repository's root, none where it names one outside it.
export function patchedIn<T extends LockedPackage>(path: string, pkg: T): T {
  if (pkg.patchPath === undefined) return pkg
  const { patchPath, ...rest } = pkg
  const parts = path.split('/').slice(0, -1)
  for (const part of patchPath.split('/')) {
    if (part === '..') { if (parts.pop() === undefined) return rest as T }
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.length > 0 ? { ...rest, patchPath: parts.join('/') } as T : rest as T
}

// Whether a lockfile at `path` is a test's fixture or example: under a
// directory of tests (`test`, `tests`, `__tests__` and such), in one of
// fixtures or examples (`fixture`, `fixtures`, `example`, `examples`) inside
// it, as a test may keep one its readers refuse on purpose.
const FIXTURES_DIR = /^(?:fixture|example)s?$/u, TESTS_DIR = /^_*tests?_*$/u
export function isTestFixture(path: string) {
  const dirs = path.split('/').slice(0, -1)
  const tests = dirs.findIndex(dir => TESTS_DIR.test(dir))
  return tests !== -1 && dirs.slice(tests + 1).some(dir => FIXTURES_DIR.test(dir))
}
