// Manage → Repositories → Risk, for admins: every connected repository's npm
// lockfiles, or a team's or one repository's, their packages, and what risk
// tells of each, as the server finds them (GET /api/admin/repositories/risk,
// server-managed/repository-risk.ts); npm's advisories of them on a tab of
// their own, those of malware a package's risk too. Those only devDependencies
// need are tagged so and listed after the rest. Opened by its URL alone,
// /manage/repositories/risk, until it is linked.
import { html, nothing, unsafeCSS } from 'lit'
import { isHttpUrl } from '@preventive/report'
import { SEVERITIES } from '../../risk/files/stamps.js'
import { npmRiskLevel } from '../../risk/npm/score.js'
import { managedRoutePath } from '../../common/managed/routes.js'
import { ManagedPage } from './page.js'
import { adminNavigation } from './navigation.js'
import { request, responseLines } from './bundle-data.js'
import { fetchTeams } from './admin-api.js'
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
}
const errorText = code => ERRORS[code] ?? code
const START_ERRORS = { 401: 'Sign in again to scan repositories.', 403: 'Only admins can scan repositories.',
  404: 'That team or repository is no longer connected. Choose again.' }

// What a scan reads: every connected repository, a team's, or one.
const SCOPES = [['all', 'All repositories'], ['team', 'Team'], ['repo', 'Repository']]

const SOURCE_LABELS = { registry: 'npm', mirror: 'Mirror', git: 'Git', tarball: 'Tarball', file: 'File' }
const assessable = source => source === 'registry' || source === 'mirror'

// The malware advisories name in a package. They speak of npm's artifact:
// not of one risk finds differs from npm's, as a private package of a public
// one's name does, from npm's registry or a mirror. A mirror's copy can't be
// held to npm's integrity where npm deleted the version, as it deletes every
// one it finds malware in: it is npm's unless found otherwise.
export const malwareOf = row => row.risk?.error === 'integrity-mismatch' ? null : row.malware ?? null
// A package row's most severe finding, its malware first, as critical: the
// advisories', or risk's own of a package npm took down, once. What its rows
// are flagged by.
const severityOf = row => malwareOf(row) ? 'critical' : row.risk?.severity ?? null
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
// Whether a package row is listed after the rest: only devDependencies need
// it, in every lockfile that locks it, as an install of none leaves it out;
// but not malware, which runs wherever it is installed, CI and a developer's
// machine among them.
export const putOff = row => Boolean(row.dev) && !findingsOf(row).some(({ id }) => id === 'malware')
const severityRank = severity => SEVERITIES.includes(severity) ? SEVERITIES.indexOf(severity) : SEVERITIES.length
const severityLabel = severity => `${severity[0].toUpperCase()}${severity.slice(1)}`

// Which package rows are shown, by the filter's value.
const FILTERS = {
  all: ['All packages', () => true],
  flagged: ['Flagged', row => Boolean(severityOf(row))],
  failed: ['Not assessed: failed', row => Boolean(row.risk?.error)],
  elsewhere: ['Not assessed: not from npm', row => !assessable(row.source)],
}

// What a package's risk is, as its column's heading tells it.
const RISK_SAID = 'Out of 100: what its findings call for, lowered by how long the version has been out among how many download its package. Malware is 100.'
// What a package's dev tag, or an advisory's, tells.
const DEV_SAID = 'Only devDependencies need it, in every lockfile that locks it: an install without them leaves it out. Assessed after the rest, and listed after them unless it is malware.'
const ADVISORY_DEV_SAID = 'Only devDependencies need the versions it affects, in every lockfile that locks them: an install without them leaves them out. Listed after the rest.'
const devTag = said => html`<span class="risk-dev" data-tooltip=${said}>dev</span>`

