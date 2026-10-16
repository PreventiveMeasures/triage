// The files each commit changes, as the code viewer's Replay plays them
// (GET /api/admin/repositories/changes), as `git log --name-status` lists
// them: each file's path and whether the commit added (`A`), modified (`M`),
// removed (`D`) or renamed (`R`, with the path it had) it, as GitHub's REST
// API lists a commit's files (GET /repos/:owner/:repo/commits/:sha), a
// page of FILES_PAGE at a time, as many as MAX_FILES, `more` where it had
// more. What a commit changes never changes, so each is kept by the commit
// (`kept`), whole, read of GitHub once; what a reader is answered, only the
// files within the directory they asked of (changesWithin). And the files a
// commit holds, which Replay starts from (GET /api/admin/repositories/tree),
// as GitHub lists its tree at once (repositoryTree), kept as well.

import { GithubApiError, githubJson } from './github-app.ts'

// Commits an answer tells at most, read of GitHub as many at once as
// CHANGES_PARALLEL.
export const CHANGES_ASKED = 50
const CHANGES_PARALLEL = 6
// A commit's files read, as many as fill MAX_FILES, FILES_PAGE a page (the
// most GitHub lists a page; it lists fewer, unasked).
export const MAX_FILES = 300
export const FILES_PAGE = 100
const MAX_PATH = 4096
const SHA = /^[a-f\d]{40}$/u

export type ChangeStatus = 'A' | 'M' | 'D' | 'R'
// A file a commit changes: its path, its status, and a rename's path before.
export type ChangedFile = [path: string, status: Exclude<ChangeStatus, 'R'>] | [path: string, status: 'R', from: string]
export interface CommitChanges { files: ChangedFile[]; more: boolean }

// What each commit changes kept, by the commit.
export interface ChangesStore {
  read(shas: string[]): Promise<Map<string, CommitChanges>>
  write(sha: string, changes: CommitChanges): Promise<void>
}

const pathOf = (value: unknown) => typeof value === 'string' && value !== '' && value.length <= MAX_PATH && !/\p{Cc}/u.test(value) ? value : null

// A file's status as git names it: a copy is a file added; one GitHub
// lists unchanged (its mode alone changed, say) changes none.
const STATUSES: Record<string, ChangeStatus> = { added: 'A', copied: 'A', modified: 'M', changed: 'M', removed: 'D', renamed: 'R' }

type GithubFile = { filename?: unknown; status?: unknown; previous_filename?: unknown }

// A commit's files as GitHub lists them; a rename it names no path before
// for, a file added.
export function commitChanges(data: unknown): CommitChanges {
  const listed = (data as { files?: unknown } | null)?.files
  if (!Array.isArray(listed)) throw new GithubApiError(502, 'github-malformed')
  const files = (listed as GithubFile[]).slice(0, MAX_FILES).flatMap((file): ChangedFile[] => {
    const path = pathOf(file?.filename)
    const status = typeof file?.status === 'string' ? STATUSES[file.status] : undefined
    if (!path || !status) return []
    const from = status === 'R' ? pathOf(file.previous_filename) : null
    return [status === 'R' ? from ? [path, 'R', from] : [path, 'A'] : [path, status]]
  })
  return { files, more: listed.length >= MAX_FILES }
}

// What a commit changes within the directory `path` ('' the whole
// repository): its files there, a rename across its edge the file added
// where it came in, removed where it went out.
export function changesWithin({ files, more }: CommitChanges, path: string): CommitChanges {
  if (path === '') return { files, more }
  const within = (file: string) => file.startsWith(`${path}/`)
  return { more, files: files.flatMap((file): ChangedFile[] => {
    if (file[1] !== 'R') return within(file[0]) ? [file] : []
    const [to, , from] = file
    if (within(to)) return [within(from) ? file : [to, 'A']]
    return within(from) ? [[from, 'D']] : []
  }) }
}

// Runs `run` for each of `items`, as many at once as `parallel`.
async function eachOf<T>(items: T[], parallel: number, run: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, async () => { while (next < items.length) await run(items[next++]!) }))
}

// A commit's files as GitHub lists them, read a page at a time while each
// is full, till MAX_FILES are.
async function commitFiles(url: string, token: string | null, fetchImpl: typeof fetch) {
  const files: unknown[] = []
  for (let page = 1; files.length < MAX_FILES; page++) {
    const data = await githubJson(`${url}?per_page=${FILES_PAGE}&page=${page}`, token, fetchImpl) as { files?: unknown } | null
    if (!Array.isArray(data?.files)) throw new GithubApiError(502, 'github-malformed')
    files.push(...data.files)
    if (data.files.length < FILES_PAGE) break
  }
  return { files }
}

