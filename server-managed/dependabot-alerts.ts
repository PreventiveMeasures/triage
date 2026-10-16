// A repository's Dependabot alerts of npm's ecosystem, open or dismissed, as a
// repository risk scan blends them into npm's advisories (repository-risk.ts),
// a dismissed one with who dismissed it, when and why: GitHub's
// `GET /repos/:repo/dependabot/alerts`, a page of 100 at a time, each found by
// the cursor the one before's Link header names, MAX_PAGES at most. Asked with
// the App's installation token, once the admin's own access to the repository
// is found to let them see the alerts on GitHub (dependabot-access.ts): where
// the installation hasn't Dependabot alerts: read, or the repository has them
// off, that is thrown as its code, never GitHub's text, for the scan to tell
// and go on.
import { isExactVersion, satisfies, validRange } from '@preventive/upstream/semver.js'
import { isNpmPackageName } from '../common/managed/npm-packages.js'
import { GithubApiError, githubUnreachable, throwGithubResponseError } from './github-errors.ts'
import type { LockedPackage } from './locked-packages.ts'

// An alert, as GitHub has it: its `number` in its repository and its page
// there (`url`, built, never fetched), the manifest or lockfile it is of
// (`manifest`, from the repository's root), its package and advisory, the
// versions it affects as GitHub writes them (`range`, `>= 1.0.0, < 1.2.6`)
// and the first that isn't (`patched`), `dev` where GitHub tells the
// dependency is only for development, and `dismissed` where it is: by whom,
// when, why and what they said, or by one of the repository's rules (`auto`).
export interface DependabotAlert {
  number: number
  url: string
  manifest: string
  name: string
  ghsa: string
  // The advisory's other ids, as its CVE.
  aliases: string[]
  title?: string
  // `critical`, `high`, `moderate`, `low`: GitHub's `medium` reads `moderate`.
  severity?: string
  range?: string
  patched?: string
  cwe: string[]
  dev?: true
  dismissed?: AlertDismissal
}

// GitHub's `dismissed_reason`: `fix_started`, `inaccurate`, `no_bandwidth`,
// `not_used` or `tolerable_risk`; `at` as GitHub writes it (ISO 8601).
export interface AlertDismissal { auto?: true; reason?: string; at?: string; by?: string; comment?: string }

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'deepview-triage'
const PER_PAGE = 100
// Up to how many pages a listing asks: 2,000 alerts of npm's in a repository,
// past which the rest are left out; where open and dismissed ones are more,
// the open ones are listed again on their own (dependabotAlerts).
const MAX_PAGES = 20
// A page holds each advisory's whole text: given longer than githubJson's.
const PAGE_TIMEOUT_MS = 20_000
const GHSA = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/u
const SEVERITIES = new Map([['critical', 'critical'], ['high', 'high'], ['medium', 'moderate'], ['moderate', 'moderate'], ['low', 'low']])
// A path from a repository's root, as git takes one: no empty, `.` or `..`
// component, nor a control character.
const isRepoPath = (path: unknown): path is string => typeof path === 'string' && path.length <= 1024 && !/\p{Cc}/u.test(path)
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')

// The states asked: a fixed alert's dependency is no longer what it was.
const STATES = ['open', 'dismissed', 'auto_dismissed']
const REASONS = new Set(['fix_started', 'inaccurate', 'no_bandwidth', 'not_used', 'tolerable_risk'])
const LOGIN = /^[\dA-Za-z](?:[\dA-Za-z-]{0,38})(?:\[bot\])?$/u

const text = (value: unknown, most = 500) => typeof value === 'string' && value.trim() ? value.trim().slice(0, most) : undefined

// How a dismissed alert was dismissed, as far as GitHub tells it soundly.
function dismissalOf(state: string, raw: Record<string, any>): AlertDismissal {
  const at = state === 'auto_dismissed' ? raw['auto_dismissed_at'] : raw['dismissed_at']
  const when = typeof at === 'string' && at.length <= 40 && !Number.isNaN(Date.parse(at)) ? { at } : {}
  if (state === 'auto_dismissed') return { auto: true, ...when }
  const by = raw['dismissed_by']?.login, comment = text(raw['dismissed_comment'], 280), reason = raw['dismissed_reason']
  return { ...REASONS.has(reason) ? { reason } : {}, ...when, ...typeof by === 'string' && LOGIN.test(by) ? { by } : {}, ...comment === undefined ? {} : { comment } }
}

// An alert as GitHub answers it, or null for one that isn't an open or
// dismissed one of npm's, of a package and GHSA npm and GitHub would name.
function alertOf(fullName: string, raw: unknown): DependabotAlert | null {
  if (raw == null || typeof raw !== 'object') return null
  const { number, state, dependency, security_advisory: advisory, security_vulnerability: vulnerability } = raw as Record<string, any>
  if (!Number.isSafeInteger(number) || number <= 0 || !STATES.includes(state)) return null
  const ghsa = advisory?.ghsa_id, manifest = dependency?.manifest_path, name = dependency?.package?.name
  if (dependency?.package?.ecosystem !== 'npm' || !isNpmPackageName(name) || !isRepoPath(manifest) || typeof ghsa !== 'string' || !GHSA.test(ghsa)) return null
  const severity = SEVERITIES.get(vulnerability?.severity ?? advisory?.severity)
  const patched = text(vulnerability?.first_patched_version?.identifier, 100), range = text(vulnerability?.vulnerable_version_range, 200), title = text(advisory?.summary)
  const ids = Array.isArray(advisory?.identifiers) ? advisory.identifiers as { value?: unknown }[] : []
  const cwes = Array.isArray(advisory?.cwes) ? advisory.cwes as { cwe_id?: unknown }[] : []
  return {
    number, url: `https://github.com/${fullName.split('/').map(encodeURIComponent).join('/')}/security/dependabot/${number}`, manifest, name, ghsa,
    aliases: [...new Set(ids.flatMap(id => typeof id?.value === 'string' && /^[\w.:-]{1,64}$/u.test(id.value) && id.value !== ghsa ? [id.value] : []))],
    ...title === undefined ? {} : { title }, ...severity === undefined ? {} : { severity },
    ...range === undefined ? {} : { range }, ...patched === undefined ? {} : { patched },
    cwe: [...new Set(cwes.flatMap(cwe => typeof cwe?.cwe_id === 'string' && /^CWE-\d{1,6}$/u.test(cwe.cwe_id) ? [cwe.cwe_id] : []))],
    ...dependency.scope === 'development' ? { dev: true as const } : {},
    ...state === 'open' ? {} : { dismissed: dismissalOf(state, raw as Record<string, any>) },
  }
}

