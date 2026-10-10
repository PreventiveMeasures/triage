// Figures and advisories for the npm package viewer's Overview, beside a
// version's files (npm-packages.ts, npm-loads.ts): the package's downloads
// over the last year, from npm's public downloads API; its GitHub
// repository's stars, forks and open issues; and its advisories across every
// published version, as `npm audit` has them and as its repository publishes
// them on GitHub, asked as bundle advisories ask (bundle-advisories.ts). All
// of it is public: npm is asked without the server's token, and a
// repository's figures, tags and advisories are asked for, and kept, only
// where GitHub says it is public. Each
// answer is kept for an hour, a failure not at all; the reader's access to
// the package is checked on every request before any of it is answered
// (http.ts handleNpm).
import type { Advisory, CacheStore } from '@preventive/upstream/advisories.js'
import { HttpError, createClient } from '@preventive/upstream/github.js'
import { ADVISORIES_TIMEOUT_MS, fetchBundleAdvisories } from './bundle-advisories.ts'
import { isExactVersion } from '@preventive/upstream/semver.js'
import { NpmPackageError, plainObject, readLimited } from './npm-packages.ts'

const DOWNLOADS_API = 'https://api.npmjs.org/downloads/range/last-year'
const KEPT_MS = 60 * 60_000
const API_TIMEOUT_MS = 30_000
const API_BYTES = 1024 * 1024
const DAY_MS = 24 * 60 * 60_000
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, moderate: 2, low: 3 }

// Answers kept for an hour by what they answer, at most `max` of them, the
// oldest asked going first; one still being asked for is shared, and one that
// failed, or that `whole` says is partial, is dropped once it is answered.
function kept<T>(max: number, whole: (value: T) => boolean = () => true) {
  const answers = new Map<string, { at: number; value: Promise<T> }>()
  return (key: string, ask: () => Promise<T>): Promise<T> => {
    const now = Date.now()
    const hit = answers.get(key)
    if (hit && now - hit.at < KEPT_MS) return hit.value
    const value = ask()
    answers.delete(key)
    answers.set(key, { at: now, value })
    while (answers.size > max) answers.delete(answers.keys().next().value!)
    const drop = () => { if (answers.get(key)?.value === value) answers.delete(key) }
    value.then(answer => { if (!whole(answer)) drop(); return answer }, drop)
    return value
  }
}

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(value))

// A package's downloads, one count a day from `start` to `end` (UTC dates),
// none for a day npm leaves out; null where npm has none for it.
export interface NpmDownloads { start: string; end: string; days: number[] }

async function askDownloads(name: string): Promise<NpmDownloads | null> {
  let res: Response
  try { res = await fetch(`${DOWNLOADS_API}/${name}`, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT_MS) }) }
  catch { throw new NpmPackageError(502, 'upstream-unavailable') }
  if (res.status === 404) { await res.body?.cancel(); return null }
  if (!res.ok) { await res.body?.cancel(); throw new NpmPackageError(502, 'upstream-unavailable') }
  let json: unknown
  try { json = JSON.parse((await readLimited(res, API_BYTES)).toString('utf8')) }
  catch { throw new NpmPackageError(502, 'upstream-invalid') }
  if (!plainObject(json) || !isDay(json['start']) || !isDay(json['end']) || !Array.isArray(json['downloads'])) throw new NpmPackageError(502, 'upstream-invalid')
  const start = Date.parse(json['start'])
  const length = (Date.parse(json['end']) - start) / DAY_MS + 1
  if (!Number.isSafeInteger(length) || length < 1 || length > 400) throw new NpmPackageError(502, 'upstream-invalid')
  const days = Array.from({ length }, () => 0)
  for (const row of json['downloads']) {
    if (!plainObject(row) || !isDay(row['day'])) continue
    const at = (Date.parse(row['day']) - start) / DAY_MS
    if (Number.isSafeInteger(at) && at >= 0 && at < length) days[at] = count(row['downloads'])
  }
  return { start: json['start'], end: json['end'], days }
}

