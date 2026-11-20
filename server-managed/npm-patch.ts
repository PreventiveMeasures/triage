// A pnpm patch of an npm package version (patchedDependencies), as its
// dependency review reads it (pull-dependency-reviews.ts): its file, which a
// lockfile names (locked-packages.ts `patchPath`), or which is found where it
// names it by its hash alone (withPatchFiles), read of a repository at a
// commit, and held to the hash the lockfile names it by, as pnpm 10 and
// later hash it, a sha256 in hex of its text with its CRLFs read as LFs
// (one pnpm 9 names by an md5 isn't read), by which it is kept for good,
// read of GitHub once; and applied to the version's files as pnpm applies
// it as it installs it (patch-package's applyPatch, which pnpm 10 and 11
// bundle): each file it deletes, creates, renames or changes, a change's
// hunks each found in the file as it was, where its header says, else as
// many as FUZZ lines either side, its lines the same but for the space they
// end in, and those it keeps kept as the file has them. A patch of a file's
// bytes (git's binary patch), or of a file outside the package, isn't read,
// and one that doesn't apply fails as a whole; what a patch changes of a
// file's mode is left out, as the files it reads have none.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { YamlError, parseYaml } from '@preventive/lockfile/yaml.js'
import { isGithubRepoName } from '../common/github-pr.ts'
import { isPatchHash, isPatchPath } from '../common/managed/npm-packages.js'
import { GithubApiError } from './github-errors.ts'
import { SHA, isId } from './github-values.ts'
import { type LockedPackage, pathFrom } from './locked-packages.ts'
import { type Lru, lru } from './lru.ts'
import type { KeptStore } from './npm-kept.ts'
import { plainObject } from './npm-manifest.ts'
import { NpmPackageError, type NpmPackageFile, npmFileText, pathOrder } from './npm-packages.ts'
import { type GithubAsked, type PullDependencies, repositoryFile } from './pull-dependencies.ts'
import { eachOf } from './queue.ts'

// Where a patch is read: its file in a repository (by its id) at a commit,
// from the repository's root; and the patch, by its hash besides. A request
// names its repository by its id, or by its name (`owner/name`) in its place
// (http.ts wholeRepositoryAccess).
export interface PatchSource { repoId: number; commit: string; path: string }
export interface NpmPatch extends PatchSource { hash: string }
export type RequestedPatch = Omit<NpmPatch, 'repoId'> & { repoId: number | string }

// The most a patch's file may hold, and how many lines either side of where a
// hunk says its lines are they are looked for; and how many patches are
// looked for at once.
const MAX_PATCH_BYTES = 8 * 1024 * 1024
const FUZZ = 20
const FIND_AT_ONCE = 4

// The patch a request names, by its hash (`hash`), its repository's id
// (`repoId`, a number or its digits) or name, the commit and its file's
// path; null where it names none of where it is, and 'invalid' where it
// names one otherwise.
export function requestedPatch({ hash, repoId, commit, path }: { hash: unknown; repoId: unknown; commit: unknown; path: unknown }): RequestedPatch | null | 'invalid' {
  if ([repoId, commit, path].every(field => field == null)) return null
  const id = typeof repoId === 'string' && /^[1-9]\d{0,15}$/u.test(repoId) ? Number(repoId) : repoId
  if (!isPatchHash(hash) || !(isId(id) || typeof id === 'string' && isGithubRepoName(id)) || typeof commit !== 'string' || !SHA.test(commit)
    || !isPatchPath(path)) return 'invalid'
  return { hash, repoId: id, commit, path }
}

// Whether `text` is the patch `hash` names, its sha256 in hex: of its text
// with its CRLFs as LFs, as pnpm reads it, or as it is.
export function isPatchOf(text: string, hash: string): boolean {
  return [...new Set([text.replaceAll('\r\n', '\n'), text])].some(read => createHash('sha256').update(read).digest('hex') === hash)
}

// A change a patch makes to a file at `path` of the package: deleting it,
// creating it, renaming it from another (`from`), and its hunks, as
// patch-package reads them: where its header says its lines are (`at`, the
// first's index, as it reads `-0`, the first line), how many it finds
// (`length`), and its lines, each without its LF, in runs of a kind
// (`parts`): those it keeps, removes or adds, the last of a side told where
// the file has no LF after it (`unended`).
export interface HunkPart { kind: 'context' | 'deletion' | 'insertion'; lines: string[]; unended?: true }
export interface PatchHunk { at: number; length: number; parts: HunkPart[] }
export interface PatchedFile { path: string; from?: string; deleted?: true; created?: true; hunks: PatchHunk[] }

