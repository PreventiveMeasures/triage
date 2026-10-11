import { LitElement, nothing } from 'lit'
import { state } from '#client/index.js'
import { dependencyReviews } from './client-managed.js'
import { loadNpmVersion, npmPackageRoute, parseNpmPackageInput } from './npm-package.js'
import { managedHistory } from './managed-history.js'
import { allowedReviewVerdicts, summarizeReview } from '../../common/dependency-reviews.js'
import { bundleCompareFiles } from './bundle-compare-inputs.js'
import { computeBundleDiff } from './bundle-compare-diff.js'
import { compareReviewPaths } from './npm-review-files.js'
import { reviewFileStates, takeReviewSelection } from './npm-review-presentation.js'
import { renderReview, renderReviewConfirmation, renderReviewEditor, renderReviewPublished } from './npm-review-view.js'
import './npm-review-code.js'
import './npm-review-tree.js'
import './npm-review-diff.js'
import './bundle-selector.js'
import './mode-switch.js'

export const EMPTY_REVIEW_BASE = { integrity: '(empty)', kind: 'sourcemap', json: { version: 3, sources: [], sourcesContent: [] }, fileSizes: new Map() }
export const reviewContext = (entry, base) => ({ ecosystem: 'npm', package: entry.npm.name, version: entry.npm.version, integrity: entry.integrity,
  basePackage: base?.npm?.name ?? null, baseVersion: base?.npm?.version ?? null, baseIntegrity: base?.npm ? base.integrity : null })
const dependency = (name, spec) => `${name}@${spec ?? 'latest'}`

