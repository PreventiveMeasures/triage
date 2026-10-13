// Manage → Repositories → Risk, for admins: every connected repository's npm
// lockfiles, their packages, and what risk tells of each, as the server finds
// them (GET /api/admin/repositories/risk, server-managed/repository-risk.ts).
// Opened by its URL alone, /manage/repositories/risk, until it is linked.
import { html, nothing, unsafeCSS } from 'lit'
import { managedFetch } from '../../client/managed/request.js'
import { managedRoutePath } from '../../common/managed/routes.js'
import { ManagedPage } from './page.js'
import { adminNavigation } from './navigation.js'
import { managedAppState } from './state.js'
import commonStyles from './styles/common.css'
import riskStyles from './styles/repository-risk.css'

const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'notice']
const SEVERITY_LABELS = { critical: 'Critical', high: 'High', moderate: 'Moderate', low: 'Low', notice: 'Notice' }

// What risk finds of a version on its own (risk/npm/held.js, compare.js).
const FINDING_LABELS = {
  deprecated: 'Deprecated',
  'too-new': 'Too new',
  popularity: 'Unpopular',
  'held-install-scripts': 'Install scripts',
  'held-runs-code': 'Runs code',
  'held-exfiltration': 'Exfiltration host',
  'held-obfuscated': 'Obfuscated',
  'non-registry-deps': 'Non-registry dependencies',
  'unused-deps': 'Unused dependencies',
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
  'upstream-unavailable': 'npm unavailable',
  'upstream-too-large': 'npm answered too much',
  'upstream-invalid': 'npm answered unexpectedly',
}
const errorText = code => ERRORS[code] ?? code

const SOURCE_LABELS = { registry: 'npm', mirror: 'Mirror', git: 'Git', tarball: 'Tarball', file: 'File' }
const assessable = source => source === 'registry' || source === 'mirror'

// How many package rows are drawn at most, the riskiest first.
const MAX_ROWS = 1000
// Lines come faster than a table this long redraws: draw at most this often.
const DRAW_MS = 250

const formatCount = new Intl.NumberFormat()

// The scan's lines (repository-risk.ts RepositoryRiskLine), each as it comes.
async function streamRisk(signal, onLine) {
  const response = await managedFetch('/api/admin/repositories/risk', { credentials: 'same-origin', cache: 'no-store', signal })
  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Sign in again to scan repositories.'
      : response.status === 403 ? 'Only admins can scan repositories.' : `The scan couldn't start (${response.status}).`)
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  // The line being read, in the chunks it came in.
  let parts = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    let start = 0
    for (let end = value.indexOf('\n'); end !== -1; start = end + 1, end = value.indexOf('\n', start)) {
      parts.push(value.slice(start, end))
      const line = JSON.parse(parts.join(''))
      parts = []
      onLine(line)
    }
    parts.push(value.slice(start))
  }
}

const packageKey = pkg => assessable(pkg.source) ? `${pkg.name}@${pkg.version}` : `${pkg.source}\0${pkg.name}@${pkg.version ?? ''}\0${pkg.from ?? ''}`

// A package row's rank: the most severe first, then those still to be told,
// those that couldn't be, those found of nothing, and those not assessed.
function rank(row) {
  if (row.risk?.severity) return SEVERITIES.indexOf(row.risk.severity)
  if (!assessable(row.source)) return SEVERITIES.length + 3
  if (!row.risk) return SEVERITIES.length
  return row.risk.error ? SEVERITIES.length + 1 : SEVERITIES.length + 2
}

class ManagedAdminRepositoryRisk extends ManagedPage {
  static properties = { _state: { state: true }, _error: { state: true }, _filter: { state: true }, _query: { state: true } }
  static styles = [unsafeCSS(commonStyles), unsafeCSS(riskStyles)]

  constructor() {
    super()
    // idle, running, stopped or done.
    this._state = 'idle'
    this._error = null
    this._filter = 'all'
    this._query = ''
    this._scan = null
    this._drawTimer = null
    this._reset()
  }

  _reset() {
    // By id: { id, fullName, commit, lockfiles, error }; lockfiles by path,
    // each { path, format, npm, packages, error, detail }.
    this._repos = new Map()
    // By packageKey: { name, version, source, from, usedIn: Set, risk }.
    this._packages = new Map()
  }

  disconnectedCallback() {
    this.stop()
    super.disconnectedCallback()
  }

