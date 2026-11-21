// Manage → Repositories → Risk, for admins: the npm lockfiles of every
// connected repository (or a team's, or one), their packages and what risk
// finds of each (GET /api/admin/repositories/risk, repository-risk.ts).
// Tabs: packages by risk (dev-only ones tagged, either kind shown alone);
// npm's advisories, blended with each repository's Dependabot alerts (by GHSA
// and package; a dismissed alert struck through and never listed alone); and
// GitHub Actions (repository-risk-actions.js). A mirror's copy differing from
// npm's is flagged critical. Lockfiles link to GitHub at the commit read.
import { html, nothing, unsafeCSS } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from '../view/style-map.js'
import { appMarkup } from '../view/markup.js'
import { isHttpUrl } from '@preventive/report'
import { npmRiskLevel } from '../../risk/npm/score.js'
import { managedRoutePath } from '../../common/managed/routes.js'
import { ManagedPage } from './page.js'
import { request, responseLines } from './bundle-data.js'
import { fetchTeams } from './admin-api.js'
import { BUNDLE_ICON_SVG, DEPENDABOT_ICON_SVG, GITHUB_ICON_SVG, NPM_ICON_SVG } from '../view/icons.js'
import { ACTION_KINDS, ActionsState, findingsCell, githubHref, pinnedTo, referenceHref, severityRank } from './repository-risk-actions.js'
import '../view/repository-selector.js'
import commonStyles from './styles/common.css'
import linksStyles from './styles/links.css'
import riskStyles from './styles/repository-risk.css'

// What risk finds of a version (risk/npm/held.js, combined.js, compare.js).
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
  'dependabot-app-permission': 'App lacks Dependabot alerts permission',
  'dependabot-not-installed': 'App not installed',
  'dependabot-unverified': 'Sign-in not verified, sign in again',
  'github-app-not-configured': 'GitHub App not configured',
  'workflow-unreadable': 'Unreadable',
  'workflow-too-large': 'Too large to read',
  'invalid-uses': 'Not a reference GitHub reads',
}
const errorText = code => ERRORS[code] ?? code
const failure = ({ error, detail }) => html`<span class="risk-error" data-tooltip=${detail ?? nothing}>${errorText(error)}</span>`
const START_ERRORS = { 401: 'Sign in again to scan repositories.', 403: 'Only admins can scan repositories.',
  404: 'That team or repository is no longer connected. Choose again.' }

const SCOPES = [['all', 'All repositories'], ['team', 'Team'], ['repo', 'Repository']]
// Teams are buttons up to this many, else a list.
const TEAM_BUTTONS = 5

const SOURCE_LABELS = { registry: 'npm', mirror: 'Mirror', git: 'Git', tarball: 'Tarball', file: 'File' }
const assessable = source => source === 'registry' || source === 'mirror'

// The malware advisories name in a package. They speak of npm's artifact, so
// not of a copy found to differ from it; a mirror's copy of a version npm
// deleted (as it deletes malware) is npm's unless found otherwise.
export const malwareOf = row => differs(row) ? null : row.malware ?? null
// A mirror's copy whose integrity isn't npm's: a private package of a public
// one's name, or one tampered with. Critical, not unassessed.
export const differs = row => row.risk?.error === 'integrity-mismatch'
const severityOf = row => malwareOf(row) || differs(row) ? 'critical' : row.risk?.severity ?? null
// Out of 100 (risk/npm/score.js), malware's 100; null where not told.
export const scoreOf = row => malwareOf(row) ? 100 : row.risk && !row.risk.error ? row.risk.score ?? null : null
export const findingsOf = row => {
  const found = row.risk?.findings ?? []
  return malwareOf(row) ? [{ id: 'malware', severity: 'critical' }, ...found.filter(({ id }) => id !== 'malware')] : found
}
// The Malware finding's lines: the advisories naming it, and npm's takedown.
export const malwareSaid = row => [...malwareOf(row) ?? [],
  ...row.risk?.findings?.some(({ id, takenDown }) => id === 'malware' && takenDown) ? ['Taken down by npm'] : []]
const hasMalware = row => findingsOf(row).some(({ id }) => id === 'malware')
// Shown whatever needs it, as either runs wherever it is installed.
const regardless = row => differs(row) || hasMalware(row)
// Of `kind` (PACKAGE_KINDS): development where only devDependencies need it.
const ofKind = (row, kind) => kind === 'all' || regardless(row) || Boolean(row.dev) === (kind === 'development')
const severityLabel = severity => `${severity[0].toUpperCase()}${severity.slice(1)}`

// Each package filter's label and rows.
const FILTERS = {
  all: ['All', () => true],
  flagged: ['Flagged', row => Boolean(severityOf(row))],
  failed: ['Failed', row => Boolean(row.risk?.error) && !differs(row)],
  elsewhere: ['Not from npm', row => !assessable(row.source)],
}

const RISK_SAID = 'Out of 100: what its findings call for, lowered by how long the version has been out among how many download its package. Malware is 100.'
const DEV_SAID = 'Only devDependencies need it, in every lockfile that locks it: an install without them leaves it out. Assessed after the rest.'
const ADVISORY_DEV_SAID = 'Only devDependencies need these versions, in every lockfile that locks them: an install without them leaves them out.'
const DIFFERS_SAID = 'Its lockfile’s integrity, a mirror’s, isn’t npm’s of this name and version: not npm’s package, as a private one of a public one’s name is, or one tampered with.'
// Advisories by the versions they affect: production where some lockfile
// needs them beyond devDependencies (or doesn't say, as Yarn 1's); malware's
// either way.
const KINDS = { production: 'Production', development: 'Development' }
const PACKAGE_KINDS = { all: 'All', production: 'Production', development: 'Development' }
const devTag = said => html`<span class="risk-dev" data-tooltip=${said}>dev</span>`

