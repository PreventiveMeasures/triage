// A pnpm patch of an npm package version (patchedDependencies), as its
// dependency review reads it (pull-dependency-reviews.ts): its file, which a
// lockfile names (locked-packages.ts `patchPath`), read of a repository at a
// commit, and held to the hash the lockfile names it by, as pnpm hashes it,
// a sha256 in hex from pnpm 10 and an md5 in base32 before, of its text with
// its CRLFs read as LFs; and applied to the version's files as pnpm applies
// it as it installs it (patch-package's applyPatch): each file it deletes,
// creates, renames or changes, a change's hunks each where it says its lines
// are, else where they are as many as FUZZ lines either side, as the hunks
// before it found theirs. A patch of a file's bytes (git's binary patch), or
// of a file outside the package, isn't read, and one that doesn't apply
// fails as a whole; what a patch changes of a file's mode is left out, as the
// files it reads have none.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createClient } from '@preventive/upstream/github.js'
import { isPatchHash, isPatchPath } from '../common/managed/npm-packages.js'
import { GithubApiError } from './github-app.ts'
import { upstreamGithub } from './github-errors.ts'
import { type Lru, lru } from './lru.ts'
import { NpmPackageError, type NpmPackageFile, npmFileText } from './npm-packages.ts'
import type { GithubAsked } from './pull-dependencies.ts'

// Where a patch is read: its file in a repository (by its id) at a commit,
// from the repository's root; and the patch, by its hash besides.
export interface PatchSource { repoId: number; commit: string; path: string }
export interface NpmPatch extends PatchSource { hash: string }

// The most a patch's file may hold, and how many lines either side of where a
// hunk says its lines are they are looked for.
export const MAX_PATCH_BYTES = 8 * 1024 * 1024
const FUZZ = 20

const COMMIT = /^[\da-f]{40}$/u

// The patch a request names, by its hash (`hash`), its repository's id
// (`repoId`, a number or its digits), the commit and its file's path; null
// where it names none of where it is, and 'invalid' where it names one
// otherwise.
export function requestedPatch({ hash, repoId, commit, path }: { hash: unknown; repoId: unknown; commit: unknown; path: unknown }): NpmPatch | null | 'invalid' {
  if ([repoId, commit, path].every(field => field == null)) return null
  const id = typeof repoId === 'string' && /^[1-9]\d{0,15}$/u.test(repoId) ? Number(repoId) : repoId
  if (!isPatchHash(hash) || !Number.isSafeInteger(id) || (id as number) <= 0 || typeof commit !== 'string' || !COMMIT.test(commit)
    || !isPatchPath(path)) return 'invalid'
  return { hash, repoId: id as number, commit, path }
}

// RFC 4648's base32 of `bytes`, in lowercase and unpadded, as pnpm 9 spells
// an md5.
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
function base32(bytes: Uint8Array) {
  let bits = 0, spelled = '', value = 0
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff
    bits += 8
    for (; bits >= 5; bits -= 5) spelled += BASE32[(value >>> (bits - 5)) & 31]
  }
  return bits > 0 ? spelled + BASE32[(value << (5 - bits)) & 31] : spelled
}

// Whether `text` is the patch `hash` names: of its text with its CRLFs as
// LFs, as pnpm reads it, or as it is.
export function isPatchOf(text: string, hash: string): boolean {
  return [...new Set([text.replaceAll('\r\n', '\n'), text])].some(read => hash.length === 64
    ? createHash('sha256').update(read).digest('hex') === hash : base32(createHash('md5').update(read).digest()) === hash)
}