const unreadable = () => new NpmPackageError(422, 'patch-unreadable')

// A path as git writes it, unquoted where quoted (as C writes a string, its
// bytes past ASCII in octal); null where it is quoted otherwise.
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
function unquoted(path: string): string | null {
  if (!path.startsWith('"')) return path
  const bytes: number[] = []
  for (let at = 1; at < path.length; at++) {
    const char = path[at]!
    if (char === '"') return at === path.length - 1 ? new TextDecoder().decode(Uint8Array.from(bytes)) : null
    if (char !== '\\') { bytes.push(...Buffer.from(char)); continue }
    const next = path[++at] ?? ''
    const octal = /^[0-3][0-7]{2}/u.exec(path.slice(at))?.[0]
    if (octal) { bytes.push(Number.parseInt(octal, 8)); at += 2 }
    else if (next in ESCAPES) bytes.push(ESCAPES[next]!)
    else return null
  }
  return null
}

// A side's path in the package, as a `---` or `+++` line names it after its
// prefix (`a/` or `b/`), git's tab after one with a space in it left out;
// null for none (`/dev/null`).
function sidePath(named: string, prefix: string): string | null {
  const path = unquoted(named.endsWith('\t') ? named.slice(0, -1) : named)
  if (path === '/dev/null') return null
  if (path === null || !path.startsWith(prefix)) throw unreadable()
  return path.slice(prefix.length)
}

// The paths a `diff --git` line names, where they are the same, as git
// writes them for a file neither renamed nor copied: `a/<path> b/<path>`.
function gitPath(named: string): string | null {
  if (named.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/u.exec(named)
    const [a, b] = quoted ? [unquoted(quoted[1]!), unquoted(quoted[2]!)] : []
    return a?.startsWith('a/') && b?.startsWith('b/') && a.slice(2) === b.slice(2) ? a.slice(2) : null
  }
  const length = (named.length - 5) / 2
  const path = named.slice(2, 2 + length)
  return Number.isInteger(length) && named.startsWith('a/') && named.slice(2 + length) === ` b/${path}` ? path : null
}

// The hunk whose `@@` line is at `at` of `lines`, those before `end` read,
// and the line after it, as patch-package reads it: a line of its own
// kind, else of those it keeps where it is empty, or a CR alone.
function readHunk(lines: string[], at: number, end: number): { hunk: PatchHunk; next: number } {
  const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[at++]!)
  if (!range) throw unreadable()
  let news = Number(range[4] ?? 1), olds = Number(range[2] ?? 1)
  const hunk: PatchHunk = { at: Math.max(Number(range[1]), 1) - 1, length: olds, parts: [] }
  while (olds > 0 || news > 0) {
    // A line its count reads past those read isn't one.
    if (at >= end) throw unreadable()
    const line = lines[at++]!
    const kind = line === '' || line === '\r' || line[0] === ' ' ? 'context' : line[0] === '-' ? 'deletion' : line[0] === '+' ? 'insertion' : null
    if (!kind) throw unreadable()
    const last = hunk.parts.at(-1)
    const part = last?.kind === kind ? last : hunk.parts[hunk.parts.push({ kind, lines: [] }) - 1]!
    part.lines.push(line.slice(1))
    if (kind !== 'insertion') olds--
    if (kind !== 'deletion') news--
    if (olds < 0 || news < 0) throw unreadable()
    // The line before it the last of its side, with no LF after it.
    if (lines[at]?.startsWith('\\')) {
      if (!lines[at++]!.startsWith('\\ No newline at end of file')) throw unreadable()
      part.unended = true
    }
  }
  return { hunk, next: at }
}

