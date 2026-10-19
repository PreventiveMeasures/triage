// Reading a directory of a repository at a commit for the managed code viewer
// (GET /api/admin/repositories/code): its tree's tarball as GitHub archives
// it, verified against the tree's id and kept in upstream's disk cache as
// bundle builds keep theirs (getRepoTreeTarball), and its files as the npm
// viewer reads a package's (npm-packages.ts npmFileRows). Readers asking for
// the same directory meanwhile share its body, a load among the npm viewer's
// active ones (npm-loads.ts sharedLoad). The default branch's head's bodies
// are kept in byte storage, for the next to open them (repositoryCodeKept).
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { encodeBrotli } from './brotli.ts'
import { CacheMissError, type CacheStorage } from './cache-storage.ts'
import type { KeptStore } from './npm-kept.ts'
import { plainObject } from './npm-manifest.ts'
import { MAX_NPM_JSON_LENGTH, NpmPackageError, npmFileRows } from './npm-packages.ts'
import { type NpmLoad, loadPlaces, readTarballFiles, sharedLoad } from './npm-loads.ts'

// What a directory may hold, bounded apart from a package's (npm-packages.ts),
// as the viewer holds every file in memory: its files' count and bytes.
export const MAX_REPOSITORY_CODE_FILES = 80_000
export const MAX_REPOSITORY_CODE_BYTES = 256 * 1024 * 1024
// The tarball they come in, bounded in proportion as a package's is: its tar
// stream, headers and padding included, and its entries, as many again as
// files, as GitHub's has one for each directory too.
const REPOSITORY_TAR = { maxFiles: MAX_REPOSITORY_CODE_FILES, maxBytes: MAX_REPOSITORY_CODE_BYTES, maxEntries: 2 * MAX_REPOSITORY_CODE_FILES, maxTarBytes: 384 * 1024 * 1024 }
// What the files may take as the viewer's JSON, written as one string: short
// of the longest V8 holds (2^29 - 24 characters).
const MAX_REPOSITORY_CODE_JSON_LENGTH = 384 * 1024 * 1024

// Whether a directory's files fit, by GitHub's listing of its tree and every
// tree under it (repository-browser.ts repositoryTreeFiles): asked before
// its tarball is, which may run to hundreds of MiB. One GitHub cut short
// (null) has too many.
export function repositoryCodeFits(files: RepositoryCodeFiles | null): files is RepositoryCodeFiles {
  return files !== null && files.files <= MAX_REPOSITORY_CODE_FILES && files.bytes <= MAX_REPOSITORY_CODE_BYTES
}

// A directory's files' count and bytes, as GitHub lists its tree.
export interface RepositoryCodeFiles { files: number; bytes: number }

// The directory read: the repository by its id and name, the commit, the
// directory (`''` for the root), its tree's id, and its files as listed,
// which weigh its load among the active ones.
export interface RepositoryCodeInput { repoId: number; repo: string; commit: string; path: string; tree: string; listed: RepositoryCodeFiles }

// A package's refusals, as a directory's: past the bounds, or an archive
// @preventive/archive refuses, as it does one holding a symlink that climbs
// past the repository's root, or an absolute one.
const DIRECTORY_ERRORS: Record<string, [number, string]> = { 'package-too-large': [413, 'directory-too-large'], 'bad-tarball': [422, 'directory-unreadable'] }
const directoryError = (err: unknown) => {
  const as = err instanceof NpmPackageError ? DIRECTORY_ERRORS[err.message] : undefined
  return as ? new NpmPackageError(...as) : err
}

