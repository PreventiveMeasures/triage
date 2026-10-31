// Whether a Stasis bundle holds what it says it does (GET and POST
// /api/bundles/:id/validation): every file of its own code as GitHub has it
// at the commit its stamp names, and every file of each dependency as its
// published package has it, fetched with upstream (npm's registry, crates.io),
// which holds the tarball to its integrity; those two covering every file it
// holds. A dependency's files it leaves out are expected, as a bundle holds
// those its code reaches alone.
//
// Own code is the files of the bundle's modules that name no ecosystem (its
// own, and its workspace's packages), at their paths under the directory the
// bundle was built in. Each is held to the blob GitHub lists at its path in
// the commit's tree, by git's id of its bytes; one with its LFs as CRLFs, as
// a checkout may write it, is told apart (`eol`) but passes. The tree is read
// a directory at a time only where its listing whole is cut short, and only
// into the directories the bundle has files in (commitBlobs).
//
// A dependency's version is fetched once, its tarball unpacked as npm unpacks
// it, and each file the bundle holds of it held to the file at its path
// there. A version pnpm patches (its lockfile's `patchedDependencies`) is held
// to its files patched, as pnpm patches them as it installs them
// (npm-patch.ts): the patch the lockfiles installing the bundle at its commit
// lock it with (bundle-dependency-reviews.ts), read of the bundle where it
// holds a file of that hash, else of the repository; without those
// lockfiles, the patch the bundle holds named for it, pnpm's way. Either is
// told (`patch`). One held to neither, patched or not, fails.
//
// Ecosystems upstream fetches no package of by its name and version alone
// (Composer's, Soldeer's, a crate from git), npm versions the lockfiles lock
// from git alone, and versions it fails to fetch, aren't checked: their files
// are told unverified, as own code is where there is no repository or commit
// to read it of, or no reader of all of it.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { getCrate } from '@preventive/upstream/cargo.js'
import { HttpError, getTarball } from '@preventive/upstream/npm.js'
import { parseCargoChecksum } from '@preventive/lockfile/cargo.js'
import { EMPTY_MODULE_PATH, dependencyEcosystem, hasNodeModulesSegment, isStatFormat, moduleFileKey } from '@exodus/stasis-core/util'
import { GithubApiError } from './github-app.ts'
import { githubJson } from './github-requests.ts'
import { readTarballFiles } from './npm-loads.ts'
import { NpmPackageError, type NpmPackageFile, npmFileText } from './npm-packages.ts'
import { type PatchedFile, isPatchOf, parsePatch, patchedFiles } from './npm-patch.ts'
import { eachOf } from './pull-dependencies.ts'

// The rules a validation was made by, kept with it: one made by others is
// made again.
export const BUNDLE_VALIDATION_READ = 1
// The files told failing or unverified, and the packages told, past which
// they are counted.
const MAX_TOLD = 500
// Versions fetched at once, and trees read in all and at once.
const PACKAGES_AT_ONCE = 6
const MAX_TREE_READS = 500
const TREES_AT_ONCE = 6
const SHA = /^[\da-f]{40}$/u

interface BundleModule { ecosystem?: string; name?: string; version?: string; files: Record<string, unknown> }
// A file the bundle holds: its path in it, the module (`dir`, an installed
// copy of its package) and its path there, and its bytes.
interface BundledFile { path: string; dir: string; rel: string; bytes: () => Buffer }
interface PlannedPackage { ecosystem: string; name: string; version: string; files: BundledFile[] }
interface ValidationPlan { files: number; own: BundledFile[]; packages: PlannedPackage[]; patches: Map<string, string> }

