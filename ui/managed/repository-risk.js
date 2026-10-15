// Manage → Repositories → Risk, for admins: every connected repository's npm
// lockfiles, or a team's or one repository's, their packages, and what risk
// tells of each, as the server finds them (GET /api/admin/repositories/risk,
// server-managed/repository-risk.ts); npm's advisories of them on a tab of
// their own, those of malware a package's risk too. Packages are listed by
// their risk alone, those only devDependencies need tagged so, and either
// kind shown alone as toggled, as are advisories of the versions production
// takes or of those, malware's either way. A mirror's copy differing from
// npm's is flagged critical, listed first but for malware. Each lockfile used
// links to it on GitHub, at the commit read. Each repository's open
// Dependabot alerts are blended into the advisories: one of an advisory npm
// tells too, by its GHSA and package, links where it is used to the alert,
// adding where npm didn't tell it, and one npm tells none of is listed as its
// own; whose alerts couldn't be had is said beside, the rest shown all the same.
// Opened by its URL alone,
// /manage/repositories/risk, until it is linked.
import { html, nothing, unsafeCSS } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from 'lit/directives/style-map.js'
import { appMarkup } from '../view/markup.js'
import { isHttpUrl } from '@preventive/report'
import { SEVERITIES } from '../../risk/files/stamps.js'
import { npmRiskLevel } from '../../risk/npm/score.js'
import { managedRoutePath } from '../../common/managed/routes.js'
import { ManagedPage } from './page.js'
import { adminNavigation } from './navigation.js'
import { request, responseLines } from './bundle-data.js'
import { fetchTeams } from './admin-api.js'
import { BUNDLE_ICON_SVG, DEPENDABOT_ICON_SVG, GITHUB_ICON_SVG, NPM_ICON_SVG } from '../view/icons.js'
import '../view/repository-selector.js'
import commonStyles from './styles/common.css'
import linksStyles from './styles/links.css'
import riskStyles from './styles/repository-risk.css'

// What risk finds of a version, against the version it picks to compare it
// with where it picks one (risk/npm/held.js, combined.js, compare.js): what it
// holds, raised by what changed; what only a change tells; and npm's
// advisories of malware.
const FINDING_LABELS = {
  malware: 'Malware',
  deprecated: 'Deprecated',
  publisher: 'Publisher changed',
  'provenance-lost': 'Provenance lost',
  'too-new': 'Too new',
  popularity: 'Unpopular',
  'held-install-scripts': 'Install scripts',
  'held-runs-code': 'Runs code',
  'held-credentials': 'Credentials',
  'held-exfiltration': 'Exfiltration host',
  'held-remote': 'Remote host',
  'held-ip-lookup': 'IP lookup',
  'held-obfuscated': 'Obfuscated',
  'held-non-registry-deps': 'Non-registry dependencies',
  'held-unused-deps': 'Unused deps',
  'large-code': 'Large new code',
  'now-unreadable': 'Now unreadable',
  'binary-code': 'Binary code',
  'new-hosts': 'New hosts',
}

const ERRORS = {
  'no-repository': 'No GitHub access',
  'github-not-found': 'Not found on GitHub',
  'github-unauthorized': 'GitHub sign-in expired',
  'github-rate-limited': 'GitHub rate limit reached',
  'github-unreachable': 'GitHub unreachable',
  'github-malformed': 'GitHub answered unexpectedly',
  'unsupported-format': 'Format not read',
  'lockfile-unreadable': 'Unreadable',
  'package-not-found': 'Not on npm',
  'version-not-found': 'Version not on npm',
  'integrity-mismatch': 'Differs from npm’s',
  'npm-busy': 'Server busy',
  'package-too-large': 'Too large to assess',
  'upstream-busy': 'npm busy',
  'upstream-unavailable': 'npm unavailable',
  'upstream-too-large': 'npm answered too much',
  'upstream-invalid': 'npm answered unexpectedly',
  'dependabot-disabled': 'Dependabot alerts off',
  'dependabot-forbidden': 'No access to Dependabot alerts',
}
const errorText = code => ERRORS[code] ?? code
const START_ERRORS = { 401: 'Sign in again to scan repositories.', 403: 'Only admins can scan repositories.',
  404: 'That team or repository is no longer connected. Choose again.' }

// What a scan reads: every connected repository, a team's, or one.
const SCOPES = [['all', 'All repositories'], ['team', 'Team'], ['repo', 'Repository']]
// Up to how many teams are chosen among as buttons, as the scope is; more in
// a list.
const TEAM_BUTTONS = 5

const SOURCE_LABELS = { registry: 'npm', mirror: 'Mirror', git: 'Git', tarball: 'Tarball', file: 'File' }
const assessable = source => source === 'registry' || source === 'mirror'

// The malware advisories name in a package. They speak of npm's artifact:
// not of one risk finds differs from npm's, as a private package of a public
// one's name does, from npm's registry or a mirror. A mirror's copy can't be
// held to npm's integrity where npm deleted the version, as it deletes every
// one it finds malware in: it is npm's unless found otherwise.
export const malwareOf = row => differs(row) ? null : row.malware ?? null
// Whether risk found a mirror's copy isn't npm's of its name and version, its
// integrity not npm's: a private package of a public one's name, or one
// tampered with. Flagged critical, and listed first but for malware, not as
// one that couldn't be assessed.
export const differs = row => row.risk?.error === 'integrity-mismatch'
// A package row's most severe finding, its malware first, as critical: the
// advisories', or risk's own of a package npm took down, once; or its copy
// differing from npm's. What its rows are flagged by.
const severityOf = row => malwareOf(row) || differs(row) ? 'critical' : row.risk?.severity ?? null
// A package row's risk, out of 100, as risk scores it (risk/npm/score.js):
// malware's 100, the advisories' as risk's own; null where it isn't told.
export const scoreOf = row => malwareOf(row) ? 100 : row.risk && !row.risk.error ? row.risk.score ?? null : null
export const findingsOf = row => {
  const found = row.risk?.findings ?? []
  return malwareOf(row) ? [{ id: 'malware', severity: 'critical' }, ...found.filter(({ id }) => id !== 'malware')] : found
}
// What its Malware finding says, a line each: the advisories of malware
// naming it, and its package taken down by npm, as risk finds it.
export const malwareSaid = row => [...malwareOf(row) ?? [],
  ...row.risk?.findings?.some(({ id, takenDown }) => id === 'malware' && takenDown) ? ['Taken down by npm'] : []]
// Whether a package row has malware: the advisories', or risk's own.
const hasMalware = row => findingsOf(row).some(({ id }) => id === 'malware')
// Whether a package row is shown whatever needs it: malware, or a copy
// differing from npm's, either of which runs wherever it is installed, CI and
// a developer's machine among them.
const regardless = row => differs(row) || hasMalware(row)
// Whether a package row is of `kind` (PACKAGE_KINDS): development's where
// only devDependencies need it, production's where more do, or its lockfiles
// don't say; one told regardless of both.
export const ofKind = (row, kind) => kind === 'all' || regardless(row) || Boolean(row.dev) === (kind === 'development')
const severityRank = severity => SEVERITIES.includes(severity) ? SEVERITIES.indexOf(severity) : SEVERITIES.length
const severityLabel = severity => `${severity[0].toUpperCase()}${severity.slice(1)}`