// npm's mark (a package's for git, tarball or file sources), its name linked
// to npm's viewer at `path`, its version muted, and its dev tag.
function packageCell({ name, source, dev }, version, path, devSaid) {
  const named = html`${name}${version ? html`<span class="risk-version">@${version}</span>` : nothing}`
  return html`<span class="risk-package">${icon(assessable(source) ? NPM_ICON_SVG : BUNDLE_ICON_SVG)}${path
    ? html`<a class="risk-name" href=${path}>${named}</a>` : html`<span>${named}</span>`}${dev ? devTag(devSaid) : nothing}</span>`
}

// A risk line of findings, or of a copy differing from npm's; not a failure.
const found = risk => !risk.error || risk.error === 'integrity-mismatch'

// A row's risk from its line, `stale` (when assessed) for one kept since; a
// stale one whose reassessment fails is kept, saying why (`refreshFailed`).
export function riskOf(line, was) {
  const stale = line.stale ?? null
  if (!found(line) && !stale && was?.stale && found(was)) return { ...was, refreshFailed: line.detail ? `${errorText(line.error)}: ${line.detail}` : errorText(line.error) }
  return line.error ? { error: line.error, detail: line.detail ?? null, stale } : { severity: line.severity, score: line.score ?? null, findings: line.findings, published: line.published, stale }
}

// Roughly: `5 minutes ago`, `3 hours ago`, `2 days ago`.
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
export function ago(at, now = Date.now()) {
  const minutes = Math.round((at - now) / 60_000)
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  return Math.abs(hours) < 48 ? relative.format(hours, 'hour') : relative.format(Math.round(hours / 24), 'day')
}

// Where the server answers in parts (`continue`): at most 100 of 270s each,
// and a scan stops after 3 that tell nothing more (_told).
const MAX_PARTS = 100
const MAX_IDLE_PARTS = 3
// Rows drawn at most, the riskiest first; lines come faster than such a
// table redraws, so it draws at most every DRAW_MS.
const MAX_ROWS = 1000
const DRAW_MS = 250

const formatCount = new Intl.NumberFormat()

// Package rows' counts; `wasStale`, those told stale this scan.
const tally = rows => ({ total: rows.length, told: rows.filter(row => row.risk).length, flagged: rows.filter(severityOf).length,
  stale: rows.filter(row => row.risk?.stale).length, wasStale: rows.filter(row => row.wasStale).length })

const icon = svg => html`<span class="risk-icon" aria-hidden="true">${appMarkup(svg)}</span>`

const DISMISSED_REASONS = {
  fix_started: 'A fix has already been started',
  inaccurate: 'This alert is inaccurate or incorrect',
  no_bandwidth: 'No bandwidth to fix this',
  not_used: 'Vulnerable code is not actually used',
  tolerable_risk: 'Risk is tolerable to this project',
}

// A Dependabot alert's number, and its dismissal: why, by whom, when, and
// what they said.
export function alertSaid({ number, dismissed }) {
  if (!dismissed) return `Dependabot alert #${number}`
  const why = dismissed.auto ? 'auto-dismissed by a rule' : `dismissed${DISMISSED_REASONS[dismissed.reason] ? `: ${DISMISSED_REASONS[dismissed.reason]}` : ''}`
  const who = [dismissed.by ? `by @${dismissed.by}` : '', dismissed.at?.slice(0, 10) ?? ''].filter(Boolean).join(', ')
  return [`Dependabot alert #${number}, ${why}${who ? ` (${who})` : ''}`, ...dismissed.comment ? [`“${dismissed.comment}”`] : []].join('\n')
}

// A lockfile (`used`: a repository's name and path), linked to its
// Dependabot alert (`alerts`, struck through where dismissed), else to
// GitHub (`links`, _lockfileLinks).
function lockfileLink(used, links, alerts) {
  const alert = alerts?.get(used)
  if (alert && isHttpUrl(alert.url)) {
    return html`<a class=${alert.dismissed ? 'risk-name risk-used is-dismissed' : 'risk-name risk-used'} href=${alert.url} target="_blank" rel="noopener noreferrer">${icon(DEPENDABOT_ICON_SVG)}<span
      class="risk-clip risk-used-in" data-tooltip=${`${used}\n${alertSaid(alert)}`}>${used}</span>${alert.dismissed ? html`<span class="sr-only"> (dismissed)</span>` : nothing}</a>`
  }
  const href = links.get(used)
  const path = html`<span class="risk-clip risk-used-in" data-tooltip-truncated data-tooltip=${used}>${used}</span>`
  return href ? html`<a class="risk-name risk-used" href=${href} target="_blank" rel="noopener noreferrer">${icon(GITHUB_ICON_SVG)}${path}</a>` : path
}

// Its one lockfile, or how many (`noun`), opening into each.
function usedInCell(lockfiles, links, alerts, noun = 'lockfiles') {
  const used = [...lockfiles]
  if (used.length === 1) return lockfileLink(used[0], links, alerts)
  const dismissed = used.filter(each => alerts?.get(each)?.dismissed).length
  return html`<details class="risk-used-all"><summary>${formatCount.format(used.length)} ${noun}${dismissed > 0 ? `, ${formatCount.format(dismissed)} dismissed` : ''}</summary>
    <ul>${used.map(each => html`<li>${lockfileLink(each, links, alerts)}</li>`)}</ul></details>`
}