const downloads = kept<NpmDownloads | null>(500)

export function npmDownloads(name: string): Promise<NpmDownloads | null> {
  return downloads(name, () => askDownloads(name))
}

// A public repository's figures: GitHub's `openIssues` takes in its open pull
// requests, which `openPulls` counts on their own, null where GitHub didn't
// say.
export interface NpmGithubStats {
  repo: string; stars: number; forks: number; openIssues: number; openPulls: number | null; archived: boolean; pushedAt: string | null
}

// How many pull requests a repository has open: the last page of their list,
// one a page, as its Link header names it, or the one page's length.
async function countOpenPulls(repo: string, token: string | null): Promise<number | null> {
  const path = repo.split('/').map(encodeURIComponent).join('/')
  let res: Response
  try {
    res = await fetch(`https://api.github.com/repos/${path}/pulls?state=open&per_page=1`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'deepview-triage', ...token && { authorization: `Bearer ${token}` } },
      redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
  } catch { return null }
  if (!res.ok) { await res.body?.cancel(); return null }
  const last = /[?&]page=(\d+)>;\s*rel="last"/u.exec(res.headers.get('link') ?? '')?.[1]
  if (last !== undefined) { await res.body?.cancel(); return Number(last) }
  try {
    const json = JSON.parse((await readLimited(res, API_BYTES)).toString('utf8')) as unknown
    return Array.isArray(json) ? json.length : null
  } catch { return null }
}

// What GitHub answers for `repo` where it says it is public, with the token
// it was asked with: `token`, or none where that is revoked. Null where GitHub
// has no such repository to show, or it is not public; anything else fails,
// to be asked again next time. Public is `visibility: 'public'`, as
// github-app.ts requires: an internal repository answers `private: false`.
async function publicRepo(repo: string, token: string | null): Promise<{ json: Record<string, unknown> & { full_name: string }; auth: string | null } | null> {
  const ask = (auth: string | null) => createClient({ token: auth, userAgent: 'deepview-triage' }).getRepo({ repo }) as Promise<unknown>
  let auth = token, json: unknown
  try { json = await ask(token) }
  catch (error) {
    if (!(error instanceof HttpError) || ![401, 404].includes(error.status)) throw error
    if (error.status === 404 || token === null) return null
    auth = null
    try { json = await ask(null) }
    catch (retry) { if (retry instanceof HttpError && retry.status === 404) return null; throw retry }
  }
  if (!plainObject(json) || json['private'] !== false || json['visibility'] !== 'public' || typeof json['full_name'] !== 'string') return null
  return { json: json as Record<string, unknown> & { full_name: string }, auth }
}

async function askGithub(repo: string, token: string | null): Promise<NpmGithubStats | null> {
  const found = await publicRepo(repo, token)
  if (found === null) return null
  const { json, auth } = found
  return {
    repo: json['full_name'], stars: count(json['stargazers_count']), forks: count(json['forks_count']), openIssues: count(json['open_issues_count']),
    openPulls: await countOpenPulls(json['full_name'], auth),
    archived: json['archived'] === true, pushedAt: typeof json['pushed_at'] === 'string' ? json['pushed_at'] : null,
  }
}

const repositories = kept<NpmGithubStats | null>(1000)

// `repo` as a package's manifest names it (owner/name); `githubToken` the
// reader's own, where they have one, for GitHub's rate limits, never for what
// it shows, asked for only where the figures aren't kept.
export function npmGithubStats(repo: string, githubToken: () => Promise<string | null>): Promise<NpmGithubStats | null> {
  return repositories(repo.toLowerCase(), async () => askGithub(repo, await githubToken()))
}

