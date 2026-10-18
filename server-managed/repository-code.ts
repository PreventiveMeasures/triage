// Reading a directory of a repository at a commit for the managed code viewer
// (GET /api/admin/repositories/code): its tree's tarball as GitHub archives
// it, verified against the tree's id and kept in upstream's disk cache as
// bundle builds keep theirs (getRepoTreeTarball), and its files as the npm
// viewer reads a package's (npm-packages.ts npmFileRows). Readers asking for
// the same directory meanwhile share its body, a load among the npm viewer's
// active ones (npm-loads.ts sharedLoad).
import { Buffer } from 'node:buffer'
import { encodeBrotli } from './brotli.ts'
import { MAX_NPM_PACKAGE_BYTES, MAX_NPM_PACKAGE_FILES, NpmPackageError, npmFileRows } from './npm-packages.ts'
import { type NpmLoad, readTarballFiles, sharedLoad } from './npm-loads.ts'

// As much as a package may hold: the viewer holds every file in memory.
export const MAX_REPOSITORY_CODE_FILES = MAX_NPM_PACKAGE_FILES
export const MAX_REPOSITORY_CODE_BYTES = MAX_NPM_PACKAGE_BYTES

// Whether a directory's files fit, by GitHub's listing of its tree and every
// tree under it (repository-browser.ts repositoryTreeFiles): asked before
// its tarball is, which may run to hundreds of MiB. One GitHub cut short
// (null) has too many.
export function repositoryCodeFits(files: { files: number; bytes: number } | null): boolean {
  return files !== null && files.files <= MAX_REPOSITORY_CODE_FILES && files.bytes <= MAX_REPOSITORY_CODE_BYTES
}

// The directory read: the repository by its id and name, the commit, the
// directory (`''` for the root) and its tree's id.
export interface RepositoryCodeInput { repoId: number; repo: string; commit: string; path: string; tree: string }

// A package's refusals, as a directory's: past the bounds, or an archive
// @preventive/archive refuses, as it does one holding a symlink that climbs
// out of the directory past its parent, or an absolute one.
const DIRECTORY_ERRORS: Record<string, [number, string]> = { 'package-too-large': [413, 'directory-too-large'], 'bad-tarball': [422, 'directory-unreadable'] }
const directoryError = (err: unknown) => {
  const as = err instanceof NpmPackageError ? DIRECTORY_ERRORS[err.message] : undefined
  return as ? new NpmPackageError(...as) : err
}

// The directory as the viewer reads it, as brotli-encoded JSON: `{ repoId,
// repo, commit, path, tree, files }`, its files as npmFileRows gives them,
// by their paths in the directory, from `tarball`, the tree's.
export function loadRepositoryCodeBody(input: RepositoryCodeInput, tarball: () => Promise<Uint8Array>): NpmLoad<Buffer> {
  const { repoId, repo, commit, path, tree } = input
  return sharedLoad(`repository ${repoId} ${repo} ${commit} ${path} ${tree}`, async () => {
    let files
    try { files = npmFileRows(await readTarballFiles(await tarball())) }
    catch (err) { throw directoryError(err) }
    return encodeBrotli(Buffer.from(JSON.stringify({ repoId, repo, commit, path, tree, files })))
  }, 'repository-busy')
}
