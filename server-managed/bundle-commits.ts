import { setImmediate } from 'node:timers/promises'
import { bundleCommitHash } from '../common/bundle-commit.js'
import type { BundleSummary } from './bundle-cache.ts'
import type { ManagedDb } from './db.ts'
import { type GithubCommit, githubCommitKey } from './github-metadata.ts'

const MAX_MESSAGE_LENGTH = 65_536
const MAX_NAME_LENGTH = 256
// GitHub logins, and the `[bot]` accounts apps commit as.
const GITHUB_LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}(?:\[bot\])?$/u
const BACKFILL_LIMIT = 4
const RETRY_MS = 5 * 60_000

export type CommitDetails = Omit<GithubCommit, 'key' | 'fetchedAt'>
// What a catalog sends with a bundle whose summary records a commit, when
// the cache holds its details, tags pointing to it, or both.
export interface BundleCommitInfo { sha: string; tags: string[]; details: CommitDetails | null }
interface CatalogBundle { id: string; integrity: string; repoId: number | null }
type Summaries = ReadonlyMap<string, { summary: BundleSummary | null }>
export interface MissingCommit { repoId: number; sha: string; key: string }
export interface CommitReader { commitDetails(sha: string): Promise<CommitDetails | null> }

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  // Never leave half of a surrogate pair at the end.
  return value.slice(0, /[\uD800-\uDBFF]/u.test(value[max - 1]!) ? max - 1 : max)
}

function name(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? truncate(value.trim(), MAX_NAME_LENGTH) : null
}

function date(value: unknown): number | null {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isSafeInteger(time) ? time : null
}

// `body` is a GitHub list-commits page that starts at `sha`, so its first
// commit is that one, without the files GET /commits/:sha would add.
export function parseGithubCommit(sha: string, body: unknown): CommitDetails | null {
  const item = Array.isArray(body) ? body[0] as {
    sha?: unknown; author?: { login?: unknown } | null
    commit?: { message?: unknown; author?: { name?: unknown; date?: unknown } | null; committer?: { date?: unknown } | null }
  } | null : null
  if (item?.sha !== sha || typeof item.commit?.message !== 'string') return null
  const login = item.author?.login
  return {
    message: truncate(item.commit.message, MAX_MESSAGE_LENGTH),
    authorName: name(item.commit.author?.name),
    authorLogin: typeof login === 'string' && GITHUB_LOGIN.test(login) ? login : null,
    authoredAt: date(item.commit.author?.date),
    committedAt: date(item.commit.committer?.date),
  }
}

// Reads only the cache: viewing a bundle never requests its commit's tags,
// and a commit missing from the cache is left for backfillBundleCommits. The
// caller lists only bundles the viewer can read; the commit is the one the
// bundle's own summary records, looked up in the repository it is stored at.
export async function bundleCommits(db: ManagedDb, bundles: readonly CatalogBundle[], summaries: Summaries) {
  const wanted = new Map<string, MissingCommit>()
  for (const bundle of bundles) {
    const sha = bundleCommitHash(summaries.get(bundle.integrity)?.summary?.commit)
    if (sha && bundle.repoId != null) wanted.set(bundle.id, { repoId: bundle.repoId, sha, key: githubCommitKey(bundle.repoId, sha) })
  }
  const keys = [...new Set([...wanted.values()].map(commit => commit.key))]
  if (keys.length === 0) return { commits: new Map<string, BundleCommitInfo>(), missing: [] }
  const details = new Map((await db.listGithubCommits(keys)).map(({ key, fetchedAt: _fetchedAt, ...commit }) => [key, commit]))
  const tags = new Map<string, string[]>()
  for (const tag of await db.listGithubCommitTags(keys)) tags.set(tag.key, [...tags.get(tag.key) ?? [], tag.name])
  const commits = new Map<string, BundleCommitInfo>()
  for (const [id, { sha, key }] of wanted) {
    if (details.has(key) || tags.has(key)) commits.set(id, { sha, tags: tags.get(key) ?? [], details: details.get(key) ?? null })
  }
  const missing = [...new Map([...wanted.values()].filter(commit => !details.has(commit.key)).map(commit => [commit.key, commit])).values()]
  return { commits, missing }
}

// Store the details of a commit, read with the reader's verified repository
// access, unless the cache already has them. Best effort: true once cached.
export async function cacheCommitDetails(db: ManagedDb, reader: CommitReader, repoId: number, sha: string): Promise<boolean> {
  const key = githubCommitKey(repoId, sha)
  try {
    if ((await db.listGithubCommits([key])).length > 0) return true
    const details = await reader.commitDetails(sha)
    if (details) await db.setGithubCommits([{ key, ...details, fetchedAt: Date.now() }])
    return details !== null
  } catch { return false }
}

const active = new Set<string>()
const retries = new Map<string, number>()

// Called after the catalog response is sent: the next one has the details.
// Reads each commit with the viewer's own repository access, so a viewer who
// cannot read it on GitHub leaves it for another (retried after a delay for
// them). Commits never change, so each is stored once and kept.
export async function backfillBundleCommits(db: ManagedDb, userId: string, missing: readonly MissingCommit[],
  readerFor: (repoId: number) => Promise<CommitReader | null>): Promise<void> {
  if (missing.length === 0) return
  await setImmediate()
  const now = Date.now()
  for (const [key, retryAt] of retries) if (retryAt <= now) retries.delete(key)
  const batch = missing.filter(commit => !active.has(commit.key) && !retries.has(`${userId}\n${commit.key}`)).slice(0, BACKFILL_LIMIT)
  for (const commit of batch) active.add(commit.key)
  try {
    for (const repoId of new Set(batch.map(commit => commit.repoId))) {
      const reader = await readerFor(repoId).catch(() => null)
      for (const commit of batch.filter(entry => entry.repoId === repoId)) {
        if (!reader || !await cacheCommitDetails(db, reader, repoId, commit.sha)) retries.set(`${userId}\n${commit.key}`, Date.now() + RETRY_MS)
      }
    }
  } finally {
    for (const commit of batch) active.delete(commit.key)
  }
}