// A change a patch makes to a file at `path` of the package: deleting it,
// creating it, renaming it from another (`from`), and its hunks, each the
// lines it finds (`old`) and puts in their place (`new`), each with its line
// ending, and where it says they are (`at`, the first one's index).
export interface PatchHunk { at: number; old: string[]; new: string[] }
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
// and the line after it.
function readHunk(lines: string[], at: number, end: number): { hunk: PatchHunk; next: number } {
  const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[at++]!)
  if (!range) throw unreadable()
  let news = Number(range[4] ?? 1), olds = Number(range[2] ?? 1)
  const hunk: PatchHunk = { at: olds === 0 ? Number(range[1]) : Number(range[1]) - 1, old: [], new: [] }
  while (olds > 0 || news > 0) {
    // A line its count reads past those read isn't one.
    if (at >= end) throw unreadable()
    const line = lines[at++]!
    const tag = line === '' ? ' ' : line[0]
    const sided = tag === ' ' ? [hunk.old, hunk.new] : tag === '-' ? [hunk.old] : tag === '+' ? [hunk.new] : null
    if (!sided) throw unreadable()
    for (const side of sided) side.push(`${line.slice(1)}\n`)
    if (tag !== '+') olds--
    if (tag !== '-') news--
    if (olds < 0 || news < 0) throw unreadable()
    // `\ No newline at end of file`: the line before it has no ending.
    if (lines[at]?.startsWith('\\')) {
      at++
      for (const side of sided) side[side.length - 1] = side.at(-1)!.slice(0, -1)
    }
  }
  return { hunk, next: at }
}