  // Scans every connected repository anew, its lines drawn as they come.
  async start() {
    if (this._state === 'running') return
    this.stop()
    this._reset()
    this._error = null
    this._state = 'running'
    const scan = new AbortController()
    this._scan = scan
    const signal = AbortSignal.any([scan.signal, managedAppState.sessionController.signal])
    let done = false
    try {
      await streamRisk(signal, line => {
        if (line.type === 'done') done = true
        this._apply(line)
        this._draw()
      })
      if (!done) throw new Error('The scan ended before it finished. Try again.')
      this._state = 'done'
    } catch (err) {
      if (signal.aborted) return
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
      repo.lockfiles = new Map(line.lockfiles.filter(lockfile => lockfile.npm).map(lockfile => [lockfile.path, { ...lockfile, packages: null, error: null }]))
    } else if (line.type === 'lockfile') {
      const repo = this._repos.get(line.repo)
      const lockfile = repo?.lockfiles?.get(line.path)
      if (!lockfile) return
      if (line.error) { Object.assign(lockfile, { error: line.error, detail: line.detail ?? null }); return }
      lockfile.packages = line.packages.length
      for (const pkg of line.packages) {
        const key = packageKey(pkg)
        let row = this._packages.get(key)
        if (!row) this._packages.set(key, row = { ...pkg, usedIn: new Set(), risk: null })
        row.usedIn.add(`${repo.fullName}/${line.path}`)
      }
    } else if (line.type === 'risk') {
      const row = this._packages.get(`${line.name}@${line.version}`)
      if (row) row.risk = line.error ? { error: line.error } : { severity: line.severity, findings: line.findings, published: line.published }
    }
  }

  _counts() {
    const repos = [...this._repos.values()]
    const lockfiles = repos.flatMap(repo => [...repo.lockfiles?.values() ?? []])
    const packages = [...this._packages.values()]
    const assessed = packages.filter(row => assessable(row.source))
    return {
      repos: repos.length, reposRead: repos.filter(repo => repo.lockfiles || repo.error).length,
      lockfiles: lockfiles.length, lockfilesRead: lockfiles.filter(lockfile => lockfile.packages !== null || lockfile.error).length,
      packages: packages.length, assessable: assessed.length, told: assessed.filter(row => row.risk).length,
      flagged: assessed.filter(row => row.risk?.severity).length,
    }
  }