// Which package rows are shown, by the filter's value: its label, and which
// rows.
const FILTERS = {
  all: ['All', () => true],
  flagged: ['Flagged', row => Boolean(severityOf(row))],
  failed: ['Failed', row => Boolean(row.risk?.error) && !differs(row)],
  elsewhere: ['Not from npm', row => !assessable(row.source)],
}

// What a package's risk is, as its column's heading tells it.
const RISK_SAID = 'Out of 100: what its findings call for, lowered by how long the version has been out among how many download its package. Malware is 100.'
// What a package's dev tag, or an advisory's, tells.
const DEV_SAID = 'Only devDependencies need it, in every lockfile that locks it: an install without them leaves it out. Assessed after the rest.'
const ADVISORY_DEV_SAID = 'Only devDependencies need these versions, in every lockfile that locks them: an install without them leaves them out.'
// What a package's copy differing from npm's tells.
const DIFFERS_SAID = 'Its lockfile’s integrity, a mirror’s, isn’t npm’s of this name and version: not npm’s package, as a private one of a public one’s name is, or one tampered with.'
// The advisories shown, by the versions they affect: those some lockfile
// needs as more than devDependencies do, or doesn't tell (Yarn 1's), or those
// only devDependencies need. Malware's are shown either way.
const KINDS = {
  production: ['Production', 'Advisories of versions an install for production takes: some lockfile needs them as more than devDependencies do, or doesn’t say. Malware’s are shown either way.'],
  development: ['Development', 'Advisories of versions only devDependencies need, in every lockfile that locks them. Malware’s are shown either way.'],
}
// The packages shown: all, those an install for production takes, or those
// only devDependencies need (ofKind).
const PACKAGE_KINDS = {
  all: ['All'],
  production: ['Production', 'Packages an install for production takes: some lockfile needs them as more than devDependencies do, or doesn’t say. Malware, and a copy differing from npm’s, is shown either way.'],
  development: ['Development', 'Packages only devDependencies need, in every lockfile that locks them. Malware, and a copy differing from npm’s, is shown either way.'],
}
const devTag = said => html`<span class="risk-dev" data-tooltip=${said}>dev</span>`

// A package's cell: npm's mark, or a package's for one from elsewhere (git, a
// tarball, a file), its name, linked to npm's viewer at `path` where given,
// and its `version`, muted, where it has one; and its dev tag.
function packageCell({ name, source, dev }, version, path, devSaid) {
  const named = html`${name}${version ? html`<span class="risk-version">@${version}</span>` : nothing}`
  return html`<span class="risk-package">${icon(assessable(source) ? NPM_ICON_SVG : BUNDLE_ICON_SVG)}${path
    ? html`<a class="risk-name" href=${path}>${named}</a>` : html`<span>${named}</span>`}${dev ? devTag(devSaid) : nothing}</span>`
}

// Whether a risk line tells what risk found: its findings, or its copy
// differing from npm's (differs); not why it couldn't be assessed.
const found = risk => !risk.error || risk.error === 'integrity-mismatch'

// A package row's risk as its line tells it, `stale` where the line is one
// kept and since gone stale (when it was assessed); a stale one assessed
// again replaced, or, where that fails, kept, saying why (`refreshFailed`).
export function riskOf(line, was) {
  const stale = line.stale ?? null
  if (!found(line) && !stale && was?.stale && found(was)) return { ...was, refreshFailed: line.detail ? `${errorText(line.error)}: ${line.detail}` : errorText(line.error) }
  return line.error ? { error: line.error, detail: line.detail ?? null, stale } : { severity: line.severity, score: line.score ?? null, findings: line.findings, published: line.published, stale }
}

// How long ago `at` was, roughly: `5 minutes ago`, `3 hours ago`, `2 days ago`.
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
export function ago(at, now = Date.now()) {
  const minutes = Math.round((at - now) / 60_000)
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  return Math.abs(hours) < 48 ? relative.format(hours, 'hour') : relative.format(Math.round(hours / 24), 'day')
}

// How many parts a scan is asked in at most, where the server answers in
// parts (`continue`): 100 of 270s each, some seven hours.
const MAX_PARTS = 100
// How many parts running may tell nothing more (_told) before a scan stops,
// as one that goes no further wouldn't finish in MAX_PARTS either.
const MAX_IDLE_PARTS = 3

// How many package rows are drawn at most, the riskiest first.
const MAX_ROWS = 1000
// Lines come faster than a table this long redraws: draw at most this often.
const DRAW_MS = 250

const formatCount = new Intl.NumberFormat()

// Package rows' counts: how many, how many told, flagged, stale, and told
// stale this scan, since assessed again or not.
const tally = rows => ({ total: rows.length, told: rows.filter(row => row.risk).length, flagged: rows.filter(severityOf).length,
  stale: rows.filter(row => row.risk?.stale).length, wasStale: rows.filter(row => row.wasStale).length })

// An icon before a cell's text, muted (risk-icon).
const icon = svg => html`<span class="risk-icon" aria-hidden="true">${appMarkup(svg)}</span>`

// A lockfile (`used`, a repository's name and its path), cut short: a link
// to its Dependabot alert, after Dependabot's mark, where an advisory's
// alert of it is (`alerts`, by where it is used), else to it on GitHub, after
// GitHub's mark, where it is listed (`links`, _lockfileLinks).
function lockfileLink(used, links, alerts) {
  const alert = alerts?.get(used)
  if (alert && isHttpUrl(alert.url)) {
    return html`<a class="risk-name risk-used" href=${alert.url} target="_blank" rel="noopener noreferrer">${icon(DEPENDABOT_ICON_SVG)}<span
      class="risk-clip risk-used-in" data-tooltip=${`${used}\nDependabot alert #${alert.number}`}>${used}</span></a>`
  }
  const href = links.get(used)
  const path = html`<span class="risk-clip risk-used-in" data-tooltip-truncated data-tooltip=${used}>${used}</span>`
  return href ? html`<a class="risk-name risk-used" href=${href} target="_blank" rel="noopener noreferrer">${icon(GITHUB_ICON_SVG)}${path}</a>` : path
}

// Where a package or an advisory is locked: its lockfile, or how many,
// opening into each one's.
function usedInCell(lockfiles, links, alerts) {
  const used = [...lockfiles]
  if (used.length === 1) return lockfileLink(used[0], links, alerts)
  return html`<details class="risk-used-all"><summary>${formatCount.format(used.length)} lockfiles</summary>
    <ul>${used.map(each => html`<li>${lockfileLink(each, links, alerts)}</li>`)}</ul></details>`
}

// Whether an id is a GHSA, as an advisory and a Dependabot alert share it.
const isGhsa = id => typeof id === 'string' && /^GHSA(?:-[\da-z]{4}){3}$/iu.test(id)

// The lines of a scan of `params` (`team` or `repo`, or neither),
// repository-risk.ts RepositoryRiskLine, each as it comes.
const streamRisk = (params, signal, onLine) => request(`/api/admin/repositories/risk${params.size > 0 ? `?${params}` : ''}`, START_ERRORS, async response => {
  for await (const line of responseLines(response)) onLine(line)
}, signal)