const GITHUB_GRAPHQL = 'https://api.github.com/graphql'
// A ref's target is a commit, or for an annotated tag a tag object, which may
// itself name another tag before the commit.
const TAGS_QUERY = `query($owner: String!, $name: String!, $query: String!) {
  repository(owner: $owner, name: $name) {
    visibility
    refs(refPrefix: "refs/tags/", query: $query, first: 100) {
      nodes { name target { __typename oid ... on Tag { target { __typename oid ... on Tag { target { __typename oid } } } } } }
    }
  }
}`

function taggedCommit(target: unknown): unknown {
  let at = target
  for (let depth = 0; depth < 3 && plainObject(at) && at['__typename'] === 'Tag'; depth++) at = at['target']
  return plainObject(at) && at['__typename'] === 'Commit' ? at['oid'] : null
}

async function askTags(repo: string, sha: string, version: string, token: string): Promise<string[]> {
  const [owner, name] = repo.split('/')
  let res: Response
  try {
    res = await fetch(GITHUB_GRAPHQL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'deepview-triage' },
      body: JSON.stringify({ query: TAGS_QUERY, variables: { owner, name, query: version } }),
    })
  } catch { throw new NpmPackageError(502, 'upstream-unavailable') }
  if (!res.ok) { await res.body?.cancel(); throw new NpmPackageError(502, 'upstream-unavailable') }
  let json: unknown
  try { json = JSON.parse((await readLimited(res, API_BYTES)).toString('utf8')) }
  catch { throw new NpmPackageError(502, 'upstream-invalid') }
  const data = plainObject(json) ? json['data'] : null
  const repository = plainObject(data) ? data['repository'] : null
  // A repository gone, or not public (private, or internal to an enterprise),
  // has none to show anyone.
  if (!plainObject(repository) || repository['visibility'] !== 'PUBLIC') return []
  const refs = repository['refs']
  const nodes = plainObject(refs) && Array.isArray(refs['nodes']) ? refs['nodes'] as unknown[] : []
  return nodes.filter((node): node is { name: string; target: unknown } => plainObject(node) && typeof node['name'] === 'string' && node['name'] !== '')
    .filter(node => taggedCommit(node.target) === sha).map(node => node.name).toSorted()
}

// Null where no token asked: nothing to keep for a reader who has one.
const commitTags = kept<string[] | null>(500, tags => tags !== null)

// The tags of a public repository (owner/name) that point to `sha`, a
// version's publish commit, among those naming its `version` (`v1.2.3`,
// `pkg@1.2.3`, …), as GitHub's GraphQL API finds them by name. GraphQL needs
// a token: the reader's own (`githubToken`, asked for only where the tags
// aren't kept), where they have one; without, none are asked.
export async function npmCommitTags(repo: string, sha: string, version: string, githubToken: () => Promise<string | null>): Promise<string[]> {
  return await commitTags(`${repo.toLowerCase()}\0${sha}\0${version}`, async () => {
    const token = await githubToken()
    return token === null ? null : askTags(repo, sha, version, token)
  }) ?? []
}

// An advisory on the package, with the versions it covers as their indexes in
// the list it was asked with: npm's (`registry`), or one its repository
// publishes on GitHub before GitHub reviews it into npm's (`repository`).
export interface NpmAdvisory {
  id: string; source: Advisory['source']; ghsa?: string; url?: string; title?: string; severity?: string; cvss?: number; cwe: string[]; range?: string
  affected: number[]
}

// `repository` false where the repository's advisories could not be had
// (GitHub refusing, its rate limit spent), leaving npm's alone.
export interface NpmAdvisoryList { advisories: NpmAdvisory[]; repository: boolean }

export interface NpmAdvisoryOptions {
  // The reader's GitHub token, and the repository the package names (owner/
  // name, null where it names none), each asked for only where the list is
  // not kept.
  githubToken: () => Promise<string | null>
  repo: () => Promise<string | null>
  // Where repositories' listings are kept, as bundle advisories keep them
  // (upstream-cache.ts auditCache), for as long as `signal` asks.
  cache: (signal: AbortSignal) => CacheStore | undefined
  debug?: boolean
}