  _rows() {
    const query = this._query.trim().toLowerCase()
    const shown = row => (this._filter === 'all' || (this._filter === 'flagged' ? Boolean(row.risk?.severity)
      : this._filter === 'failed' ? Boolean(row.risk?.error) : !assessable(row.source)))
      && (!query || row.name.toLowerCase().includes(query))
    return [...this._packages.values()].filter(shown)
      .toSorted((a, b) => rank(a) - rank(b) || (b.risk?.findings?.length ?? 0) - (a.risk?.findings?.length ?? 0)
        || a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? ''))
  }

  render() {
    const counts = this._counts()
    const running = this._state === 'running'
    return html`<div class="wrap">${adminNavigation('manage-repos', this._role, this.allowShare)}
      <h1 class="sr-only">Repository risk</h1>
      <div class="page-intro"><p class="intro">Every connected repository’s npm lockfiles at its default branch, and what risk finds in each package they lock.</p>
        ${running ? html`<button type="button" class="btn" @click=${() => this.stop()}>Stop</button>`
          : html`<button type="button" class="btn primary" @click=${() => { void this.start() }}>${this._state === 'idle' ? 'Start scan' : 'Scan again'}</button>`}
      </div>
      <p class="risk-progress" role="status">${this._progress(counts)}</p>
      ${this._error ? html`<p class="msg error" role="alert">${this._error}</p>` : nothing}
      ${this._repos.size > 0 ? this._lockfiles() : nothing}
      ${this._packages.size > 0 ? this._packageTable(counts) : nothing}
    </div>`
  }

  _progress(counts) {
    if (this._state === 'idle') return 'Not scanned yet. A scan reads each repository from GitHub and assesses each npm package it locks, which can take a while.'
    const parts = [
      `${formatCount.format(counts.reposRead)} of ${formatCount.format(counts.repos)} repositories read`,
      `${formatCount.format(counts.lockfilesRead)} of ${formatCount.format(counts.lockfiles)} lockfiles`,
      `${formatCount.format(counts.told)} of ${formatCount.format(counts.assessable)} packages assessed`,
      `${formatCount.format(counts.flagged)} flagged`,
    ]
    const state = { running: 'Scanning', stopped: 'Stopped', done: 'Done' }[this._state]
    return `${state} · ${parts.join(' · ')}`
  }

  _lockfiles() {
    const rows = [...this._repos.values()].flatMap(repo => {
      const status = repo.error ? html`<span class="risk-error">${errorText(repo.error)}</span>`
        : repo.lockfiles === null ? html`<span class="risk-pending">${this._state === 'running' ? 'Waiting…' : 'Not read'}</span>` : null
      if (status || repo.lockfiles.size === 0) {
        return [html`<tr><td>${repo.fullName}</td><td colspan="3">${status ?? html`<span class="risk-none">No npm lockfiles</span>`}</td></tr>`]
      }
      return [...repo.lockfiles.values()].map(lockfile => html`<tr>
        <td>${repo.fullName}</td><td class="mono">${lockfile.path}</td><td>${lockfile.format}</td>
        <td>${lockfile.error ? html`<span class="risk-error" title=${lockfile.detail ?? nothing}>${errorText(lockfile.error)}${lockfile.detail ? html`: ${lockfile.detail}` : nothing}</span>`
          : lockfile.packages === null ? html`<span class="risk-pending">${this._state === 'running' ? 'Reading…' : 'Not read'}</span>`
          : `${formatCount.format(lockfile.packages)} packages`}</td>
      </tr>`)
    })
    return html`<section class="risk-section" aria-label="Lockfiles">
      <h2>Lockfiles</h2>
      <div class="risk-table"><table>
        <thead><tr><th>Repository</th><th>Lockfile</th><th>Format</th><th>Packages</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`
  }

  _packageTable(counts) {
    const rows = this._rows()
    return html`<section class="risk-section" aria-label="Packages">
      <h2>Packages</h2>
      <div class="collection-toolbar">
        <input type="search" aria-label="Search packages" placeholder="Search by package…" .value=${this._query} @input=${event => { this._query = event.target.value }}>
        <select aria-label="Show packages" .value=${this._filter} @change=${event => { this._filter = event.target.value }}>
          <option value="all">All packages</option>
          <option value="flagged">Flagged</option>
          <option value="failed">Not assessed: failed</option>
          <option value="elsewhere">Not assessed: not from npm</option>
        </select>
        <span class="result-count">${rows.length === counts.packages ? '' : `${formatCount.format(rows.length)} of `}${formatCount.format(counts.packages)} packages</span>
      </div>
      <div class="risk-table"><table>
        <thead><tr><th>Package</th><th>Version</th><th>Risk</th><th>Findings</th><th>Source</th><th>Used in</th></tr></thead>
        <tbody>${rows.slice(0, MAX_ROWS).map(row => this._packageRow(row))}</tbody>
      </table></div>
      ${rows.length > MAX_ROWS ? html`<p class="msg">Showing the first ${formatCount.format(MAX_ROWS)}. Search or filter to see others.</p>` : nothing}
    </section>`
  }

  _packageRow(row) {
    const path = assessable(row.source) ? managedRoutePath({ view: 'npm', packageName: row.name, packageSpec: row.version }) : null
    const used = [...row.usedIn]
    return html`<tr>
      <td>${path ? html`<a href=${path}>${row.name}</a>` : row.name}</td>
      <td class="mono">${row.version ?? '—'}</td>
      <td>${this._risk(row)}</td>
      <td>${row.risk?.findings?.length ? html`<ul class="risk-findings">${row.risk.findings.map(finding => html`<li class=${`risk-${finding.severity}`}>${FINDING_LABELS[finding.id] ?? finding.id}</li>`)}</ul>` : nothing}</td>
      <td title=${row.from ?? nothing}>${SOURCE_LABELS[row.source] ?? row.source}${row.source === 'mirror' && row.from ? ` (${new URL(row.from).host})` : ''}</td>
      <td title=${used.join('\n')}>${used.length === 1 ? used[0] : `${formatCount.format(used.length)} lockfiles`}</td>
    </tr>`
  }

  _risk(row) {
    if (!assessable(row.source)) return html`<span class="risk-none">Not assessed</span>`
    if (!row.risk) return html`<span class="risk-pending">${this._state === 'running' ? 'Waiting…' : 'Not assessed'}</span>`
    if (row.risk.error) return html`<span class="risk-error">${errorText(row.risk.error)}</span>`
    if (!row.risk.severity) return html`<span class="risk-none">None found</span>`
    return html`<span class=${`risk-chip risk-${row.risk.severity}`}>${SEVERITY_LABELS[row.risk.severity]}</span>`
  }
}
customElements.define('managed-admin-repo-risk', ManagedAdminRepositoryRisk)