// A package row's key: npm's package by its name and version, a mirror's by
// its integrity too, as its risk line names it; any other by where it is from.
const riskKey = ({ name, version, integrity }) => `${name}@${version}\0${integrity ?? ''}`
const packageKey = pkg => assessable(pkg.source) ? riskKey(pkg) : `${pkg.source}\0${pkg.name}@${pkg.version ?? ''}\0${pkg.from ?? ''}`

// A package row's rank: malware first, then a copy differing from npm's, each
// above any score (a version of enough critical findings scores 100 too), then
// by its risk, the highest first, then those still to be told, those that
// couldn't be, those of none, and those not assessed.
function rank(row) {
  if (hasMalware(row)) return -102
  if (differs(row)) return -101
  const score = scoreOf(row)
  if (score > 0) return -score
  if (!assessable(row.source)) return 4
  if (score === 0) return 3
  return row.risk ? 2 : 1
}

class ManagedAdminRepositoryRisk extends ManagedPage {
  static properties = { _state: { state: true }, _error: { state: true }, _filter: { state: true }, _kind: { state: true }, _packageKind: { state: true },
    _query: { state: true }, _tab: { state: true },
    _scope: { state: true }, _target: { state: true }, _choices: { state: true } }
  static styles = [unsafeCSS(commonStyles), unsafeCSS(linksStyles), unsafeCSS(riskStyles)]

  constructor() {
    super()
    // idle, running, stopped or done.
    this._state = 'idle'
    this._error = null
    this._filter = 'all'
    // The advisories' KINDS shown, and the packages' PACKAGE_KINDS.
    this._kind = 'production'
    this._packageKind = 'all'
    this._query = ''
    // packages or advisories.
    this._tab = 'packages'
    this._scan = null
    this._drawTimer = null
    // The parts a scan has been asked in so far (MAX_PARTS).
    this._parts = 0
    // SCOPES', and the team's or repository's id it names.
    this._scope = 'all'
    this._target = ''
    // The teams and connected repositories to choose among, as Teams has them.
    this._choices = null
    this._reset()
  }

  connectedCallback() {
    super.connectedCallback()
    void this._loadCollection('teams', 'teams', fetchTeams, data => { this._choices = data })
  }

  // Scans `scope` (SCOPES) and `target` from now on, what was found of
  // another put away; not while a scan is under way.
  _choose(scope, target = '') {
    // The one chosen chosen again keeps what was found of it.
    if (this._state === 'running' || (scope === this._scope && target === this._target)) return
    this._scope = scope
    this._target = target
    this._reset()
    this._error = null
    this._state = 'idle'
  }

  _reset() {
    // By id: { id, fullName, commit, lockfiles, error, detail, dependabot:
    // its alerts as told ({ alerts }), why they couldn't be had ({ error,
    // detail }), or null }; lockfiles by path, each { path, format,
    // packages, error, detail }.
    this._repos = new Map()
    // By packageKey: { name, version, source, from, integrity, usedIn: Set,
    // neededIn: Set of those of usedIn that lock it as more than
    // devDependencies need, dev: whether none does, risk, wasStale: whether
    // told stale this scan, malware: Set of advisory ids where npm's
    // advisories name it }.
    this._packages = new Map()
    // By id and package: an advisory, its versions locked and where (Sets),
    // and Dependabot's alerts of it by where (_alert).
    this._advisories = new Map()
  }

  disconnectedCallback() {
    this.stop()
    super.disconnectedCallback()
  }

  // Scans what is chosen anew, its lines drawn as they come.
  async start() {
    if (this._state === 'running' || (this._scope !== 'all' && !this._target)) return
    // The scan's id, for its parts to go on past the repositories those
    // before told whole (repository-risk.ts ScanProgress).
    const params = new URLSearchParams({ ...this._scope === 'all' ? {} : { [this._scope]: this._target }, scan: crypto.randomUUID() })
    this._reset()
    this._error = null
    this._state = 'running'
    const scan = new AbortController()
    this._scan = scan
    this._parts = 0
    try {
      // A part at a time where the server answers in parts (`continue`), as a
      // serverless deployment's time-limited function does: each asked again
      // from where the last stopped, what it told kept here.
      for (let ended = 'continue', idle = 0; ended === 'continue';) {
        if (++this._parts > MAX_PARTS) throw new Error(`Stopped after ${formatCount.format(MAX_PARTS)} parts. Scan again to go on from where it stopped.`)
        ended = null
        const told = this._told()
        await streamRisk(params, scan.signal, line => {
          if (line.type === 'done' || line.type === 'continue') ended = line.type
          this._apply(line)
          this._draw()
        })
        if (ended === null) throw new Error('The scan ended before it finished. Try again.')
        idle = this._told() > told ? 0 : idle + 1
        if (ended === 'continue' && idle >= MAX_IDLE_PARTS) throw new Error(`Stopped: the last ${formatCount.format(MAX_IDLE_PARTS)} parts found nothing more. Scan again to try once more.`)
      }
      this._state = 'done'
    } catch (err) {
      if (scan.signal.aborted || err?.name === 'AbortError') return
      this._error = err?.message ?? String(err)
      this._state = 'stopped'
    } finally {
      // Stopped otherwise than by stop(), as by the session changing.
      if (this._scan === scan) {
        this._scan = null
        if (this._state === 'running') this._state = 'stopped'
      }
      this._draw(true)
    }
  }

  // Stops a scan under way: the server stops with its reader. What it found
  // so far stays.
  stop() {
    if (!this._scan) return
    this._scan.abort()
    this._scan = null
    this._state = 'stopped'
    this._draw(true)
  }

  _draw(now = false) {
    if (now) {
      clearTimeout(this._drawTimer)
      this._drawTimer = null
      this.requestUpdate()
      return
    }
    this._drawTimer ??= setTimeout(() => { this._drawTimer = null; this.requestUpdate() }, DRAW_MS)
  }

  // How much of the scan is told: repositories and lockfiles read or failed,
  // lockfiles' advisories and repositories' Dependabot alerts told or failed,
  // and packages' risks told other than stale.
  _told() {
    let told = 0
    for (const repo of this._repos.values()) {
      if (repo.lockfiles || repo.error) told++
      if (repo.dependabot) told++
      for (const lockfile of repo.lockfiles?.values() ?? []) told += Number(lockfile.packages !== null || Boolean(lockfile.error)) + Number(Boolean(lockfile.advisories || lockfile.advisoriesError))
    }
    for (const row of this._packages.values()) if (row.risk && !row.risk.stale) told++
    return told
  }

