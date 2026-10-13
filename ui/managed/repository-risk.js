// Manage → Repositories → Risk, for admins: every connected repository's npm
// lockfiles, or a team's or one repository's, their packages, and what risk
// tells of each, as the server finds them (GET /api/admin/repositories/risk,
// server-managed/repository-risk.ts); npm's advisories of them on a tab of
// their own, those of malware a package's risk too. Opened by its URL alone,
// /manage/repositories/risk, until it is linked.
import { html, nothing, unsafeCSS } from 'lit'
import { isHttpUrl } from '@preventive/report'
import { SEVERITIES } from '../../risk/files/stamps.js'
import { managedRoutePath } from '../../common/managed/routes.js'
import { ManagedPage } from './page.js'
import { adminNavigation } from './navigation.js'
import { request, responseLines } from './bundle-data.js'
import { fetchTeams } from './admin-api.js'
import '../view/repository-selector.js'
import commonStyles from './styles/common.css'
import linksStyles from './styles/links.css'
import riskStyles from './styles/repository-risk.css'

// What risk finds of a version on its own (risk/npm/held.js, compare.js), and
// npm's advisories of malware.
const FINDING_LABELS = {
  malware: 'Malware',
  deprecated: 'Deprecated',
  'too-new': 'Too new',
  popularity: 'Unpopular',
  'held-install-scripts': 'Install scripts',
  'held-runs-code': 'Runs code',
  'held-exfiltration': 'Exfiltration host',
  'held-obfuscated': 'Obfuscated',
  'non-registry-deps': 'Non-registry dependencies',
  'unused-deps': 'Unused deps',
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
// A package row's risk, its malware first, as critical: the advisories', or
// risk's own of a package npm took down, once.
const severityOf = row => malwareOf(row) ? 'critical' : row.risk?.severity ?? null
export const findingsOf = row => {
  const found = row.risk?.findings ?? []
  return malwareOf(row) ? [{ id: 'malware', severity: 'critical' }, ...found.filter(({ id }) => id !== 'malware')] : found
}
// What its Malware finding says, a line each: the advisories of malware
// naming it, and its package taken down by npm, as risk finds it.
export const malwareSaid = row => [...malwareOf(row) ?? [],
  ...row.risk?.findings?.some(({ id, takenDown }) => id === 'malware' && takenDown) ? ['Taken down by npm'] : []]
const severityRank = severity => SEVERITIES.includes(severity) ? SEVERITIES.indexOf(severity) : SEVERITIES.length
const severityLabel = severity => `${severity[0].toUpperCase()}${severity.slice(1)}`

// Which package rows are shown, by the filter's value.
const FILTERS = {
  all: ['All packages', () => true],
  flagged: ['Flagged', row => Boolean(severityOf(row))],
  failed: ['Not assessed: failed', row => Boolean(row.risk?.error)],
  elsewhere: ['Not assessed: not from npm', row => !assessable(row.source)],
}

// How many package rows are drawn at most, the riskiest first.
const MAX_ROWS = 1000
// Lines come faster than a table this long redraws: draw at most this often.
const DRAW_MS = 250

const formatCount = new Intl.NumberFormat()

// Where a package or an advisory is locked: its lockfile, or how many, each
// in the tooltip.
function usedInCell(lockfiles) {
  const used = [...lockfiles]
  return used.length === 1 ? html`<span class="risk-clip" data-tooltip-truncated data-tooltip=${used[0]}>${used[0]}</span>`
    : html`<span class="risk-clip" data-tooltip=${used.join('\n')}>${formatCount.format(used.length)} lockfiles</span>`
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

// A package row's rank: the most severe first, then those still to be told,
// those that couldn't be, those found of nothing, and those not assessed.
function rank(row) {
  if (severityOf(row)) return SEVERITIES.indexOf(severityOf(row))
  if (!assessable(row.source)) return SEVERITIES.length + 3
  if (!row.risk) return SEVERITIES.length
  return row.risk.error ? SEVERITIES.length + 1 : SEVERITIES.length + 2
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
    // By id: { id, fullName, commit, lockfiles, error }; lockfiles by path,
    // each { path, format, packages, error, detail }.
    this._repos = new Map()
    // By packageKey: { name, version, source, from, integrity, usedIn: Set,
    // risk, malware: Set of advisory ids where npm's advisories name it }.
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
    const params = new URLSearchParams(this._scope === 'all' ? {} : { [this._scope]: this._target })
    this._reset()
    this._error = null
    this._state = 'running'
    const scan = new AbortController()
    this._scan = scan
    let done = false
    try {
      await streamRisk(params, scan.signal, line => {
        if (line.type === 'done') done = true
        this._apply(line)
        this._draw()
      })
      if (!done) throw new Error('The scan ended before it finished. Try again.')
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

  _apply(line) {
    if (line.type === 'repos') {
      for (const { id, fullName } of line.repos) this._repos.set(id, { id, fullName, commit: null, lockfiles: null, error: null })
    } else if (line.type === 'repo') {
      const repo = this._repos.get(line.id)
      if (!repo) return
      if (line.error) { repo.error = line.error; return }
      repo.commit = line.commit
      repo.lockfiles = new Map(line.lockfiles.map(lockfile => [lockfile.path, { ...lockfile, packages: null, error: null }]))
    } else if (line.type === 'lockfile') {
      const repo = this._repos.get(line.repo)
      const lockfile = repo?.lockfiles?.get(line.path)
      if (!lockfile) return
      if (line.error) { Object.assign(lockfile, { error: line.error, detail: line.detail ?? null }); return }
      lockfile.packages = line.packages.length
      const usedIn = `${repo.fullName}/${line.path}`
      for (const pkg of line.packages) {
        const key = packageKey(pkg)
        let row = this._packages.get(key)
        if (!row) this._packages.set(key, row = { ...pkg, usedIn: new Set(), risk: null })
        row.usedIn.add(usedIn)
      }
    } else if (line.type === 'risk') {
      const row = this._packages.get(riskKey(line))
      if (row) row.risk = line.error ? { error: line.error, detail: line.detail ?? null } : { severity: line.severity, findings: line.findings, published: line.published }
    } else if (line.type === 'advisories') {
      this._applyAdvisories(line)
    }
  }

  // A lockfile's advisories, each kept once by its id and package: npm
  // answers one a range it covers, here its ranges and versions together,
  // and malware if any says so (npm-insights.ts merges them alike). Malware's
  // marked on the packages of the versions it names.
  _applyAdvisories(line) {
    const repo = this._repos.get(line.repo)
    const lockfile = repo?.lockfiles?.get(line.path)
    if (!lockfile) return
    if (line.error) { lockfile.advisoriesError = line.error; return }
    const usedIn = `${repo.fullName}/${line.path}`
    for (const { range, versions, ...advisory } of line.advisories) {
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
      assessable: assessed.length, told: assessed.filter(row => row.risk).length, flagged: assessed.filter(severityOf).length,
      advisories: this._advisories.size, malware: [...this._advisories.values()].filter(row => row.malware).length,
    }
  }

  _rows() {
    const query = this._query.trim().toLowerCase()
    const [, shown] = FILTERS[this._filter]
    return [...this._packages.values()].filter(row => shown(row) && (!query || row.name.toLowerCase().includes(query)))
      .toSorted((a, b) => rank(a) - rank(b) || findingsOf(b).length - findingsOf(a).length
        || a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? ''))
  }

  // Advisories by their package, malware first, then the most severe.
  _advisoryRows() {
    const query = this._query.trim().toLowerCase()
    return [...this._advisories.values()].filter(row => !query || row.name.toLowerCase().includes(query))
      .toSorted((a, b) => Number(b.malware) - Number(a.malware) || severityRank(a.severity) - severityRank(b.severity)
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
      ${this._repos.size > 0 ? this._lockfiles() : nothing}
      ${this._packages.size === 0 ? nothing : this._tab === 'advisories' ? this._advisoryTable() : this._packageTable()}
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
    const of = (read, total, what) => `${formatCount.format(read)} of ${formatCount.format(total)} ${what}`
    const state = { running: 'Scanning', stopped: 'Stopped', done: 'Done' }[this._state]
    return [state, of(counts.reposRead, counts.repos, 'repositories read'), of(counts.lockfilesRead, counts.lockfiles, 'lockfiles'),
      of(counts.told, counts.assessable, 'packages assessed'), `${formatCount.format(counts.flagged)} flagged`,
      ...counts.advisories > 0 ? [`${formatCount.format(counts.advisories)} advisories${counts.malware > 0 ? `, ${formatCount.format(counts.malware)} of malware` : ''}`] : []].join(' · ')
  }

  _pending(running, otherwise) {
    return html`<span class="risk-pending">${this._state === 'running' ? running : otherwise}</span>`
  }

  // What a repository's row says in place of its lockfiles, where it has none
  // to list; null where it has.
  _repoStatus(repo) {
    if (repo.error) return html`<span class="risk-error">${errorText(repo.error)}</span>`
    if (repo.lockfiles === null) return this._pending('Waiting…', 'Not read')
    return repo.lockfiles.size === 0 ? html`<span class="risk-none">No npm lockfiles</span>` : null
  }

  _lockfileStatus(lockfile) {
    if (lockfile.error) {
      return html`<span class="risk-error risk-wrap">${errorText(lockfile.error)}${lockfile.detail ? `: ${lockfile.detail}` : ''}</span>`
    }
    return lockfile.packages === null ? this._pending('Reading…', 'Not read') : `${formatCount.format(lockfile.packages)} packages`
  }

  _lockfiles() {
    const rows = [...this._repos.values()].flatMap(repo => {
      const status = this._repoStatus(repo)
      return status ? [html`<tr><td>${repo.fullName}</td><td colspan="3">${status}</td></tr>`]
        : [...repo.lockfiles.values()].map(lockfile => html`<tr>
          <td>${repo.fullName}</td><td class="mono">${lockfile.path}</td><td>${lockfile.format}</td><td>${this._lockfileStatus(lockfile)}</td>
        </tr>`)
    })
    return html`<section class="risk-section" aria-label="Lockfiles">
      <h2>Lockfiles</h2>
      <div class="link-table"><table>
        <thead><tr><th>Repository</th><th>Lockfile</th><th>Format</th><th>Packages</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`
  }

  _packageTable() {
    const rows = this._rows()
    return html`<section class="risk-section" aria-label="Packages">
      ${this._tabs()}
      <div class="collection-toolbar">
        <select aria-label="Show packages" .value=${this._filter} @change=${event => { this._filter = event.target.value }}>
          ${Object.entries(FILTERS).map(([value, [label]]) => html`<option value=${value}>${label}</option>`)}
        </select>
        ${this._search(rows.length, this._packages.size, 'packages')}
      </div>
      <div class="link-table"><table>
        <thead><tr><th>Package</th><th>Version</th><th>Risk</th><th>Findings</th><th>Source</th><th>Used in</th></tr></thead>
        <tbody>${rows.slice(0, MAX_ROWS).map(row => this._packageRow(row))}</tbody>
      </table></div>
      ${rows.length > MAX_ROWS ? html`<p class="msg">Showing the first ${formatCount.format(MAX_ROWS)}. Search or filter to see others.</p>` : nothing}
    </section>`
  }

  _packageRow(row) {
    const path = assessable(row.source) ? managedRoutePath({ view: 'npm', packageName: row.name, packageSpec: row.version }) : null
    const findings = findingsOf(row)
    return html`<tr>
      <td>${path ? html`<a href=${path}>${row.name}</a>` : row.name}</td>
      <td class="mono">${row.version ?? '—'}</td>
      <td>${this._risk(row)}</td>
      <td>${findings.length > 0 ? html`<ul class="risk-findings">${findings.map(finding => html`<li class=${`risk-${finding.severity}`}
        data-tooltip=${finding.id === 'malware' ? malwareSaid(row).join('\n') : nothing}>${FINDING_LABELS[finding.id] ?? finding.id}</li>`)}</ul>` : nothing}</td>
      <td><span data-tooltip=${row.from ?? nothing}>${SOURCE_LABELS[row.source] ?? row.source}${row.source === 'mirror' && row.from ? ` (${new URL(row.from).host})` : ''}</span></td>
      <td>${usedInCell(row.usedIn)}</td>
    </tr>`
  }

  _risk(row) {
    if (!assessable(row.source)) return html`<span class="risk-none">Not assessed</span>`
    const malware = malwareOf(row)
    if (!malware && !row.risk) return this._pending('Waiting…', 'Not assessed')
    if (!malware && row.risk.error) return html`<span class="risk-error" data-tooltip=${row.risk.detail ?? nothing}>${errorText(row.risk.error)}</span>`
    const severity = severityOf(row)
    return severity ? html`<span class=${`risk-chip risk-${severity}`}>${severityLabel(severity)}</span>` : html`<span class="risk-none">None found</span>`
  }

  _advisoryTable() {
    const rows = this._advisoryRows()
    const failed = [...this._repos.values()].flatMap(repo => [...repo.lockfiles?.values() ?? []]
      .filter(lockfile => lockfile.advisoriesError).map(lockfile => `${repo.fullName}/${lockfile.path}`))
    return html`<section class="risk-section" aria-label="Advisories">
      ${this._tabs()}
      <div class="collection-toolbar">${this._search(rows.length, this._advisories.size, 'advisories')}</div>
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
      <td><a href=${managedRoutePath({ view: 'npm', packageName: row.name, packageSpec: versions[0] })}>${row.name}</a></td>
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