// A patch's files as git's diff writes them, as pnpm writes a patch: a file's
// `diff --git` line, its headers, the paths its sides have, and its hunks;
// what comes before the first file, or between one file and the next, left
// out. One whose own lines end in CRLFs, as an editor or git's autocrlf
// leaves one, is read as patch-package reads it: its headers but their CRs,
// its hunks' lines with them. Throws for one it can't read, or of bytes.
export function parsePatch(patch: string): PatchedFile[] {
  const lines = patch.split('\n')
  // The lines read: those but the empty one past the patch's last ending.
  const end = lines.length - (patch.endsWith('\n') ? 1 : 0)
  // A header's line but its CR.
  const headerAt = (at: number) => lines[at]?.replace(/\r$/u, '') ?? ''
  const files: PatchedFile[] = []
  for (let at = 0; at < lines.length;) {
    const head = headerAt(at++)
    if (!head.startsWith('diff --git ')) continue
    let created = false, deleted = false, from: string | null = null, to: string | null = null
    let sides: [string | null, string | null] | null = null
    for (; at < lines.length && !/^(?:diff --git |@@ |--- )/u.test(lines[at]!); at++) {
      const header = headerAt(at)
      if (header === 'GIT binary patch' || header.startsWith('Binary files ')) throw new NpmPackageError(422, 'patch-unsupported')
      if (header.startsWith('copy from ') || header.startsWith('copy to ')) throw new NpmPackageError(422, 'patch-unsupported')
      if (header.startsWith('deleted file mode ')) deleted = true
      else if (header.startsWith('new file mode ')) created = true
      else if (header.startsWith('rename from ')) from = unquoted(header.slice('rename from '.length))
      else if (header.startsWith('rename to ')) to = unquoted(header.slice('rename to '.length))
    }
    if (lines[at]?.startsWith('--- ')) {
      if (!lines[at + 1]?.startsWith('+++ ')) throw unreadable()
      sides = [sidePath(headerAt(at).slice(4), 'a/'), sidePath(headerAt(at + 1).slice(4), 'b/')]
      at += 2
    }
    const named = gitPath(head.slice('diff --git '.length))
    const after = to ?? (sides ? sides[1] : named), before = from ?? (sides ? sides[0] : named)
    if ((from === null) !== (to === null) || (deleted && created)) throw unreadable()
    const path = deleted ? before : after
    if (path == null || (!created && before == null) || (!deleted && after == null) || ![before, after].every(side => side == null || isPatchPath(side))
      || (from === null && !deleted && !created && before !== after)) throw unreadable()
    const hunks: PatchHunk[] = []
    while (lines[at]?.startsWith('@@ ')) {
      const { hunk, next } = readHunk(lines, at, end)
      hunks.push(hunk)
      at = next
    }
    files.push({ path, ...from !== null && to !== null ? { from: before! } : {}, ...deleted ? { deleted: true as const } : {},
      ...created ? { created: true as const } : {}, hunks: deleted ? [] : hunks })
  }
  return files
}

const doesNotApply = () => new NpmPackageError(422, 'patch-does-not-apply')

// A change a hunk makes to a file's lines (`lines`, split at its LFs): those
// at `splice` that it removes (`remove`) and adds in their place (`insert`),
// or an empty last line it adds or removes, its LF after the last.
type LineChange = { splice: number; remove: number; insert: string[] } | 'push' | 'pop'

// The changes `hunk` makes where its lines are at `at` of `lines`, as
// patch-package works them out (evaluateHunk): those it finds the same but
// for the space they end in, as it compares them; else null.
function changesAt(hunk: PatchHunk, lines: string[], at: number): LineChange[] | null {
  if (at < 0 || lines.length - at < hunk.length) return null
  const changes: LineChange[] = []
  for (const part of hunk.parts) {
    if (part.kind === 'insertion') {
      changes.push({ splice: at, remove: 0, insert: part.lines })
      if (part.unended) changes.push('pop')
      continue
    }
    for (const line of part.lines) if (lines[at++]!.trimEnd() !== line.trimEnd()) return null
    if (part.kind === 'deletion') {
      changes.push({ splice: at - part.lines.length, remove: part.lines.length, insert: [] })
      if (part.unended) changes.push('push')
    }
  }
  return changes
}

// `text` with `hunks` applied as patch-package applies them (applyPatch):
// each one's lines found in the text as it was, where its header says, else
// as near as FUZZ lines either side, the nearer first, and the earlier of
// two as near; then its changes made in turn, past the lines those before
// added or removed.
function applied(text: string, hunks: PatchHunk[]): string {
  const lines = text.split('\n')
  const changes = hunks.flatMap(hunk => {
    for (let offset = 0; Math.abs(offset) <= FUZZ; offset = offset < 0 ? -offset : -offset - 1) {
      const found = changesAt(hunk, lines, hunk.at + offset)
      if (found) return found
    }
    throw doesNotApply()
  })
  let shift = 0
  for (const change of changes) {
    if (change === 'push') lines.push('')
    else if (change === 'pop') lines.pop()
    else {
      lines.splice(change.splice + shift, change.remove, ...change.insert)
      shift += change.insert.length - change.remove
    }
  }
  return lines.join('\n')
}