  _apply(line) {
    // A scan's next part tells its repositories and lockfiles again: those
    // told already kept as they are until told otherwise.
    if (line.type === 'repos') {
      // Those no longer listed, as disconnected or no longer the team's, or
      // listed by another name, as renamed, forgotten.
      const listed = new Map(line.repos.map(({ id, fullName }) => [id, fullName]))
      const gone = [...this._repos.values()].filter(repo => listed.get(repo.id) !== repo.fullName)
      for (const repo of gone) this._repos.delete(repo.id)
      this._forget(gone.flatMap(repo => [...repo.lockfiles?.keys() ?? []].map(path => `${repo.fullName}/${path}`)), gone.some(repo => repo.dependabot?.alerts))
      for (const { id, fullName } of line.repos) if (!this._repos.has(id)) this._repos.set(id, { id, fullName, commit: null, lockfiles: null, error: null, detail: null, dependabot: null })
    } else if (line.type === 'repo') {
      const repo = this._repos.get(line.id)
      if (!repo) return
      // One that fails where a part before read it, as its access is
      // withdrawn: what its lockfiles and its Dependabot alerts told
      // forgotten.
      if (line.error) {
        const told = [...repo.lockfiles?.keys() ?? []].map(path => `${repo.fullName}/${path}`)
        const alerted = Boolean(repo.dependabot?.alerts)
        Object.assign(repo, { lockfiles: null, error: line.error, detail: line.detail ?? null, dependabot: null })
        this._forget(told, alerted)
        return
      }
      // Its lockfiles told again as they were, but where its default branch
      // moved on between parts, or a team's directories in it changed:
      // what those no longer listed told forgotten.
      const moved = repo.commit !== null && repo.commit !== line.commit
      const listed = new Set(moved ? [] : line.lockfiles.map(({ path }) => path))
      const gone = [...repo.lockfiles?.keys() ?? []].filter(path => !listed.has(path)).map(path => `${repo.fullName}/${path}`)
      Object.assign(repo, { commit: line.commit, error: null, detail: null })
      repo.lockfiles = new Map(line.lockfiles.map(lockfile => [lockfile.path, (!moved && repo.lockfiles?.get(lockfile.path)) || { ...lockfile, packages: null, error: null }]))
      this._forget(gone)
    } else if (line.type === 'lockfile') {
      const repo = this._repos.get(line.repo)
      const lockfile = repo?.lockfiles?.get(line.path)
      if (!lockfile) return
      if (line.error) { Object.assign(lockfile, { error: line.error, detail: line.detail ?? null }); return }
      Object.assign(lockfile, { packages: line.packages.length, error: null, detail: null })
      const usedIn = `${repo.fullName}/${line.path}`
      for (const pkg of line.packages) {
        const key = packageKey(pkg)
        let row = this._packages.get(key)
        if (!row) this._packages.set(key, row = { ...pkg, usedIn: new Set(), neededIn: new Set(), risk: null })
        row.usedIn.add(usedIn)
        if (pkg.dev !== true) row.neededIn.add(usedIn)
        row.dev = row.neededIn.size === 0
      }
    } else if (line.type === 'risk') {
      const row = this._packages.get(riskKey(line))
      // One told stale is so marked for the scan (wasStale), as one assessed
      // again since (_metrics).
      if (row) { row.risk = riskOf(line, row.risk); row.wasStale ||= Boolean(row.risk.stale) }
    } else if (line.type === 'advisories') {
      this._applyAdvisories(line)
    } else if (line.type === 'dependabot') {
      this._applyDependabot(line)
    }
  }

  // What lockfiles no longer listed told (`usedIn`, a repository's name and
  // a path) forgotten: the packages no other lockfile tells, and the
  // advisories as those listed tell them, as they are told again too where
  // a repository's Dependabot alerts are forgotten (`alerted`).
  _forget(usedIn, alerted = false) {
    if (usedIn.length === 0) {
      if (alerted) this._readvise()
      return
    }
    for (const [key, row] of this._packages) {
      for (const used of usedIn) { row.usedIn.delete(used); row.neededIn.delete(used) }
      if (row.usedIn.size === 0) this._packages.delete(key)
      row.dev = row.neededIn.size === 0
    }
    this._readvise()
  }

  // Each listed lockfile's advisories, as it told them last, told anew, and
  // each repository's Dependabot alerts blended into them.
  _readvise() {
    this._advisories = new Map()
    for (const row of this._packages.values()) row.malware = undefined
    for (const repo of this._repos.values()) {
      for (const [path, lockfile] of repo.lockfiles ?? []) if (lockfile.advisories) this._advise(`${repo.fullName}/${path}`, lockfile.advisories)
    }
    this._alert()
  }

  // Whether any repository told Dependabot alerts, blended into the
  // advisories, so that another's are told anew with them.
  _alerted() {
    return [...this._repos.values()].some(repo => repo.dependabot?.alerts?.length > 0)
  }

  // A lockfile's advisories, kept as it told them: told again otherwise, as
  // a scan over an hour long audits it again (repository-risk.ts
  // RISK_KEPT_MS), they replace those it told before. Where Dependabot's
  // alerts are blended in, all are told anew, as an alert listed as its own
  // may be of the advisory these tell.
  _applyAdvisories(line) {
    const repo = this._repos.get(line.repo)
    const lockfile = repo?.lockfiles?.get(line.path)
    if (!lockfile) return
    if (line.error) { lockfile.advisoriesError = line.error; return }
    const before = lockfile.advisories
    Object.assign(lockfile, { advisories: line.advisories, advisoriesError: null })
    if (!before && !this._alerted()) this._advise(`${repo.fullName}/${line.path}`, line.advisories)
    else if (JSON.stringify(before) !== JSON.stringify(line.advisories)) this._readvise()
  }

  // A repository's Dependabot alerts, or why they couldn't be had, kept as
  // told: told again otherwise, as a later part asks them again, they replace
  // those told before; where a later part couldn't have them, those told
  // before are kept, beside why, as a lockfile's advisories are.
  _applyDependabot(line) {
    const repo = this._repos.get(line.repo)
    if (!repo) return
    const before = repo.dependabot
    repo.dependabot = line.error ? { ...before?.alerts && { alerts: before.alerts }, error: line.error, detail: line.detail ?? null } : { alerts: line.alerts }
    if (JSON.stringify(before?.alerts ?? null) !== JSON.stringify(repo.dependabot.alerts ?? null)) this._readvise()
  }

  // Each repository's Dependabot alerts blended into the advisories npm's
  // told: an alert of an advisory told, by its GHSA (its id, or one of its
  // aliases) and package, is kept with it, by where it is used, its versions
  // and malware with the rest; one of none is listed as its own, as GitHub
  // tells it, its range its own. Where it is used, as its manifest's path,
  // adds to where the advisory is, linked to the alert (lockfileLink).
  _alert() {
    const byGhsa = new Map()
    const keyOf = (ghsa, name) => `${ghsa.toUpperCase()}\0${name}`
    for (const row of this._advisories.values()) {
      for (const id of [row.id, row.ghsa, ...row.aliases ?? []]) if (isGhsa(id) && !byGhsa.has(keyOf(id, row.name))) byGhsa.set(keyOf(id, row.name), row)
    }
    for (const repo of this._repos.values()) {
      for (const alert of repo.dependabot?.alerts ?? []) {
        const usedIn = `${repo.fullName}/${alert.manifest}`
        let row = byGhsa.get(keyOf(alert.ghsa, alert.name))
        if (!row) {
          row = { id: alert.ghsa, ghsa: alert.ghsa, name: alert.name, title: alert.title, severity: alert.severity, url: `https://github.com/advisories/${alert.ghsa}`,
            aliases: alert.aliases, cwe: alert.cwe, malware: false, dependabot: true, ranges: new Set(), versions: new Set(), usedIn: new Set(), versionsIn: new Map() }
          this._advisories.set(`${alert.ghsa}\0${alert.name}`, row)
          byGhsa.set(keyOf(alert.ghsa, alert.name), row)
        }
        if (row.dependabot && alert.range) row.ranges.add(alert.range)
        row.alerts ??= new Map()
        row.alerts.set(usedIn, alert)
        row.usedIn.add(usedIn)
        if (alert.versions.length > 0) {
          const told = row.versionsIn.get(usedIn) ?? row.versionsIn.set(usedIn, new Set()).get(usedIn)
          for (const version of alert.versions) { told.add(version); row.versions.add(version) }
        }
        row.malware ||= alert.malware
        this._markMalware(row)
      }
    }
  }