// The directory as the viewer reads it, as brotli-encoded JSON: `{ repoId,
// repo, commit, path, tree, files }`, its files as npmFileRows gives them,
// by their paths in the directory, from `tarball`, the tree's, as upstream
// verifies it with its symlinks let climb `symlinksAbove` levels.
export function loadRepositoryCodeBody(input: RepositoryCodeInput, tarball: (symlinksAbove: number) => Promise<Uint8Array>): NpmLoad<Buffer> {
  const { repoId, repo, commit, path, tree, listed } = input
  // A symlink may reach the repository's root, as a monorepo package's
  // LICENSE links the root's, and no further: the directory's depth, less
  // the level the archive's root already stands above its top directory.
  const symlinksAbove = path.split('/').length - 1
  // Its places among the active loads, by its files as listed, hold their
  // JSON too, which the listing cannot tell, as escaping may grow a text
  // sixfold: as much as a package's may take for each.
  const places = loadPlaces(listed)
  const maxLength = Math.min(MAX_REPOSITORY_CODE_JSON_LENGTH, places * MAX_NPM_JSON_LENGTH)
  return sharedLoad(`repository ${repoId} ${repo} ${commit} ${path} ${tree}`, async () => {
    let files
    try { files = npmFileRows(await readTarballFiles(await tarball(symlinksAbove), { ...REPOSITORY_TAR, symlinksAbove }), maxLength) }
    catch (err) { throw directoryError(err) }
    return encodeBrotli(Buffer.from(JSON.stringify({ repoId, repo, commit, path, tree, files })))
  }, 'repository-busy', { places })
}

// The form of the bodies kept, bumped as what a body holds changes
// (npmFileRows): one kept in another is none to read.
const KEPT_CODE_VERSION = 1
// The largest body kept. Source text runs, as brotli's JSON, to a third of
// its bytes or less, and a directory's binary files are named, not held, so
// this keeps one of some 200 MiB of text: nearly every directory that opens
// at all (MAX_REPOSITORY_CODE_BYTES). One past it would take as much byte
// storage as hundreds of ordinary directories, and hold a serverless
// invocation a while uploading it: it is sent as ever, and read again the
// next time.
export const MAX_KEPT_CODE_BYTES = 64 * 1024 * 1024
const COMMIT = /^[a-f\d]{40}$/u

// A directory as kept: the repository by its id and name, the commit and the
// directory, as its body names them.
export type KeptCodeAt = Pick<RepositoryCodeInput, 'repoId' | 'repo' | 'commit' | 'path'>
// Under the repository, then the commit, so either goes by its prefix; the
// repository's name and the directory hashed, as a key's parts are names.
const keptKey = ({ repoId, repo, commit, path }: KeptCodeAt) =>
  `${repoId}/${commit}/v${KEPT_CODE_VERSION}-${createHash('sha256').update(JSON.stringify([repo, path])).digest('hex')}.json.br`

// Bodies being kept, by their storage and key, each kept once; and each
// storage's own name among the active loads, as its reads are one of them.
const keeping = new WeakMap<CacheStorage, Set<string>>()
const storageNames = new WeakMap<CacheStorage, number>()
let storagesNamed = 0

// A body kept, read whole, where it is one MAX_KEPT_CODE_BYTES keeps.
async function readKept(storage: CacheStorage, key: string): Promise<Buffer | null> {
  const { size, stream } = await storage.open(key)
  try {
    if (size !== null && size > MAX_KEPT_CODE_BYTES) return null
    const parts: Buffer[] = []
    let length = 0
    for await (const part of stream) {
      length += (part as Buffer).byteLength
      if (length > MAX_KEPT_CODE_BYTES) return null
      parts.push(Buffer.from(part as Buffer))
    }
    return Buffer.concat(parts, length)
  } finally { stream.destroy() }
}