const isGhsa = id => typeof id === 'string' && /^GHSA(?:-[\da-z]{4}){3}$/iu.test(id)

// A scan's lines (repository-risk.ts RepositoryRiskLine) as they come.
const streamRisk = (params, signal, onLine) => request(`/api/admin/repositories/risk${params.size > 0 ? `?${params}` : ''}`, START_ERRORS, async response => {
  for await (const line of responseLines(response)) onLine(line)
}, signal)

// npm's by name and version (a mirror's with its integrity), as risk lines
// name them; any other by where it is from.
const riskKey = ({ name, version, integrity }) => `${name}@${version}\0${integrity ?? ''}`
const packageKey = pkg => assessable(pkg.source) ? riskKey(pkg) : `${pkg.source}\0${pkg.name}@${pkg.version ?? ''}\0${pkg.from ?? ''}`
// Where a repository's lockfiles are used, as `usedIn` names them.
const usedInOf = repo => [...repo.lockfiles?.keys() ?? []].map(path => `${repo.fullName}/${path}`)
// An advisory row's versions, and those each lockfile told of (`versionsIn`,
// for those of one kind alone to name only their lockfiles, _advisoryKinds).
function addVersions(row, usedIn, versions) {
  const told = row.versionsIn.get(usedIn) ?? row.versionsIn.set(usedIn, new Set()).get(usedIn)
  for (const version of versions) { told.add(version); row.versions.add(version) }
}

// Malware, then a differing copy (above any score: enough critical findings
// score 100 too), then by risk, then pending, failed, none, not assessed.
function rank(row) {
  if (hasMalware(row)) return -102
  if (differs(row)) return -101
  const score = scoreOf(row)
  if (score > 0) return -score
  if (!assessable(row.source)) return 4
  if (score === 0) return 3
  return row.risk ? 2 : 1
}

const tabList = (name, tabs, current, choose) => html`<div class="risk-tabs" role="tablist" aria-label=${name}>${tabs.map(([tab, label]) => html`<button type="button" role="tab"
  aria-selected=${current === tab} @click=${() => choose(tab)}>${label}</button>`)}</div>`

class ManagedAdminRepositoryRisk extends ManagedPage {
  static view = 'manage-repos'
  static properties = { _state: { state: true }, _filter: { state: true }, _kind: { state: true }, _packageKind: { state: true },
    _query: { state: true }, _tab: { state: true }, _actionKind: { state: true }, _files: { state: true },
    _scope: { state: true }, _target: { state: true }, _choices: { state: true } }
  static styles = [unsafeCSS(commonStyles), unsafeCSS(linksStyles), unsafeCSS(riskStyles)]

  constructor() {
    super()
    // _state: idle, running, stopped or done. _kind: the advisories' KINDS,
    // _packageKind the packages', _actionKind the Actions tab's. _tab:
    // packages, advisories or actions; _files: lockfiles or workflows.
    // _scope (SCOPES) names a team's or repository's id in _target; _choices
    // are the teams and repositories, as Teams has them.
    Object.assign(this, { _state: 'idle', _filter: 'all', _kind: 'production', _packageKind: 'all', _actionKind: 'all', _query: '',
      _tab: 'packages', _files: 'lockfiles', _scope: 'all', _target: '', _choices: null })
    this._scan = null
    this._drawTimer = null
    // The parts a scan has been asked in so far (MAX_PARTS).
    this._parts = 0
    this._reset()
  }

  _load() {
    return this._loadCollection('teams', 'teams', fetchTeams, data => { this._choices = data })
  }

  // What later scans read, dropping what was found of another; not while
  // scanning. The same one chosen again keeps its findings.
  _choose(scope, target = '') {
    if (this._state === 'running' || (scope === this._scope && target === this._target)) return
    this._scope = scope
    this._target = target
    this._reset()
    this._error = null
    this._state = 'idle'
  }

  _reset() {
    // By id: { id, fullName, commit, error, detail, dependabot: { alerts } or
    // { error, detail } or null, lockfiles: by path { path, format, packages,
    // error, detail } }.
    this._repos = new Map()
    // By packageKey: { name, version, source, from, integrity, usedIn,
    // neededIn (those of usedIn needing it beyond devDependencies), dev (none
    // does), risk, wasStale (told stale this scan), malware (advisory ids) }.
    this._packages = new Map()
    // By id and package: an advisory, its versions and where (Sets), and
    // Dependabot's alerts of it by where (_alert).
    this._advisories = new Map()
    this._actions = new ActionsState()
  }

  disconnectedCallback() {
    this.stop()
    super.disconnectedCallback()
  }

  async start() {
    if (this._state === 'running' || (this._scope !== 'all' && !this._target)) return
    // The scan's id lets later parts skip what earlier ones told whole
    // (repository-risk.ts ScanProgress).
    const params = new URLSearchParams({ ...this._scope === 'all' ? {} : { [this._scope]: this._target }, scan: crypto.randomUUID() })
    this._reset()
    this._error = null
    this._state = 'running'
    const scan = new AbortController()
    this._scan = scan
    this._parts = 0
    try {
      // A time-limited (serverless) server answers in parts (`continue`),
      // each asked from where the last stopped.
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
      // Stopped otherwise than by stop(), as by a session change.
      if (this._scan === scan) {
        this._scan = null
        if (this._state === 'running') this._state = 'stopped'
      }
      this._draw(true)
    }
  }

  // The server stops with its reader; what was found stays.
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