// A version's `files` with `patch` applied, in the order of their paths, as
// its tarball's are read; a file it changes the text of must be text. One it
// creates holds its first hunk's first lines, in place of any there, as
// patch-package writes it.
export function patchedFiles(files: NpmPackageFile[], patch: PatchedFile[]): NpmPackageFile[] {
  const byPath = new Map(files.map(file => [file.path, file.bytes]))
  const encoder = new TextEncoder()
  for (const file of patch) {
    if (file.created) {
      const first = file.hunks[0]?.parts[0]
      byPath.set(file.path, encoder.encode(first ? `${first.lines.join('\n')}${first.unended ? '' : '\n'}` : ''))
      continue
    }
    const source = file.from ?? file.path
    const bytes = byPath.get(source)
    if (!bytes) throw doesNotApply()
    if (file.deleted) { byPath.delete(source); continue }
    let next = bytes
    if (file.hunks.length > 0) {
      const text = npmFileText(bytes)
      if (text === null) throw doesNotApply()
      next = encoder.encode(applied(text, file.hunks))
    }
    if (file.from !== undefined) {
      if (byPath.has(file.path)) throw doesNotApply()
      byPath.delete(source)
    }
    byPath.set(file.path, next)
  }
  return [...byPath].map(([path, bytes]) => ({ path, bytes })).toSorted((a, b) => pathOrder(a.path, b.path))
}

// About the bytes a patch read takes: the characters of its paths and of the
// lines its hunks hold, and the room past them each line takes (LINE_COST)
// and each file, hunk and part (HUNK_COST), as V8 takes it; so a patch of a
// few long lines (a minified file's) weighs about its size, and one of many
// short lines or tiny hunks many times it, as it takes.
const HUNK_COST = 256, LINE_COST = 40
const held = (lines: string[]) => lines.reduce((sum, line) => sum + LINE_COST + line.length, HUNK_COST)
export const patchWeight = (files: PatchedFile[]) => files.reduce((sum, file) => sum + HUNK_COST + file.path.length + (file.from?.length ?? 0)
  + file.hunks.reduce((bytes, hunk) => bytes + HUNK_COST + hunk.parts.reduce((parts, part) => parts + held(part.lines), 0), 0), 1)

// What is kept of a patch, for good, by its repository and hash (patchKey):
// where it was read, and its text, which its hash names wherever it is.
// Kept by its repository too, as only one who reads all of that is given it.
export interface KeptPatch { commit: string; path: string; text: string }
export const patchKey = (repoId: number, hash: string) => `${repoId}\0${hash}`

// Patches read lately, with where each was read, by their keys, as many as
// MAX_KEPT_PATCHES of the bytes they take (patchWeight); and the path each
// found or kept is at (`located`), '' by its key and a commit for one not
// found there, lest each telling look again.
const MAX_KEPT_PATCHES = 64 * 1024 * 1024
type ReadPatch = Omit<PatchSource, 'repoId'> & { files: PatchedFile[] }
const patches: Lru<ReadPatch> = lru(MAX_KEPT_PATCHES, read => patchWeight(read.files))
const located: Lru<string> = lru(100_000)

// The patch `patch` names, and where it was read (`commit`, `path`): as kept
// by its repository and hash, in this instance, else beyond it (`kept`, held
// to its hash again), wherever the request says it is; else read of
// repository `fullName` with `token` at the commit and path it names, held
// to its hash, and kept for good; `asked` told where GitHub was. Its file
// missing there, or other than its hash says, or past MAX_PATCH_BYTES,
// fails, as does one that isn't read as git writes a diff (parsePatch).
export async function readPatch(fullName: string, token: string, patch: NpmPatch, kept: KeptStore<KeptPatch>, asked?: GithubAsked): Promise<ReadPatch> {
  const key = patchKey(patch.repoId, patch.hash)
  const known = patches.get(key)
  if (known) return known
  let stored = (await kept.read(key))?.value
  if (typeof stored?.text !== 'string' || !isPatchOf(stored.text, patch.hash)) {
    if (asked) asked.github = true
    const text = await repositoryFile(fullName, token, patch.path, patch.commit)
    if (text === null) throw new NpmPackageError(404, 'patch-not-found')
    if (Buffer.byteLength(text) > MAX_PATCH_BYTES) throw new NpmPackageError(413, 'patch-too-large')
    if (!isPatchOf(text, patch.hash)) throw new NpmPackageError(409, 'patch-mismatch')
    stored = { commit: patch.commit, path: patch.path, text }
    await kept.write(key, stored, Date.now())
  }
  const read = { commit: stored.commit, path: stored.path, files: parsePatch(stored.text) }
  patches.set(key, read)
  return read
}