  // Advisories a lockfile (`usedIn`) tells, each kept once by its id and
  // package: npm answers one a range it covers, here its ranges and versions
  // together, and malware if any says so (npm-insights.ts merges them
  // alike). Malware's marked on the packages of the versions it names.
  _advise(usedIn, advisories) {
    for (const { range, versions, ...advisory } of advisories) {
      const key = `${advisory.id}\0${advisory.name}`
      let row = this._advisories.get(key)
      if (!row) this._advisories.set(key, row = { ...advisory, ranges: new Set(), versions: new Set(), usedIn: new Set(), versionsIn: new Map() })
      if (range) row.ranges.add(range)
      for (const version of versions) row.versions.add(version)
      row.malware ||= advisory.malware
      row.usedIn.add(usedIn)
      // The versions each lockfile told it of, for those of one kind alone
      // to name only their lockfiles (_advisoryKinds).
      const told = row.versionsIn.get(usedIn) ?? row.versionsIn.set(usedIn, new Set()).get(usedIn)
      for (const version of versions) told.add(version)
      this._markMalware(row)
    }
  }

  // An advisory of malware marked on the packages of the versions it names.
  _markMalware(row) {
    if (!row.malware) return
    for (const pkg of this._packages.values()) {
      if (assessable(pkg.source) && pkg.name === row.name && row.versions.has(pkg.version)) (pkg.malware ??= new Set()).add(row.id)
    }
  }

  _counts() {
    const repos = [...this._repos.values()]
    const lockfiles = repos.flatMap(repo => [...repo.lockfiles?.values() ?? []])
    const assessed = [...this._packages.values()].filter(row => assessable(row.source))
    return {
      repos: repos.length, reposRead: repos.filter(repo => repo.lockfiles || repo.error).length,
      lockfiles: lockfiles.length, lockfilesRead: lockfiles.filter(lockfile => lockfile.packages !== null || lockfile.error).length,
      // Those more than devDependencies need, and those only they need, apart.
      needed: tally(assessed.filter(row => !row.dev)), dev: tally(assessed.filter(row => row.dev)),
      advisories: this._adviseCounts(),
    }
  }

  // The advisories, how many in all and apart: those of malware, those of
  // versions an install for production takes, and those only of versions
  // only devDependencies need.
  _adviseCounts() {
    const kinds = this._advisoryKinds()
    const needed = new Set(kinds.production.filter(row => !row.malware).map(row => `${row.id}\0${row.name}`))
    const malware = [...this._advisories.values()].filter(row => row.malware).length
    return { total: this._advisories.size, malware, needed: needed.size, dev: this._advisories.size - malware - needed.size }
  }

