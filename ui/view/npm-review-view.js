import { html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { summarizeReview } from '../../common/dependency-reviews.js'
import { npmCompareSource } from './npm-package.js'
import { managedHistory } from './managed-history.js'
import { NEXT_ICON } from './lit-icons.js'
import { renderCompareStats } from './bundle-compare-stats.js'
import { comparePickerStyle } from './bundle-compare-picker.js'
import { reviewBadge, reviewDate, reviewNote, reviewProgress, reviewTitle, verdictLabel, verdictLabels } from './npm-review-presentation.js'

const busy = page => page._blocked || page._loading
const isFrozen = page => page._shownReview?.publishedAt != null
const coverage = summary => summary.coverage === 'full' ? 'Full' : 'Partial'
const errorMessage = page => page._error ? html`<p class="npm-review-error" role="alert">${page._error}</p>` : nothing
const savingMessage = page => page._saveBlocked ? html`<div class="npm-review-saving" role="status">Saving changes…</div>` : nothing
const finalizeClass = page => `npm-review-primary npm-review-finalize ${page._allowedVerdicts[0]}`
const verdictChoices = (name, status, change, disabled, allowed = Object.keys(verdictLabels), unchecked = false) => html`<div class="npm-review-verdict-options" role="group" aria-label="Verdict">
  ${Object.entries(unchecked ? { '': 'Not checked', ...verdictLabels } : verdictLabels).map(([value, label]) => html`<label class=${`npm-review-verdict-choice ${value || 'unchecked'}`}>
    <input type="radio" name=${name} aria-label=${label} value=${value} .checked=${live(status === value)} ?disabled=${disabled || value !== '' && !allowed.includes(value)}
      @change=${() => change(value)}><span>${label}</span></label>`)}</div>`

function reviewActions(page) {
  const frozen = isFrozen(page), review = page._shownReview, summary = page._summary
  return html`<div class="npm-review-summary-actions"><div class="npm-review-progress-block"><span>${page._unsaved
    ? html`<button type="button" class="npm-review-text-button" @click=${() => page._openPanel('unsaved')}>Unsaved changes</button>`
    : html`<strong>${summary.checkedFiles} of ${summary.totalFiles}</strong> files checked`}</span>
    ${reviewProgress(summary.checkedFiles, summary.totalFiles)}</div>
    ${page._canEdit ? html`<button type="button" class=${finalizeClass(page)} ?disabled=${page._saving || page._loading || !summary.checkedFiles} @click=${() => void page._beginPublish()}>Finalize review ${NEXT_ICON}</button>`
      : frozen && page._writable && (page._activeReview || page._ownPublished.length === 0) ? html`<button type="button" class="npm-review-primary" ?disabled=${busy(page)} @click=${() => page._resume()}>Resume your review ${NEXT_ICON}</button>`
      : frozen && review.user === page.session?.id && page._writable ? html`<button type="button" class="npm-review-primary" ?disabled=${busy(page)}
        @click=${() => page._change({ action: 'continue', reviewId: review.id, revision: review.revision })}>Continue review ${NEXT_ICON}</button>` : nothing}
  </div>`
}

function reviewHeader(page) {
  const source = page.source ?? npmCompareSource(page.entry)
  const choices = [{ value: '(empty)', label: 'Empty package', displayLabel: 'Empty package' }, ...source.options.map(row => ({
    value: `${page.entry.npm.name}@${row.id}`, label: row.name, displayLabel: row.displayLabel ?? row.id, detail: row.detail,
  }))]
  if (!choices.some(row => row.value === page._target)) choices.push({ value: page._target, label: page._target })
  const versions = source.choices.map(row => ({ value: row.id, label: row.name, displayLabel: row.displayLabel ?? row.id, detail: row.detail }))
  if (!versions.some(row => row.value === page.entry.npm.version)) versions.push({ value: page.entry.npm.version, label: page.entry.npm.version })
  return html`<header class="bundle-compare-head npm-review-head"><div class="bundle-compare-picker is-versions" style=${comparePickerStyle(source)}>
    <div class="bundle-compare-select-wrap"><span class="bundle-compare-select-hint">Review</span>
      <bundle-selector .options=${choices} .value=${page._target} noun="version" versions label="Review base" ?disabled=${busy(page) || page._unsaved}
        @bundle-change=${event => { event.stopPropagation(); if (!busy(page) && !page._unsaved) page._navigate(event.detail.value) }}></bundle-selector></div>
    <span class="bundle-compare-arrow" aria-hidden="true">→</span>
    <div class="bundle-compare-select-wrap"><bundle-selector .options=${versions} .value=${page.entry.npm.version} noun="version" versions
      label="Version to review" ?disabled=${busy(page) || page._unsaved} @bundle-change=${event => { event.stopPropagation(); if (!busy(page) && !page._unsaved) {
        void managedHistory?.navigate({ view: 'npm', packageName: page.entry.npm.name, packageSpec: event.detail.value, bundleTab: 'review', ...page._location(page._target) }) } }}></bundle-selector></div>
    ${source.badges?.(page._base, page.details) ?? nothing}
    </div><div class="bundle-compare-summary">${renderCompareStats(page._diff)}</div></header>`
}

function toolbar(page) {
  const review = page._shownReview
  return html`<div class="npm-review-toolbar"><div class="npm-review-toolbar-group">
    ${isFrozen(page) ? html`${reviewBadge(review)}<button type="button" class="npm-review-text-button" @click=${() => page._openPanel('manage')}>Details</button>` : nothing}
    <button type="button" class="npm-review-text-button" ?disabled=${page._blocked} @click=${() => page._openPanel('notes')}>Review notes</button>
    <button type="button" class="npm-review-text-button" @click=${() => page._openPanel('history')}>History <span class="npm-review-count">${page._reviews.filter(row => row.publishedAt !== null).length}</span></button>
    <button type="button" class="npm-review-text-button" @click=${() => managedHistory?.navigate({ view: 'reviews' })}>My reviews</button>
    </div>${reviewActions(page)}</div>`
}

export function renderReviewEditor(page, file = page._file, inline = false) {
  const editor = page._editorState(file)
  const saved = page._shownReview?.entries.find(row => row.file === file), whole = file === null
  const nonText = page._nonTextFiles.includes(file)
  const showNotes = whole || nonText || ['accept-with-nits', 'request-changes', 'reject'].includes(editor.status)
  if (!page._canEdit) {return html`<section class=${`npm-review-decision${inline ? ' npm-review-inline-decision' : ''}`} aria-label="File review"><div class="npm-review-decision-head">
    <strong>${whole ? 'Review notes' : 'File review'}</strong><span class="npm-review-muted">${isFrozen(page) ? 'Frozen' : 'Read only'}</span></div>
    ${saved ? html`<div class="npm-review-saved-entry">${saved.status ? verdictLabel(saved.status) : nothing}${reviewNote(saved.comment)}</div>`
      : html`<p class="npm-review-muted">${whole ? 'No review notes.' : 'This file was not reviewed.'}</p>`}
    ${page._writable ? nothing : html`<p class="npm-review-help">Triage access is required to add a review.</p>`}</section>`}
  return html`<section class=${`npm-review-decision${inline ? ' npm-review-inline-decision' : ''}`} aria-label=${whole ? 'Review notes editor' : 'File decision'}>
    <div class="npm-review-form">
      ${whole ? nothing : html`<div class="npm-review-verdict-field">${verdictChoices(`file:${file}`, nonText ? '' : editor.status,
        status => void page._setFileStatus(file, status), busy(page) || nonText, undefined, true)}</div>`}
      ${nonText ? html`<p class="npm-review-help">Non-text file. Verdicts are not supported yet; this file remains unchecked.</p>` : nothing}
      ${showNotes ? html`<textarea aria-label=${whole ? 'Review notes' : 'File note'} rows=${whole ? 6 : 2} maxlength="20000" placeholder=${whole ? 'Add context that spans more than one file…' : 'Add a note (optional)…'}
        .value=${live(editor.comment)} ?disabled=${busy(page)} @input=${event => page._editFile(file, { _comment: event.target.value })}
        @blur=${() => void page._saveFile(file)}></textarea>` : nothing}
    </div>
  </section>`
}

export function renderReviewConfirmation(page, review) {
  const allowed = page._allowedVerdicts, summary = summarizeReview(review.entries, page._files, page._nonTextFiles)
  return html`<form class="npm-review-publish-form" @submit=${event => { event.preventDefault(); void page._publish() }}>
    <div class="npm-review-dialog-body"><section class="npm-review-coverage"><div><strong>${coverage(summary)} review</strong><span>${summary.checkedFiles} of ${summary.totalFiles} files checked</span></div>
      ${reviewProgress(summary.checkedFiles, summary.totalFiles)}<p>${summary.totalFiles > summary.checkedFiles ? html`${summary.totalFiles - summary.checkedFiles} files not checked.
        <button type="button" class="npm-review-text-button" @click=${() => { page._unchecked = true; page._closePanel() }}>View files</button>` : 'Every file has a verdict.'}</p>
      ${page._needsPackageJson ? html`<p class="npm-review-error">Review ${page._files.includes('package.json')
        ? html`<button type="button" class="npm-review-text-button" @click=${() => { page._closePanel(); page._selectFile('package.json') }}>package.json</button>`
        : 'package.json'} before publishing a partial review.</p>` : nothing}</section>
      <div><strong>Final verdict</strong>${verdictChoices('final-verdict', page._finalStatus, status => { page._finalStatus = status }, busy(page), allowed)}</div>
      ${page._securityLimit === 'reject' ? html`<p class="npm-review-help">Malware detected. Only Reject is available.</p>`
        : page._securityLimit === 'request-changes' ? html`<p class="npm-review-help">Critical vulnerabilities detected.</p>` : nothing}
      <label>Final note <span class="npm-review-muted">· optional</span><textarea aria-label="Final comment" rows="3" maxlength="20000" .value=${live(page._finalComment)}
        placeholder="Summarize your findings or explain what remains…" ?disabled=${busy(page)} @input=${event => { page._finalComment = event.target.value }}></textarea></label>
      ${page._unchangedContinuation ? html`<p class="npm-review-help">Change a verdict or note to publish a new review.</p>` : nothing}
      <fieldset class="npm-review-team-options"><legend>Publish to teams</legend>${page._teams.map(team => html`<mode-switch label=${team.name}
        .checked=${page._selectedTeams.has(team.id)} .disabled=${busy(page)} @click=${() => { if (busy(page)) return; const selected = new Set(page._selectedTeams);
          if (selected.has(team.id)) selected.delete(team.id); else selected.add(team.id); page._selectedTeams = selected }}></mode-switch>`)}
        ${page._selectedTeams.size > 0 ? nothing : html`<p class="npm-review-error">${page._teams.length === 0 ? 'No teams you belong to have dependency review enabled.'
          : 'Select at least one team to publish.'}</p>`}</fieldset>
      ${errorMessage(page)}</div>
    <footer class="npm-review-dialog-footer"><p>Publishing freezes your verdicts and notes.<br>You can continue in a new review to make changes.</p>
      <button type="submit" class=${finalizeClass(page)} ?disabled=${busy(page) || page._unsaved || !summary.checkedFiles || page._needsPackageJson || page._unchangedContinuation || page._selectedTeams.size === 0 || !allowed.includes(page._finalStatus)}>Publish to ${page._selectedTeams.size} ${page._selectedTeams.size === 1 ? 'team' : 'teams'} ${NEXT_ICON}</button>
    </footer>
  </form>`
}

export function renderReviewPublished(page, review) {
  const own = review.user === page.session?.id, remaining = page._teams.filter(team => !review.teams.some(linked => linked.id === team.id))
  const selected = page._additionalTeams.get(review.id) ?? new Set(remaining.length === 1 ? remaining.map(team => team.id) : [])
  const chosen = remaining.filter(team => selected.has(team.id)).map(team => team.id)
  return html`<section class="npm-review-published"><div class="npm-review-history-heading"><strong>${review.userLogin}</strong>${reviewBadge(review)}</div>
    ${verdictLabel(review.status)}<p class="npm-review-help">${coverage(review)} · ${review.checkedFiles}/${review.totalFiles} files checked<br>
      ${review.teams.map(team => team.name).join(', ')} · ${reviewDate(review.publishedAt)}</p>${reviewNote(review.comment)}
    <review-audit-copy .review=${review}></review-audit-copy>
    ${page._panel === 'history' ? html`<button type="button" @click=${() => page._showPublished(review)}>Open review ${NEXT_ICON}</button>` : nothing}
    ${own && !page._activeReview && page._writable ? html`<button type="button" ?disabled=${busy(page)}
      @click=${() => page._change({ action: 'continue', reviewId: review.id, revision: review.revision })}>Continue in a new review</button>` : nothing}
    ${own && page._writable && review.revokedAt === null && page._panel !== 'history' ? html`
      ${remaining.length > 0 ? html`<fieldset class="npm-review-team-options"><legend>Publish to more teams</legend>
        ${remaining.map(team => html`<mode-switch label=${team.name} .checked=${selected.has(team.id)} .disabled=${busy(page)}
          @click=${() => { if (busy(page)) return; const next = new Set(selected); if (next.has(team.id)) next.delete(team.id); else next.add(team.id);
            page._additionalTeams = new Map(page._additionalTeams).set(review.id, next) }}></mode-switch>`)}
        <button type="button" ?disabled=${busy(page) || chosen.length === 0} @click=${() => page._change({ action: 'publish', reviewId: review.id, revision: review.revision, teamIds: chosen })}>Publish to more teams</button></fieldset>` : nothing}
      <div class="npm-review-revoke"><strong>Revoke review</strong><p class="npm-review-help">Marks this review as revoked. It stays frozen and linked to its teams.</p>
        <button type="button" class="npm-review-danger" ?disabled=${busy(page)} @click=${() => page._change({ action: 'revoke', reviewId: review.id, revision: review.revision })}>Revoke</button></div>` : nothing}
    ${review.revokedAt === null ? nothing : html`<p class="npm-review-help">Revoked ${reviewDate(review.revokedAt)}. Content and team links remain frozen.</p>`}
  </section>`
}

function panel(page) {
  if (!page._panel) return nothing
  const titles = { publish: 'Publish review', history: 'Published reviews', notes: 'Review notes', manage: 'Published review', unsaved: 'Unsaved changes' }
  const drafts = new Map(page._drafts)
  if (page._dirty) drafts.set(page._file, {})
  return html`<dialog class="npm-review-dialog" aria-label=${titles[page._panel]} @cancel=${event => { event.preventDefault(); page._closePanel() }}>
    <header class="npm-review-dialog-head"><div><h2>${titles[page._panel]}</h2><p>${reviewTitle(page._context)}</p></div>
      <button type="button" class="npm-review-icon-button" aria-label="Close panel" ?disabled=${page._blocked} @click=${() => page._closePanel()}>×</button></header>
    ${page._panel === 'publish' ? renderReviewConfirmation(page, page._activeReview) : html`<div class="npm-review-dialog-body">
      ${page._panel === 'notes' ? renderReviewEditor(page) : page._panel === 'manage' ? renderReviewPublished(page, page._shownReview)
        : page._panel === 'unsaved' ? html`${[...drafts.keys()].map(file => html`<button type="button"
          @click=${() => { page._closePanel(); page._open(file) }}>${file ?? 'Whole diff notes'} ${NEXT_ICON}</button>`)}`
        : page._reviews.filter(review => review.publishedAt !== null).toSorted((a, b) => b.publishedAt - a.publishedAt).map(review => renderReviewPublished(page, review))}
      ${page._panel === 'history' ? html`${page._reviews.some(review => review.publishedAt !== null) ? nothing : html`<p class="npm-review-muted">No published reviews yet.</p>`}
        <button type="button" ?disabled=${busy(page) || page._pendingSaves.length > 0} @click=${() => page._refresh()}>Refresh reviews</button>` : nothing}${errorMessage(page)}</div>`}
    ${savingMessage(page)}
  </dialog>`
}

export function renderReview(page) {
  if (!page._base) {return html`<div class="npm-review-empty" role=${page._baseError ? 'alert' : 'status'}>${page._baseError ?? 'Loading comparison…'}
    ${page._baseError ? html`<button type="button" @click=${() => { page._baseKey = null; void page._loadBase(page._target, page.request?.resume) }}>Retry</button>` : nothing}</div>`}
  const states = page._fileStates
  const baseAlerts = page.source?.files?.alerts?.(page._base), otherAlerts = page.source?.files?.alerts?.(page.details)
  return html`${reviewHeader(page)}${toolbar(page)}${page._panel ? nothing : errorMessage(page)}
    <div class="npm-review-workbench bundle-code-view"><npm-review-tree class="bundle-code-rail" .files=${page._treeFiles} .states=${states} .path=${page._path} .unchecked=${page._unchecked}
      @review-file-select=${event => page._selectFile(event.detail.path)} @review-file-filter=${event => { page._unchecked = event.detail.unchecked }}></npm-review-tree>
      <bundle-code-splitter role="separator" tabindex="0" aria-orientation="vertical" aria-label="Resize file tree"
        data-tooltip="Drag to resize · double-click to reset"></bundle-code-splitter>
      <div class="npm-review-content">${page._mode === 'code' ? html`<npm-review-code .base=${page._base} .other=${page.details} .files=${page._diff.files}
        .baseAlerts=${baseAlerts} .otherAlerts=${otherAlerts} .alertTags=${page.source?.files?.alertTags}
        .path=${page._path} .order=${page._files} baseName=${page._base.npm ? `${page._base.npm.name}@${page._base.npm.version}` : 'Empty package'} otherName=${`${page.entry.npm.name}@${page.entry.npm.version}`}
        @compare-code-select=${event => { event.stopPropagation(); page._selectFile(event.detail.path) }}></npm-review-code>
        ${page._path && page._panel !== 'notes' ? renderReviewEditor(page) : nothing}`
        : html`<npm-review-diff .path=${page._path} .base=${page._base} .other=${page.details} .files=${page._diff.files} .reviewAfter=${true}
          .baseAlerts=${baseAlerts} .otherAlerts=${otherAlerts} .alertTags=${page.source?.files?.alertTags}
          baseName=${page._base.npm ? `${page._base.npm.name}@${page._base.npm.version}` : 'Empty package'} otherName=${`${page.entry.npm.name}@${page.entry.npm.version}`}
          .reviewFile=${path => renderReviewEditor(page, path, true)}></npm-review-diff>`}</div>
    </div><span class="npm-review-announcement" role="status">${page._notice ?? ''}</span>${page._panel ? nothing : savingMessage(page)}${panel(page)}`
}