// The file the pnpm-workspace.yaml of directory `dir` (`workspace`, its
// text) names `pkg`'s patch by, as pnpm 11 and later read their
// patchedDependencies there alone: its version's, else its package's, from
// the repository's root; null where it names none, or its reader refuses it.
function namedPatch(dir: string, workspace: string, { name, version }: { name: string; version: string }): string | null {
  let settings: unknown
  try { settings = parseYaml(workspace, { workflow: true }) } catch (err) {
    if (!(err instanceof YamlError)) throw err
  }
  const patched = plainObject(settings) ? settings['patchedDependencies'] : null
  const file = plainObject(patched) ? patched[`${name}@${version}`] ?? patched[name] : null
  return typeof file === 'string' ? pathFrom(dir, file) : null
}

// `told`, each version of its that pnpm patches by a patch its lockfile
// names by its hash alone (pnpm 11's and later) with its patch's file
// (`patchPath`), as a lockfile naming one tells it: as kept by its
// repository and hash, else the file the pnpm-workspace.yaml beside its
// lockfile (`patchDir`) names of it (namedPatch) at `told.head`, held to
// its hash and kept for good, so each is found once; one not found left
// with none. `asked` told where GitHub was. A file GitHub has no text of,
// or past MAX_PATCH_BYTES, is none; any other failure of GitHub's is the
// whole answer's, as a lockfile's is.
type Unnamed = LockedPackage & { patchHash: string; patchDir: string; version: string }
const unnamed = (pkg: LockedPackage): pkg is Unnamed => pkg.patchPath === undefined && pkg.patchDir !== undefined && pkg.version !== null && isPatchHash(pkg.patchHash)
export async function withPatchFiles<T extends PullDependencies>(told: T, repoId: number, fullName: string, token: string, kept: KeptStore<KeptPatch>,
  asked?: GithubAsked): Promise<T> {
  const wanted = new Map<string, Unnamed>()
  for (const dir of told.lockfiles) {
    for (const pkg of 'error' in dir ? [] : [...dir.added, ...dir.locked]) if (unnamed(pkg)) wanted.set(patchKey(repoId, pkg.patchHash), pkg)
  }
  if (wanted.size === 0) return told
  // Where one is: its path, '' for one not found at this commit, undefined for one not looked for yet.
  const at = (key: string) => located.get(key) ?? located.get(`${key}\0${told.head}`)
  const unknown = () => [...wanted.keys()].filter(key => at(key) === undefined)
  for (const [key, { value }] of unknown().length > 0 ? await kept.readMany(unknown()) : []) if (typeof value?.path === 'string') located.set(key, value.path)
  const files = new Map<string, Promise<string | null>>()
  const read = (path: string) => files.get(path) ?? files.set(path, repositoryFile(fullName, token, path, told.head).then(
    text => text !== null && Buffer.byteLength(text) > MAX_PATCH_BYTES ? null : text,
    (err: unknown) => { if (err instanceof GithubApiError && err.message === 'github-malformed') return null; throw err })).get(path)!
  await eachOf(unknown(), FIND_AT_ONCE, async key => {
    const pkg = wanted.get(key)!
    if (asked) asked.github = true
    const workspace = await read(pathFrom(pkg.patchDir, 'pnpm-workspace.yaml')!)
    const path = workspace === null ? null : namedPatch(pkg.patchDir, workspace, pkg)
    const text = path === null ? null : await read(path)
    if (path === null || text === null || !isPatchOf(text, pkg.patchHash)) { located.set(`${key}\0${told.head}`, ''); return }
    await kept.write(key, { commit: told.head, path, text }, Date.now())
    located.set(key, path)
  })
  const named = <P extends LockedPackage>(pkg: P): P => {
    const patchPath = unnamed(pkg) && at(patchKey(repoId, pkg.patchHash))
    return patchPath ? { ...pkg, patchPath } : pkg
  }
  return { ...told, lockfiles: told.lockfiles.map(dir => 'error' in dir ? dir : { ...dir, added: dir.added.map(named), locked: dir.locked.map(named) }) }
}
