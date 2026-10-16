// The files each commit changes, as the code viewer's Replay plays them
// (GET /api/admin/repositories/changes), as `git log --name-status` lists
// them: each file's path and whether the commit added (`A`), modified (`M`),
// removed (`D`) or renamed (`R`, with the path it had) it, as GitHub's REST
// API lists a commit's files (GET /repos/:owner/:repo/commits/:sha), the
// first page of them, as many as MAX_FILES, `more` where it had more. What
// a commit changes never changes, so each is kept by the commit (`kept`),
// whole, read of GitHub once; what a reader is answered, only the files
// within the directory they asked of (changesWithin). And the files a
// commit holds, which Replay starts from (GET /api/admin/repositories/tree),
// as GitHub lists its tree at once (repositoryTree), kept as well.

import { GithubApiError, githubJson } from './github-app.ts'

// Commits an answer tells at most, read of GitHub as many at once as
// CHANGES_PARALLEL.
export const CHANGES_ASKED = 50
const CHANGES_PARALLEL = 6
// GitHub's first page of a commit's files.
export const MAX_FILES = 300
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

// What each of `shas` changes, kept, else read of GitHub and then kept; null
// for one GitHub has no commit of (as one of another repository is).
export async function repositoryChanges(fullName: string, token: string | null, shas: string[], kept: ChangesStore,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<Map<string, CommitChanges | null>> {
  const asked = [...new Set(shas)].filter(sha => SHA.test(sha))
  const found = new Map<string, CommitChanges | null>(await kept.read(asked))
  const repo = `https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`
  await eachOf(asked.filter(sha => !found.has(sha)), CHANGES_PARALLEL, async sha => {
    try {
      const changes = commitChanges(await githubJson(`${repo}/commits/${sha}`, token, fetchImpl))
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

// The files a commit holds, as many as MAX_TREE_FILES, each by its path, as
// GitHub lists its tree and every tree under it at once
// (GET /repos/:owner/:repo/git/trees/:commit?recursive=1): its blobs, not
// its directories nor submodules; `cut` where some are left out, GitHub's
// listing cut short (past 100,000 entries) or more than MAX_TREE_FILES. Null
// for a commit GitHub has none of.
export const MAX_TREE_FILES = 25_000
export interface CommitTree { files: string[]; cut: boolean }
export interface TreeStore {
  read(commit: string): Promise<CommitTree | null>
  write(commit: string, tree: CommitTree): Promise<void>
}

export async function repositoryTree(fullName: string, token: string | null, commit: string, kept: TreeStore,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<CommitTree | null> {
  if (!SHA.test(commit)) return null
  const held = await kept.read(commit)
  if (held) return held
  let data: { tree?: unknown; truncated?: unknown }
  try {
    data = await githubJson(`https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}/git/trees/${commit}?recursive=1`,
      token, fetchImpl) as typeof data
  } catch (err) {
    if (err instanceof GithubApiError && (err.message === 'github-not-found' || err.message === 'github-status-422')) return null
    throw err
  }
  if (!Array.isArray(data?.tree)) throw new GithubApiError(502, 'github-malformed')
  const files = (data.tree as { type?: unknown; path?: unknown }[]).flatMap(item => item?.type === 'blob' && pathOf(item.path) ? [item.path as string] : [])
  const tree = { files: files.slice(0, MAX_TREE_FILES), cut: data.truncated === true || files.length > MAX_TREE_FILES }
  await kept.write(commit, tree)
  return tree
}

// The files of a tree within the directory `path` ('' the whole repository).
export const treeWithin = ({ files, cut }: CommitTree, path: string): CommitTree =>
  ({ files: path === '' ? files : files.filter(file => file.startsWith(`${path}/`)), cut })

// The commits a request names (`shas`), each once, as many as
// CHANGES_ASKED; null for none, or for one that isn't a commit id.
export function changesAsked(shas: string | null): string[] | null {
  if (!shas) return null
  const asked = [...new Set(shas.split(','))]
  return asked.length <= CHANGES_ASKED && asked.every(sha => SHA.test(sha)) ? asked : null
}