// The next page's cursor, as the Link header's `next` names it: its `after`,
// or its `page`, all that is taken of it, the rest of its URL left as asked.
function nextPage(link: string | null): [string, string] | null {
  const next = link?.split(',').map(part => /^\s*<([^>]*)>\s*;\s*rel="next"\s*$/u.exec(part)?.[1]).find(Boolean)
  if (!next) return null
  let url
  try { url = new URL(next) } catch { return null }
  if (url.origin !== API) return null
  const after = url.searchParams.get('after'), page = url.searchParams.get('page')
  return after ? ['after', after] : page && /^\d{1,4}$/u.test(page) ? ['page', page] : null
}

// A page asked of GitHub: its alerts and the headers they came with. A 403
// that isn't a rate limit is told as the alerts being off
// (`dependabot-disabled`) or not to be read by the App's installation
// (`dependabot-app-permission`), as a 404 is, the repository found just
// before; the rest as githubJson tells them.
async function askPage(url: string, token: string, fetchImpl: typeof fetch): Promise<{ alerts: unknown[]; link: string | null }> {
  const started = Date.now()
  let res: Response
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), redirect: 'error',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': USER_AGENT, 'x-github-api-version': API_VERSION },
    })
  } catch (error) { throw githubUnreachable(error, started) }
  if (res.status === 403) {
    const message = (await res.clone().json().catch(() => null) as { message?: unknown } | null)?.message
    const limited = res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')
      || (typeof message === 'string' && /rate limit|abuse detection/iu.test(message))
    if (!limited) throw new GithubApiError(403, typeof message === 'string' && /disabled/iu.test(message) ? 'dependabot-disabled' : 'dependabot-app-permission')
  }
  if (res.status === 404) throw new GithubApiError(403, 'dependabot-app-permission')
  if (!res.ok) await throwGithubResponseError(res)
  let body
  try { body = await res.json() } catch (error) {
    throw error instanceof SyntaxError ? new GithubApiError(502, 'github-malformed') : githubUnreachable(error, started)
  }
  if (!Array.isArray(body)) throw new GithubApiError(502, 'github-malformed')
  return { alerts: body, link: res.headers.get('link') }
}

// `fullName`'s alerts in `states`, MAX_PAGES at most, in GitHub's order (the
// newest first), and whether that is all of them.
async function listAlerts(fullName: string, states: readonly string[], token: string, fetchImpl: typeof fetch) {
  const base = `${API}/repos/${fullName.split('/').map(encodeURIComponent).join('/')}/dependabot/alerts`
  const alerts: DependabotAlert[] = []
  const seen = new Set<number>()
  let cursor: [string, string] | null = null
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const query = new URLSearchParams({ state: states.join(','), ecosystem: 'npm', per_page: String(PER_PAGE), ...cursor ? { [cursor[0]]: cursor[1] } : {} })
    const answer = await askPage(`${base}?${query}`, token, fetchImpl)
    for (const raw of answer.alerts) {
      const alert = alertOf(fullName, raw)
      if (alert && !seen.has(alert.number)) { seen.add(alert.number); alerts.push(alert) }
    }
    cursor = answer.alerts.length === 0 ? null : nextPage(answer.link)
    if (!cursor) return { alerts, whole: true }
  }
  return { alerts, whole: false }
}

// `fullName`'s Dependabot alerts of npm's ecosystem, open or dismissed, as
// `token`, the App's installation's (dependabot-access.ts), may see them, in
// GitHub's order. Asked at once, but where they are more than a listing holds,
// as newer dismissed ones would leave older open ones out, the open ones are
// listed again on their own, and the dismissed ones had kept after them.
export async function dependabotAlerts(fullName: string, token: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<DependabotAlert[]> {
  const all = await listAlerts(fullName, STATES, token, fetchImpl)
  if (all.whole) return all.alerts
  const open = await listAlerts(fullName, ['open'], token, fetchImpl)
  const told = new Set(open.alerts.map(alert => alert.number))
  return [...open.alerts, ...all.alerts.filter(alert => alert.dismissed && !told.has(alert.number))]
}

// The versions of an alert's package that a lockfile it is of locks
// (`packages`) and its range covers, GitHub's read as npm's semver reads its
// own (`>= 1.0.0, < 1.2.6` as `>= 1.0.0 < 1.2.6`); none where it is of no
// lockfile read, or its range is none semver reads.
export function alertVersions(alert: Pick<DependabotAlert, 'name' | 'range'>, packages: readonly LockedPackage[] | undefined): string[] {
  const range = alert.range === undefined ? null : validRange(alert.range.replaceAll(',', ' '))
  if (!packages || range === null) return []
  return [...new Set(packages.flatMap(({ name, version, source }) => name === alert.name && (source === 'registry' || source === 'mirror')
    && isExactVersion(version) && satisfies(version, range) ? [version] : []))]
}
