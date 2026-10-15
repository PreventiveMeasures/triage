// A repository's open Dependabot alerts of npm's ecosystem, as a repository
// risk scan blends them into npm's advisories (repository-risk.ts): GitHub's
// `GET /repos/:repo/dependabot/alerts`, a page of 100 at a time, each found by
// the cursor the one before's Link header names, MAX_PAGES at most. Asked with
// the signed-in user's own token (repository-browser.ts), never the App's
// installation's, as GitHub shows a repository's alerts only to those it lets
// see them: where the App hasn't Dependabot alerts: read, the user may not see
// them, or the repository has them off, that is thrown as its code, never
// GitHub's text, for the scan to tell and go on.
import { isExactVersion, satisfies, validRange } from '@preventive/upstream/semver.js'
import { isNpmPackageName } from '../common/managed/npm-packages.js'
import { GithubApiError, githubUnreachable, throwGithubResponseError } from './github-errors.ts'
import type { LockedPackage } from './locked-packages.ts'

// An alert, as GitHub has it: its `number` in its repository and its page
// there (`url`, built, never fetched), the manifest or lockfile it is of
// (`manifest`, from the repository's root), its package and advisory, the
// versions it affects as GitHub writes them (`range`, `>= 1.0.0, < 1.2.6`)
// and the first that isn't (`patched`), and `dev` where GitHub tells the
// dependency is only for development.
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
}

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'deepview-triage'
const PER_PAGE = 100
// Up to how many pages are asked: 2,000 open alerts of npm's in a repository,
// past which the rest are left out.
const MAX_PAGES = 20
// A page holds each advisory's whole text: given longer than githubJson's.
const PAGE_TIMEOUT_MS = 20_000
const GHSA = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/u
const SEVERITIES = new Map([['critical', 'critical'], ['high', 'high'], ['medium', 'moderate'], ['moderate', 'moderate'], ['low', 'low']])
// A path from a repository's root, as git takes one: no empty, `.` or `..`
// component, nor a control character.
const isRepoPath = (path: unknown): path is string => typeof path === 'string' && path.length <= 1024 && !/\p{Cc}/u.test(path)
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')

const text = (value: unknown, most = 500) => typeof value === 'string' && value.trim() ? value.trim().slice(0, most) : undefined

// An alert as GitHub answers it, or null for one that isn't an open one of
// npm's, of a package and GHSA npm and GitHub would name.
function alertOf(fullName: string, raw: unknown): DependabotAlert | null {
  if (raw == null || typeof raw !== 'object') return null
  const { number, state, dependency, security_advisory: advisory, security_vulnerability: vulnerability } = raw as Record<string, any>
  if (!Number.isSafeInteger(number) || number <= 0 || (state !== undefined && state !== 'open')) return null
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
// (`dependabot-disabled`) or not to be seen (`dependabot-forbidden`), as a
// 404 is, the repository found just before; the rest as githubJson tells them.
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
    if (!limited) throw new GithubApiError(403, typeof message === 'string' && /disabled/iu.test(message) ? 'dependabot-disabled' : 'dependabot-forbidden')
  }
  if (res.status === 404) throw new GithubApiError(403, 'dependabot-forbidden')
  if (!res.ok) await throwGithubResponseError(res)
  let body
  try { body = await res.json() } catch (error) {
    throw error instanceof SyntaxError ? new GithubApiError(502, 'github-malformed') : githubUnreachable(error, started)
  }
  if (!Array.isArray(body)) throw new GithubApiError(502, 'github-malformed')
  return { alerts: body, link: res.headers.get('link') }
}

// `fullName`'s open Dependabot alerts of npm's ecosystem, as `token` may see
// them, in GitHub's order; none asked without a token.
export async function dependabotAlerts(fullName: string, token: string | null, fetchImpl: typeof fetch = globalThis.fetch): Promise<DependabotAlert[]> {
  if (!token) throw new GithubApiError(403, 'dependabot-forbidden')
  const base = `${API}/repos/${fullName.split('/').map(encodeURIComponent).join('/')}/dependabot/alerts`
  const alerts: DependabotAlert[] = []
  const seen = new Set<number>()
  let cursor: [string, string] | null = null
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const query = new URLSearchParams({ state: 'open', ecosystem: 'npm', per_page: String(PER_PAGE), ...cursor ? { [cursor[0]]: cursor[1] } : {} })
    const answer = await askPage(`${base}?${query}`, token, fetchImpl)
    for (const raw of answer.alerts) {
      const alert = alertOf(fullName, raw)
      if (alert && !seen.has(alert.number)) { seen.add(alert.number); alerts.push(alert) }
    }
    cursor = answer.alerts.length === 0 ? null : nextPage(answer.link)
    if (!cursor) break
  }
  return alerts
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