async function askAdvisories(name: string, versions: string[], { githubToken, repo, cache, debug = false }: NpmAdvisoryOptions): Promise<NpmAdvisoryList> {
  // Every version upstream takes, as it checks each one it is asked about.
  const asked = versions.filter(version => isExactVersion(version))
  if (asked.length === 0) return { advisories: [], repository: true }
  // Its repository's own advisories are asked for only where GitHub says, now
  // and not from an answer kept, that it is public, and that repository is the
  // one asked: the list is kept for every reader of the package, and the
  // reader's token could read a private repository's, or a listing of one
  // kept for another reader. Where that can't be told, the list is npm's
  // alone, and not kept.
  let github: string | null = null, repository = true
  try {
    const named = await repo()
    github = named === null ? null : (await publicRepo(named, await githubToken()))?.json.full_name ?? null
  } catch { repository = false }
  const packages = [{ ecosystem: 'npm' as const, name, versions: asked, ...github !== null && { github } }]
  const ask = (repoAdvisories: boolean, token: string | null) => {
    const signal = AbortSignal.timeout(ADVISORIES_TIMEOUT_MS)
    return fetchBundleAdvisories(packages, signal, { debug, repoAdvisories, githubToken: token, cache: cache(signal) })
  }
  let result = await (github === null ? ask(false, null) : ask(true, await githubToken()))
  if (result.status !== 200 && github !== null) {
    repository = false
    result = await ask(false, null)
  }
  if (result.status !== 200) throw new NpmPackageError(502, 'upstream-unavailable')
  const index = new Map(versions.map((version, i) => [version, i]))
  // npm's registry answers an advisory once a range it covers: here it is one
  // row, its ranges joined as semver joins them, the versions and CWEs they
  // cover together, and the highest score.
  const merged = new Map<string, NpmAdvisory>()
  for (const row of result.body) {
    const affected = row.versions.map(version => index.get(version)).filter(at => at !== undefined)
    const key = `${row.source}\0${row.id}`
    const known = merged.get(key)
    if (!known) {
      merged.set(key, {
        id: row.id, source: row.source, ...row.ghsa && { ghsa: row.ghsa }, ...row.url && { url: row.url }, ...row.title && { title: row.title },
        ...row.severity && { severity: row.severity }, ...row.cvss !== undefined && { cvss: row.cvss }, cwe: row.cwe, ...row.range && { range: row.range }, affected,
      })
      continue
    }
    const range = [known.range, row.range].filter(Boolean).join(' || ')
    const cvss = Math.max(known.cvss ?? -1, row.cvss ?? -1)
    merged.set(key, { ...known, ...range && { range }, ...cvss >= 0 && { cvss }, cwe: [...new Set([...known.cwe, ...row.cwe])], affected: [...known.affected, ...affected] })
  }
  return {
    repository,
    advisories: [...merged.values()].map(row => ({ ...row, affected: [...new Set(row.affected)].toSorted((a, b) => a - b) })).filter(row => row.affected.length > 0)
      .toSorted((a, b) => (SEVERITY_RANK[a.severity ?? ''] ?? 4) - (SEVERITY_RANK[b.severity ?? ''] ?? 4) || a.id.localeCompare(b.id)),
  }
}

const advisoryLists = kept<NpmAdvisoryList>(100, list => list.repository)

// The package's advisories, `versions` its published versions as the version
// list has them; asked again once a version is published, and a list without
// its repository's, next time.
export function npmAdvisories(name: string, versions: string[], options: NpmAdvisoryOptions): Promise<NpmAdvisoryList> {
  return advisoryLists(`${name}\0${versions.length}\0${versions[0] ?? ''}`, () => askAdvisories(name, versions, options))
}
