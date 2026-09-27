import { html, nothing, unsafeCSS } from 'lit'
import { adminNavigation } from './navigation.js'
import commonStyles from './styles/common.css'
import importStyles from './styles/workspace-import.css'
import { decodeWorkspaceFile, prepareWorkspaceImport, runWorkspaceImport, workspaceImportApi } from '../../client/managed/workspace-import.js'
import { localWorkspaceReader } from '../../client/managed/workspace-import-local.js'

// The already-loaded management entry supplies its base class and request
// transport, preserving its shared caches, session cancellation and preview mode.
export function registerWorkspaceImport(ManagedPage, request) {
  if (customElements.get('managed-admin-import')) return
  class WorkspaceImport extends ManagedPage {
    static styles = [unsafeCSS(commonStyles), unsafeCSS(importStyles)]
    static properties = { localDeps: { attribute: false }, _busy: { state: true }, _error: { state: true }, _message: { state: true },
      _plan: { state: true }, _catalog: { state: true }, _localOpen: { state: true }, _workspaces: { state: true }, _localId: { state: true },
      _triage: { state: true }, _repo: { state: true }, _drag: { state: true } }
    constructor() {
      super()
      this._busy = false; this._error = ''; this._message = ''; this._plan = null
      this._catalog = null; this._workspaces = []; this._localOpen = false; this._localId = ''; this._triage = ''; this._repo = null
      this._files = []; this._drag = false; this._local = false
      this._over = event => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); this._drag = true } }
      this._drop = event => {
        if (!event.dataTransfer?.types?.includes('Files')) return
        event.preventDefault(); event.stopPropagation(); this._drag = false
        if (!this._busy) { this._files.push(...event.dataTransfer.files); void this._nextFile() }
      }
      this._localChanged = () => {
        this._workspaces = []; this._localId = ''
        if (this._local && !this._unlocking) { this._operation?.abort(); this._plan = null; this._message = ''; this._error = 'Local data changed or was locked. Choose the workspace again.' }
      }
      this._blur = () => { if (this._readingLocal) this._localChanged() }
    }
    connectedCallback() {
      super.connectedCallback()
      this.addEventListener('dragover', this._over); this.addEventListener('drop', this._drop)
      globalThis.addEventListener('blur', this._blur)
      globalThis.addEventListener('storage', this._localChanged)
      this._offVault = this.localDeps?.onVaultStateChange(this._localChanged)
      void this._loadCatalog()
    }
    disconnectedCallback() {
      this._operation?.abort(); this._offVault?.()
      this._plan = null; this._files = []
      this.removeEventListener('dragover', this._over); this.removeEventListener('drop', this._drop)
      globalThis.removeEventListener('blur', this._blur); globalThis.removeEventListener('storage', this._localChanged)
      super.disconnectedCallback()
    }
    updated(changed) {
      if (changed.has('session') && (this._role !== 'admin' || changed.get('session')?.id !== this.session?.id)) { this._operation?.abort(); this._plan = null; this._files = [] }
    }
    async _action(work) {
      if (this._busy || this._role !== 'admin') return
      const operation = this._operation = new AbortController()
      const signal = AbortSignal.any([operation.signal, this.appState.sessionController.signal])
      this._busy = true; this._error = ''
      try { await work(signal); signal.throwIfAborted() }
      catch (err) { if (!signal.aborted) this._error = String(err?.message ?? err) }
      finally { if (this._operation === operation) this._busy = false }
    }
    async _loadCatalog() {
      if (this._role !== 'admin') return
      try {
        await this._loadCollection('workspace-import:catalog', 'import options', async signal => {
          const api = workspaceImportApi(request, this.session, signal)
          const [reports, teams, bundles] = await Promise.all([api.send('/api/admin/reports'), api.send('/api/admin/teams'), api.send('/api/admin/bundles')])
          return { repos: reports.repos, teams: teams.teams, bundles: bundles.bundles }
        }, data => { this._catalog = data })
      } catch (err) { this._error = String(err?.message ?? err) }
    }
    _browse() {
      const input = document.createElement('input')
      input.type = 'file'; input.multiple = true; input.accept = '.enc,.gz,.json'
      input.addEventListener('change', () => { this._files.push(...input.files); void this._nextFile() }, { once: true })
      input.click()
    }
    async _prepare(data, signal) {
      if (!data) return
      if (!this._catalog) await this._loadCatalog()
      signal.throwIfAborted()
      if (!this._catalog) throw new Error('Could not load repositories. Try again.')
      const plan = await prepareWorkspaceImport(data, this._catalog.repos)
      signal.throwIfAborted()
      const names = new Set(this._catalog.teams.map(team => team.name))
      const base = plan.name || 'Imported workspace'
      let n = 2
      while (names.has(plan.name)) { const suffix = ` (${n++})`; plan.name = base.slice(0, 100 - suffix.length) + suffix }
      const repos = new Set(plan.reports.map(report => report.repoId).filter(id => id != null))
      this._repo = repos.size === 1 ? [...repos][0] : null
      this._triage = Object.keys(plan.triage).length > 0 ? '' : 'skip'
      this._plan = plan; this._message = ''
    }
    async _nextFile() {
      if (this._files.length === 0 || this._busy) return
      const file = this._files.shift()
      this._local = false; this._plan = null
      await this._action(async signal => {
        const data = await decodeWorkspaceFile(file, this.promptPassword)
        signal.throwIfAborted()
        await this._prepare(data, signal)
      })
    }
    async _unlock(reader, signal) {
      this._unlocking = true
      try { return !reader.locked || await reader.unlock({ signal }) }
      finally { this._unlocking = false }
    }
    async _chooseLocal() {
      this._localOpen = true
      await this._action(async signal => {
        const reader = localWorkspaceReader(this.localDeps)
        if (!(await this._unlock(reader, signal))) return
        signal.throwIfAborted()
        this._workspaces = await reader.list({ signal })
      })
    }
    async _readLocal() {
      if (!this._localId) return
      const id = this._localId
      this._local = true; this._plan = null
      await this._action(async signal => {
        const reader = localWorkspaceReader(this.localDeps)
        if (!(await this._unlock(reader, signal))) return
        this._readingLocal = true
        try { await this._prepare(await reader.read(id, { signal }), signal) }
        finally { this._readingLocal = false }
      })
    }
    async _import() {
      if (!this._plan || !this._triage || !this._csrf) return
      await this._action(async signal => {
        if (this._local && localWorkspaceReader(this.localDeps).locked) throw new Error('Unlock local data and choose the workspace again.')
        const plan = this._plan
        const families = ['teams', 'reports', 'bundles', 'history', 'workspace-import', 'scan-sources', 'repo-impact']
        try {
          const team = await this.appState.mutate(() => runWorkspaceImport(plan, {
            api: workspaceImportApi(request, this.session, signal), session: this.session,
            defaultRepo: this._repo, includeTriage: this._triage === 'include', resolveConflicts: this.resolveConflicts, signal,
            progress: message => { this._message = message },
          }), families)
          this._catalog.teams.push(team)
          this._message = `Imported into ${team.name}.`
          this._plan = null
        } finally {
          // A failed multi-step import can already have created managed records.
          this.appState.invalidate(families)
          if (plan.team) this.dispatchEvent(new CustomEvent('managed-import-complete', { bubbles: true, composed: true }))
        }
      })
      if (!this._plan && !this._error) await this._nextFile()
    }
    render() {
      if (this._role !== 'admin') return nothing
      const plan = this._plan
      const triageCount = plan ? Object.keys(plan.triage).length : 0
      const bundleHashes = new Set([...(plan?.references ?? []), ...(plan?.bundles.map(bundle => bundle.integrity) ?? [])])
      const reusedBundles = (this._catalog?.bundles ?? []).filter(bundle => bundleHashes.has(bundle.integrity))
      const missing = plan?.references.filter(hash => !plan.bundles.some(bundle => bundle.integrity === hash)).length ?? 0
      return html`<div class="wrap" @dragleave=${() => { this._drag = false }}>${adminNavigation('manage-import', this._role, this.allowShare)}
        <h1>Import workspace</h1><p class="intro">Create a new team from a workspace export or a workspace stored in this browser.</p>
        <section class=${`workspace-drop ${this._drag ? 'dragging' : ''}`} aria-label="Workspace files">
          <strong>Drop workspace files here</strong><span>Encrypted exports, JSON, or compressed JSON. Encrypted files prompt for a password.</span>
          <div class="actions"><button type="button" class="btn" ?disabled=${this._busy || !this._catalog} @click=${() => this._browse()}>Choose files</button>
          <button type="button" class="btn" ?disabled=${this._busy} @click=${() => this._chooseLocal()}>Choose local workspace</button></div>
        </section>
        ${this._localOpen ? html`<section class="local-choice"><label for="local-workspace">Local workspace</label>
          <select id="local-workspace" .value=${this._localId} ?disabled=${this._busy} @change=${e => { this._localId = e.target.value }}><option value="">Choose a workspace…</option>${this._workspaces.map(ws => html`<option value=${ws.id}>${ws.name}</option>`)}</select>
          <button type="button" class="btn" ?disabled=${this._busy || !this._localId} @click=${() => this._readLocal()}>Select workspace</button>
          ${!this._busy && this._workspaces.length === 0 ? html`<p>No unlocked local workspaces. Choose local workspace to unlock or refresh.</p>` : nothing}</section>` : nothing}
        ${plan ? html`<section class="import-preview" aria-label="Import options">
          ${plan.team ? html`<p>Team ${plan.team.name} has been created. Retry continues its remaining import steps.</p>` : nothing}
          <label for="import-team">New team name</label><input id="import-team" maxlength="100" .value=${plan.name} ?disabled=${this._busy || !!plan.team} @input=${e => { plan.name = e.target.value; this.requestUpdate() }}>
          <p>${plan.reports.length} reports / links · ${bundleHashes.size} source bundles · ${triageCount} triaged findings</p>
          <label for="import-repo">Repository for files and source bundles without an existing repository</label>
          <select id="import-repo" .value=${String(this._repo ?? '')} ?disabled=${this._busy || !!plan.team} @change=${e => { this._repo = e.target.value ? Number(e.target.value) : null }}><option value="" ?selected=${this._repo == null}>Choose a repository…</option>${(this._catalog?.repos ?? []).map(repo => html`<option value=${String(repo.repoId)} ?selected=${this._repo === repo.repoId}>${repo.fullName}</option>`)}</select>
          <p>Declared report repositories and directories are preserved. The new team receives those repository paths; other published reports in the same paths are also visible to that team.</p>
          <ul>${plan.reports.map(report => html`<li>${report.name}<span>${report.github ?? 'Uses selected repository'}${report.embedded && report.repoId == null ? ' — connect this repository first' : ''}</span></li>`)}</ul>
          ${reusedBundles.length > 0 ? html`<p>Existing source bundles keep their repositories. The new team also receives access to those repositories. Unassigned bundles use the selected repository.</p>
            <ul>${reusedBundles.map(bundle => html`<li>${bundle.filename}<span>${bundle.repoFullName ?? 'Uses selected repository'}</span></li>`)}</ul>` : nothing}
          ${missing ? html`<p>${missing} referenced source bundles have no bytes in this export. Reports can use matching bundles already on the server.</p>` : nothing}
          ${triageCount ? html`<fieldset ?disabled=${this._busy || !!plan.team}><legend>Import triage?</legend>
            <label><input type="radio" name="import-triage" value="include" ?checked=${this._triage === 'include'} @change=${() => { this._triage = 'include' }}> Include triage and comments</label>
            <label><input type="radio" name="import-triage" value="skip" ?checked=${this._triage === 'skip'} @change=${() => { this._triage = 'skip' }}> Skip triage</label>
            <p>Conflicting values prompt for resolution. Triage stays shared by finding ID across teams. Per-report local ignores are not imported.</p></fieldset>` : nothing}
          <button type="button" class="btn primary" ?disabled=${this._busy || !this._triage || !this._csrf} @click=${() => this._import()}>${this._busy ? 'Importing…' : plan.team ? 'Retry remaining import' : 'Import workspace'}</button>
        </section>` : nothing}
        ${this._message ? html`<p role="status">${this._message}</p>` : nothing}
        ${this._error ? html`<p class="error" role="alert">${this._error}${this._catalog ? nothing : html` <button class="btn" @click=${() => this._loadCatalog()}>Retry</button>`}</p>` : nothing}
        ${this._files.length > 0 && !this._busy ? html`<button class="btn" @click=${() => this._nextFile()}>Next workspace file (${this._files.length} waiting)</button>` : nothing}
      </div>`
    }
  }
  customElements.define('managed-admin-import', WorkspaceImport)
}