  // The package rows of the kind shown (`_packageKind`), filtered and
  // searched for, by their risk alone (rank), whatever needs them: the
  // riskiest first, of more findings ahead.
  _rows() {
    const query = this._query.trim().toLowerCase()
    const [, shown] = FILTERS[this._filter]
    return [...this._packages.values()].filter(row => ofKind(row, this._packageKind) && shown(row) && (!query || row.name.toLowerCase().includes(query)))
      .toSorted((a, b) => rank(a) - rank(b) || findingsOf(b).length - findingsOf(a).length
        || a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? ''))
  }

  // Each of KINDS' advisories, by their package: each with the versions of
  // that kind it affects and the lockfiles that told it of them, `dev` where
  // only devDependencies need them; a version is development's where every
  // package locked of it is `dev`. Where only a Dependabot alert tells of
  // it, of no version a lockfile read locks (a package.json, bun's
  // lockfile), it is of the kind the alert's scope tells.
  // Malware's are of both, with all their versions, `dev` where all are.
  _advisoryKinds() {
    const devOnly = new Map()
    for (const row of this._packages.values()) {
      const key = `${row.name}@${row.version}`
      if (assessable(row.source)) devOnly.set(key, (devOnly.get(key) ?? true) && row.dev)
    }
    const kinds = { production: [], development: [] }
    for (const row of this._advisories.values()) {
      const versions = [...row.versions]
      const dev = versions.filter(version => devOnly.get(`${row.name}@${version}`) === true)
      const needed = versions.filter(version => devOnly.get(`${row.name}@${version}`) !== true)
      // Where alerts alone tell it, of no version: by their scope.
      const unversioned = [...row.alerts ?? []].filter(([usedIn]) => !row.versionsIn.get(usedIn)?.size)
      const devIn = unversioned.filter(([, alert]) => alert.dev).map(([usedIn]) => usedIn)
      const neededIn = unversioned.filter(([, alert]) => !alert.dev).map(([usedIn]) => usedIn)
      if (row.malware) {
        const all = { ...row, dev: needed.length === 0 && neededIn.length === 0 }
        kinds.production.push(all)
        kinds.development.push(all)
        continue
      }
      // Each kind's versions, and where it is used of them.
      const of = (shown, also) => ({ ...row, versions: new Set(shown),
        usedIn: new Set([...row.usedIn].filter(usedIn => also.includes(usedIn) || shown.some(version => row.versionsIn.get(usedIn)?.has(version)))) })
      if (needed.length > 0 || neededIn.length > 0) kinds.production.push({ ...of(needed, neededIn), dev: false })
      if (dev.length > 0 || devIn.length > 0) kinds.development.push({ ...of(dev, devIn), dev: true })
    }
    return kinds
  }

  // The advisories of the kind shown (`_kind`) searched for, malware first,
  // then the most severe.
  _advisoryRows(kinds = this._advisoryKinds()) {
    const query = this._query.trim().toLowerCase()
    return kinds[this._kind].filter(row => !query || row.name.toLowerCase().includes(query))
      .toSorted((a, b) => Number(b.malware) - Number(a.malware) || severityRank(a.severity) - severityRank(b.severity)
        || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  // A toggle (`name`d) of `kinds` ({ kind: [label, tooltip] }, a tooltip
  // where one tells more), the one `value` names pressed, each with how many
  // there are (`counts`) in a bubble, another `choose`n.
  _kindToggle(name, kinds, counts, value, choose) {
    return html`<div class="risk-scope" role="group" aria-label=${name}>${Object.entries(kinds).map(([kind, [label, said]]) => html`<button type="button"
      aria-pressed=${value === kind} data-tooltip=${said ?? nothing} @click=${() => choose(kind)}>${label}<span class="n">${formatCount.format(counts[kind])}</span></button>`)}</div>`
  }

  // Which of `rows`, a kind's, are shown, by FILTERS, each with how many:
  // those of none left out but All and the one chosen; none where All alone
  // is left.
  _filterToggle(rows) {
    const counts = Object.fromEntries(Object.entries(FILTERS).map(([filter, [, shown]]) => [filter, rows.filter(shown).length]))
    const offered = Object.entries(FILTERS).filter(([filter]) => filter === 'all' || filter === this._filter || counts[filter] > 0)
    return offered.length === 1 ? nothing : this._kindToggle('Show packages', Object.fromEntries(offered.map(([filter, [label]]) => [filter, [label]])),
      counts, this._filter, filter => { this._filter = filter })
  }

  // Each listed lockfile's link on GitHub, at the commit it was read at, by
  // where it is used (`${fullName}/${path}`, as `usedIn` names it).
  _lockfileLinks() {
    const links = new Map()
    for (const repo of this._repos.values()) {
      for (const path of repo.commit ? repo.lockfiles?.keys() ?? [] : []) {
        links.set(`${repo.fullName}/${path}`, `https://github.com/${repo.fullName}/blob/${repo.commit}/${path.split('/').map(encodeURIComponent).join('/')}`)
      }
    }
    return links
  }

  render() {
    return html`<div class="wrap">${adminNavigation('manage-repos', this._role, this.allowShare)}
      <h1 class="sr-only">Repository risk</h1>
      <div class="page-intro"><p class="intro">Each connected repository’s npm lockfiles at its default branch, and what risk finds in each package they lock.</p>
        ${this._state === 'running' ? html`<button type="button" class="btn" @click=${() => this.stop()}>Stop</button>`
          : html`<button type="button" class="btn primary" ?disabled=${this._scope !== 'all' && !this._target} @click=${() => { void this.start() }}>${this._state === 'idle' ? 'Start scan' : 'Scan again'}</button>`}
      </div>
      ${this._scopeBar()}
      ${this._progress()}
      ${this._error ? html`<p class="msg error" role="alert">${this._error}</p>` : nothing}
      ${this._repos.size === 0 ? nothing : html`<div class="manage-list">${this._lockfiles()}
        ${this._packages.size === 0 ? nothing : this._tab === 'advisories' ? this._advisoryTable() : this._packageTable()}</div>`}
    </div>`
  }

  _tabs() {
    const tabs = [['packages', 'Packages'], ['advisories', html`Advisories${this._advisories.size > 0 ? html`<span class="n">${formatCount.format(this._advisories.size)}</span>` : nothing}`]]
    return html`<div class="risk-tabs" role="tablist" aria-label="Results">${tabs.map(([tab, label]) => html`<button type="button" role="tab"
      aria-selected=${this._tab === tab} @click=${() => { this._tab = tab }}>${label}</button>`)}</div>`
  }

  _search(count, total, what) {
    return html`<input type="search" aria-label=${`Search ${what}`} placeholder="Search by package…" .value=${this._query} @input=${event => { this._query = event.target.value }}>
      <span class="result-count">${count === total ? '' : `${formatCount.format(count)} of `}${formatCount.format(total)} ${what}</span>`
  }

  // A team's chosen with _teamPicker, and a repository with the picker the
  // other pages share, by owner and searchable.
  _scopeBar() {
    const running = this._state === 'running'
    const loading = this._choices ? '' : 'Loading…'
    return html`<div class="risk-scope-bar">
      <div class="risk-scope" role="group" aria-label="What to scan">${SCOPES.map(([scope, label]) => html`<button type="button"
        aria-pressed=${this._scope === scope} ?disabled=${running} @click=${() => this._choose(scope)}>${label}</button>`)}</div>
      ${this._scope === 'team' ? this._teamPicker(running, loading) : nothing}
      ${this._scope === 'repo' ? html`<repository-selector label="Which repository" placeholder=${loading || 'Choose a repository…'} ?disabled=${running || !this._choices}
        .options=${(this._choices?.repos ?? []).map(repo => ({ value: String(repo.repoId), label: repo.fullName }))} .value=${this._target || null}
        @repository-change=${event => this._choose('repo', event.detail.value)}></repository-selector>` : nothing}
    </div>`
  }

  // A team, chosen as the scope is among a few (TEAM_BUTTONS), else from a
  // list.
  _teamPicker(running, loading) {
    const teams = this._choices?.teams ?? []
    const name = team => team.hidden ? `${team.name} (hidden)` : team.name
    if (teams.length > 0 && teams.length <= TEAM_BUTTONS) {
      return html`<div class="risk-scope" role="group" aria-label="Which team">${teams.map(team => html`<button type="button"
        aria-pressed=${team.id === this._target} ?disabled=${running} @click=${() => this._choose('team', team.id)}>${name(team)}</button>`)}</div>`
    }
    return html`<select aria-label="Which team" ?disabled=${running} @change=${event => this._choose('team', event.target.value)}>
      <option value="" ?selected=${!this._target}>${loading || 'Choose a team…'}</option>
      ${teams.map(team => html`<option value=${team.id} ?selected=${team.id === this._target}>${name(team)}</option>`)}
    </select>`
  }

  // The scan's progress, a metric each: its `label`, how many (`value`), of
  // how many where it reads them (`of`), its bar's segments, each of a kind
  // and how many of `of`, else of `scale`, else of `value` (`bar`: read;
  // those an install for production takes and those only devDependencies
  // need; malware), the rest unfilled; its parts told apart, each its kind,
  // how many and of how many where told (`split`), and lines of `note`, both
  // in its tooltip; and a `tone` where it calls for one.
  _metrics() {
    const counts = this._counts()
    const { needed, dev, advisories } = counts
    const count = value => formatCount.format(value)
    // A metric's parts, each its kind, how many and of how many: its bar's
    // segments, and its split, those of none left out.
    const apart = parts => ({ bar: parts.map(([kind, value]) => [kind, value]), split: parts.filter(([, value, total = value]) => total > 0) })
    const flagged = needed.flagged + dev.flagged, stale = needed.stale + dev.stale, wasStale = needed.wasStale + dev.wasStale
    return [
      { label: 'Repositories', value: counts.reposRead, of: counts.repos, bar: [['read', counts.reposRead]] },
      { label: 'Lockfiles', value: counts.lockfilesRead, of: counts.lockfiles, bar: [['read', counts.lockfilesRead]] },
      { label: 'Packages assessed', value: needed.told + dev.told, of: needed.total + dev.total,
        ...apart([['prod', needed.told, needed.total], ['dev', dev.told, dev.total]]) },
      { label: 'Flagged', value: flagged, ...apart([['prod', needed.flagged], ['dev', dev.flagged]]), tone: flagged > 0 ? 'high' : null },
      // Those still stale, its bar those assessed again of all told stale.
      ...wasStale > 0 ? [{ label: 'Stale', value: stale, scale: wasStale,
        bar: [['prod', needed.wasStale - needed.stale], ['dev', dev.wasStale - dev.stale]], split: apart([['prod', needed.stale], ['dev', dev.stale]]).split,
        note: [...stale > 0 ? [`Assessed over an hour ago; ${this._state === 'running' ? 'to be assessed again once the rest are' : 'not assessed again yet'}.`] : [],
          `${count(wasStale - stale)} of ${count(wasStale)} assessed again.`] }] : [],
      ...advisories.total > 0 ? [{ label: 'Advisories', value: advisories.total,
        ...apart([['malware', advisories.malware], ['prod', advisories.needed], ['dev', advisories.dev]]) }] : [],
    ]
  }

  // The scan's metrics (_metrics), each read with a bar and its tooltip a
  // line each part, its count aligned, said to a screen reader too, as the
  // bar is hidden from one and the tooltip shows on hover alone; then its
  // state, at the end, so that the metrics stay put as it changes.
  _progress() {
    if (this._state === 'idle') return html`<div class="risk-progress" role="status"><p class="risk-progress-idle">Not scanned yet. A scan reads each repository from GitHub and assesses each npm package it locks, which can take a while; a scan again within the hour is quicker.</p></div>`
    const state = this._state === 'running' && this._parts > 1 ? `Scanning · part ${formatCount.format(this._parts)}` : { running: 'Scanning', stopped: 'Stopped', done: 'Done' }[this._state]
    const count = value => formatCount.format(value)
    const said = ({ split = [], note = [] }) => [split.length > 0 ? `${split.map(([kind, value, total]) => `${count(value)}${total === undefined ? '' : `/${count(total)}`} ${kind}`).join(', ')}.` : '', ...note].filter(Boolean).join(' ')
    const tip = ({ split = [], note = [] }) => html`${split.length > 0 ? html`<div class="tooltip-counts">${split.map(([kind, value, total]) => html`<span class="tooltip-count">${count(value)}${
      total === undefined ? nothing : html`<span class="tooltip-count-of"><span class="tooltip-slash">/</span>${count(total)}</span>`}</span><span>${kind}</span>`)}</div>` : nothing}${
      note.map(line => html`<div class="tooltip-counts-note">${line}</div>`)}`
    return html`<div class="risk-progress" role="status">${this._metrics().map(metric => {
      const { label, value, of, scale = of ?? value, bar, tone } = metric, text = said(metric)
      return html`<span class=${tone ? `risk-metric risk-${tone}` : 'risk-metric'} data-tooltip=${text || nothing} .tooltipContent=${text ? tip(metric) : null}>
        <span class="risk-metric-label">${label}</span>
        <span class="risk-metric-value">${count(value)}${of === undefined ? nothing : html`<span class="risk-metric-of"><span class="risk-metric-slash">/</span>${count(of)}</span>`}${text ? html`<span class="sr-only"> ${text}</span>` : nothing}</span>
        <span class="risk-bar" aria-hidden="true">${bar.filter(([, some]) => some > 0).map(([kind, some]) => html`<span class=${`risk-bar-${kind}`}
          style=${styleMap({ width: `${some / scale * 100}%` })}></span>`)}</span>
      </span>`
    })}<span class="risk-state" data-state=${this._state}>${state}</span></div>`
  }

  _pending(running, otherwise) {
    return html`<span class="risk-pending">${this._state === 'running' ? running : otherwise}</span>`
  }

  // What a repository's row says in place of its lockfiles, where it has none
  // to list; null where it has.
  _repoStatus(repo) {
    if (repo.error) return html`<span class="risk-error" data-tooltip=${repo.detail ?? nothing}>${errorText(repo.error)}</span>`
    if (repo.lockfiles === null) return this._pending('Waiting…', 'Not read')
    return repo.lockfiles.size === 0 ? html`<span class="risk-none">No npm lockfiles</span>` : null
  }

  _lockfileStatus(lockfile) {
    if (lockfile.error) return html`<span class="risk-error" data-tooltip=${lockfile.detail ?? nothing}>${errorText(lockfile.error)}</span>`
    return lockfile.packages === null ? this._pending('Reading…', 'Not read') : `${formatCount.format(lockfile.packages)} packages`
  }

  // A line a repository: its name, and its lockfiles beside it, each with its
  // format and how many packages it locks, or why there are none.
  _lockfiles() {
    return html`<section class="risk-section" aria-label="Lockfiles">
      <h2>Lockfiles</h2>
      <ul class="risk-repos">${[...this._repos.values()].map(repo => html`<li>
        <span class="risk-repo-name" data-tooltip-truncated data-tooltip=${repo.fullName}>${repo.fullName}</span>
        ${this._repoStatus(repo) ?? html`<ul class="risk-lockfiles">${[...repo.lockfiles.values()].map(lockfile => html`<li>
          <span class="mono">${lockfile.path}</span><span class="risk-lockfile-meta">${lockfile.format} · ${this._lockfileStatus(lockfile)}</span>
        </li>`)}</ul>`}
      </li>`)}</ul>
    </section>`
  }

  // The tabs and the controls of the results, kept in view as they scroll.
  _resultsHead(controls) {
    return html`<div class="risk-results-head">${this._tabs()}<div class="collection-toolbar">${controls}</div></div>`
  }

  _packageTable() {
    const rows = this._rows()
    const all = [...this._packages.values()]
    const counts = Object.fromEntries(Object.keys(PACKAGE_KINDS).map(kind => [kind, all.filter(row => ofKind(row, kind)).length]))
    const links = this._lockfileLinks()
    // Where they are from, but where all are npm's registry's, as most are.
    const sourced = all.some(row => row.source !== 'registry')
    return html`<section class="risk-section" aria-label="Packages">
      ${this._resultsHead(html`${this._kindToggle('Which packages', PACKAGE_KINDS, counts, this._packageKind, kind => { this._packageKind = kind })}
        ${this._filterToggle(all.filter(row => ofKind(row, this._packageKind)))}
        ${this._search(rows.length, counts[this._packageKind], 'packages')}`)}
      <div class="link-table"><table>
        <thead><tr><th>Package</th><th><span data-tooltip=${RISK_SAID}>Risk</span></th><th>Findings</th>${sourced ? html`<th>Source</th>` : nothing}<th class="risk-used-column">Used in</th></tr></thead>
        <tbody>${repeat(rows.slice(0, MAX_ROWS), packageKey, row => this._packageRow(row, links, sourced))}</tbody>
      </table></div>
      ${rows.length > MAX_ROWS ? html`<p class="msg">Showing the first ${formatCount.format(MAX_ROWS)}. Search or filter to see others.</p>` : nothing}
    </section>`
  }

  _packageRow(row, links, sourced) {
    const path = assessable(row.source) ? managedRoutePath({ view: 'npm', packageName: row.name, packageSpec: row.version }) : null
    return html`<tr class=${row.risk?.stale ? 'is-stale' : ''}>
      <td>${packageCell(row, row.version, path, DEV_SAID)}</td>
      <td>${this._score(row)}</td>
      <td>${this._findings(row)}</td>
      ${sourced ? html`<td><span data-tooltip=${row.from ?? nothing}>${SOURCE_LABELS[row.source] ?? row.source}${row.source === 'mirror' && row.from ? ` (${new URL(row.from).host})` : ''}</span></td>` : nothing}
      <td>${usedInCell(row.usedIn, links)}</td>
    </tr>`
  }

  // A package's risk, out of 100, in its level's color (risk/npm/score.js
  // npmRiskLevel): red from 75, orange from 50, yellow from 25, else plain;
  // nothing where it isn't told, its findings' cell saying why.
  _score(row) {
    const score = scoreOf(row)
    const told = score === null ? nothing : html`<span class=${`risk-score risk-${npmRiskLevel(score)}`}>${score}</span>`
    return row.risk?.stale ? html`${told}<span class="risk-stale" data-tooltip=${this._staleSaid(row.risk)}>stale</span>` : told
  }

  // Why a risk is stale: when it was assessed, and whether it is to be
  // assessed again, once those with none are, or couldn't be.
  _staleSaid({ stale, refreshFailed }) {
    const next = refreshFailed ? `couldn’t be assessed again: ${refreshFailed}` : this._state === 'running' ? 'to be assessed again once the rest are' : 'not assessed again yet'
    return `Assessed ${ago(stale.assessedAt)}; ${next}`
  }

  // What risk finds of a package, each by its severity; or, where it finds
  // nothing, whether it is still to be told, couldn't be, or wasn't asked.
  _findings(row) {
    const findings = findingsOf(row)
    if (findings.length > 0) {
      return html`<ul class="risk-findings">${findings.map(finding => html`<li class=${`risk-${finding.severity}`}
        data-tooltip=${finding.id === 'malware' ? malwareSaid(row).join('\n') : nothing}>${FINDING_LABELS[finding.id] ?? finding.id}</li>`)}</ul>`
    }
    if (!assessable(row.source)) return html`<span class="risk-none">Not assessed</span>`
    if (!row.risk) return this._pending('Waiting…', 'Not assessed')
    if (differs(row)) return html`<ul class="risk-findings"><li class="risk-critical" data-tooltip=${DIFFERS_SAID}>${errorText(row.risk.error)}</li></ul>`
    if (row.risk.error) return html`<span class="risk-error" data-tooltip=${row.risk.detail ?? nothing}>${errorText(row.risk.error)}</span>`
    return html`<span class="risk-none">None found</span>`
  }

  _advisoryTable() {
    const kinds = this._advisoryKinds()
    const links = this._lockfileLinks()
    const rows = this._advisoryRows(kinds)
    const failed = [...this._repos.values()].flatMap(repo => [...repo.lockfiles?.values() ?? []]
      .filter(lockfile => lockfile.advisoriesError).map(lockfile => `${repo.fullName}/${lockfile.path}`))
    const versions = this._kind === 'production' ? 'the versions an install for production takes' : 'the versions only devDependencies need'
    const none = this._alerted() ? `Neither npm nor Dependabot tells of advisories of ${versions}.` : `npm has no advisories of ${versions}.`
    return html`<section class="risk-section" aria-label="Advisories">
      ${this._resultsHead(html`${this._kindToggle('Which advisories', KINDS, { production: kinds.production.length, development: kinds.development.length }, this._kind, kind => { this._kind = kind })}${this._search(rows.length, kinds[this._kind].length, 'advisories')}`)}
      ${this._dependabotStatus()}
      ${failed.length > 0 ? html`<p class="msg error">npm’s advisories couldn’t be had for <span data-tooltip=${failed.join('\n')}>${failed.length === 1 ? failed[0] : `${formatCount.format(failed.length)} lockfiles`}</span>.</p>` : nothing}
      ${rows.length === 0 ? html`<p class="msg">${this._state === 'running' ? 'None yet.' : none}</p>` : html`<div class="link-table"><table>
        <thead><tr><th>Package</th><th>Versions</th><th>Severity</th><th>Advisory</th><th>Title</th><th>Affected</th><th>Used in</th></tr></thead>
        <tbody>${repeat(rows.slice(0, MAX_ROWS), row => `${row.id}\0${row.name}`, row => this._advisoryRow(row, links))}</tbody>
      </table></div>`}
      ${rows.length > MAX_ROWS ? html`<p class="msg">Showing the first ${formatCount.format(MAX_ROWS)}. Search to see others.</p>` : nothing}
    </section>`
  }

  _advisoryRow(row, links) {
    const versions = [...row.versions]
    const severity = row.malware ? 'critical' : row.severity
    return html`<tr>
      <td>${packageCell({ ...row, source: 'registry' }, null, managedRoutePath({ view: 'npm', packageName: row.name, packageSpec: versions[0] }), ADVISORY_DEV_SAID)}</td>
      <td class="mono">${versions.join(', ')}</td>
      <td>${row.malware ? html`<span class="risk-chip risk-critical">Malware</span>`
        : severity ? html`<span class=${`risk-chip risk-${severity}`}>${severityLabel(severity)}</span>` : nothing}</td>
      <td class="mono">${isHttpUrl(row.url) ? html`<a href=${row.url} target="_blank" rel="noopener noreferrer">${row.id}</a>` : row.id}</td>
      <td><span class="risk-clip" data-tooltip-truncated data-tooltip=${row.title ?? nothing}>${row.title ?? ''}</span></td>
      <td class="mono">${[...row.ranges].join(' || ')}</td>
      <td>${usedInCell(row.usedIn, links, row.alerts)}</td>
    </tr>`
  }

  // What Dependabot told, small, beside the advisories: how many open alerts
  // of how many repositories, and of how many they couldn't be had, each
  // saying why in its tooltip; nothing where none told any.
  _dependabotStatus() {
    const repos = [...this._repos.values()].filter(repo => repo.dependabot)
    if (repos.length === 0) return nothing
    const had = repos.filter(repo => repo.dependabot.alerts)
    const failed = repos.filter(repo => repo.dependabot.error)
    const alerts = had.reduce((sum, repo) => sum + repo.dependabot.alerts.length, 0)
    const count = (value, one, many = `${one}s`) => `${formatCount.format(value)} ${value === 1 ? one : many}`
    const why = failed.map(({ fullName, dependabot: { error, detail } }) => `${fullName}: ${errorText(error)}${detail ? ` (${detail})` : ''}`).join('\n')
    return html`<p class="risk-dependabot" role="status">${icon(DEPENDABOT_ICON_SVG)}<span>Dependabot</span>
      ${had.length > 0 ? html`<span data-tooltip=${had.map(repo => `${repo.fullName}: ${count(repo.dependabot.alerts.length, 'open alert')}`).join('\n')}>${count(alerts, 'open alert')} of ${count(had.length, 'repository', 'repositories')}</span>` : nothing}
      ${failed.length > 0 ? html`<span class="risk-dependabot-failed" data-tooltip=${why}>${had.length > 0 ? 'unavailable for ' : 'alerts unavailable for '}${failed.length === 1 ? failed[0].fullName : count(failed.length, 'repository', 'repositories')}${failed.length === 1 ? html`: ${errorText(failed[0].dependabot.error)}` : nothing}</span>` : nothing}
    </p>`
  }
}
customElements.define('managed-admin-repo-risk', ManagedAdminRepositoryRisk)