export class NpmReview extends LitElement {
  static properties = {
    entry: { attribute: false }, details: { attribute: false }, request: { attribute: false }, session: { attribute: false },
    _teams: { state: true }, _selectedTeams: { state: true }, _additionalTeams: { state: true },
    _reviews: { state: true }, _loading: { state: true }, _error: { state: true }, _saving: { state: true },
    _file: { state: true }, _comment: { state: true }, _status: { state: true }, _edit: { state: true },
    _publishStep: { state: true }, _finalStatus: { state: true }, _finalComment: { state: true },
    _base: { state: true }, _baseError: { state: true }, _panel: { state: true }, _path: { state: true },
    _selectedReview: { state: true }, _unchecked: { state: true }, _notice: { state: true },
  }
  createRenderRoot() { return this }
  constructor() {
    super()
    this._teams = []; this._reviews = []; this._files = []; this._treeFiles = []
    this._selectedTeams = new Set(); this._additionalTeams = new Map(); this._drafts = new Map()
    this._file = null; this._path = null; this._comment = ''; this._status = ''; this._edit = null
    this._loading = false; this._saving = false; this._error = null; this._context = null; this._key = null
    this._controller = new AbortController(); this._mode = 'code'; this._publishStep = false
    this._panel = null; this._selectedReview = null; this._unchecked = false
  }
  disconnectedCallback() { super.disconnectedCallback(); this._controller.abort(); this._key = null; this._baseKey = null }
  updated() {
    const dialog = this.querySelector('dialog'); if (dialog && !dialog.open) dialog.showModal()
    this._rememberBase()
  }
  _rememberBase() {
    if (state.bundleDetailsTab !== 'review' || state.selectedBundle !== this.entry?.integrity || !this._context || (!this._activeReview && this._ownPublished.length === 0 && !this._unsaved)) return
    state.npmReview = { bundle: this.entry.integrity,
      ...(this._context.basePackage ? { reviewPackage: this._context.basePackage, reviewSpec: this._context.baseVersion } : {}),
      ...(this._mode === 'diff' ? { reviewMode: 'diff' } : {}), started: true, user: this.session?.id }
  }
  get _writable() { return ['triage', 'manage', 'admin'].includes(this.session?.role) && !this.session?.viewer }
  get _activeReview() { return this._reviews.find(review => review.user === this.session?.id && review.publishedAt === null) ?? null }
  get _ownPublished() { return this._reviews.filter(review => review.user === this.session?.id && review.publishedAt !== null).toSorted((a, b) => b.publishedAt - a.publishedAt) }
  get _shownReview() { return this._selectedReview ? this._reviews.find(review => review.id === this._selectedReview) : this._activeReview ?? this._ownPublished[0] ?? null }
  get _canEdit() { return this._writable && !this._selectedReview && (this._activeReview !== null || this._ownPublished.length === 0) }
  get _dirty() { return this._comment !== (this._edit?.comment ?? '') || this._status !== (this._edit?.status ?? '') }
  get _unsaved() { return this._dirty || [...this._drafts.keys()].some(file => !this._canEdit || file !== this._file) }
  get _fileStates() {
    const entries = this._shownReview?.entries
    if (!this._statesCache || this._statesCache.entries !== entries) this._statesCache = { entries, states: reviewFileStates(entries) }
    return this._statesCache.states
  }
  get _summary() { return summarizeReview(this._shownReview?.entries ?? [], this._files) }
  _location(target, mode = this._mode) {
    const parsed = target && target !== '(empty)' ? parseNpmPackageInput(target) : null
    return { ...(parsed ? { reviewPackage: parsed.name, reviewSpec: parsed.spec } : {}), ...(mode === 'diff' ? { reviewMode: 'diff' } : {}) }
  }
  _navigate(target, mode) { void managedHistory?.navigate(npmPackageRoute(this.entry, 'review', this._location(target, mode))) }
  async _loadBase(target) {
    const key = JSON.stringify([this.entry.integrity, target, this.session?.id, this.session?.role])
    if (this._baseKey === key) return
    this._baseKey = key; this._base = null; this._baseError = null
    this._controller.abort(); this._key = null
    try {
      const parsed = target === '(empty)' ? null : parseNpmPackageInput(target)
      const base = parsed ? (await loadNpmVersion(parsed.name, parsed.spec ?? 'latest')).details : EMPTY_REVIEW_BASE
      if (this._baseKey !== key) return
      this._base = base; this._ensureContext(base)
    } catch (error) { if (this._baseKey === key) this._baseError = error.message }
  }
  _ensureContext(base) {
    const context = reviewContext(this.entry, base), key = JSON.stringify([this.session?.id, this.session?.role, context])
    if (key === this._key) return
    this._controller.abort(); this._controller = new AbortController(); this._context = context
    this._diff = computeBundleDiff(bundleCompareFiles(base), bundleCompareFiles(this.details), () => '.')
    this._files = [...this._diff.files.onlyBase, ...this._diff.files.onlyOther, ...this._diff.files.changed].map(file => file.path).toSorted(compareReviewPaths)
    const after = bundleCompareFiles(this.details), before = bundleCompareFiles(base)
    this._treeFiles = [['onlyBase', 'removed'], ['onlyOther', 'added'], ['changed', 'changed']].flatMap(([group, kind]) =>
      this._diff.files[group].map(file => ({ path: file.path, kind: file.renamedFrom == null ? kind : 'renamed',
        before: group === 'onlyOther' ? '' : before.get(file.basePath ?? file.path), after: group === 'onlyBase' ? '' : after.get(file.path) }))).toSorted((a, b) => compareReviewPaths(a.path, b.path))
    this._key = key; this._teams = []; this._reviews = []; this._selectedTeams = new Set(); this._additionalTeams = new Map()
    this._selectedReview = null; this._drafts.clear(); this._path = this._files[0] ?? null; this._panel = null; this._notice = ''
    this._resetEditor(this._path); this._saving = false
    void this._refresh(true)
    if (state.bundleDetailsTab === 'review' && state.selectedBundle === this.entry.integrity) {
      const location = this._location(base.npm ? dependency(base.npm.name, base.npm.version) : '(empty)')
      state.npmReview = { bundle: this.entry.integrity, ...location }
      // Pin tags to the exact bytes shown without loading the same base again.
      this._baseKey = JSON.stringify([this.entry.integrity, base.npm ? dependency(base.npm.name, base.npm.version) : '(empty)', this.session?.id, this.session?.role])
      managedHistory?.replaceRoute(npmPackageRoute(this.entry, 'review', location))
    }
  }
  async _refresh(initializeTeams = false) {
    const key = this._key
    this._loading = true; this._error = null
    try {
      const { reviews, teams } = await dependencyReviews(this._context, null, null, this._controller.signal)
      if (key === this._key) {
        const preserve = this._unsaved
        this._reviews = reviews; this._teams = teams
        this._rememberBase()
        const selection = takeReviewSelection(this._context)
        if (selection && reviews.some(review => review.id === selection && review.publishedAt !== null)) this._selectedReview = selection
        this._selectedTeams = new Set(teams.filter(team => initializeTeams ? teams.length === 1 : this._selectedTeams.has(team.id)).map(team => team.id))
        if (!preserve) this._resetEditor(this._file)
      }
    } catch (error) { if (key === this._key && error.name !== 'AbortError') this._error = error.message }
    finally { if (key === this._key) this._loading = false }
  }
  _resetEditor(file = null, draft = undefined) {
    this._publishStep = false
    const saved = draft === undefined && this._canEdit ? this._drafts.get(file) : null
    const rows = this._shownReview?.entries.filter(row => row.file === file) ?? []
    this._file = file; this._edit = saved?.edit ?? draft ?? rows.findLast(row => row.status !== null) ?? rows.at(-1) ?? null
    this._editRevision = saved?.revision ?? this._activeReview?.revision ?? null
    this._comment = saved?.comment ?? this._edit?.comment ?? ''; this._status = saved?.status ?? this._edit?.status ?? ''
  }
  _editorState(file) {
    if (file === this._file) return { edit: this._edit, status: this._status, comment: this._comment, dirty: this._dirty }
    const rows = this._shownReview?.entries.filter(row => row.file === file) ?? []
    const buffer = this._canEdit ? this._drafts.get(file) : null
    const edit = buffer?.edit ?? rows.findLast(row => row.status !== null) ?? rows.at(-1) ?? null
    return { edit, status: buffer?.status ?? edit?.status ?? '', comment: buffer?.comment ?? edit?.comment ?? '', dirty: !!buffer }
  }
  _editFile(file, values = {}) {
    if (!this._canEdit || this._saving) return
    if (file !== this._file) { this._rememberEditor(); this._resetEditor(file) }
    Object.assign(this, values)
  }
  _discardFile(file) {
    this._drafts.delete(file)
    if (file === this._file) this._resetEditor(file)
    this.requestUpdate()
  }
  _setFileStatus(file, status) { this._editFile(file, { _status: status }); return this._save(false) }
  _saveFile(file, next = false) { this._editFile(file); return this._save(next) }
  _rememberEditor() {
    if (!this._canEdit) return
    if (this._dirty) this._drafts.set(this._file, { edit: this._edit, revision: this._editRevision, comment: this._comment, status: this._status })
    else this._drafts.delete(this._file)
  }
  _selectFile(path) {
    if (this._saving || !this._files.includes(path)) return
    this._rememberEditor(); this._path = path; this._resetEditor(path)
  }
  _open(file = null, draft = undefined) {
    if (this._saving) return
    if (draft && this._dirty && file === this._file) { this._error = 'Save or discard your changes before editing another note.'; return }
    this._rememberEditor(); this._resetEditor(file, draft)
    if (file === null) this._panel = 'notes'
    else { this._path = file; this._panel = null }
  }
  _openPanel(panel) { if (panel === 'notes') this._open(); else this._panel = panel }
  _closePanel() {
    if (this._saving) return
    if (this._panel === 'notes') { this._rememberEditor(); this._resetEditor(this._path) }
    this.querySelector('dialog')?.close(); this._panel = null; this._publishStep = false
  }
  _showPublished(review) {
    this._rememberEditor(); this._selectedReview = review.id; this._panel = null
    // Private buffers survive, but published snapshots never use them.
    this._file = this._path; this._edit = null; this._comment = ''; this._status = ''
  }
  _resume() { this._selectedReview = null; this._panel = null; this._resetEditor(this._path) }
  async _change(change) {
    if (this._saving || this._loading || !this._writable) return null
    const key = this._key, previous = this._activeReview
    this._saving = true; this._error = null
    try {
      const { review } = await dependencyReviews(this._context, change, this.session.csrfToken, this._controller.signal)
      if (key !== this._key) return null
      this._reviews = [...this._reviews.filter(row => row.id !== review.id), review]
      if (change.action === 'save') {
        this._drafts.delete(change.file)
        for (const buffer of this._drafts.values()) if (buffer.revision === previous?.revision) buffer.revision = review.revision
        this._resetEditor(this._file); this._notice = 'Saved privately.'
      }
      if (change.action === 'continue') {
        this._selectedTeams = new Set(this._teams.length === 1 ? this._teams.map(team => team.id) : []); this._selectedReview = null; this._panel = null
        this._drafts.clear(); this._resetEditor(this._path); this._notice = 'New private review created. The published review is unchanged.'
      }
      if (change.action === 'publish') {
        this._selectedReview = review.id; this._panel = null; this._publishStep = false
        this._comment = ''; this._status = ''; this._edit = null; this._notice = 'Published. Verdicts and notes are now frozen.'
      }
      this._rememberBase()
      return review
    } catch (error) { if (key === this._key && error.name !== 'AbortError') this._error = error.message; return null }
    finally { if (key === this._key) this._saving = false }
  }
  async _save(next = false) {
    if (!this._canEdit || !this._status && !this._comment.trim() && !this._edit?.id) return null
    const file = this._file, review = this._activeReview
    const saved = await this._change({ action: 'save', reviewId: review?.id ?? null, revision: this._editRevision ?? review?.revision ?? null,
      entryId: this._edit?.id ?? null, file, comment: this._comment, status: file === null ? null : this._status || null })
    if (saved && next && file !== null) {
      const states = reviewFileStates(saved.entries)
      const at = this._files.indexOf(file)
      const nextPath = this._files.find((path, index) => index > at && !states.get(path)?.status)
        ?? this._files.find(path => path !== file && !states.get(path)?.status)
      if (nextPath) this._selectFile(nextPath)
    }
    return saved
  }
  _beginPublish() {
    if (!this._canEdit || this._unsaved || !this._summary.checkedFiles) return
    const review = this._activeReview
    if (!review) return
    this._finalStatus = summarizeReview(review.entries, this._files).verdictLimit; this._finalComment = review.comment ?? ''
    this._publishRevision = review.revision; this._publishStep = true; this._panel = 'publish'
  }
  _publish() {
    const review = this._activeReview
    if (!review || !this._summary.checkedFiles || !this._publishStep || this._selectedTeams.size === 0 || this._unsaved || !allowedReviewVerdicts(review.entries).includes(this._finalStatus)) return
    return this._change({ action: 'publish', reviewId: review.id, revision: this._publishRevision, teamIds: [...this._selectedTeams],
      finalStatus: this._finalStatus, finalComment: this._finalComment })
  }
  _editor() { return renderReviewEditor(this) }
  _confirmation(review) { return renderReviewConfirmation(this, review) }
  _published(review) { return renderReviewPublished(this, review) }
  render() {
    if (!this.entry?.npm || !this.details) return nothing
    const request = this.request?.bundle === this.entry.integrity ? this.request : {}
    this._target = request.reviewPackage ? dependency(request.reviewPackage, request.reviewSpec) : '(empty)'
    this._mode = request.reviewMode === 'diff' ? 'diff' : 'code'
    void this._loadBase(this._target)
    return renderReview(this)
  }
}
customElements.define('npm-review', NpmReview)