// A patch's files as git's diff writes them, as pnpm writes a patch: a file's
// `diff --git` line, its headers, the paths its sides have, and its hunks;
// what comes before the first file, or between one file and the next, left
// out. One whose own lines end in CRLFs, as an editor or git's autocrlf
// leaves one, is read as git wrote it, with LFs, as pnpm hashes it: a line
// git writes ends in a CR only where the file it changes has one, and never
// a `diff --git` line. Throws for one it can't read, or of bytes.
export function parsePatch(patch: string): PatchedFile[] {
  const text = /^diff --git .*\r$/mu.test(patch) ? patch.replaceAll('\r\n', '\n') : patch
  const lines = text.split('\n')
  // The lines read: those but the empty one past the patch's last ending.
  const end = lines.length - (text.endsWith('\n') ? 1 : 0)
  const files: PatchedFile[] = []
  for (let at = 0; at < lines.length;) {
    const head = lines[at++]!
    if (!head.startsWith('diff --git ')) continue
    let created = false, deleted = false, from: string | null = null, to: string | null = null
    let sides: [string | null, string | null] | null = null
    for (; at < lines.length && !/^(?:diff --git |@@ |--- )/u.test(lines[at]!); at++) {
      const header = lines[at]!
      if (header === 'GIT binary patch' || header.startsWith('Binary files ')) throw new NpmPackageError(422, 'patch-unsupported')
      if (header.startsWith('copy from ') || header.startsWith('copy to ')) throw new NpmPackageError(422, 'patch-unsupported')
      if (header.startsWith('deleted file mode ')) deleted = true
      else if (header.startsWith('new file mode ')) created = true
      else if (header.startsWith('rename from ')) from = unquoted(header.slice('rename from '.length))
      else if (header.startsWith('rename to ')) to = unquoted(header.slice('rename to '.length))
    }
    if (lines[at]?.startsWith('--- ')) {
      if (!lines[at + 1]?.startsWith('+++ ')) throw unreadable()
      sides = [sidePath(lines[at]!.slice(4), 'a/'), sidePath(lines[at + 1]!.slice(4), 'b/')]
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
    if (deleted && hunks.some(hunk => hunk.new.length > 0)) throw unreadable()
    files.push({ path, ...from !== null && to !== null ? { from: before! } : {}, ...deleted ? { deleted: true as const } : {},
      ...created ? { created: true as const } : {}, hunks: deleted ? [] : hunks })
  }
  return files
}

const doesNotApply = () => new NpmPackageError(422, 'patch-does-not-apply')
// Whether `old` is among `records` at `at`.
const isAt = (records: string[], old: string[], at: number) => at >= 0 && at + old.length <= records.length && old.every((record, index) => records[at + index] === record)

// `text` with `hunks` applied, each where it says its lines are, else where
// they are as near that as FUZZ lines, the nearest first, the earlier of
// two as near, after those of the hunk before, and as far off where they are
// as the hunks before found theirs.
function applied(text: string, hunks: PatchHunk[]): string {
  const records = text === '' ? [] : text.split(/(?<=\n)/u)
  let floor = 0, shift = 0
  for (const hunk of hunks) {
    const expected = hunk.at + shift
    let found = -1
    for (let step = 0; step <= 2 * FUZZ && found === -1; step++) {
      const at = expected + (step % 2 === 1 ? -(step + 1) / 2 : step / 2)
      if (at >= floor && isAt(records, hunk.old, at)) found = at
    }
    if (found === -1) throw doesNotApply()
    records.splice(found, hunk.old.length, ...hunk.new)
    shift = found - hunk.at + hunk.new.length - hunk.old.length
    floor = found + hunk.new.length
  }
  return records.join('')
}

// A version's `files` with `patch` applied, in the order of their paths, as
// its tarball's are read; a file it changes the text of must be text.
export function patchedFiles(files: NpmPackageFile[], patch: PatchedFile[]): NpmPackageFile[] {
  const byPath = new Map(files.map(file => [file.path, file.bytes]))
  const encoder = new TextEncoder()
  for (const file of patch) {
    if (file.created) {
      if (byPath.has(file.path)) throw doesNotApply()
      byPath.set(file.path, encoder.encode(applied('', file.hunks)))
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
  return [...byPath].map(([path, bytes]) => ({ path, bytes })).toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

// About the bytes a patch read takes: the characters of its paths and of the
// lines its hunks hold, and the room past them each line takes (LINE_COST)
// and each hunk and file (HUNK_COST), as V8 takes it; so a patch of a few
// long lines (a minified file's) weighs about its size, and one of many
// short lines or tiny hunks many times it, as it takes.
const HUNK_COST = 512, LINE_COST = 32
const held = (records: string[]) => records.reduce((sum, record) => sum + LINE_COST + record.length, 0)
export const patchWeight = (files: PatchedFile[]) => files.reduce((sum, file) => sum + HUNK_COST + file.path.length + (file.from?.length ?? 0)
  + file.hunks.reduce((bytes, hunk) => bytes + HUNK_COST + held(hunk.old) + held(hunk.new), 0), 1)

// Patches read lately, by their source and hash, as what a commit holds never
// changes: as many as MAX_KEPT_PATCHES of the bytes they take (patchWeight).
const MAX_KEPT_PATCHES = 64 * 1024 * 1024
const patches: Lru<PatchedFile[]> = lru(MAX_KEPT_PATCHES, patchWeight)

// The patch `patch` names, read as kept, else of repository `fullName` with
// `token`, held to its hash and read (parsePatch), and kept; `asked` told
// where GitHub was. Its file missing there, or other than its hash says, or
// past MAX_PATCH_BYTES, fails.
export async function readPatch(fullName: string, token: string, patch: NpmPatch, asked?: GithubAsked): Promise<PatchedFile[]> {
  const key = `${patch.repoId}\0${patch.commit}\0${patch.path}\0${patch.hash}`
  const known = patches.get(key)
  if (known) return known
  if (asked) asked.github = true
  let text: string
  try {
    text = await upstreamGithub(() => createClient({ token, userAgent: 'deepview-triage' }).getRepoFile({ repo: fullName, path: patch.path, ref: patch.commit }))
  } catch (err) {
    if (err instanceof GithubApiError && err.message === 'github-not-found') throw new NpmPackageError(404, 'patch-not-found')
    throw err
  }
  if (Buffer.byteLength(text) > MAX_PATCH_BYTES) throw new NpmPackageError(413, 'patch-too-large')
  if (!isPatchOf(text, patch.hash)) throw new NpmPackageError(409, 'patch-mismatch')
  const files = parsePatch(text)
  patches.set(key, files)
  return files
}