// A package row's risk as its line tells it, `stale` where the line is one
// kept and since gone stale (when it was assessed); a stale one assessed
// again replaced, or, where that fails, kept, saying why (`refreshFailed`).
export function riskOf(line, was) {
  const stale = line.stale ?? null
  if (line.error && !stale && was?.stale && !was.error) return { ...was, refreshFailed: line.detail ? `${errorText(line.error)}: ${line.detail}` : errorText(line.error) }
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

// Package rows' counts: how many, how many told, flagged and stale.
const tally = rows => ({ total: rows.length, told: rows.filter(row => row.risk).length, flagged: rows.filter(severityOf).length,
  stale: rows.filter(row => row.risk?.stale).length })

// Where a package or an advisory is locked: its lockfile, or how many, each
// in the tooltip.
function usedInCell(lockfiles) {
  const used = [...lockfiles]
  return used.length === 1 ? html`<span class="risk-clip risk-used-in" data-tooltip-truncated data-tooltip=${used[0]}>${used[0]}</span>`
    : html`<span class="risk-clip risk-used-in" data-tooltip=${used.join('\n')}>${formatCount.format(used.length)} lockfiles</span>`
}

// The lines of a scan of `params` (`team` or `repo`, or neither),
// repository-risk.ts RepositoryRiskLine, each as it comes.
const streamRisk = (params, signal, onLine) => request(`/api/admin/repositories/risk${params.size > 0 ? `?${params}` : ''}`, START_ERRORS, async response => {
  for await (const line of responseLines(response)) onLine(line)
}, signal)

// A package row's key: npm's package by its name and version, a mirror's by
// its integrity too, as its risk line names it; any other by where it is from.
const riskKey = ({ name, version, integrity }) => `${name}@${version}\0${integrity ?? ''}`
const packageKey = pkg => assessable(pkg.source) ? riskKey(pkg) : `${pkg.source}\0${pkg.name}@${pkg.version ?? ''}\0${pkg.from ?? ''}`

// A package row's rank: by its risk, the highest first, then those still to
// be told, those that couldn't be, those of none, and those not assessed.
function rank(row) {
  const score = scoreOf(row)
  if (score > 0) return -score
  if (!assessable(row.source)) return 4
  if (score === 0) return 3
  return row.risk ? 2 : 1
}

class ManagedAdminRepositoryRisk extends ManagedPage {
  static properties = { _state: { state: true }, _error: { state: true }, _filter: { state: true }, _query: { state: true }, _tab: { state: true },
    _scope: { state: true }, _target: { state: true }, _choices: { state: true } }
  static styles = [unsafeCSS(commonStyles), unsafeCSS(linksStyles), unsafeCSS(riskStyles)]

  constructor() {
    super()
    // idle, running, stopped or done.
    this._state = 'idle'
    this._error = null
    this._filter = 'all'
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
    if (this._state === 'running') return
    this._scope = scope
    this._target = target
    this._reset()
    this._error = null
    this._state = 'idle'
  }

  _reset() {
    // By id: { id, fullName, commit, lockfiles, error, detail }; lockfiles by path,
    // each { path, format, packages, error, detail }.
    this._repos = new Map()
    // By packageKey: { name, version, source, from, integrity, usedIn: Set,
    // neededIn: Set of those of usedIn that lock it as more than
    // devDependencies need, dev: whether none does, risk, malware: Set of
    // advisory ids where npm's advisories name it }.
    this._packages = new Map()
    // By id and package: an advisory, its versions locked and where (Sets).
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
  // lockfiles' advisories told or failed, and packages' risks told other
  // than stale.
  _told() {
    let told = 0
    for (const repo of this._repos.values()) {
      if (repo.lockfiles || repo.error) told++
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
      this._forget(gone.flatMap(repo => [...repo.lockfiles?.keys() ?? []].map(path => `${repo.fullName}/${path}`)))
      for (const { id, fullName } of line.repos) if (!this._repos.has(id)) this._repos.set(id, { id, fullName, commit: null, lockfiles: null, error: null, detail: null })
    } else if (line.type === 'repo') {
      const repo = this._repos.get(line.id)
      if (!repo) return
      // One that fails where a part before read it, as its access is
      // withdrawn: what its lockfiles told forgotten.
      if (line.error) {
        const told = [...repo.lockfiles?.keys() ?? []].map(path => `${repo.fullName}/${path}`)
        Object.assign(repo, { lockfiles: null, error: line.error, detail: line.detail ?? null })
        this._forget(told)
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
      if (row) row.risk = riskOf(line, row.risk)
    } else if (line.type === 'advisories') {
      this._applyAdvisories(line)
    }
  }

  // What lockfiles no longer listed told (`usedIn`, a repository's name and
  // a path) forgotten: the packages no other lockfile tells, and the
  // advisories as those listed tell them.
  _forget(usedIn) {
    if (usedIn.length === 0) return
    for (const [key, row] of this._packages) {
      for (const used of usedIn) { row.usedIn.delete(used); row.neededIn.delete(used) }
      if (row.usedIn.size === 0) this._packages.delete(key)
      row.dev = row.neededIn.size === 0
    }
    this._readvise()
  }

  // Each listed lockfile's advisories, as it told them last, told anew.
  _readvise() {
    this._advisories = new Map()
    for (const row of this._packages.values()) row.malware = undefined
    for (const repo of this._repos.values()) {
      for (const [path, lockfile] of repo.lockfiles ?? []) if (lockfile.advisories) this._advise(`${repo.fullName}/${path}`, lockfile.advisories)
    }
  }

  // A lockfile's advisories, kept as it told them: told again otherwise, as
  // a scan over an hour long audits it again (repository-risk.ts
  // RISK_KEPT_MS), they replace those it told before.
  _applyAdvisories(line) {
    const repo = this._repos.get(line.repo)
    const lockfile = repo?.lockfiles?.get(line.path)
    if (!lockfile) return
    if (line.error) { lockfile.advisoriesError = line.error; return }
    const before = lockfile.advisories
    Object.assign(lockfile, { advisories: line.advisories, advisoriesError: null })
    if (!before) this._advise(`${repo.fullName}/${line.path}`, line.advisories)
    else if (JSON.stringify(before) !== JSON.stringify(line.advisories)) this._readvise()
  }

  // Advisories a lockfile (`usedIn`) tells, each kept once by its id and
  // package: npm answers one a range it covers, here its ranges and versions
  // together, and malware if any says so (npm-insights.ts merges them
  // alike). Malware's marked on the packages of the versions it names.
  _advise(usedIn, advisories) {
    for (const { range, versions, ...advisory } of advisories) {
      const key = `${advisory.id}\0${advisory.name}`
      let row = this._advisories.get(key)
      if (!row) this._advisories.set(key, row = { ...advisory, ranges: new Set(), versions: new Set(), usedIn: new Set() })
      if (range) row.ranges.add(range)
      for (const version of versions) row.versions.add(version)
      row.malware ||= advisory.malware
      row.usedIn.add(usedIn)
      if (!row.malware) continue
      for (const pkg of this._packages.values()) {
        if (assessable(pkg.source) && pkg.name === row.name && row.versions.has(pkg.version)) (pkg.malware ??= new Set()).add(row.id)
      }
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
      advisories: this._advisories.size, malware: [...this._advisories.values()].filter(row => row.malware).length,
    }
  }

  _rows() {
    const query = this._query.trim().toLowerCase()
    const [, shown] = FILTERS[this._filter]
    return [...this._packages.values()].filter(row => shown(row) && (!query || row.name.toLowerCase().includes(query)))
      .toSorted((a, b) => Number(putOff(a)) - Number(putOff(b)) || rank(a) - rank(b) || findingsOf(b).length - findingsOf(a).length
        || a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? ''))
  }

  // Advisories by their package, malware first, then those of versions more
  // than devDependencies need (`dev` where none is), then the most severe.
  _advisoryRows() {
    const query = this._query.trim().toLowerCase()
    const needed = new Set([...this._packages.values()].filter(row => assessable(row.source) && !row.dev).map(row => `${row.name}@${row.version}`))
    return [...this._advisories.values()].filter(row => !query || row.name.toLowerCase().includes(query))
      .map(row => ({ ...row, dev: ![...row.versions].some(version => needed.has(`${row.name}@${version}`)) }))
      .toSorted((a, b) => Number(b.malware) - Number(a.malware) || Number(a.dev) - Number(b.dev) || severityRank(a.severity) - severityRank(b.severity)
        || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  render() {
    return html`<div class="wrap">${adminNavigation('manage-repos', this._role, this.allowShare)}
      <h1 class="sr-only">Repository risk</h1>
      <div class="page-intro"><p class="intro">Each connected repository’s npm lockfiles at its default branch, and what risk finds in each package they lock.</p>
        ${this._state === 'running' ? html`<button type="button" class="btn" @click=${() => this.stop()}>Stop</button>`
          : html`<button type="button" class="btn primary" ?disabled=${this._scope !== 'all' && !this._target} @click=${() => { void this.start() }}>${this._state === 'idle' ? 'Start scan' : 'Scan again'}</button>`}
      </div>
      ${this._scopeBar()}
      <p class="risk-progress" role="status">${this._progress()}</p>
      ${this._error ? html`<p class="msg error" role="alert">${this._error}</p>` : nothing}
      ${this._repos.size === 0 ? nothing : html`<div class="manage-list">${this._lockfiles()}
        ${this._packages.size === 0 ? nothing : this._tab === 'advisories' ? this._advisoryTable() : this._packageTable()}</div>`}
    </div>`
  }

  _tabs() {
    const tabs = [['packages', 'Packages'], ['advisories', `Advisories${this._advisories.size > 0 ? ` (${formatCount.format(this._advisories.size)})` : ''}`]]
    return html`<div class="risk-tabs" role="tablist" aria-label="Results">${tabs.map(([tab, label]) => html`<button type="button" role="tab"
      aria-selected=${this._tab === tab} @click=${() => { this._tab = tab }}>${label}</button>`)}</div>`
  }

  _search(count, total, what) {
    return html`<input type="search" aria-label=${`Search ${what}`} placeholder="Search by package…" .value=${this._query} @input=${event => { this._query = event.target.value }}>
      <span class="result-count">${count === total ? '' : `${formatCount.format(count)} of `}${formatCount.format(total)} ${what}</span>`
  }

  // A team's chosen from a list, and a repository with the picker the other
  // pages share, by owner and searchable.
  _scopeBar() {
    const running = this._state === 'running'
    const loading = this._choices ? '' : 'Loading…'
    return html`<div class="risk-scope-bar">
      <div class="risk-scope" role="group" aria-label="What to scan">${SCOPES.map(([scope, label]) => html`<button type="button"
        aria-pressed=${this._scope === scope} ?disabled=${running} @click=${() => this._choose(scope)}>${label}</button>`)}</div>
      ${this._scope === 'team' ? html`<select aria-label="Which team" ?disabled=${running} @change=${event => this._choose('team', event.target.value)}>
        <option value="" ?selected=${!this._target}>${loading || 'Choose a team…'}</option>
        ${(this._choices?.teams ?? []).map(team => html`<option value=${team.id} ?selected=${team.id === this._target}>${team.hidden ? `${team.name} (hidden)` : team.name}</option>`)}
      </select>` : nothing}
      ${this._scope === 'repo' ? html`<repository-selector label="Which repository" placeholder=${loading || 'Choose a repository…'} ?disabled=${running || !this._choices}
        .options=${(this._choices?.repos ?? []).map(repo => ({ value: String(repo.repoId), label: repo.fullName }))} .value=${this._target || null}
        @repository-change=${event => this._choose('repo', event.detail.value)}></repository-selector>` : nothing}
    </div>`
  }

  _progress() {
    if (this._state === 'idle') return 'Not scanned yet. A scan reads each repository from GitHub and assesses each npm package it locks, which can take a while; a scan again within the hour is quicker.'
    const counts = this._counts()
    const { needed, dev } = counts
    const of = (read, total, what) => `${formatCount.format(read)} of ${formatCount.format(total)}${what ? ` ${what}` : ''}`
    // Packages' counts, those of devDependencies alone apart where there are any.
    const packages = (what, count) => dev.total === 0 ? `${count(needed)} ${what}` : `${count(needed)} non-dev and ${count(dev)} dev ${what}`
    const state = this._state === 'running' && this._parts > 1 ? `Scanning, part ${formatCount.format(this._parts)}` : { running: 'Scanning', stopped: 'Stopped', done: 'Done' }[this._state]
    return [state, of(counts.reposRead, counts.repos, 'repositories read'), of(counts.lockfilesRead, counts.lockfiles, 'lockfiles'),
      packages('packages assessed', ({ told, total }) => of(told, total)), packages('flagged', ({ flagged }) => formatCount.format(flagged)),
      ...needed.stale + dev.stale > 0 ? [packages('stale', ({ stale }) => formatCount.format(stale))] : [],
      ...counts.advisories > 0 ? [`${formatCount.format(counts.advisories)} advisories${counts.malware > 0 ? `, ${formatCount.format(counts.malware)} of malware` : ''}`] : []].join(' · ')
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
    return html`<section class="risk-section" aria-label="Packages">
      ${this._resultsHead(html`<select aria-label="Show packages" .value=${this._filter} @change=${event => { this._filter = event.target.value }}>
          ${Object.entries(FILTERS).map(([value, [label]]) => html`<option value=${value}>${label}</option>`)}
        </select>
        ${this._search(rows.length, this._packages.size, 'packages')}`)}
      <div class="link-table"><table>
        <thead><tr><th>Package</th><th>Version</th><th><span data-tooltip=${RISK_SAID}>Risk</span></th><th class="risk-findings-column">Findings</th><th>Source</th><th>Used in</th></tr></thead>
        <tbody>${rows.slice(0, MAX_ROWS).map(row => this._packageRow(row))}</tbody>
      </table></div>
      ${rows.length > MAX_ROWS ? html`<p class="msg">Showing the first ${formatCount.format(MAX_ROWS)}. Search or filter to see others.</p>` : nothing}
    </section>`
  }

  _packageRow(row) {
    const path = assessable(row.source) ? managedRoutePath({ view: 'npm', packageName: row.name, packageSpec: row.version }) : null
    return html`<tr class=${row.risk?.stale ? 'is-stale' : ''}>
      <td>${path ? html`<a class="risk-name" href=${path}>${row.name}</a>` : row.name}${row.dev ? devTag(DEV_SAID) : nothing}</td>
      <td class="mono">${row.version ?? '—'}</td>
      <td>${this._score(row)}</td>
      <td>${this._findings(row)}</td>
      <td><span data-tooltip=${row.from ?? nothing}>${SOURCE_LABELS[row.source] ?? row.source}${row.source === 'mirror' && row.from ? ` (${new URL(row.from).host})` : ''}</span></td>
      <td>${usedInCell(row.usedIn)}</td>
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
    if (row.risk.error) return html`<span class="risk-error" data-tooltip=${row.risk.detail ?? nothing}>${errorText(row.risk.error)}</span>`
    return html`<span class="risk-none">None found</span>`
  }

  _advisoryTable() {
    const rows = this._advisoryRows()
    const failed = [...this._repos.values()].flatMap(repo => [...repo.lockfiles?.values() ?? []]
      .filter(lockfile => lockfile.advisoriesError).map(lockfile => `${repo.fullName}/${lockfile.path}`))
    return html`<section class="risk-section" aria-label="Advisories">
      ${this._resultsHead(this._search(rows.length, this._advisories.size, 'advisories'))}
      ${failed.length > 0 ? html`<p class="msg error">npm’s advisories couldn’t be had for <span data-tooltip=${failed.join('\n')}>${failed.length === 1 ? failed[0] : `${formatCount.format(failed.length)} lockfiles`}</span>.</p>` : nothing}
      ${rows.length === 0 ? html`<p class="msg">${this._state === 'running' ? 'None yet.' : 'npm has no advisories of these packages.'}</p>` : html`<div class="link-table"><table>
        <thead><tr><th>Package</th><th>Versions</th><th>Severity</th><th>Advisory</th><th>Title</th><th>Affected</th><th>Used in</th></tr></thead>
        <tbody>${rows.slice(0, MAX_ROWS).map(row => this._advisoryRow(row))}</tbody>
      </table></div>`}
      ${rows.length > MAX_ROWS ? html`<p class="msg">Showing the first ${formatCount.format(MAX_ROWS)}. Search to see others.</p>` : nothing}
    </section>`
  }

  _advisoryRow(row) {
    const versions = [...row.versions]
    const severity = row.malware ? 'critical' : row.severity
    return html`<tr>
      <td><a class="risk-name" href=${managedRoutePath({ view: 'npm', packageName: row.name, packageSpec: versions[0] })}>${row.name}</a>${row.dev ? devTag(ADVISORY_DEV_SAID) : nothing}</td>
      <td class="mono">${versions.join(', ')}</td>
      <td>${row.malware ? html`<span class="risk-chip risk-critical">Malware</span>`
        : severity ? html`<span class=${`risk-chip risk-${severity}`}>${severityLabel(severity)}</span>` : nothing}</td>
      <td class="mono">${isHttpUrl(row.url) ? html`<a href=${row.url} target="_blank" rel="noopener noreferrer">${row.id}</a>` : row.id}</td>
      <td><span class="risk-clip" data-tooltip-truncated data-tooltip=${row.title ?? nothing}>${row.title ?? ''}</span></td>
      <td class="mono">${[...row.ranges].join(' || ')}</td>
      <td>${usedInCell(row.usedIn)}</td>
    </tr>`
  }
}
customElements.define('managed-admin-repo-risk', ManagedAdminRepositoryRisk)
