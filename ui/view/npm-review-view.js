import { html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { allowedReviewVerdicts, summarizeReview } from '../../common/dependency-reviews.js'
import { npmCompareSource } from './npm-package.js'
import { managedHistory } from './managed-history.js'
import { NEXT_ICON } from './lit-icons.js'
import { reviewBadge, reviewDate, reviewNote, reviewProgress, verdictLabel, verdictLabels } from './npm-review-presentation.js'

const busy = page => page._saving || page._loading
const isFrozen = page => page._shownReview?.publishedAt != null
const coverage = summary => summary.coverage === 'full' ? 'Full' : 'Partial'
const errorMessage = page => page._error ? html`<p class="npm-review-error" role="alert">${page._error}</p>` : nothing
const options = (status, allowed = Object.keys(verdictLabels)) => Object.entries(verdictLabels).map(([value, label]) =>
  html`<option value=${value} ?disabled=${!allowed.includes(value)} ?selected=${status === value}>${label}</option>`)

function summaryBar(page) {
  const frozen = isFrozen(page), review = page._shownReview, summary = page._summary
  return html`<header class="npm-review-summary"><div class="npm-review-summary-copy">
    <div class="npm-review-summary-title"><strong>${frozen ? `${coverage(summary)} review` : 'Your review'}</strong>
      ${frozen ? reviewBadge(review) : html`<span class="npm-review-muted">Private to you</span>`}
      ${frozen ? html`<button type="button" class="npm-review-text-button" @click=${() => page._openPanel('manage')}>Details</button>` : nothing}</div>
    <p>${frozen ? html`${verdictLabels[review.status]} · ${review.userLogin} · ${review.teams.map(team => team.name).join(', ')}`
      : page._unsaved ? html`<button type="button" class="npm-review-text-button" @click=${() => page._openPanel('unsaved')}>Unsaved changes — save before publishing</button>`
      : 'Review files, then publish a final verdict.'}</p></div>
    <div class="npm-review-summary-actions"><div class="npm-review-progress-block"><span><strong>${summary.checkedFiles} of ${summary.totalFiles}</strong> files checked</span>
      ${reviewProgress(summary.checkedFiles, summary.totalFiles)}</div>
      ${page._canEdit ? html`<button type="button" class="npm-review-primary" ?disabled=${busy(page) || page._unsaved} @click=${() => page._beginPublish()}>Finalize review ${NEXT_ICON}</button>`
        : frozen && page._writable && (page._activeReview || page._ownPublished.length === 0) ? html`<button type="button" class="npm-review-primary" ?disabled=${busy(page)} @click=${() => page._resume()}>Resume your review ${NEXT_ICON}</button>`
        : frozen && review.user === page.session?.id && page._writable ? html`<button type="button" class="npm-review-primary" ?disabled=${busy(page)}
          @click=${() => page._change({ action: 'continue', reviewId: review.id, revision: review.revision })}>Continue review ${NEXT_ICON}</button>` : nothing}
    </div></header>`
}

function toolbar(page) {
  const source = npmCompareSource(page.entry)
  const choices = [{ value: '(empty)', label: 'Empty package', displayLabel: 'Empty package' }, ...source.options.map(row => ({
    value: `${page.entry.npm.name}@${row.id}`, label: row.name, displayLabel: row.displayLabel ?? row.id, detail: row.detail,
  }))]
  if (!choices.some(row => row.value === page._target)) choices.push({ value: page._target, label: page._target })
  return html`<div class="npm-review-toolbar"><div class="npm-review-toolbar-group"><div class="npm-review-modes" role="group" aria-label="Review view">
    ${[['code', 'Code'], ['diff', 'Whole diff']].map(([mode, label]) => html`<button type="button" aria-pressed=${String(page._mode === mode)}
      @click=${() => page._navigate(page._target, mode)}>${label}</button>`)}</div>
    <div class="npm-review-baseline"><span>Against</span><bundle-selector .options=${choices} .value=${page._target} noun="version" versions
      label="Review base" ?disabled=${busy(page) || page._unsaved} @bundle-change=${event => { event.stopPropagation(); if (!busy(page) && !page._unsaved) page._navigate(event.detail.value) }}></bundle-selector></div></div>
    <div class="npm-review-toolbar-group"><button type="button" class="npm-review-text-button" ?disabled=${page._saving} @click=${() => page._openPanel('notes')}>Review notes</button>
      <button type="button" class="npm-review-text-button" @click=${() => page._openPanel('history')}>History <span class="npm-review-count">${page._reviews.filter(row => row.publishedAt !== null).length}</span></button>
      <button type="button" class="npm-review-text-button" @click=${() => managedHistory?.navigate({ view: 'reviews' })}>My reviews</button></div></div>`
}

export function renderReviewEditor(page) {
  const rows = page._shownReview?.entries.filter(row => row.file === page._file) ?? [], whole = page._file === null
  if (!page._canEdit) {return html`<section class="npm-review-decision" aria-label="File review"><div class="npm-review-decision-head">
    <strong>${whole ? 'Review notes' : 'File review'}</strong><span class="npm-review-muted">${isFrozen(page) ? 'Frozen' : 'Read only'}</span></div>
    ${rows.length > 0 ? rows.map(row => html`<div class="npm-review-saved-entry">${row.status ? verdictLabel(row.status) : nothing}${reviewNote(row.comment)}</div>`)
      : html`<p class="npm-review-muted">${whole ? 'No review notes.' : 'This file was not reviewed.'}</p>`}
    ${page._writable ? nothing : html`<p class="npm-review-help">Triage access is required to add a review.</p>`}</section>`}
  return html`<section class="npm-review-decision" aria-label=${whole ? 'Review notes editor' : 'File decision'}>
    <div class="npm-review-decision-head"><strong>${whole ? 'Review notes' : html`Your verdict for <span class="mono">${page._file}</span>`}</strong>
      <span class="npm-review-muted" role="status">${page._saving ? 'Saving…' : page._dirty ? 'Unsaved changes' : page._edit ? 'Saved privately' : 'Not reviewed'}</span></div>
    <form class="npm-review-form" @submit=${event => { event.preventDefault(); void page._save(!whole) }}>
      ${whole ? nothing : html`<div class="npm-review-verdict-field"><select aria-label="File verdict" .value=${live(page._status)} ?disabled=${busy(page)}
        @change=${event => { page._status = event.target.value }}><option value="">Note only / not checked</option>${options(page._status)}</select>
        ${page._status === 'accept-with-nits' ? html`<span class="npm-review-help">Non-blocking</span>` : nothing}</div>`}
      <textarea aria-label=${whole ? 'Review notes' : 'File note'} rows=${whole ? 6 : 2} maxlength="20000" placeholder=${whole ? 'Add context that spans more than one file…' : 'Add a note (optional)…'}
        .value=${live(page._comment)} ?disabled=${busy(page)} @input=${event => { page._comment = event.target.value }}></textarea>
      <div class="npm-review-editor-footer"><span class="npm-review-help">${whole ? 'Notes do not mark files as checked.' : 'Visible only to you until published.'}</span>
        <div class="npm-review-toolbar-group">${page._dirty ? html`<button type="button" class="npm-review-text-button" ?disabled=${busy(page)}
          @click=${() => { page._drafts.delete(page._file); page._resetEditor(page._file) }}>Discard changes</button>` : nothing}
          <button type="submit" class="npm-review-primary" ?disabled=${busy(page) || (!page._status && !page._comment.trim())}>${whole ? 'Save notes' : 'Save & next'} ${NEXT_ICON}</button></div></div>
    </form>
    ${rows.length > 1 ? html`<details class="npm-review-entry-history"><summary>${rows.length} saved verdicts and notes</summary>
      ${rows.map(row => html`<div>${row.status ? verdictLabel(row.status) : 'Note'}${reviewNote(row.comment)}
        <button type="button" class="npm-review-text-button" ?disabled=${busy(page) || page._dirty} @click=${() => page._open(page._file, row)}>Edit this entry</button></div>`)}</details>` : nothing}
    ${rows.length > 0 ? html`<button type="button" class="npm-review-text-button npm-review-add-note" ?disabled=${busy(page) || page._dirty}
      @click=${() => page._resetEditor(page._file, { id: null, status: null, comment: '' })}>Add another note</button>` : nothing}
  </section>`
}

export function renderReviewConfirmation(page, review) {
  const allowed = allowedReviewVerdicts(review.entries), summary = summarizeReview(review.entries, page._files)
  return html`<form class="npm-review-publish-form" @submit=${event => { event.preventDefault(); void page._publish() }}>
    <div class="npm-review-dialog-body"><section class="npm-review-coverage"><div><strong>${coverage(summary)} review</strong><span>${summary.checkedFiles} of ${summary.totalFiles} files checked</span></div>
      ${reviewProgress(summary.checkedFiles, summary.totalFiles)}<p>${summary.totalFiles > summary.checkedFiles ? html`${summary.totalFiles - summary.checkedFiles} files not checked.
        <button type="button" class="npm-review-text-button" @click=${() => { page._unchecked = true; page._closePanel() }}>View files</button>` : 'Every file has a verdict.'}</p></section>
      <label>Final verdict<select aria-label="Final verdict" .value=${live(page._finalStatus)} ?disabled=${busy(page)}
        @change=${event => { page._finalStatus = event.target.value }}>${options(page._finalStatus, allowed)}</select>
        <span class="npm-review-help">File verdicts limit the final verdict to ${verdictLabels[summary.verdictLimit]} or less favorable.</span></label>
      <label>Final note <span class="npm-review-muted">· optional</span><textarea aria-label="Final comment" rows="3" maxlength="20000" .value=${live(page._finalComment)}
        placeholder="Summarize your findings or explain what remains…" ?disabled=${busy(page)} @input=${event => { page._finalComment = event.target.value }}></textarea></label>
      <fieldset class="npm-review-team-options"><legend>Publish to teams</legend>${page._teams.map(team => html`<label><span>${team.name}</span><input type="checkbox"
        .checked=${page._selectedTeams.has(team.id)} ?disabled=${busy(page)} @change=${event => { const selected = new Set(page._selectedTeams);
          if (event.target.checked) selected.add(team.id); else selected.delete(team.id); page._selectedTeams = selected }}></label>`)}
        <p class=${page._selectedTeams.size > 0 ? 'npm-review-help' : 'npm-review-error'}>${page._teams.length === 0 ? 'No teams you belong to have dependency review enabled.'
          : page._selectedTeams.size > 0 ? 'Only teams with dependency review enabled are listed.' : 'Select at least one team to publish.'}</p></fieldset>
      ${errorMessage(page)}</div>
    <footer class="npm-review-dialog-footer"><p>Publishing freezes your verdicts and notes. You can continue in a new review to make changes.</p>
      <button type="submit" class="npm-review-primary" ?disabled=${busy(page) || page._unsaved || page._selectedTeams.size === 0 || !allowed.includes(page._finalStatus)}>Publish to ${page._selectedTeams.size} ${page._selectedTeams.size === 1 ? 'team' : 'teams'} ${NEXT_ICON}</button>
      <button type="button" class="npm-review-text-button" ?disabled=${page._saving} @click=${() => page._closePanel()}>Back to files</button></footer>
  </form>`
}

export function renderReviewPublished(page, review) {
  const own = review.user === page.session?.id, remaining = page._teams.filter(team => !review.teams.some(linked => linked.id === team.id))
  const selected = page._additionalTeams.get(review.id) ?? new Set(remaining.map(team => team.id))
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
        ${remaining.map(team => html`<label><span>${team.name}</span><input type="checkbox" .checked=${selected.has(team.id)} ?disabled=${busy(page)}
          @change=${event => { const next = new Set(selected); if (event.target.checked) next.add(team.id); else next.delete(team.id); page._additionalTeams = new Map(page._additionalTeams).set(review.id, next) }}></label>`)}
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
    <header class="npm-review-dialog-head"><div><h2>${titles[page._panel]}</h2><p>${page.entry.npm.name} · ${page.entry.npm.version}</p></div>
      <button type="button" class="npm-review-icon-button" aria-label="Close panel" ?disabled=${page._saving} @click=${() => page._closePanel()}>×</button></header>
    ${page._panel === 'publish' ? renderReviewConfirmation(page, page._activeReview) : html`<div class="npm-review-dialog-body">
      ${page._panel === 'notes' ? renderReviewEditor(page) : page._panel === 'manage' ? renderReviewPublished(page, page._shownReview)
        : page._panel === 'unsaved' ? html`<p>Save these changes before publishing.</p>${[...drafts.keys()].map(file => html`<button type="button"
          @click=${() => { page._closePanel(); page._open(file) }}>${file ?? 'Whole diff notes'} ${NEXT_ICON}</button>`)}`
        : page._reviews.filter(review => review.publishedAt !== null).toSorted((a, b) => b.publishedAt - a.publishedAt).map(review => renderReviewPublished(page, review))}
      ${page._panel === 'history' ? html`${page._reviews.some(review => review.publishedAt !== null) ? nothing : html`<p class="npm-review-muted">No published reviews yet.</p>`}
        <button type="button" ?disabled=${busy(page)} @click=${() => page._refresh()}>Refresh reviews</button>` : nothing}${errorMessage(page)}</div>`}
  </dialog>`
}

export function renderReview(page) {
  if (!page._base) {return html`<div class="npm-review-empty" role=${page._baseError ? 'alert' : 'status'}>${page._baseError ?? 'Loading comparison…'}
    ${page._baseError ? html`<button type="button" @click=${() => { page._baseKey = null; void page._loadBase(page._target) }}>Retry</button>` : nothing}</div>`}
  const states = page._fileStates
  return html`${summaryBar(page)}${toolbar(page)}${page._panel ? nothing : errorMessage(page)}
    ${page._loading ? html`<div class="npm-review-loading" role="status">Loading reviews…</div>` : nothing}
    <div class="npm-review-workbench"><npm-review-tree .files=${page._treeFiles} .states=${states} .path=${page._path} .unchecked=${page._unchecked}
      @review-file-select=${event => page._selectFile(event.detail.path)} @review-file-filter=${event => { page._unchecked = event.detail.unchecked }}></npm-review-tree>
      <div class="npm-review-content">${page._mode === 'code' ? html`<npm-review-code .base=${page._base} .other=${page.details} .files=${page._diff.files}
        .path=${page._path} baseName=${page._base.npm ? `${page._base.npm.name}@${page._base.npm.version}` : 'Empty package'} otherName=${`${page.entry.npm.name}@${page.entry.npm.version}`}
        @compare-code-select=${event => { event.stopPropagation(); page._selectFile(event.detail.path) }}></npm-review-code>
        ${page._path && page._panel !== 'notes' ? renderReviewEditor(page) : nothing}`
        : html`<bundle-compare-all .base=${page._base} .other=${page.details} .files=${page._diff.files}
          baseName=${page._base.npm ? `${page._base.npm.name}@${page._base.npm.version}` : 'Empty package'} otherName=${`${page.entry.npm.name}@${page.entry.npm.version}`}
          .reviewFile=${path => html`<div class="npm-review-diff-decision">${verdictLabel(states.get(path)?.status)}<button type="button" @click=${() => page._selectFile(path)}>${isFrozen(page) ? 'View file review' : 'Review this file'}</button></div>`}></bundle-compare-all>`}</div>
    </div><span class="npm-review-announcement" role="status">${page._notice ?? ''}</span>${panel(page)}`
}