// The directories of repositories' default branches' heads, as
// loadRepositoryCodeBody encodes them, kept in the managed byte storage
// (`storage`: Vercel Blob, else the filesystem, encrypted at rest where
// storage is: storage-payload.ts REPOSITORY_CODE_CACHE), so that one opened
// again, on any instance, asks GitHub for no tarball, and is neither unpacked
// nor encoded again; by the commit `heads` keeps for each repository, the
// head as last read (npm-kept.ts codeHeadStore). Most opens read the head:
// `/repo/<repo id>` opens it, and its route then names its commit, as do its
// directories opened from it and a reload. A read naming the default branch
// (`''`, or `heads/` and its name) takes its head as GitHub resolves it for
// the commit kept, the directories kept at any other removed (`own`ed,
// behind its answer); any other read, of a commit, a tag or another branch,
// reads and keeps a directory only where what it resolves to is the commit
// kept. Nothing kept is per reader, and each is read only once the reader's
// own access has named its commit. A body names what it was read of, so
// instances disagreeing on the head meanwhile, as at a push, only cost a
// directory read again: one kept for a head since moved on removes itself.
// A head is written only for a repository still `active` after it, as one
// removed meanwhile has its head removed after (remove). Byte storage, as
// the database, is an optimization: its failures read as a directory kept
// nowhere, and keep nothing.
export function repositoryCodeKept(storage: CacheStorage, heads: KeptStore<{ commit: string }>, active: (repoId: number) => Promise<boolean>,
  own: (work: Promise<unknown>) => void, debug = false) {
  const warn = (what: string) => (error: unknown) => { if (debug) console.warn(`managed: kept repository code ${what} failed:`, error) }
  const headOf = async (repoId: number) => {
    const kept: unknown = (await heads.read(String(repoId)))?.value
    return plainObject(kept) && typeof kept['commit'] === 'string' ? kept['commit'] : null
  }
  // What is kept of repository `repoId`: its head first, so that a body being
  // kept meanwhile removes itself.
  const remove = async (repoId: number) => {
    await heads.remove(String(repoId))
    await storage.delete(String(repoId))
  }
  return {
    // Whether a read of `ref` at repository `repoId`, resolved to `commit`
    // with `defaultBranch` GitHub's, reads and keeps its directories.
    async at(repoId: number, ref: string, commit: string, defaultBranch: string): Promise<boolean> {
      if (!COMMIT.test(commit)) return false
      const kept = await headOf(repoId)
      if (ref !== '' && (defaultBranch === '' || ref !== `heads/${defaultBranch}`)) return kept === commit
      if (kept !== commit) {
        await heads.write(String(repoId), { commit }, Date.now())
        // One removed as its commit was read, its head removed before this
        // wrote it again, keeps nothing, and has what is kept removed again.
        if (!await active(repoId).catch(() => false)) {
          await remove(repoId).catch(warn('removal'))
          return false
        }
        own(storage.delete(String(repoId), commit).catch(warn('removal')))
      }
      return true
    },
    // The body kept of the directory `at` names, or null: a load among the
    // active ones (npm-loads.ts sharedLoad), as one read from GitHub is, a
    // place of them, as it holds no more than a package may
    // (MAX_KEPT_CODE_BYTES), till each reader has released it; readers
    // asking for it meanwhile share it, and none is read where every place
    // is taken (`repository-busy`).
    read(at: KeptCodeAt): NpmLoad<Buffer | null> {
      const key = keptKey(at)
      const name = storageNames.get(storage) ?? storageNames.set(storage, ++storagesNamed).get(storage)!
      return sharedLoad(`repository kept ${name} ${key}`, () => readKept(storage, key).catch((error: unknown) => {
        if (!(error instanceof CacheMissError)) warn('read')(error)
        return null
      }), 'repository-busy')
    },
    // The directory's body kept, behind its answer, where it is no larger
    // than MAX_KEPT_CODE_BYTES; and removed again, with the rest of its
    // commit's, where the head kept is another by then, as when it moved on
    // or the repository was removed meanwhile.
    keep(at: KeptCodeAt, body: Buffer): void {
      const key = keptKey(at)
      const kept = keeping.get(storage) ?? keeping.set(storage, new Set()).get(storage)!
      if (body.byteLength > MAX_KEPT_CODE_BYTES || kept.has(key)) return
      kept.add(key)
      own((async () => {
        await storage.put(key, body)
        if (await headOf(at.repoId) !== at.commit) await storage.delete(`${at.repoId}/${at.commit}`)
      })().catch(warn('write')).finally(() => kept.delete(key)))
    },
    // What is kept of repository `repoId`, removed once the repository is
    // no longer active.
    remove,
  }
}
export type RepositoryCodeKept = ReturnType<typeof repositoryCodeKept>
