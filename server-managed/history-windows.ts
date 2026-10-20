// A default branch's history read by when its commits were made, for the
// Pulse (repository-pulse.ts yearCommits): where the pages kept from a head
// run out, the rest of the time it needs read at once, in windows of time
// (GitHub's `history(since:, until:)`), not a page after another, each page
// waiting on the last; and the pages GitHub would list from the commits read
// (git log) kept by their tops, as reading a page at a time keeps them, so a
// walk later, from a head moved on or in the Commits tab, reads them kept.
import { linkNoreplyUsers } from './github-accounts.ts'
import { githubGraphql } from './github-graphql.ts'
import { COMMIT_FRAGMENT, type GraphCommit, HISTORY_PAGE, type HistoryCommit, type HistoryPages, PAGES_PARALLEL, PAGES_PER_QUERY, commitActors, graphCommit,
  inBatches, variablesOf } from './repository-history.ts'

// Windows a read is split into at most, each meant to hold as many commits
// as WINDOW_COMMITS, a page's worth with room to spare, as often as the
// commits read before it were made, as far back as they reach, the rest left
// to the next read; pages read of them at most a read, those over going on
// where a window holds more, as many times as MAX_WAVES, each waiting on the
// last; and pages kept of what was read at most.
const MAX_WINDOWS = 40
const WINDOW_COMMITS = 70
const WINDOW_PAGES = 50
const MAX_WAVES = 5
const MAX_KEPT = 500
const KEPT_AT_ONCE = 10
const WINDOWS_AFTER = 2
const HOUR_MS = 60 * 60_000

// Each window's commits from `$head`, `w<n>` the `n`th's: those made since
// `$s<n>` (none, any time) and until `$u<n>`, after `$a<n>`.
const windowsQuery = (count: number) => `query($owner: String!, $name: String!, $head: GitObjectID!, ${variablesOf('s', count, 'GitTimestamp')}, ${
  variablesOf('u', count, 'GitTimestamp!')}, ${variablesOf('a', count, 'String')}) {
  repository(owner: $owner, name: $name) {
    object(oid: $head) { ... on Commit {
      ${Array.from({ length: count }, (_, at) => `w${at}: history(first: ${HISTORY_PAGE}, since: $s${at}, until: $u${at}, after: $a${at}) {
        pageInfo { hasNextPage endCursor } nodes { ...historyCommit } }`).join('\n      ')}
    } }
  }
}
${COMMIT_FRAGMENT}`

type Window = { since: number | null; until: number; after: string | null; oldest?: number }
type WindowPage = { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: GraphCommit[] } | null
type Windows = { repository?: { object?: Record<string, WindowPage> | null } | null } | null
// A time as GitHub takes it, to the second: a window's start rounded down,
// its end up, so that those beside each other overlap rather than part.
const stamp = (at: number, up: boolean) => new Date((up ? Math.ceil : Math.floor)(at / 1000) * 1000).toISOString()

// The commits from `head` made from `low` to `high`, as often as `perMs` (commits
// a millisecond) says they are made, as many windows as MAX_WINDOWS reach
// down from `high`, read at once (inBatches), the latest first, each paged on
// as far as it goes, as many pages as WINDOW_PAGES; and, those reaching
// `low`, a page of those made before it besides, where a walk reading them
// goes on from. Since when every one is read (`through`: where the windows
// reach, each read whole, else, of the latest not, just after the earliest
// made of those it read, as GitHub lists them the latest made first, those
// made together left out; or its end, none read), and how many pages were
// read (`read`).
export async function readWindows(fullName: string, token: string, head: string, low: number, high: number, perMs: number, fetchImpl: typeof fetch) {
  const [owner, name] = fullName.split('/') as [string, string]
  const bottom = Math.max(low, high - MAX_WINDOWS * WINDOW_COMMITS / perMs)
  const count = Math.min(MAX_WINDOWS, Math.max(1, Math.ceil((high - bottom) * perMs / WINDOW_COMMITS)))
  const width = (high - bottom) / count
  let open: Window[] = [...Array.from({ length: count }, (_, at) => ({ since: high - (at + 1) * width, until: high - at * width, after: null })),
    ...bottom > low ? [] : [{ since: null, until: low - 1000, after: null }]]
  const commits = new Map<string, HistoryCommit>()
  let [read, waves] = [0, 0]
  while (open.length > 0 && read < WINDOW_PAGES && waves++ < MAX_WAVES) {
    const wave = open.slice(0, WINDOW_PAGES - read)
    const next: Window[] = []
    read += wave.length
    await inBatches(wave, PAGES_PER_QUERY, PAGES_PARALLEL, async batch => {
      const data = await githubGraphql(windowsQuery(batch.length), { owner, name, head, ...Object.fromEntries(batch.flatMap((window, at) => [
        [`s${at}`, window.since === null ? null : stamp(window.since, false)], [`u${at}`, stamp(window.until, true)], [`a${at}`, window.after]])) }, token, fetchImpl) as Windows
      const pages = batch.map((_, at) => data?.repository?.object?.[`w${at}`] ?? null)
      await linkNoreplyUsers(pages.flatMap(page => page?.nodes ?? []).flatMap(commitActors), token, fetchImpl)
      for (const [at, window] of batch.entries()) {
        let oldest = window.oldest ?? Number.POSITIVE_INFINITY
        for (const commit of (pages[at]?.nodes ?? []).flatMap(node => graphCommit(node) ?? [])) {
          if (!commits.has(commit.sha)) commits.set(commit.sha, commit)
          oldest = Math.min(oldest, commit.committedAt ?? Number.POSITIVE_INFINITY)
        }
        const info = pages[at]?.pageInfo
        if (window.since !== null && info?.hasNextPage === true && typeof info.endCursor === 'string') next.push({ ...window, after: info.endCursor, oldest })
      }
    })
    open = [...next, ...open.slice(wave.length)]
  }
  const through = Math.max(bottom, ...open.flatMap(window => window.since === null ? [] : [Number.isFinite(window.oldest) ? window.oldest! + 1 : window.until]))
  return { commits: [...commits.values()], through, read }
}