// What a bundle's files are, as validation checks them: of its own code, or
// of each package version; and the patches it holds, by their paths.
// Directories and stat records, which are no files, are left out, as is
// Stasis's empty stub, which is allowed. Null for a bundle with no modules.
export function validationPlan(details: { kind: string | null; bundle?: unknown }): ValidationPlan | null {
  const bundle = details.bundle as { modules?: ReadonlyMap<string, BundleModule>; formats?: ReadonlyMap<string, string> } | undefined
  if (details.kind !== 'stasis' || !bundle?.modules) return null
  const formats = bundle.formats ?? new Map<string, string>()
  const own: BundledFile[] = [], patches = new Map<string, string>()
  const packages = new Map<string, PlannedPackage>()
  for (const [dir, info] of bundle.modules) {
    // The root's, and an npm-tagged module's outside node_modules (a
    // workspace package's), are own code whatever they record, as the file
    // tree and its GitHub links read them (bundle-file-github.js).
    const ecosystem = dir === '.' || (info.ecosystem === 'npm' && !hasNodeModulesSegment(dir)) ? undefined : dependencyEcosystem(dir, info.ecosystem)
    const [name, version] = [info.name ?? '', info.version ?? '']
    const key = `${ecosystem}\0${name}\0${version}`
    for (const [rel, content] of Object.entries(info.files)) {
      const path = moduleFileKey(dir, rel)
      const format = formats.get(path)
      if (typeof content !== 'string' || format === 'directory' || isStatFormat(format)) continue
      const file = { path, dir, rel, bytes: () => Buffer.from(content, format === 'resource:base64' ? 'base64' : 'utf8') }
      if (ecosystem !== undefined) {
        const known = packages.get(key) ?? packages.set(key, { ecosystem, name, version, files: [] }).get(key)!
        known.files.push(file)
      } else if (path !== EMPTY_MODULE_PATH || content !== '') {
        if (format === 'patch' || path.endsWith('.patch')) patches.set(path, content)
        own.push(file)
      }
    }
  }
  const listed = [...packages.values()]
  return { files: listed.reduce((sum, pkg) => sum + pkg.files.length, own.length), own, packages: listed, patches }
}

// Git's id of a blob of `bytes`.
export const gitBlobId = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')

// An entry of a commit's tree: a blob (a file, `100644` or `100755`, or a
// symlink, `120000`) or a submodule (a commit).
export interface TreeEntry { sha: string; mode: string; type: 'blob' | 'commit' }
// The entries a commit's tree has at `paths` and above them, by their paths
// from the repository's root, and whether some of the tree was left unread
// (`cut`): its listing whole, else, where GitHub cuts that short, each
// directory alone a level at a time, only those `paths` are in, as many as
// MAX_TREE_READS in all. GitHub having no such commit throws its
// GithubApiError.
export async function commitBlobs(fullName: string, token: string, commit: string, paths: string[],
  fetchImpl: typeof fetch = globalThis.fetch): Promise<{ entries: Map<string, TreeEntry>; cut: boolean }> {
  const api = `https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}/git/trees`
  const wanted = new Set(paths.flatMap(path => path.split('/').slice(0, -1).map((_, at, dirs) => dirs.slice(0, at + 1).join('/'))))
  const entries = new Map<string, TreeEntry>()
  let cut = false, reads = 0, round = [{ tree: commit, prefix: '', recursive: true }]
  while (round.length > 0) {
    const asked = round.slice(0, Math.max(0, MAX_TREE_READS - reads))
    cut ||= asked.length < round.length
    reads += asked.length
    const listed = await eachOf(asked, TREES_AT_ONCE, async ({ tree, recursive }) =>
      await githubJson(`${api}/${tree}${recursive ? '?recursive=1' : ''}`, token, fetchImpl) as { tree?: unknown; truncated?: unknown })
    const next: typeof round = []
    for (const [at, { tree, prefix, recursive }] of asked.entries()) {
      const answer = listed[at]!
      if (!Array.isArray(answer?.tree)) throw new GithubApiError(502, 'github-malformed')
      const truncated = answer.truncated === true
      if (truncated && recursive) { next.push({ tree, prefix, recursive: false }); continue }
      cut ||= truncated
      for (const item of answer.tree as { path?: unknown; mode?: unknown; type?: unknown; sha?: unknown }[]) {
        if (typeof item?.path !== 'string' || typeof item.sha !== 'string' || !SHA.test(item.sha) || typeof item.mode !== 'string') continue
        const path = `${prefix}${item.path}`
        if (item.type === 'blob' || item.type === 'commit') entries.set(path, { sha: item.sha, mode: item.mode, type: item.type })
        else if (item.type === 'tree' && !recursive && wanted.has(path)) next.push({ tree: item.sha, prefix: `${path}/`, recursive: true })
      }
    }
    round = next
  }
  return { entries, cut }
}

