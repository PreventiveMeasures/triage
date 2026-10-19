// A period's pull requests and issues, as the Pulse shows them
// (repository-pulse.ts repositoryActivity), told of those the repository's
// tabs keep (repository-pulls.ts readList) rather than searched for.
import { LISTED, type PulseNarrowing, pulseSince } from './repository-pulse.ts'
import type { KeptIssue, KeptPull } from './repository-pulls.ts'

const DAY_MS = 24 * 60 * 60_000
const WEEK_MS = 7 * DAY_MS

// What repositoryActivity tells, of the pull requests and issues kept
// (repository-pulls.ts readList: `pulls` and `issues`, those updated since
// the period before it started all read): each counted by the day (UTC), as
// a search counts it, its narrowing's `authors` by login whatever its case,
// an app's bot (`name[bot]`) its own, not a user's of its name, and the
// latest of each listed, as many
// as LISTED, those merged or closed the latest of all.
export function listedActivity(pulls: KeptPull[], issues: KeptIssue[], weeks: number, now: number = Date.now(), narrowing: PulseNarrowing | null = null) {
  const since = pulseSince(weeks, now)
  const back = weeks * WEEK_MS
  const dayOf = (at: number) => Math.floor(at / DAY_MS) * DAY_MS
  const [from, to] = [dayOf(narrowing?.from ?? since), narrowing?.to == null ? Number.POSITIVE_INFINITY : dayOf(narrowing.to) + DAY_MS]
  const [before, beforeEnd] = [dayOf(since - back), dayOf(now - back) + DAY_MS]
  // A login whatever its case, a bot's (`name[bot]`, as REST names it) apart from a user's of its name.
  const loginOf = (login: string, bot = false) => `${login.toLowerCase().replace(/\[bot\]$/u, '')}${bot || /\[bot\]$/iu.test(login) ? '[bot]' : ''}`
  const authors = new Set((narrowing?.authors ?? []).map(login => loginOf(login)))
  const by = (row: KeptPull | KeptIssue) => authors.size === 0 || (row.author !== null && authors.has(loginOf(row.author, row.bot)))
  const told = <T extends KeptPull | KeptIssue>(rows: T[], when: (row: T) => number | null, item: (row: T, at: number) => object) => {
    const timed = rows.flatMap(row => { const at = when(row); return at !== null && by(row) ? [{ row, at }] : [] })
    const within = timed.filter(({ at }) => at >= from && at < to)
    return { count: within.length, previous: timed.filter(({ at }) => at >= before && at < beforeEnd).length,
      items: within.toSorted((a, b) => b.at - a.at).slice(0, LISTED).map(({ row, at }) => item(row, at)) }
  }
  const common = (row: KeptPull | KeptIssue, at: number) => ({ number: row.number, title: row.title, author: row.author, authorId: row.authorId ?? null, at,
    createdAt: row.createdAt })
  const pull = (row: KeptPull, at: number) => ({ ...common(row, at), kind: 'pulls', state: row.state, draft: row.draft })
  const issue = (row: KeptIssue, at: number) => ({ ...common(row, at), kind: 'issues', state: row.state, reason: row.reason })
  return { since, previousSince: since - back, merged: told(pulls, row => row.merged?.at ?? null, pull), opened: told(pulls, row => row.createdAt, pull),
    closed: told(issues, row => row.state === 'closed' ? row.closedAt : null, issue), created: told(issues, row => row.createdAt, issue) }
}
