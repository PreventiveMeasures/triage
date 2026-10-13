import { html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { summarizeReview } from '../../common/dependency-reviews.js'
import { npmComparisonSource } from './npm-compare-source.js'
import { NEXT_ICON } from './lit-icons.js'
import { compareSourceOptions, renderComparisonHeader, renderComparisonPicker, renderComparisonSummary } from './bundle-compare-picker.js'
import { renderComparisonViewer } from './bundle-compare-view.js'
import { reviewBadge, reviewDate, reviewFileStates, reviewNote, reviewProgress, reviewTitle, sameReviewContext, verdictIcon, verdictLabel, verdictLabels } from './npm-review-presentation.js'

const busy = page => page._blocked || page._loading
const isFrozen = page => page._shownReview?.publishedAt != null
const coverage = summary => summary.coverage === 'full' ? 'Full' : 'Partial'
const errorMessage = page => page._error ? html`<p class="npm-review-error" role="alert">${page._error}</p>` : nothing
const savingMessage = page => page._saveBlocked ? html`<div class="npm-review-saving" role="status">Saving changes…</div>` : nothing
const listedReviews = page => [page._continuation?.review, ...page._reviews].filter(Boolean).toSorted((a, b) =>
  Number(a.publishedAt !== null) - Number(b.publishedAt !== null) || (b.publishedAt ?? b.time) - (a.publishedAt ?? a.time))
const finalizeClass = page => `npm-review-button npm-review-primary npm-review-finalize ${page._allowedVerdicts[0]}`
const verdictChoices = (name, status, change, disabled, allowed = Object.keys(verdictLabels), unchecked = false) => html`<div class="npm-review-verdict-options" role="group" aria-label="Verdict">
  ${Object.entries(unchecked ? { '': 'Not checked', ...verdictLabels } : verdictLabels).map(([value, label]) => html`<label class=${`npm-review-verdict-choice ${value || 'unchecked'}`}>
    <input type="radio" name=${name} aria-label=${label} value=${value} .checked=${live(status === value)} ?disabled=${disabled || value !== '' && !allowed.includes(value)}
      @change=${() => change(value)}>${label}</label>`)}</div>`

function reviewActions(page) {
  const frozen = isFrozen(page), review = page._shownReview, summary = page._summary
  const action = page._canEdit ? { label: 'Finalize review', run: () => page._beginPublish(), disabled: !summary.checkedFiles }
    : !frozen || !page._writable ? null
    : page._activeReview || page._ownPublished.length === 0 ? { label: 'Resume your review', run: () => page._resume() }
    : review.user === page.session?.id ? { label: 'Continue review', run: () => page._change({ action: 'continue', reviewId: review.id, revision: review.revision }) } : null
  return html`<div class="npm-review-summary-actions">${frozen ? reviewBadge(review) : nothing}<div class="npm-review-progress-block"><span>${page._unsaved && (page._saveBlocked || page._error)
    ? html`<button type="button" class="npm-review-button npm-review-text-button" @click=${() => page._openPanel('unsaved')}>Unsaved changes</button>`
    : html`<strong>${summary.checkedFiles} of ${summary.totalFiles}</strong> files checked`}</span>
    ${reviewProgress(summary.checkedFiles, summary.totalFiles)}</div>
    ${action ? html`<button type="button" class=${page._canEdit ? finalizeClass(page) : 'npm-review-button npm-review-primary'}
      ?disabled=${busy(page) || action.disabled} @click=${action.run}>${action.label} ${NEXT_ICON}</button>` : nothing}
  </div>`
}

function reviewHeader(page) {
  const source = page.source ?? npmComparisonSource(page.entry)
  const hasBase = Boolean(page._target && page._target !== '(empty)')
  const choices = compareSourceOptions(source.options, row => `${page.entry.npm.name}@${row.id}`)
  if (hasBase && !choices.some(row => row.id === page._target)) choices.push(...compareSourceOptions([{ id: page._target, name: page._target, format: 'npm' }]))
  const versions = compareSourceOptions(source.choices)
  if (!versions.some(row => row.id === page.entry.npm.version)) versions.push(...compareSourceOptions([{ id: page.entry.npm.version, name: page.entry.npm.version, format: 'npm' }]))
  return renderComparisonHeader(renderComparisonPicker({ source, label: 'Review', disabled: busy(page),
    from: { options: choices, value: hasBase ? page._target : null, label: 'Review base', pick: value => void page._navigate(value) },
    to: { options: versions, value: page.entry.npm.version, label: 'Version to review', pick: value => void page._navigateTo({
      view: 'npm', packageName: page.entry.npm.name, packageSpec: value, bundleTab: 'review', ...page._location(page._target),
    }) },
    clear: hasBase ? { label: 'Clear review base', run: () => void page._navigate('(empty)') } : null,
    openLine: detail => page._openLine(detail),
    comparison: { base: page._base, other: page.details, files: page._diff.files },
  }), renderComparisonSummary(page._diff))
}

function toolbar(page) {
  return html`<div class="npm-review-toolbar"><nav class="npm-review-toolbar-group" aria-label="Review breadcrumbs">
    <button type="button" class="npm-review-button npm-review-text-button" ?disabled=${busy(page)} @click=${() => void page._navigateTo({ view: 'reviews' })}>My reviews</button>
    ${NEXT_ICON}<button type="button" class="npm-review-button npm-review-text-button npm-review-package" aria-haspopup="dialog" ?disabled=${page._blocked}
      @click=${() => page._openPanel('reviews')}><span>${page.entry.npm.name}@${page.entry.npm.version}</span><span class="npm-review-count">${listedReviews(page).length}</span></button>
    </nav>${reviewActions(page)}</div>`
}

export function renderReviewEditor(page, file = page._file, inline = false) {
  const editor = page._editorState(file)
  const saved = page._shownReview?.entries.find(row => row.file === file)
  const nonText = page._nonTextFiles.includes(file)
  const showNotes = nonText || ['accept-with-nits', 'request-changes', 'reject'].includes(editor.status)
  return html`<section class=${`npm-review-decision${inline ? ' npm-review-inline-decision' : ''}`} aria-label="File decision">
    ${page._canEdit ? html`
      ${verdictChoices(`file:${file}`, nonText ? '' : editor.status,
        status => void page._setFileStatus(file, status), busy(page) || nonText, undefined, true)}
      ${nonText ? html`<p class="npm-review-help">Non-text file. Verdicts are not supported yet; this file remains unchecked.</p>` : nothing}
      ${showNotes ? html`<textarea aria-label="File note" rows="2" maxlength="20000" placeholder="Add a note (optional)…"
        .value=${live(editor.comment)} ?disabled=${busy(page)} @input=${event => page._editFile(file, { comment: event.target.value })}
        @blur=${() => void page._saveFile(file)}></textarea>` : nothing}`
      : html`${inline ? nothing : html`<header><strong>File review</strong><span class="npm-review-muted">${isFrozen(page) ? 'Frozen' : 'Read only'}</span></header>`}
        ${saved ? html`${saved.status ? verdictLabel(saved.status) : nothing}${reviewNote(saved.comment)}`
          : html`<p class="npm-review-muted">This file was not reviewed.</p>`}
        ${page._writable ? nothing : html`<p class="npm-review-help">Triage access is required to add a review.</p>`}`}
  </section>`
}

function teamOptions(page, title, teams, selected, change, footer) {
  return html`<fieldset class="npm-review-team-options"><legend>${title}</legend>${teams.map(team => html`<mode-switch label=${team.name}
    .checked=${selected.has(team.id)} .disabled=${busy(page)} @click=${() => {
      if (busy(page)) return
      const next = new Set(selected)
      if (next.has(team.id)) next.delete(team.id); else next.add(team.id)
      change(next)
    }}></mode-switch>`)}${footer}</fieldset>`
}

export function renderReviewConfirmation(page, review) {
  const allowed = page._allowedVerdicts, summary = summarizeReview(review.entries, page._files, page._nonTextFiles)
  return html`<form class="npm-review-publish-form" @submit=${event => { event.preventDefault(); void page._publish() }}>
    <div class="npm-review-dialog-body"><section class="npm-review-coverage"><div><strong>${coverage(summary)} review</strong><span>${summary.checkedFiles} of ${summary.totalFiles} files checked</span></div>
      ${reviewProgress(summary.checkedFiles, summary.totalFiles)}<p>${summary.totalFiles > summary.checkedFiles ? html`${summary.totalFiles - summary.checkedFiles} files not checked.
        <button type="button" class="npm-review-button npm-review-text-button" @click=${() => { page._unchecked = true; page._closePanel() }}>View files</button>` : 'Every file has a verdict.'}</p>
      ${page._needsPackageJson ? html`<p class="npm-review-error">Review ${page._files.includes('package.json')
        ? html`<button type="button" class="npm-review-button npm-review-text-button" @click=${() => { page._closePanel(); page._selectFile('package.json') }}>package.json</button>`
        : 'package.json'} before publishing a partial review.</p>` : nothing}</section>
      <div><strong>Final verdict</strong>${verdictChoices('final-verdict', page._finalStatus, status => { page._finalStatus = status }, busy(page), allowed)}</div>
      ${page._securityLimit === 'reject' ? html`<p class="npm-review-help">Malware detected. Only Reject is available.</p>`
        : page._securityLimit === 'request-changes' ? html`<p class="npm-review-help">Critical vulnerabilities detected.</p>` : nothing}
      <label>Final note <span class="npm-review-muted">· optional</span><textarea aria-label="Final comment" rows="3" maxlength="20000" .value=${live(page._finalComment)}
        placeholder="Summarize your findings or explain what remains…" ?disabled=${busy(page)} @input=${event => { page._finalComment = event.target.value }}></textarea></label>
      ${page._unchangedContinuation ? html`<p class="npm-review-help">Change a verdict or note to publish a new review.</p>` : nothing}
      ${teamOptions(page, 'Publish to teams', page._teams, page._selectedTeams, selected => { page._selectedTeams = selected },
        page._selectedTeams.size > 0 ? nothing : html`<p class="npm-review-error">${page._teams.length === 0 ? 'No teams you belong to have dependency review enabled.'
          : 'Select at least one team to publish.'}</p>`)}
      ${errorMessage(page)}</div>
    <footer class="npm-review-dialog-footer"><p>Publishing freezes your verdicts and notes.<br>You can continue in a new review to make changes.</p>
      <button type="submit" class=${finalizeClass(page)} ?disabled=${busy(page) || !page._canPublish}>Publish to ${page._selectedTeams.size} ${page._selectedTeams.size === 1 ? 'team' : 'teams'} ${NEXT_ICON}</button>
    </footer>
  </form>`
}

export function renderReviewEntry(page, review) {
  const current = review === page._shownReview, published = review.publishedAt !== null
  const summary = published ? review : sameReviewContext(review, page._context) ? summarizeReview(review.entries, page._files, page._nonTextFiles)
    : { checkedFiles: review.entries.filter(entry => entry.status).length, totalFiles: null }
  const hasPrivate = [page._continuation?.review, ...page._reviews].some(row => row?.publishedAt === null && row.user === page.session?.id && sameReviewContext(row, review))
  const own = review.user === page.session?.id, remaining = page._teams.filter(team => !review.teams.some(linked => linked.id === team.id))
  const selected = page._additionalTeams.get(review.id) ?? new Set(remaining.length === 1 ? remaining.map(team => team.id) : [])
  const chosen = remaining.filter(team => selected.has(team.id)).map(team => team.id)
  return html`<section class="npm-review-entry" aria-current=${String(current)}><div class="npm-review-history-heading">
      <strong>${review.userLogin}</strong>${current ? html`<span class="npm-review-current">Current</span>` : nothing}${reviewBadge(review)}</div>
    <p class="npm-review-help">${review.basePackage ? `${review.basePackage === review.package ? review.baseVersion : `${review.basePackage}@${review.baseVersion}`} → ${review.version}` : 'All package files'}</p>
    <div class="npm-review-entry-result">${published ? verdictLabel(review.status) : nothing}<span class="dependency-review-coverage">
      ${published ? html`${summary.coverage === 'full' ? 'Full' : html`<span class="dependency-review-partial">Partial</span>`} · ` : nothing}${summary.checkedFiles}${summary.totalFiles === null ? nothing : `/${summary.totalFiles}`} files checked</span></div>
    <p class="npm-review-help">${review.teams.length > 0 ? `${review.teams.map(team => team.name).join(', ')} · ` : ''}${reviewDate(review.publishedAt ?? review.time)}</p>${reviewNote(review.comment)}
    <div class="npm-review-entry-actions">
      <button type="button" class="npm-review-button" ?disabled=${busy(page)} @click=${() => void page._openReview(review)}>Open ${NEXT_ICON}</button>
      ${published && own && !hasPrivate && page._writable ? html`<button type="button" class="npm-review-button" aria-label="Continue in a new review" ?disabled=${busy(page)}
        @click=${() => void page._openReview(review, true)}>Continue</button>` : nothing}
      ${published && own && page._writable && review.revokedAt === null ? html`<button type="button" class="npm-review-button npm-review-danger" ?disabled=${busy(page)}
        @click=${() => page._change({ action: 'revoke', reviewId: review.id, revision: review.revision })}>Revoke</button>` : nothing}
      <review-audit-copy .review=${review}></review-audit-copy>
    </div>
    ${published && own && page._writable && review.revokedAt === null && remaining.length > 0 ? html`
      <details class="npm-review-share"><summary>Publish to more teams</summary>${teamOptions(page, 'Teams', remaining, selected,
        next => { page._additionalTeams = new Map(page._additionalTeams).set(review.id, next) },
        html`<button type="button" class="npm-review-button" ?disabled=${busy(page) || chosen.length === 0} @click=${() => page._change({ action: 'publish', reviewId: review.id, revision: review.revision, teamIds: chosen })}>Publish to more teams</button>`)}</details>` : nothing}
    ${review.revokedAt === null ? nothing : html`<p class="npm-review-help">Revoked ${reviewDate(review.revokedAt)}. Content and team links remain frozen.</p>`}
  </section>`
}

function panel(page) {
  if (!page._panel) return nothing
  const titles = { publish: 'Publish review', reviews: 'Reviews', unsaved: 'Unsaved changes' }
  return html`<dialog class="npm-review-dialog" aria-label=${titles[page._panel]} @cancel=${event => { event.preventDefault(); page._closePanel() }}>
    <button type="button" class="detail-action npm-review-close" aria-label="Close panel" ?disabled=${page._blocked} @click=${() => page._closePanel()}>×</button>
    <header class="npm-review-dialog-head"><h2>${titles[page._panel]}</h2><p>${page._panel === 'reviews' ? `${page.entry.npm.name}@${page.entry.npm.version}` : reviewTitle(page._context)}</p></header>
    ${page._panel === 'publish' ? renderReviewConfirmation(page, page._activeReview) : html`<div class=${`npm-review-dialog-body${page._panel === 'reviews' ? ' npm-review-entries' : ''}`}>
      ${page._panel === 'unsaved' ? html`${page._dirtyFiles.map(file => html`<button type="button" class="npm-review-button"
          @click=${() => { page._closePanel(); page._selectFile(file) }}>${file} ${NEXT_ICON}</button>`)}`
        : listedReviews(page).map(review => renderReviewEntry(page, review))}
      ${page._panel === 'reviews' && listedReviews(page).length === 0 ? html`<p class="npm-review-muted">No reviews yet.</p>` : nothing}${errorMessage(page)}</div>`}
    ${savingMessage(page)}
  </dialog>`
}

// Review decorates the shared comparison tree and viewer. It never renders a
// second tree or reimplements source/chip wiring.
export function reviewExtensions(page) {
  const entries = page._shownReview?.entries, files = page._files, nonTextFiles = page._nonTextFiles
  if (page._treeProgress?.entries !== entries || page._treeProgress?.files !== files || page._treeProgress?.nonTextFiles !== nonTextFiles) {
    const states = reviewFileStates(entries, nonTextFiles)
    const directories = new Map()
    let checked = 0
    for (const path of page._files) {
      const parts = path.split('/'), reviewed = Number(Boolean(states.get(path)?.status))
      checked += reviewed
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        const counts = directories.get(dir) ?? { total: 0, checked: 0 }
        counts.total++; counts.checked += reviewed
        directories.set(dir, counts)
      }
    }
    page._treeProgress = { entries, files, nonTextFiles, states, directories, checked }
  }
  const { states, directories, checked } = page._treeProgress
  return {
    railLabel: 'Files', treeLabel: 'Review files', collapseLabel: 'Collapse folders',
    searchLabel: 'Find a file', searchPlaceholder: 'Find a file…',
    treePageSize: 300, openAllMax: 0, filterContent: false, fullPaths: true, collapseClearsSearch: true,
    canSelect: () => !page._blocked && !page._panel,
    fileFilter: page._unchecked ? path => !states.get(path)?.status : null,
    fileLabel: path => `${path}, ${verdictLabels[states.get(path)?.status] ?? 'Not reviewed'}`,
    filePrefix: path => verdictIcon(states.get(path)?.status),
    fileSuffix: path => states.get(path)?.notes ? html`<span class="npm-review-note-dot" aria-label="Has notes">•</span>` : nothing,
    directoryLabel: node => { const count = directories.get(node.sourcePath); return `${node.sourcePath}, ${count?.checked ?? 0} of ${count?.total ?? 0} checked` },
    directorySummary: node => { const count = directories.get(node.sourcePath); return `${count?.checked ?? 0}/${count?.total ?? 0}` },
    filters: html`<div class="npm-review-filters" aria-label="Filter review files">
      <button type="button" class="npm-review-button" aria-pressed=${String(!page._unchecked)} @click=${() => { page._unchecked = false }}>All ${page._files.length}</button>
      <button type="button" class="npm-review-button" aria-pressed=${String(!!page._unchecked)} @click=${() => { page._unchecked = true }}>Unchecked ${page._files.length - checked}</button>
    </div>`,
    footer: select => html`<footer class="npm-review-tree-footer"><span>Checked / total</span><button type="button" class="npm-review-button" ?disabled=${page._blocked || page._files.length === checked}
      @click=${() => { const at = page._files.indexOf(page._path);
        const next = page._files.find((path, index) => index > at && !states.get(path)?.status) ?? page._files.find(path => !states.get(path)?.status);
        select(next) }}>Next unchecked ${NEXT_ICON}</button></footer>`,
    fileActions: (path, inline) => renderReviewEditor(page, path, inline),
  }
}

export function renderReview(page) {
  if (!page._base) {return html`<div class="npm-review-empty" role=${page._baseError ? 'alert' : 'status'}>${page._baseError ?? 'Loading comparison…'}
    ${page._baseError ? html`<button type="button" class="npm-review-button" @click=${() => { page._baseKey = null; void page._loadBase(page._target, page.request?.resume) }}>Retry</button>` : nothing}</div>`}
  return html`${reviewHeader(page)}${toolbar(page)}${page._panel ? nothing : errorMessage(page)}
    ${renderComparisonViewer({ base: page._base, other: page.details, diff: page._diff, source: page.source, path: page._path, seek: page._seek,
      baseName: page._base.npm ? `${page._base.npm.name}@${page._base.npm.version}` : 'Empty package', otherName: `${page.entry.npm.name}@${page.entry.npm.version}`,
      select: path => page._selectFile(path), extensions: reviewExtensions(page), mode: page._mode,
    })}
    <span class="npm-review-announcement" role="status">${page._notice ?? ''}</span>${page._panel ? nothing : savingMessage(page)}${panel(page)}`
}