// A package version's files as upstream fetches its tarball, by their paths
// in it, a crate's with its sha256 in hex (`checksum`), which a vendored
// copy's `.cargo-checksum.json` names; throws where it can't.
type PackageFiles = Map<string, Uint8Array> & { checksum?: string }
type FetchPackage = (ecosystem: string, name: string, version: string) => Promise<PackageFiles>
// Ecosystems upstream fetches a version of by its name and version alone.
const FETCHED = new Set(['npm', 'cargo'])
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const fetchUpstreamPackage: FetchPackage = async (ecosystem, name, version) => {
  const tarball = ecosystem === 'npm' ? await getTarball(name, version) : await getCrate(name, version)
  const files: PackageFiles = new Map((await readTarballFiles(tarball)).map(file => [file.path, file.bytes]))
  if (ecosystem === 'cargo') files.checksum = sha256(tarball)
  return files
}

// Whether a vendored crate's `.cargo-checksum.json`, which `cargo vendor`
// writes and no crate holds (its `bytes`), is of `crate`, its files as
// fetched: each file it lists the crate's, by its sha256, and its package
// checksum the crate's where the fetch tells it.
const CARGO_CHECKSUM = '.cargo-checksum.json'
function checksumOf(bytes: Uint8Array, crate: PackageFiles): boolean {
  const text = npmFileText(bytes)
  let parsed
  try { parsed = text === null ? null : parseCargoChecksum(text) } catch { return false }
  if (!parsed) return false
  return (crate.checksum === undefined || parsed.checksum === crate.checksum)
    && Object.entries(parsed.files).every(([path, listed]) => { const there = crate.get(path); return there !== undefined && sha256(there) === listed })
}

// Why a version wasn't checked: its ecosystem's packages fetched by none
// (`unsupported`), one with no name or version (`unnamed`), none published
// of it (`not-published`), one its registry refuses to read
// (`unreadable`), one too large to unpack (`too-large`), its time up
// (`timeout`), or another failure (`failed`).
function fetchFailure(err: unknown): string {
  if (err instanceof HttpError) return err.status === 404 ? 'not-published' : err.status === 401 || err.status === 403 ? 'unreadable' : 'failed'
  if (err instanceof NpmPackageError) return err.status === 413 ? 'too-large' : 'failed'
  return 'failed'
}

// A patch a version is held to: its hash and file where the lockfile names
// them, where it was read (`from`: the bundle's file, or the repository's),
// and why it couldn't be, where it couldn't.
interface ToldPatch { hash?: string; path?: string; from?: 'bundle' | 'repository'; error?: string; applied?: boolean }
// The patch a lockfile locks a version with (its hash, and file where it
// names one), null for none, undefined where no lockfile was read; the
// patch's file read of the repository; and whether it locks a version from
// git alone, which npm may build as it installs it, and whose name and
// version the registry's release is another package of.
export interface LockedPatches {
  of(name: string, version: string): { hash: string; path?: string } | null | undefined
  read(hash: string, path: string): Promise<PatchedFile[]>
  git(name: string, version: string): boolean
}

// What a validation tells: when it was made; its status, `valid` where every
// file the bundle holds was checked and is as it should be, `invalid` where
// any isn't, else `incomplete`; whether its own code was checked, at which
// repository, commit and directory, or why not (`own`); how many files it
// holds, of each kind and outcome; each file failing (`differs`, or
// `unexpected`: an own file GitHub hasn't there, or a dependency's its
// package hasn't) and each own one left unverified, with what it is of
// (`own`, or its package, `npm:name@version`), as many as MAX_TOLD
// (`problems`, how many more `moreProblems`); and each package version not
// wholly valid or patched (`packages`, those valid counted alone), a patched
// one's patch with whether its files are as patched (`applied`).
type OwnChecked = { checked: true; repository: string; commit: string; directory: string; cut?: true } | { checked: false; reason: string }
interface Problem { path: string; kind: 'differs' | 'unexpected' | 'unverified'; of: 'own' | string; reason?: string }
interface PackageTold { ecosystem: string; name: string; version: string; files: number; status: 'valid' | 'invalid' | 'unverified'
  reason?: string; patch?: ToldPatch }
export interface BundleValidation {
  validatedAt: number; status: 'valid' | 'invalid' | 'incomplete'; own: OwnChecked
  counts: { files: number; own: number; dependencies: number; matched: number; eol: number; differs: number; unexpected: number; unverified: number
    packages: number; validPackages: number }
  problems: Problem[]; moreProblems: number; packages: PackageTold[]
}

