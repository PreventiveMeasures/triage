import { LitElement, nothing } from 'lit'
import { state } from '#client/index.js'
import { dependencyReviews, latestDependencyReview } from './client-managed.js'
import { loadNpmVersion, npmPackageRoute, parseNpmPackageInput } from './npm-package.js'
import { managedHistory } from './managed-history.js'
import { showToast } from './toast.js'
import { allowedReviewVerdicts, isReviewableFile, needsPackageJsonReview, summarizeReview } from '../../common/dependency-reviews.js'
import { bundleCompareFiles } from './bundle-compare-inputs.js'
import { computeBundleDiff } from './bundle-compare-diff.js'
import { compareReviewPaths, reviewViewMode } from './npm-review-files.js'
import { bundleLineCounts } from '../../common/bundle-metadata.js'
import { reviewFileStates, selectReviewOnOpen, takeReviewSelection } from './npm-review-presentation.js'
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
    entry: { attribute: false }, details: { attribute: false }, request: { attribute: false }, session: { attribute: false }, source: { attribute: false },
    _teams: { state: true }, _selectedTeams: { state: true }, _additionalTeams: { state: true },
    _reviews: { state: true }, _loading: { state: true }, _error: { state: true }, _saving: { state: true }, _saveBlocked: { state: true },
    _file: { state: true }, _comment: { state: true }, _status: { state: true }, _edit: { state: true },
    _publishStep: { state: true }, _finalStatus: { state: true }, _finalComment: { state: true },
    _base: { state: true }, _baseError: { state: true }, _panel: { state: true }, _path: { state: true },
    _selectedReview: { state: true }, _unchecked: { state: true }, _notice: { state: true }, _continuation: { state: true },
  }
  createRenderRoot() { return this }
  constructor() {
    super()
    this._teams = []; this._reviews = []; this._files = []; this._treeFiles = []; this._nonTextFiles = []
    this._selectedTeams = new Set(); this._additionalTeams = new Map(); this._drafts = new Map()
    this._file = null; this._path = null; this._comment = ''; this._status = ''; this._edit = null
    this._loading = false; this._saving = false; this._error = null; this._context = null; this._key = null
    this._controller = new AbortController(); this._mode = 'code'; this._publishStep = false
    this._panel = null; this._selectedReview = null; this._unchecked = false
    this._pendingSaves = []; this._saveBlocked = false
  }
  disconnectedCallback() { super.disconnectedCallback(); this._controller.abort(); this._cancelSaves(); this._dismissLoading?.(); this._key = null; this._baseKey = null }
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
  get _activeReview() { return this._reviews.find(review => review.user === this.session?.id && review.publishedAt === null)
    ?? (this._continuation && this._continuation.review.user === this.session?.id ? this._continuation.review : null) }
  get _ownPublished() { return this._reviews.filter(review => review.user === this.session?.id && review.publishedAt !== null).toSorted((a, b) => b.publishedAt - a.publishedAt) }
  get _shownReview() { return this._selectedReview ? this._reviews.find(review => review.id === this._selectedReview) : this._activeReview ?? this._ownPublished[0] ?? null }
  get _canEdit() { return this._writable && !this._selectedReview && (this._activeReview !== null || this._ownPublished.length === 0) }
  get _dirty() { return this._comment !== (this._edit?.comment ?? '') || this._status !== (this._nonTextFiles.includes(this._file) ? '' : this._edit?.status ?? '') }
  get _blocked() { return this._saving || this._saveBlocked }
  get _unsaved() { return this._pendingSaves.length > 0 || this._dirty || [...this._drafts.keys()].some(file => !this._canEdit || file !== this._file) }
  get _fileStates() {
    const entries = this._shownReview?.entries
    if (!this._statesCache || this._statesCache.entries !== entries || this._statesCache.nonTextFiles !== this._nonTextFiles) {
      const states = reviewFileStates(entries)
      for (const file of this._nonTextFiles) if (states.has(file)) states.set(file, { ...states.get(file), status: null })
      this._statesCache = { entries, nonTextFiles: this._nonTextFiles, states }
    }
    return this._statesCache.states
  }
  get _summary() { return summarizeReview(this._shownReview?.entries ?? [], this._files, this._nonTextFiles) }
  get _securityLimit() { return this.source?.reviewVerdictLimit?.(this.entry) ?? 'accept' }
  get _allowedVerdicts() {
    const entries = new Map((this._shownReview?.entries ?? []).map(entry => [entry.file, entry]))
    if (this._canEdit) {
      for (const [file, draft] of this._drafts) entries.set(file, { file, status: draft.status || null })
      if (this._file !== null) entries.set(this._file, { file: this._file, status: this._status || null })
    }
    return allowedReviewVerdicts([...entries.values()].filter(entry => !this._nonTextFiles.includes(entry.file)), this._securityLimit)
  }
  get _needsPackageJson() { return needsPackageJsonReview(this._activeReview?.entries ?? [], this._files, this._nonTextFiles) }
  get _unchangedContinuation() {
    const source = this._continuation?.source
    return Boolean(source && this._finalStatus === source.status && this._finalComment === source.comment)
  }
  _location(target, mode = this._mode) {
    const parsed = target && target !== '(empty)' ? parseNpmPackageInput(target) : null
    return { ...(parsed ? { reviewPackage: parsed.name, reviewSpec: parsed.spec } : {}), ...(mode === 'diff' ? { reviewMode: 'diff' } : {}) }
  }
  _navigate(target, mode) { return this._navigateTo(npmPackageRoute(this.entry, 'review', this._location(target, mode))) }
  async _navigateTo(route) {
    if (this._blocked || this._loading) return
    const key = this._key, navigation = this._navigation = {}
    if (this._unsaved && !await this._saveAll()) return
    if (key === this._key && navigation === this._navigation && !this._unsaved) await managedHistory?.navigate(route)
  }
  async _loadBase(target, resume = false) {
    const key = JSON.stringify([this.entry.integrity, target, this.session?.id, this.session?.role])
    if (this._baseKey === key) return
    this._baseKey = key; this._base = null; this._baseError = null
    this._controller.abort(); this._cancelSaves(); this._key = null
    this._controller = new AbortController()
    try {
      const latest = resume ? await latestDependencyReview(reviewContext(this.entry, null), this._controller.signal) : null
      if (this._baseKey !== key) return
      if (latest) target = latest.basePackage ? dependency(latest.basePackage, latest.baseVersion) : '(empty)'
      const parsed = target === '(empty)' ? null : parseNpmPackageInput(target)
      const base = parsed ? (await loadNpmVersion(parsed.name, parsed.spec ?? 'latest')).details : EMPTY_REVIEW_BASE
      if (this._baseKey !== key) return
      if (resume) {
        if (latest) selectReviewOnOpen(latest)
        this._target = target
        this.request = { bundle: this.entry.integrity, ...this._location(target) }
        this._baseKey = JSON.stringify([this.entry.integrity, target, this.session?.id, this.session?.role])
      }
      this._base = base; this._ensureContext(base)
    } catch (error) { if (this._baseKey === key) this._baseError = error.message }
  }
  _ensureContext(base) {
    const context = reviewContext(this.entry, base), key = JSON.stringify([this.session?.id, this.session?.role, context])
    if (key === this._key) return
    this._controller.abort(); this._cancelSaves(); this._controller = new AbortController(); this._context = context
    this._diff = computeBundleDiff(bundleCompareFiles(base), bundleCompareFiles(this.details), () => '.')
    this._files = [...this._diff.files.onlyBase, ...this._diff.files.onlyOther, ...this._diff.files.changed].map(file => file.path).toSorted(compareReviewPaths)
    const after = bundleCompareFiles(this.details), before = bundleCompareFiles(base)
    const baseLines = bundleLineCounts(base), otherLines = bundleLineCounts(this.details)
    const linesOf = (counts, files) => [...files.keys()].reduce((total, path) => total + (counts.get(path) ?? 0), 0)
    Object.assign(this._diff.totals, { baseLines: linesOf(baseLines, before), otherLines: linesOf(otherLines, after) })
    this._treeFiles = [['onlyBase', 'removed'], ['onlyOther', 'added'], ['changed', 'changed']].flatMap(([group, kind]) =>
      this._diff.files[group].map(file => ({ path: file.path, kind: file.renamedFrom == null ? kind : 'renamed', modified: file.modified,
        before: group === 'onlyOther' ? '' : before.get(file.basePath ?? file.path), after: group === 'onlyBase' ? '' : after.get(file.path) }))).toSorted((a, b) => compareReviewPaths(a.path, b.path))
    this._nonTextFiles = this._treeFiles.filter(file => !isReviewableFile(file.before, file.after)).map(file => file.path)
    this._mode = reviewViewMode(this._treeFiles)
    this._key = key; this._teams = []; this._reviews = []; this._selectedTeams = new Set(); this._additionalTeams = new Map()
    this._selectedReview = null; this._continuation = null; this._drafts.clear(); this._path = this._files[0] ?? null; this._panel = null; this._notice = ''
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
    while (key === this._key && this._pendingSaves.length > 0) {
      if ((await Promise.all(this._pendingSaves.map(save => save.promise))).some(review => !review)) return
    }
    if (key !== this._key) return
    this._dismissLoading?.()
    const dismiss = this._dismissLoading = showToast('Loading reviews…', { duration: 0 })
    this._loading = true; this._error = null
    try {
      const { reviews, teams } = await dependencyReviews(this._context, null, null, this._controller.signal)
      if (key === this._key) {
        const preserve = this._unsaved
        this._reviews = reviews; this._teams = teams
        if (reviews.some(review => review.user === this.session?.id && review.publishedAt === null)) this._continuation = null
        this._rememberBase()
        const selection = takeReviewSelection(this._context)
        if (selection && reviews.some(review => review.id === selection && review.publishedAt !== null)) this._selectedReview = selection
        this._selectedTeams = new Set(teams.filter(team => initializeTeams ? teams.length === 1 : this._selectedTeams.has(team.id)).map(team => team.id))
        if (!preserve) this._resetEditor(this._file)
      }
    } catch (error) { if (key === this._key && error.name !== 'AbortError') this._error = error.message }
    finally { dismiss(); if (key === this._key) this._loading = false }
  }
  _resetEditor(file = null) {
    this._publishStep = false
    const saved = this._canEdit ? this._drafts.get(file) : null
    this._file = file; this._edit = saved?.edit ?? this._shownReview?.entries.find(row => row.file === file) ?? null
    this._editRevision = saved?.revision ?? this._activeReview?.revision ?? null
    this._comment = saved?.comment ?? this._edit?.comment ?? ''; this._status = this._nonTextFiles.includes(file) ? '' : saved?.status ?? this._edit?.status ?? ''
  }
  _editorState(file) {
    if (file === this._file) return { edit: this._edit, status: this._status, comment: this._comment, dirty: this._dirty }
    const buffer = this._canEdit ? this._drafts.get(file) : null
    const edit = buffer?.edit ?? this._shownReview?.entries.find(row => row.file === file) ?? null
    return { edit, status: this._nonTextFiles.includes(file) ? '' : buffer?.status ?? edit?.status ?? '', comment: buffer?.comment ?? edit?.comment ?? '', dirty: !!buffer }
  }
  _editFile(file, values = {}) {
    if (!this._canEdit || this._blocked) return
    if (file !== this._file) { this._rememberEditor(); this._resetEditor(file) }
    Object.assign(this, values)
  }
  _setFileStatus(file, status) { if (this._blocked || this._nonTextFiles.includes(file)) return; this._editFile(file, { _status: status }); return this._saveFile(file) }
  _rememberEditor() {
    if (!this._canEdit) return
    if (this._dirty || this._pendingSaves.some(save => save.change.file === this._file)) this._drafts.set(this._file, { edit: this._edit, revision: this._editRevision, comment: this._comment, status: this._status })
    else this._drafts.delete(this._file)
  }
  _selectFile(path) {
    if (this._blocked || !this._files.includes(path)) return
    this._rememberEditor(); this._path = path; this._resetEditor(path)
  }
  _open(file = null) {
    if (this._blocked) return
    this._rememberEditor(); this._resetEditor(file)
    if (file === null) this._panel = 'notes'
    else { this._path = file; this._panel = null }
  }
  _openPanel(panel) { if (panel === 'notes') this._open(); else this._panel = panel }
  _closePanel() {
    if (this._blocked) return
    if (this._panel === 'notes') { this._rememberEditor(); this._resetEditor(this._path) }
    this.querySelector('dialog')?.close(); this._panel = null; this._publishStep = false
  }
  _showPublished(review) {
    this._rememberEditor(); this._selectedReview = review.id; this._panel = null
    // Private buffers survive, but published snapshots never use them.
    this._file = this._path; this._edit = null; this._comment = ''; this._status = ''
  }
  _resume() { this._selectedReview = null; this._panel = null; this._resetEditor(this._path) }
  _continue(reviewId, revision) {
    const source = this._reviews.find(review => review.id === reviewId && review.revision === revision && review.user === this.session?.id && review.publishedAt !== null)
    if (!source || this._activeReview) return null
    this._continuation = { source, review: { ...source, publishedAt: null, revokedAt: null, status: null, teams: [] } }
    this._selectedTeams = new Set(this._teams.length === 1 ? this._teams.map(team => team.id) : [])
    this._selectedReview = null; this._panel = null; this._drafts.clear(); this._resetEditor(this._path)
    this._notice = 'Continue editing. A new review will be saved when you make a change.'
    return this._activeReview
  }
  async _persistContinuation(save) {
    const continuation = this._continuation, key = this._key
    const { review } = await dependencyReviews(this._context, { action: 'continue', reviewId: continuation.source.id,
      revision: continuation.source.revision }, this.session.csrfToken, this._controller.signal)
    if (key !== this._key || this._continuation !== continuation || save && this._pendingSaves[0] !== save) return null
    this._acceptSave(review, { revision: continuation.source.revision })
    return review
  }
  _cancelSaves() {
    for (const save of this._pendingSaves) { clearTimeout(save.timer); save.resolve(null) }
    this._pendingSaves = []; this._saveBlocked = false
  }
  _queueSave(change) {
    const pending = this._pendingSaves.findLast(save => save.change.file === change.file)
    if (pending && pending.change.comment === change.comment && pending.change.status === change.status) return pending.promise
    const save = { change, slow: false }
    save.promise = new Promise(resolve => { save.resolve = resolve })
    save.timer = setTimeout(() => { save.slow = true; this._saveBlocked = true }, 3000)
    this._pendingSaves.push(save)
    this.requestUpdate()
    if (this._pendingSaves.length === 1) void this._flushSaves()
    return save.promise
  }
  _acceptSave(review, change) {
    this._rememberEditor()
    this._reviews = [...this._reviews.filter(row => row.id !== review.id), review]
    this._continuation = null
    // Rebase only our own edits; a revision changed in another tab still conflicts.
    for (const [file, buffer] of this._drafts) {
      if (buffer.revision !== change.revision) continue
      buffer.revision = review.revision; buffer.edit = review.entries.find(row => row.file === file) ?? null
      if (buffer.comment === (buffer.edit?.comment ?? '') && buffer.status === (buffer.edit?.status ?? '')) this._drafts.delete(file)
    }
    for (const { change: pending } of this._pendingSaves.slice(1)) {
      if (pending.revision !== change.revision) continue
      pending.revision = review.revision; pending.reviewId = review.id
      pending.entryId = review.entries.find(row => row.file === pending.file)?.id ?? null
    }
    if (this._canEdit) this._resetEditor(this._file)
    this._notice = 'Saved privately.'; this._rememberBase()
  }
  async _flushSaves() {
    while (this._pendingSaves.length > 0) {
      const save = this._pendingSaves[0]
      this._error = null
      try {
        if (this._continuation) {
          const continued = await this._persistContinuation(save)
          if (!continued || this._pendingSaves[0] !== save) return
          Object.assign(save.change, { reviewId: continued.id, revision: continued.revision,
            entryId: continued.entries.find(row => row.file === save.change.file)?.id ?? null })
        }
        const { review } = await dependencyReviews(this._context, save.change, this.session.csrfToken, this._controller.signal)
        if (this._pendingSaves[0] !== save) return
        this._acceptSave(review, save.change)
        clearTimeout(save.timer); this._pendingSaves.shift(); save.resolve(review)
        this._saveBlocked = this._pendingSaves.some(pending => pending.slow)
        this.requestUpdate()
      } catch (error) {
        if (this._pendingSaves[0] !== save) return
        this._rememberEditor(); this._cancelSaves()
        if (error.name !== 'AbortError') this._error = error.message
        this.requestUpdate(); return
      }
    }
  }
  async _change(change) {
    if (this._blocked || this._pendingSaves.length > 0 || this._loading || !this._writable) return null
    if (change.action === 'continue') return this._continue(change.reviewId, change.revision)
    const key = this._key
    this._saving = true; this._error = null
    try {
      if (change.action === 'publish' && this._continuation) {
        const continued = await this._persistContinuation()
        if (!continued) return null
        change = { ...change, reviewId: continued.id, revision: continued.revision }
      }
      const { review } = await dependencyReviews(this._context, change, this.session.csrfToken, this._controller.signal)
      if (key !== this._key) return null
      this._reviews = [...this._reviews.filter(row => row.id !== review.id), review]
      if (change.action === 'publish') {
        this._selectedReview = review.id; this._panel = null; this._publishStep = false
        this._comment = ''; this._status = ''; this._edit = null; this._notice = 'Published. Verdicts and notes are now frozen.'
      }
      this._rememberBase()
      return review
    } catch (error) { if (key === this._key && error.name !== 'AbortError') this._error = error.message; return null }
    finally { if (key === this._key) this._saving = false }
  }
  _save() { return this._saveFile(this._file) }
  _saveFile(file) {
    if (!this._canEdit || this._saving || this._loading) return null
    const editor = this._editorState(file), pending = this._pendingSaves.some(save => save.change.file === file), review = this._activeReview
    if (!editor.dirty && !pending) return review
    if (!editor.status && !editor.comment.trim() && !editor.edit?.id && !pending) {
      this._drafts.delete(file)
      if (file === this._file) this._resetEditor(file)
      return review
    }
    const revision = file === this._file ? this._editRevision : this._drafts.get(file)?.revision
    return this._queueSave({ action: 'save', reviewId: review?.id ?? null, revision: revision ?? review?.revision ?? null,
      entryId: editor.edit?.id ?? null, file, comment: editor.comment, status: file === null || this._nonTextFiles.includes(file) ? null : editor.status || null })
  }
  async _saveAll() {
    const key = this._key
    while (key === this._key && this._canEdit) {
      if (this._pendingSaves.length > 0) {
        if ((await Promise.all(this._pendingSaves.map(save => save.promise))).some(review => !review)) return false
        continue
      }
      this._rememberEditor()
      if (this._drafts.size === 0) return true
      if (!await this._saveFile(this._drafts.keys().next().value)) return false
    }
    return false
  }
  async _beginPublish() {
    if (!this._canEdit || this._saving || this._loading || this._finalizing || !this._summary.checkedFiles) return
    const key = this._key
    this._finalizing = true
    try {
      if (this._unsaved && !await this._saveAll()) return
      if (key !== this._key || !this._canEdit || this._unsaved || !this._summary.checkedFiles) return
      const review = this._activeReview
      if (!review) return
      const allowed = this._allowedVerdicts, continued = this._continuation?.source.status
      this._finalStatus = allowed.includes(continued) ? continued : allowed[0]; this._finalComment = review.comment ?? ''
      this._publishRevision = review.revision; this._publishStep = true; this._panel = 'publish'
    } finally { this._finalizing = false }
  }
  _publish() {
    const review = this._activeReview
    if (!review || !this._summary.checkedFiles || this._needsPackageJson || this._unchangedContinuation || !this._publishStep || this._selectedTeams.size === 0 || this._unsaved || !this._allowedVerdicts.includes(this._finalStatus)) return
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
    void this._loadBase(this._target, request.resume)
    return renderReview(this)
  }
}
customElements.define('npm-review', NpmReview)