  // How much is told: repositories, lockfiles, advisories and alerts read or
  // failed, and risks told fresh.
  _told() {
    let told = 0
    for (const repo of this._repos.values()) {
      if (repo.lockfiles || repo.error) told++
      if (repo.dependabot) told++
      for (const lockfile of repo.lockfiles?.values() ?? []) told += Number(lockfile.packages !== null || Boolean(lockfile.error)) + Number(Boolean(lockfile.advisories || lockfile.advisoriesError))
    }
    for (const row of this._packages.values()) if (row.risk && !row.risk.stale) told++
    return told + this._actions.told()
  }

  // A scan's next part tells its repositories and lockfiles again: what was
  // told is kept until told otherwise.
  _apply(line) {
    if (line.type === 'repos') {
      // Those no longer listed (disconnected, no longer the team's) or
      // renamed are forgotten.
      const listed = new Map(line.repos.map(({ id, fullName }) => [id, fullName]))
      const gone = [...this._repos.values()].filter(repo => listed.get(repo.id) !== repo.fullName)
      for (const repo of gone) { this._repos.delete(repo.id); this._actions.forget(repo.id) }
      this._forget(gone.flatMap(usedInOf), gone.some(repo => repo.dependabot?.alerts))
      for (const { id, fullName } of line.repos) if (!this._repos.has(id)) this._repos.set(id, { id, fullName, commit: null, lockfiles: null, error: null, detail: null, dependabot: null })
    } else if (line.type === 'repo') {
      const repo = this._repos.get(line.id)
      if (!repo) return
      // One failing after an earlier part read it (its access withdrawn)
      // forgets what its lockfiles and alerts told.
      if (line.error) {
        const told = usedInOf(repo)
        const alerted = Boolean(repo.dependabot?.alerts)
        Object.assign(repo, { lockfiles: null, error: line.error, detail: line.detail ?? null, dependabot: null })
        this._actions.forget(repo.id)
        this._forget(told, alerted)
        return
      }
      // Its lockfiles kept, unless its default branch moved on between parts;
      // those no longer listed (a team's directories changed) forgotten.
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
      // Told stale stays marked for the scan (_metrics), assessed again or not.
      if (row) { row.risk = riskOf(line, row.risk); row.wasStale ||= Boolean(row.risk.stale) }
    } else if (line.type === 'advisories') {
      this._applyAdvisories(line)
    } else if (line.type === 'dependabot') {
      this._applyDependabot(line)
    } else if (line.type === 'action' || ((line.type === 'workflows' || line.type === 'workflow') && this._repos.has(line.repo))) {
      this._actions.apply(line)
    }
  }

  // What lockfiles no longer listed told (`usedIn`): packages no other one
  // tells, and the advisories, rebuilt then too where a repository's
  // Dependabot alerts are forgotten (`alerted`).
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

  // The advisories rebuilt from each lockfile's last, with the alerts blended in.
  _readvise() {
    this._advisories = new Map()
    for (const row of this._packages.values()) row.malware = undefined
    for (const repo of this._repos.values()) {
      for (const [path, lockfile] of repo.lockfiles ?? []) if (lockfile.advisories) this._advise(`${repo.fullName}/${path}`, lockfile.advisories)
    }
    this._alert()
  }

  _alerted() {
    return [...this._repos.values()].some(repo => repo.dependabot?.alerts?.length > 0)
  }

  // Told differently (a scan over an hour audits again, RISK_KEPT_MS), a
  // lockfile's advisories replace its last. With alerts blended in, all are
  // rebuilt, as an alert listed alone may be of an advisory these tell.
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

  // A repository's alerts replace its last; where a later part couldn't have
  // them, the last are kept beside why.
  _applyDependabot(line) {
    const repo = this._repos.get(line.repo)
    if (!repo) return
    const before = repo.dependabot
    repo.dependabot = line.error ? { ...before?.alerts && { alerts: before.alerts }, error: line.error, detail: line.detail ?? null } : { alerts: line.alerts }
    if (JSON.stringify(before?.alerts ?? null) !== JSON.stringify(repo.dependabot.alerts ?? null)) this._readvise()
  }

  // Dependabot's alerts blended into npm's advisories: one of an advisory
  // told (by GHSA, its id or an alias, and package) joins it, open or
  // dismissed, with its versions, malware and manifest (linked by
  // lockfileLink); an open one of none is listed as GitHub tells it, and a
  // dismissed one never alone.
  _alert() {
    const byGhsa = new Map()
    const keyOf = (ghsa, name) => `${ghsa.toUpperCase()}\0${name}`
    for (const row of this._advisories.values()) {
      for (const id of [row.id, row.ghsa, ...row.aliases ?? []]) if (isGhsa(id) && !byGhsa.has(keyOf(id, row.name))) byGhsa.set(keyOf(id, row.name), row)
    }
    // The open ones first, as only they list an advisory of their own.
    const alerts = [...this._repos.values()].flatMap(repo => (repo.dependabot?.alerts ?? []).map(alert => ({ repo, alert })))
    for (const { repo, alert } of [...alerts.filter(each => !each.alert.dismissed), ...alerts.filter(each => each.alert.dismissed)]) {
      const usedIn = `${repo.fullName}/${alert.manifest}`
      let row = byGhsa.get(keyOf(alert.ghsa, alert.name))
      if (!row && alert.dismissed) continue
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
      if (alert.versions.length > 0) addVersions(row, usedIn, alert.versions)
      row.malware ||= alert.malware
      this._markMalware(row)
    }
  }