// What each of `shas` changes, kept, else read of GitHub and then kept; null
// for one GitHub has no commit of (as one of another repository is).
export async function repositoryChanges(fullName: string, token: string | null, shas: string[], kept: ChangesStore,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<Map<string, CommitChanges | null>> {
  const asked = [...new Set(shas)].filter(sha => SHA.test(sha))
  const found = new Map<string, CommitChanges | null>(await kept.read(asked))
  const repo = `https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`
  await eachOf(asked.filter(sha => !found.has(sha)), CHANGES_PARALLEL, async sha => {
    try {
      const changes = commitChanges(await commitFiles(`${repo}/commits/${sha}`, token, fetchImpl))
      found.set(sha, changes)
      await kept.write(sha, changes)
    } catch (err) {
      // No such commit: GitHub's 404, or its 422 for an id naming none.
      if (err instanceof GithubApiError && (err.message === 'github-not-found' || err.message === 'github-status-422')) found.set(sha, null)
      else throw err
    }
  })
  return new Map(asked.map(sha => [sha, found.get(sha) ?? null]))
}

// The files a commit (or a tree) holds, as many as MAX_TREE_FILES, each by its path and
// its bytes (`sizes`, in the same order), as
// GitHub lists its tree and every tree under it at once
// (GET /repos/:owner/:repo/git/trees/:tree?recursive=1); where GitHub cuts
// that listing short (past 100,000 entries or 7 MB, as a large repository's
// is), as GitHub advises: the tree's own entries listed alone, and each tree
// in it read so in turn, as many at once as TREES_PARALLEL (treeByTrees).
// Its blobs, not its directories nor submodules, sorted by path; past
// MAX_TREE_FILES those nearest its root of those read, `cut` where some are
// left out: more files than MAX_TREE_FILES, a tree's own entries cut short,
// or more trees to read than MAX_TREE_READS.
// Null for a commit GitHub has none of. Kept by the commit and the rules it
// is read by (TREES_READ), a tree kept by older ones (without sizes, the
// last) read again.
export const MAX_TREE_FILES = 75_000
export const TREES_READ = 3
const MAX_TREE_READS = 400
const TREES_PARALLEL = 6
export interface CommitTree { files: string[]; sizes: number[]; cut: boolean }
export interface TreeStore {
  read(commit: string): Promise<CommitTree | null>
  write(commit: string, tree: CommitTree): Promise<void>
}

type TreeEntry = { type?: unknown; path?: unknown; sha?: unknown; size?: unknown }
// A file read: its path and its bytes.
type Blob = [path: string, size: number]
type TreeListing = (tree: string, recursive: boolean) => Promise<{ entries: TreeEntry[]; truncated: boolean }>

export async function repositoryTree(fullName: string, token: string | null, commit: string, kept: TreeStore,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<CommitTree | null> {
  if (!SHA.test(commit)) return null
  const held = await kept.read(commit)
  if (held) return held
  const repo = `https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`
  const listing: TreeListing = async (tree, recursive) => {
    const data = await githubJson(`${repo}/git/trees/${tree}${recursive ? '?recursive=1' : ''}`, token, fetchImpl) as { tree?: unknown; truncated?: unknown }
    if (!Array.isArray(data?.tree)) throw new GithubApiError(502, 'github-malformed')
    return { entries: data.tree as TreeEntry[], truncated: data.truncated === true }
  }
  let whole: Awaited<ReturnType<TreeListing>>
  try {
    whole = await listing(commit, true)
  } catch (err) {
    if (err instanceof GithubApiError && (err.message === 'github-not-found' || err.message === 'github-status-422')) return null
    throw err
  }
  const files: Blob[] = []
  let cut = false
  if (whole.truncated) cut = await treeByTrees(commit, listing, files)
  else blobsOf(whole.entries, '', files)
  const depth = (path: string) => path.split('/').length
  const byPath = ([a]: Blob, [b]: Blob) => a < b ? -1 : a > b ? 1 : 0
  const nearest = files.length > MAX_TREE_FILES ? files.toSorted((a, b) => depth(a[0]) - depth(b[0]) || byPath(a, b)).slice(0, MAX_TREE_FILES) : files
  const sorted = nearest.toSorted(byPath)
  const tree = { files: sorted.map(([path]) => path), sizes: sorted.map(([, size]) => size), cut: cut || files.length > MAX_TREE_FILES }
  await kept.write(commit, tree)
  return tree
}

// The blobs of a tree's entries, each its path under `prefix` and its bytes
// (none, as GitHub names none), onto `files`.
function blobsOf(entries: TreeEntry[], prefix: string, files: Blob[]) {
  for (const item of entries) {
    if (item?.type !== 'blob' || !pathOf(item.path)) continue
    files.push([`${prefix}${item.path as string}`, Number.isSafeInteger(item.size) && (item.size as number) > 0 ? item.size as number : 0])
  }
}

// The files under the commit's tree, `commit`, onto `files`, its trees read
// a round at a time, those nearest the root first: its own entries, then
// each tree in it whole, or, where that is cut short, alone in turn, and so
// on. Each round read whole, whatever answers first, but for trees no file
// of which could be kept: as deep as, or deeper than, the files nearest the
// root, as many as MAX_TREE_FILES, of those read (files of a tree are at
// least a level deeper than it is). As many trees read in all as
// MAX_TREE_READS, those of a round first in its order. Whether some were
// left out.
async function treeByTrees(commit: string, listing: TreeListing, files: Blob[]): Promise<boolean> {
  let cut = false, reads = 1, round = [{ tree: commit, prefix: '', recursive: false }]
  const atDepth: number[] = []
  let counted = 0
  while (round.length > 0) {
    for (; counted < files.length; counted++) {
      const depth = files[counted]![0].split('/').length
      atDepth[depth] = (atDepth[depth] ?? 0) + 1
    }
    // The depth no file deeper than is kept.
    let kept = Number.POSITIVE_INFINITY
    for (let depth = 0, sum = 0; depth < atDepth.length; depth++) {
      sum += atDepth[depth] ?? 0
      if (sum >= MAX_TREE_FILES) {
        kept = depth
        break
      }
    }
    const asked = round.filter(({ prefix }) => prefix.split('/').length - 1 < kept).slice(0, Math.max(0, MAX_TREE_READS - reads))
    cut ||= asked.length < round.length
    reads += asked.length
    const listed: Awaited<ReturnType<TreeListing>>[] = []
    await eachOf([...asked.keys()], TREES_PARALLEL, async at => { listed[at] = await listing(asked[at]!.tree, asked[at]!.recursive) })
    const next: typeof round = []
    for (const [at, { tree, prefix, recursive }] of asked.entries()) {
      const { entries, truncated } = listed[at]!
      if (truncated && recursive) {
        next.push({ tree, prefix, recursive: false })
        continue
      }
      cut ||= truncated
      blobsOf(entries, prefix, files)
      if (recursive) continue
      for (const item of entries) {
        const path = pathOf(item?.path)
        if (item?.type === 'tree' && path && typeof item.sha === 'string' && SHA.test(item.sha)) next.push({ tree: item.sha, prefix: `${prefix}${path}/`, recursive: true })
      }
    }
    round = next
  }
  return cut
}

// The files commit `commit` holds within the directory `path` ('' the whole
// repository), as repositoryTree reads them: its whole tree's within it; where
// that is cut short, some of the directory's perhaps among those left out,
// the directory's own tree read so (directoryTree), kept by its id, the files
// nearest it kept. Null for a commit GitHub has none of.
export async function directoryFiles(fullName: string, token: string | null, commit: string, path: string, kept: TreeStore,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<CommitTree | null> {
  const whole = await repositoryTree(fullName, token, commit, kept, fetchImpl)
  if (!whole || path === '' || !whole.cut) return whole && treeWithin(whole, path)
  const id = await directoryTree(fullName, token, commit, path, fetchImpl)
  const own = id ? await repositoryTree(fullName, token, id, kept, fetchImpl) : null
  return own ? { ...own, files: own.files.map(file => `${path}/${file}`) } : treeWithin(whole, path)
}

// The id of the tree at `path` in commit `commit`, read a level at a time
// (GET /repos/:owner/:repo/git/trees/:tree, its own entries alone); null
// where it has none there, or GitHub has no such commit.
async function directoryTree(fullName: string, token: string | null, commit: string, path: string, fetchImpl: typeof fetch): Promise<string | null> {
  const repo = `https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`
  let tree = commit
  for (const name of path.split('/')) {
    let data: { tree?: unknown }
    try {
      data = await githubJson(`${repo}/git/trees/${tree}`, token, fetchImpl) as typeof data
    } catch (err) {
      if (err instanceof GithubApiError && (err.message === 'github-not-found' || err.message === 'github-status-422')) return null
      throw err
    }
    if (!Array.isArray(data?.tree)) throw new GithubApiError(502, 'github-malformed')
    const entry = (data.tree as TreeEntry[]).find(item => item?.path === name && item.type === 'tree')
    if (typeof entry?.sha !== 'string' || !SHA.test(entry.sha)) return null
    tree = entry.sha
  }
  return tree
}

// The files of a tree within the directory `path` ('' the whole repository).
export function treeWithin({ files, sizes, cut }: CommitTree, path: string): CommitTree {
  if (path === '') return { files, sizes, cut }
  const within = [...files.keys()].filter(at => files[at]!.startsWith(`${path}/`))
  return { files: within.map(at => files[at]!), sizes: within.map(at => sizes[at]!), cut }
}

// The commits a request names (`shas`), each once, as many as
// CHANGES_ASKED; null for none, or for one that isn't a commit id.
export function changesAsked(shas: string | null): string[] | null {
  if (!shas) return null
  const asked = [...new Set(shas.split(','))]
  return asked.length <= CHANGES_ASKED && asked.every(sha => SHA.test(sha)) ? asked : null
}