// The page GitHub would list from `top` (git log: of those reached, the
// latest made first, of those made together the first reached) of `known`
// commits, every one made since `low` known; none where it would list one not
// known, or one made before `low` while one not known waits beside it.
export function gitLogPage(top: string, known: Map<string, HistoryCommit>, low: number): HistoryCommit[] | null {
  if (!known.has(top)) return null
  const page: HistoryCommit[] = []
  const reached = new Set<string>()
  const waiting: HistoryCommit[] = []
  let unknown = 0
  const reach = (sha: string) => {
    if (reached.has(sha)) return
    reached.add(sha)
    const commit = known.get(sha)
    if (!commit || commit.committedAt === null) { unknown++; return }
    const at = waiting.findIndex(other => other.committedAt! < commit.committedAt!)
    waiting.splice(at < 0 ? waiting.length : at, 0, commit)
  }
  reach(top)
  while (page.length < HISTORY_PAGE && waiting.length > 0) {
    const commit = waiting.shift()!
    if (commit.committedAt! < low && unknown > 0) return null
    page.push(commit)
    for (const parent of commit.parents) reach(parent)
  }
  return page.length < HISTORY_PAGE && unknown > 0 ? null : page
}

// The pages from each of `tops` GitHub would list of `known` commits
// (gitLogPage), kept by their tops, KEPT_AT_ONCE at a time, and from the
// parents of those they list that none of `listed` is nor any kept lists, on
// till none is left, as many as MAX_KEPT: as a walk reading pages goes on to
// them.
export async function keepPages(tops: string[], known: Map<string, HistoryCommit>, listed: Set<string>, low: number, pages: HistoryPages) {
  const covered = new Set(listed)
  const kept: [string, HistoryCommit[]][] = []
  const waiting = [...tops]
  while (waiting.length > 0 && kept.length < MAX_KEPT) {
    const top = waiting.shift()!
    if (covered.has(top)) continue
    const page = gitLogPage(top, known, low)
    if (!page) continue
    kept.push([top, page])
    for (const commit of page) covered.add(commit.sha)
    for (const commit of page) for (const parent of commit.parents) if (!covered.has(parent) && known.has(parent)) waiting.push(parent)
  }
  for (let at = 0; at < kept.length; at += KEPT_AT_ONCE) await Promise.all(kept.slice(at, at + KEPT_AT_ONCE).map(([top, page]) => pages.write(top, page)))
}

// What a walk from `head` (yearCommits) reads next of `starts`: those a page
// is kept from (`batch`), where any is, or all of them, a page at a time, as
// long as it has read GitHub fewer times than WINDOWS_AFTER (`queries`), a
// head moved on soon reaching the pages kept from where it was; else, none
// kept, those made from
// `low` to `high` read at once (readWindows), as often as those `found`
// were made, told it (`found`), and the pages from `starts` on kept of them,
// as far down as every one is read (keepPages), the queries that took
// (`queries`, PAGES_PER_QUERY pages each, as many at once as PAGES_PARALLEL
// a query of its) and none to read (`windowed`); where the windows can't be
// read, all of them, a page at a time (`windowed` all the same).
export async function windowsOn(fullName: string, token: string, head: string, starts: string[], found: Map<string, HistoryCommit>, low: number, high: number,
  pages: HistoryPages, fetchImpl: typeof fetch, queries: number): Promise<{ batch: string[]; queries: number; windowed: boolean }> {
  const kept = await pages.read(starts)
  if (kept.size > 0 || queries < WINDOWS_AFTER || !(high > low) || !Number.isFinite(high)) {
    return { batch: kept.size > 0 ? starts.filter(sha => kept.has(sha)) : starts, queries: 0, windowed: false }
  }
  let [newest, oldest, dated] = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 0]
  for (const { committedAt } of found.values()) {
    if (committedAt === null) continue
    [newest, oldest, dated] = [Math.max(newest, committedAt), Math.min(oldest, committedAt), dated + 1]
  }
  // From the one commit the walk goes on from, where there is one, none of
  // those read listed again; else from the head.
  const read = await readWindows(fullName, token, starts.length === 1 ? starts[0]! : head, low, high, dated / Math.max(newest - oldest, HOUR_MS), fetchImpl)
    .catch((err: unknown) => { console.warn('managed: history windows read failed:', err); return null })
  if (!read) return { batch: starts, queries: 0, windowed: true }
  const listed = new Set(found.keys())
  for (const commit of read.commits) if (!found.has(commit.sha)) found.set(commit.sha, commit)
  await keepPages(starts, found, listed, read.through, pages)
  return { batch: [], queries: Math.ceil(read.read / (PAGES_PER_QUERY * PAGES_PARALLEL)), windowed: true }
}