  // A lockfile's advisories, each once by id and package: npm answers one per
  // range it covers, merged here (as npm-insights.ts does).
  _advise(usedIn, advisories) {
    for (const { range, versions, ...advisory } of advisories) {
      const key = `${advisory.id}\0${advisory.name}`
      let row = this._advisories.get(key)
      if (!row) this._advisories.set(key, row = { ...advisory, ranges: new Set(), versions: new Set(), usedIn: new Set(), versionsIn: new Map() })
      if (range) row.ranges.add(range)
      row.malware ||= advisory.malware
      row.usedIn.add(usedIn)
      addVersions(row, usedIn, versions)
      this._markMalware(row)
    }
  }

  // Malware marked on the packages of the versions it names.
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
      needed: tally(assessed.filter(row => !row.dev)), dev: tally(assessed.filter(row => row.dev)),
      advisories: this._adviseCounts(),
    }
  }

  // How many advisories: in all, of malware, production's, and dev-only.
  _adviseCounts() {
    const kinds = this._advisoryKinds()
    const needed = new Set(kinds.production.filter(row => !row.malware).map(row => `${row.id}\0${row.name}`))
    const malware = [...this._advisories.values()].filter(row => row.malware).length
    return { total: this._advisories.size, malware, needed: needed.size, dev: this._advisories.size - malware - needed.size }
  }

  // The package rows shown, the riskiest first (rank), more findings ahead.
  _rows() {
    const query = this._query.trim().toLowerCase()
    const [, shown] = FILTERS[this._filter]
    return [...this._packages.values()].filter(row => ofKind(row, this._packageKind) && shown(row) && (!query || row.name.toLowerCase().includes(query)))
      .toSorted((a, b) => rank(a) - rank(b) || findingsOf(b).length - findingsOf(a).length
        || a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? ''))
  }

  // Each of KINDS' advisories, with that kind's versions and the lockfiles
  // telling of them; a version is development's where every package of it
  // is `dev`. One only an alert tells of, of no version a lockfile read
  // locks (a package.json, bun's), is of the alert's scope. Malware's is of
  // both, with all its versions.
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
      const unversioned = [...row.alerts ?? []].filter(([usedIn]) => !row.versionsIn.get(usedIn)?.size)
      const devIn = unversioned.filter(([, alert]) => alert.dev).map(([usedIn]) => usedIn)
      const neededIn = unversioned.filter(([, alert]) => !alert.dev).map(([usedIn]) => usedIn)
      if (row.malware) {
        const all = { ...row, dev: needed.length === 0 && neededIn.length === 0 }
        kinds.production.push(all)
        kinds.development.push(all)
        continue
      }
      const of = (shown, also) => ({ ...row, versions: new Set(shown),
        usedIn: new Set([...row.usedIn].filter(usedIn => also.includes(usedIn) || shown.some(version => row.versionsIn.get(usedIn)?.has(version)))) })
      if (needed.length > 0 || neededIn.length > 0) kinds.production.push({ ...of(needed, neededIn), dev: false })
      if (dev.length > 0 || devIn.length > 0) kinds.development.push({ ...of(dev, devIn), dev: true })
    }
    return kinds
  }

  // Malware first, then the most severe.
  _advisoryRows(kinds = this._advisoryKinds()) {
    const query = this._query.trim().toLowerCase()
    return kinds[this._kind].filter(row => !query || row.name.toLowerCase().includes(query))
      .toSorted((a, b) => Number(b.malware) - Number(a.malware) || severityRank(a.severity) - severityRank(b.severity)
        || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  // Buttons of `kinds` ({ kind: label }), each counted, `value` pressed.
  _kindToggle(name, kinds, counts, value, choose) {
    return html`<div class="risk-scope" role="group" aria-label=${name}>${Object.entries(kinds).map(([kind, label]) => html`<button type="button"
      aria-pressed=${value === kind} @click=${() => choose(kind)}>${label}<span class="n">${formatCount.format(counts[kind])}</span></button>`)}</div>`
  }

  // FILTERS of `rows`, those matching none left out (but All and the one
  // chosen); none where All alone is left.
  _filterToggle(rows) {
    const counts = Object.fromEntries(Object.entries(FILTERS).map(([filter, [, shown]]) => [filter, rows.filter(shown).length]))
    const offered = Object.entries(FILTERS).filter(([filter]) => filter === 'all' || filter === this._filter || counts[filter] > 0)
    return offered.length === 1 ? nothing : this._kindToggle('Show packages', Object.fromEntries(offered.map(([filter, [label]]) => [filter, label])),
      counts, this._filter, filter => { this._filter = filter })
  }

  // Each lockfile's GitHub link at the commit read, by `usedIn`.
  _lockfileLinks() {
    const links = new Map()
    for (const repo of this._repos.values()) {
      for (const path of repo.commit ? repo.lockfiles?.keys() ?? [] : []) {
        links.set(`${repo.fullName}/${path}`, githubHref(repo.fullName, repo.commit, path))
      }
    }
    return links
  }

  render() {
    return html`<div class="wrap">${this._nav()}
      <h1 class="sr-only">Repository risk</h1>
      <div class="page-intro"><p class="intro">Risks in each repository’s npm dependencies and GitHub Actions.</p>
        ${this._stateBadge()}${this._state === 'running' ? html`<button type="button" class="btn" @click=${() => this.stop()}>Stop</button>`
          : html`<button type="button" class="btn primary" ?disabled=${this._scope !== 'all' && !this._target} @click=${() => { void this.start() }}>${this._state === 'idle' ? 'Start scan' : 'Scan again'}</button>`}
      </div>
      ${this._scopeBar()}
      ${this._progress()}
      ${this._error ? html`<p class="msg error" role="alert">${this._error}</p>` : nothing}
      ${this._repos.size === 0 ? nothing : html`<div class="manage-list">${this._lockfiles()}
        ${this._packages.size === 0 && this._actions.files.size === 0 ? nothing
          : this._tab === 'advisories' ? this._advisoryTable() : this._tab === 'actions' ? this._actionsTable() : this._packageTable()}</div>`}
    </div>`
  }

  _tabs() {
    const actions = this._actions.rows('actions').length
    const tabs = [['packages', 'Packages'], ['advisories', html`Advisories${this._advisories.size > 0 ? html`<span class="n">${formatCount.format(this._advisories.size)}</span>` : nothing}`],
      ['actions', html`Actions${actions > 0 ? html`<span class="n">${formatCount.format(actions)}</span>` : nothing}`]]
    return tabList('Results', tabs, this._tab, tab => { this._tab = tab })
  }

  _search(count, total, what, by = 'package') {
    return html`<input type="search" aria-label=${`Search ${what}`} placeholder=${`Search by ${by}…`} .value=${this._query} @input=${event => { this._query = event.target.value }}>
      <span class="result-count">${count === total ? '' : `${formatCount.format(count)} of `}${formatCount.format(total)} ${what}</span>`
  }

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

  // The scan's progress, a metric each: `label`, `value` (of `of`), its
  // `bar`'s segments `[kind, n]` (of `scale`, else `of`, else `value`), its
  // parts `split` `[kind, n, of]` and `note` lines for the tooltip, and a
  // `tone`.
  _metrics() {
    const counts = this._counts()
    const { needed, dev, advisories } = counts
    const count = value => formatCount.format(value)
    // A bar's segments, and the split of those not empty.
    const apart = parts => ({ bar: parts.map(([kind, value]) => [kind, value]), split: parts.filter(([, value, total = value]) => total > 0) })
    const flagged = needed.flagged + dev.flagged, stale = needed.stale + dev.stale, wasStale = needed.wasStale + dev.wasStale
    const { workflows, workflowsRead } = this._actions.counts()
    return [
      { label: 'Repositories', value: counts.reposRead, of: counts.repos, bar: [['read', counts.reposRead]],
        split: [['lockfiles', counts.lockfilesRead, counts.lockfiles], ['workflows', workflowsRead, workflows]].filter(([, , total]) => total > 0) },
      { label: 'Packages', value: needed.told + dev.told, of: needed.total + dev.total,
        ...apart([['prod', needed.told, needed.total], ['dev', dev.told, dev.total]]) },
      { label: 'Flagged', value: flagged, ...apart([['prod', needed.flagged], ['dev', dev.flagged]]), tone: flagged > 0 ? 'high' : null },
      // Those still stale; the bar, those assessed again of all told stale.
      ...wasStale > 0 ? [{ label: 'Stale', value: stale, scale: wasStale,
        bar: [['prod', needed.wasStale - needed.stale], ['dev', dev.wasStale - dev.stale]], split: apart([['prod', needed.stale], ['dev', dev.stale]]).split,
        note: [...stale > 0 ? [`Assessed over an hour ago; ${this._state === 'running' ? 'to be assessed again once the rest are' : 'not assessed again yet'}.`] : [],
          `${count(wasStale - stale)} of ${count(wasStale)} assessed again.`] }] : [],
      ...advisories.total > 0 ? [{ label: 'Advisories', value: advisories.total,
        ...apart([['malware', advisories.malware], ['prod', advisories.needed], ['dev', advisories.dev]]) }] : [],
      ...this._actionsMetrics(),
    ]
  }

  _actionsMetrics() {
    if (this._actions.listed.size === 0) return []
    const { actions, resolved } = this._actions.counts()
    const flagged = this._actions.rows('all').filter(row => row.severity && row.severity !== 'notice' && row.severity !== 'low').length
    return [{ label: 'Actions', value: resolved, of: actions, bar: [['read', resolved]] },
      { label: 'Actions flagged', value: flagged, bar: [], tone: flagged > 0 ? 'high' : null }]
  }

  _stateBadge() {
    if (this._state === 'idle') return nothing
    const state = this._state === 'running' && this._parts > 1 ? `Scanning · part ${formatCount.format(this._parts)}` : { running: 'Scanning', stopped: 'Stopped', done: 'Done' }[this._state]
    return html`<span class="risk-state" role="status" data-state=${this._state}>${state}</span>`
  }

  // Each metric with its bar and tooltip, its text said to screen readers
  // too, as the bar is hidden from them and the tooltip shows on hover.
  _progress() {
    if (this._state === 'idle') return html`<div class="risk-progress" role="status"><p class="risk-progress-idle">Not scanned yet. A scan reads each repository from GitHub and assesses each npm package it locks, which can take a while; a scan again within the hour is quicker.</p></div>`
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
    })}</div>`
  }

  _pending(running, otherwise) {
    return html`<span class="risk-pending">${this._state === 'running' ? running : otherwise}</span>`
  }

  // What a repository's row says instead of its lockfiles (or `workflows`);
  // null where it has some.
  _repoStatus(repo, workflows = false) {
    if (repo.error) return failure(repo)
    if (repo.lockfiles === null) return this._pending('Waiting…', 'Not read')
    if (!workflows) return repo.lockfiles.size === 0 ? html`<span class="risk-none">No npm lockfiles</span>` : null
    const listed = this._actions.listed.get(repo.id)
    if (!listed) return this._pending('Waiting…', 'Not read')
    return listed.error || this._actions.filesOf(repo.id).length > 0 ? null : html`<span class="risk-none">No workflows</span>`
  }

  _lockfileStatus(lockfile) {
    if (lockfile.error) return failure(lockfile)
    return lockfile.packages === null ? this._pending('Reading…', 'Not read') : `${formatCount.format(lockfile.packages)} packages`
  }

  // A line per repository: its lockfiles (format, packages) or, on their tab,
  // its workflows and own actions (findings), or why there are none.
  _lockfiles() {
    const workflows = this._actions.listed.size > 0 && this._files === 'workflows'
    return html`<section class="risk-section" aria-label="Lockfiles and workflows">
      ${this._actions.listed.size > 0 ? tabList('Files', [['lockfiles', 'Lockfiles'], ['workflows', 'Workflows']], this._files, files => { this._files = files }) : html`<h2>Lockfiles</h2>`}
      <ul class="risk-repos">${[...this._repos.values()].map(repo => html`<li>
        <span class="risk-repo-name" data-tooltip-truncated data-tooltip=${repo.fullName}>${repo.fullName}</span>
        ${this._repoStatus(repo, workflows) ?? html`<ul class="risk-lockfiles">${workflows ? this._workflowItems(repo) : [...repo.lockfiles.values()].map(lockfile => html`<li>
          <span class="mono">${lockfile.path}</span><span class="risk-lockfile-meta">${lockfile.format} · ${this._lockfileStatus(lockfile)}</span>
        </li>`)}</ul>`}
      </li>`)}</ul>
    </section>`
  }

  _workflowItems(repo) {
    const listed = this._actions.listed.get(repo.id)
    if (!listed) return nothing
    if (listed.error) return html`<li><span class="mono">.github/workflows</span><span class="risk-lockfile-meta">${failure(listed)}</span></li>`
    return this._actions.filesOf(repo.id).map(file => html`<li><span class="mono">${file.path}</span><span class="risk-lockfile-meta">${file.kind} · ${file.error ? failure(file)
      : `${formatCount.format(file.findings.length)} findings`}</span></li>`)
  }

  // Kept in view as the results scroll.
  _resultsHead(controls) {
    return html`<div class="risk-results-head">${this._tabs()}<div class="collection-toolbar">${controls}</div></div>`
  }

  _packageTable() {
    const rows = this._rows()
    const all = [...this._packages.values()]
    const counts = Object.fromEntries(Object.keys(PACKAGE_KINDS).map(kind => [kind, all.filter(row => ofKind(row, kind)).length]))
    const links = this._lockfileLinks()
    // A Source column, unless all are from npm's registry, as most are.
    const sourced = all.some(row => row.source !== 'registry')
    return html`<section class="risk-section" aria-label="Packages">
      ${this._resultsHead(html`${this._kindToggle('Which packages', PACKAGE_KINDS, counts, this._packageKind, kind => { this._packageKind = kind })}
        ${this._filterToggle(all.filter(row => ofKind(row, this._packageKind)))}
        ${this._search(rows.length, counts[this._packageKind], 'packages')}`)}
      ${this._table(rows, null, html`<th>Package</th><th><span data-tooltip=${RISK_SAID}>Risk</span></th><th>Findings</th>${sourced ? html`<th>Source</th>` : nothing}<th class="risk-used-column">Used in</th>`,
        packageKey, row => this._packageRow(row, links, sourced), 'Search or filter to see others.')}
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

  // Out of 100, in its level's color (npmRiskLevel); nothing where not told,
  // the findings cell saying why.
  _score(row) {
    const score = scoreOf(row)
    const told = score === null ? nothing : html`<span class=${`risk-score risk-${npmRiskLevel(score)}`}>${score}</span>`
    return row.risk?.stale ? html`${told}<span class="risk-stale" data-tooltip=${this._staleSaid(row.risk)}>stale</span>` : told
  }

  _staleSaid({ stale, refreshFailed }) {
    const next = refreshFailed ? `couldn’t be assessed again: ${refreshFailed}` : this._state === 'running' ? 'to be assessed again once the rest are' : 'not assessed again yet'
    return `Assessed ${ago(stale.assessedAt)}; ${next}`
  }

  // Each finding by its severity; or whether it is pending, failed or unasked.
  _findings(row) {
    const findings = findingsOf(row)
    if (findings.length > 0) {
      return html`<ul class="risk-findings">${findings.map(finding => html`<li class=${`risk-${finding.severity}`}
        data-tooltip=${finding.id === 'malware' ? malwareSaid(row).join('\n') : nothing}>${FINDING_LABELS[finding.id] ?? finding.id}</li>`)}</ul>`
    }
    if (!assessable(row.source)) return html`<span class="risk-none">Not assessed</span>`
    if (!row.risk) return this._pending('Waiting…', 'Not assessed')
    if (differs(row)) return html`<ul class="risk-findings"><li class="risk-critical" data-tooltip=${DIFFERS_SAID}>${errorText(row.risk.error)}</li></ul>`
    if (row.risk.error) return failure(row.risk)
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
      ${this._table(rows, this._state === 'running' ? 'None yet.' : none, html`<th>Package</th><th>Versions</th><th>Severity</th><th>Advisory</th><th>Title</th><th>Affected</th><th>Used in</th>`,
        row => `${row.id}\0${row.name}`, row => this._advisoryRow(row, links))}
    </section>`
  }

  _actionsTable() {
    const counts = Object.fromEntries(Object.keys(ACTION_KINDS).map(kind => [kind, this._actions.rows(kind).length]))
    const rows = this._actions.rows(this._actionKind, this._query)
    const empty = this._state === 'running' ? 'None yet.' : this._actions.listed.size === 0 ? 'No workflows were read.' : 'Nothing found.'
    return html`<section class="risk-section" aria-label="Actions">
      ${this._resultsHead(html`${this._kindToggle('Which', ACTION_KINDS, counts, this._actionKind, kind => { this._actionKind = kind })}
        ${this._search(rows.length, counts[this._actionKind], 'rows', 'name')}`)}
      ${this._table(rows, empty, html`<th>Uses</th><th>Pinned to</th><th>Findings</th><th class="risk-used-column">Used in</th>`, row => row.key, row => this._actionRow(row))}
    </section>`
  }

  // A table of `rows` under `head`, MAX_ROWS at most; `empty` where none are
  // (unless null), `more` where some are left out.
  _table(rows, empty, head, key, row, more = 'Search to see others.') {
    return html`${rows.length === 0 && empty != null ? html`<p class="msg">${empty}</p>` : html`<div class="link-table"><table>
        <thead><tr>${head}</tr></thead><tbody>${repeat(rows.slice(0, MAX_ROWS), key, row)}</tbody></table></div>`}
      ${rows.length > MAX_ROWS ? html`<p class="msg">Showing the first ${formatCount.format(MAX_ROWS)}. ${more}</p>` : nothing}`
  }

  // A reference, linked on GitHub, and what it is pinned to; or what a step
  // pulls in. Then its findings and where it is used.
  _actionRow(row) {
    const href = row.kind === 'action' ? referenceHref(row) : null
    // A commit cut short, as GitHub shows one; the whole key in its tooltip.
    const ref = row.key.replace(/^[^@]*@/u, '').replace(/^([\da-f]{7})[\da-f]{33}\b/u, '$1')
    const name = row.kind === 'action' ? html`<span data-tooltip=${row.key}>${row.key.replace(/@.*$/u, '')}<span class="risk-version">@${ref}</span></span>` : row.name
    const status = row.line?.error ? failure(row.line) : row.kind === 'action' && !row.line ? this._pending('Resolving…', 'Not resolved') : nothing
    return html`<tr>
      <td><span class="risk-package">${icon(row.kind === 'action' ? GITHUB_ICON_SVG : BUNDLE_ICON_SVG)}${href
        ? html`<a class="risk-name mono" href=${href} target="_blank" rel="noopener noreferrer">${name}</a>` : html`<span class="mono">${name}</span>`}</span></td>
      <td class="mono">${pinnedTo(row.line) ?? status}</td>
      <td>${row.findings.length > 0 ? findingsCell(row.findings) : row.line && !row.line.error ? html`<span class="risk-none">None found</span>` : nothing}</td>
      <td>${this._actionUsedIn(row.usedIn)}</td>
    </tr>`
  }

  // A file's line, linked on GitHub at the commit read, or a reference naming it.
  _actionUsedIn(usedIn) {
    const links = new Map()
    const used = usedIn.map(({ repo, path, line, via }) => {
      if (via) return `via ${via}`
      const { fullName = String(repo), commit } = this._repos.get(repo) ?? {}
      const text = `${fullName}/${path}:${line}`
      if (commit) links.set(text, `${githubHref(fullName, commit, path)}${line ? `#L${line}` : ''}`)
      return text
    })
    return usedInCell(used, links, undefined, 'places')
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

  // How many alerts (open, dismissed) of how many repositories, and whose
  // couldn't be had, why in its tooltip; nothing where none told any.
  _dependabotStatus() {
    const repos = [...this._repos.values()].filter(repo => repo.dependabot)
    if (repos.length === 0) return nothing
    const had = repos.filter(repo => repo.dependabot.alerts)
    const failed = repos.filter(repo => repo.dependabot.error)
    const count = (value, one, many = `${one}s`) => `${formatCount.format(value)} ${value === 1 ? one : many}`
    // How many open, and dismissed where any are, of `alerts`.
    const said = alerts => {
      const dismissed = alerts.filter(alert => alert.dismissed).length, open = alerts.length - dismissed
      return dismissed === 0 ? count(open, 'open alert')
        : `${formatCount.format(open)} open and ${formatCount.format(dismissed)} dismissed ${alerts.length === 1 ? 'alert' : 'alerts'}`
    }
    const why = failed.map(({ fullName, dependabot: { error, detail } }) => `${fullName}: ${errorText(error)}${detail ? ` (${detail})` : ''}`).join('\n')
    return html`<p class="risk-dependabot" role="status">${icon(DEPENDABOT_ICON_SVG)}<span>Dependabot</span>
      ${had.length > 0 ? html`<span data-tooltip=${had.map(repo => `${repo.fullName}: ${said(repo.dependabot.alerts)}`).join('\n')}>${said(had.flatMap(repo => repo.dependabot.alerts))} of ${count(had.length, 'repository', 'repositories')}</span>` : nothing}
      ${failed.length > 0 ? html`<span class="risk-dependabot-failed" data-tooltip=${why}>${had.length > 0 ? 'unavailable for ' : 'alerts unavailable for '}${failed.length === 1 ? failed[0].fullName : count(failed.length, 'repository', 'repositories')}${failed.length === 1 ? html`: ${errorText(failed[0].dependabot.error)}` : nothing}</span>` : nothing}
    </p>`
  }
}
customElements.define('managed-admin-repo-risk', ManagedAdminRepositoryRisk)