const equal = (a: Uint8Array, b: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b)
const packageKey = ({ ecosystem, name, version }: { ecosystem: string; name: string; version: string }) => `${ecosystem}:${name}@${version}`
const byText = <T>(key: (item: T) => string) => (a: T, b: T) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
// The name pnpm gives a version's patch file, `@scope__name@1.0.0.patch`.
const pnpmPatchName = (name: string, version: string) => `${name.replace('/', '__')}@${version}.patch`

// The bundle `plan` validated: its own code against `own` (the entries of the
// commit's tree, and where they were read), or not, and why; each package
// fetched with `fetch`, those of an npm version pnpm patches held to its
// files patched, and those it locks from git alone left unverified
// (`locked`, null where no lockfile was read), as many fetched at once as
// PACKAGES_AT_ONCE, while own code is checked, those left past `deadline`
// unverified.
export async function validateBundle(plan: ValidationPlan, own: { entries: Map<string, TreeEntry>; cut: boolean; repository: string; commit: string; directory: string }
  | { reason: string }, { fetch = fetchUpstreamPackage, locked = null, deadline = Number.POSITIVE_INFINITY, now = Date.now }: { fetch?: FetchPackage
  locked?: LockedPatches | null; deadline?: number; now?: () => number } = {}): Promise<BundleValidation> {
  const problems: Problem[] = []
  const counts = { files: plan.files, own: plan.own.length, dependencies: plan.files - plan.own.length, matched: 0, eol: 0, differs: 0,
    unexpected: 0, unverified: 0, packages: plan.packages.length, validPackages: 0 }
  const tell = (problem: Problem) => { counts[problem.kind]++; problems.push(problem) }

  const told: PackageTold[] = []
  const fetching = eachOf(plan.packages, PACKAGES_AT_ONCE, async pkg => {
    const of = packageKey(pkg)
    const tellPackage = (status: PackageTold['status'], more: Partial<PackageTold> = {}) =>
      told.push({ ecosystem: pkg.ecosystem, name: pkg.name, version: pkg.version, files: pkg.files.length, status, ...more })
    const unverified = (reason: string) => { counts.unverified += pkg.files.length; tellPackage('unverified', { reason }) }
    if (!pkg.name || !pkg.version) { unverified('unnamed'); return }
    if (!FETCHED.has(pkg.ecosystem)) { unverified('unsupported'); return }
    if (pkg.ecosystem === 'npm' && locked?.git(pkg.name, pkg.version)) { unverified('git'); return }
    if (now() > deadline) { unverified('timeout'); return }
    let files: PackageFiles
    try { files = await fetch(pkg.ecosystem, pkg.name, pkg.version) } catch (err) { unverified(fetchFailure(err)); return }
    const { patch, patched } = pkg.ecosystem === 'npm' ? await patchOf(plan, pkg, files, locked) : { patch: undefined, patched: null }
    // A crate's `.cargo-checksum.json` held to the crate, as no crate holds one.
    const checksum = (file: BundledFile) => pkg.ecosystem === 'cargo' && file.rel === CARGO_CHECKSUM
    const matches = (file: BundledFile, bytes: Buffer, candidate: PackageFiles) => {
      if (checksum(file)) return checksumOf(bytes, candidate)
      const there = candidate.get(file.rel)
      return there !== undefined && equal(bytes, there)
    }
    // Each installed copy of it (its module) apart, as one may be patched
    // and another not, the version fetched once for them all: held to its
    // files patched, else, where they all are as published, to those.
    let asPatched = 0, missed = 0
    for (const copy of Map.groupBy(pkg.files, file => file.dir).values()) {
      const bytes = new Map(copy.map(file => [file, file.bytes()]))
      const missing = (candidate: PackageFiles) => copy.filter(file => !matches(file, bytes.get(file)!, candidate))
      let held: PackageFiles = patched ?? files
      let misses = missing(held)
      if (patched && misses.length > 0 && missing(files).length === 0) [held, misses] = [files, []]
      for (const file of misses) tell({ path: file.path, kind: checksum(file) || held.has(file.rel) ? 'differs' : 'unexpected', of })
      missed += misses.length
      if (misses.length === 0 && held === patched) asPatched++
    }
    counts.matched += pkg.files.length - missed
    const valid = missed === 0
    if (valid) counts.validPackages++
    // Each patched one told, and, valid, whether any copy of it is as patched.
    if (!valid || patch) tellPackage(valid ? 'valid' : 'invalid', patch ? { patch: { ...patch, ...patched && valid ? { applied: asPatched > 0 } : {} } } : {})
  })

  if ('reason' in own) counts.unverified += plan.own.length
  else {
    const at = (path: string) => own.directory ? `${own.directory}/${path}` : path
    const submodules = [...own.entries].filter(([, entry]) => entry.type === 'commit').map(([path]) => `${path}/`)
    for (const file of plan.own) {
      const path = at(file.path)
      const entry = own.entries.get(path)
      if (!entry || entry.type !== 'blob') {
        const inSubmodule = submodules.some(prefix => path.startsWith(prefix))
        tell({ path: file.path, kind: own.cut && !inSubmodule ? 'unverified' : 'unexpected', of: 'own', ...inSubmodule ? { reason: 'submodule' } : own.cut ? { reason: 'tree-cut' } : {} })
        continue
      }
      if (entry.mode === '120000') { tell({ path: file.path, kind: 'differs', of: 'own', reason: 'symlink' }); continue }
      const bytes = file.bytes()
      if (gitBlobId(bytes) === entry.sha) { counts.matched++; continue }
      // As a checkout with CRLF line endings writes it, of the file the
      // repository has with LFs.
      if (bytes.includes('\r\n') && gitBlobId(Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')) === entry.sha) {
        counts.matched++; counts.eol++; continue
      }
      tell({ path: file.path, kind: 'differs', of: 'own' })
    }
  }
  await fetching

  return { validatedAt: now(), status: counts.differs + counts.unexpected > 0 ? 'invalid' : counts.unverified > 0 ? 'incomplete' : 'valid',
    own: 'reason' in own ? { checked: false, reason: own.reason }
      : { checked: true, repository: own.repository, commit: own.commit, directory: own.directory, ...own.cut ? { cut: true as const } : {} },
    counts, problems: problems.toSorted(byText(problem => problem.path)).slice(0, MAX_TOLD), moreProblems: Math.max(0, problems.length - MAX_TOLD),
    packages: told.toSorted(byText(packageKey)).slice(0, MAX_TOLD) }
}

// The patch an npm version `pkg` is held to, and its files patched with it:
// the one the lockfiles lock it with, of the bundle's file of its hash, else
// the repository's (`locked`); without them, the bundle's named for it.
// Its files patched none where it is patched by none, or where the patch
// couldn't be read or applied, which is told.
async function patchOf(plan: ValidationPlan, pkg: PlannedPackage, files: Map<string, Uint8Array>, locked: LockedPatches | null) {
  const lock = locked?.of(pkg.name, pkg.version)
  let patch: ToldPatch | undefined, read: PatchedFile[] | null = null
  try {
    if (lock) {
      const bundled = [...plan.patches].find(([, text]) => isPatchOf(text, lock.hash))
      if (bundled) {
        patch = { hash: lock.hash, path: bundled[0], from: 'bundle' }
        read = parsePatch(bundled[1])
      } else if (lock.path) {
        patch = { hash: lock.hash, path: lock.path, from: 'repository' }
        read = await locked!.read(lock.hash, lock.path)
      } else return { patch: { hash: lock.hash, error: 'patch-not-found' }, patched: null }
    } else if (lock === undefined) {
      const named = [...plan.patches].find(([path]) => path.split('/').at(-1) === pnpmPatchName(pkg.name, pkg.version))
      if (!named) return { patch, patched: null }
      patch = { path: named[0], from: 'bundle' }
      read = parsePatch(named[1])
    } else return { patch, patched: null }
    const unpatched: NpmPackageFile[] = [...files].map(([path, bytes]) => ({ path, bytes }))
    return { patch, patched: new Map(patchedFiles(unpatched, read).map(file => [file.path, file.bytes])) }
  } catch (err) {
    const error = err instanceof NpmPackageError || err instanceof GithubApiError ? err.message : 'patch-unreadable'
    return { patch: { ...patch, error }, patched: null }
  }
}
