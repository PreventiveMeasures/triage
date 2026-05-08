import { html, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { state } from '../../client/state.js'
import { prettyModel, stripExportMarker, fileUrl, commitUrl } from './format.js'
import { tabKey, groupKey, sortTabs, activeTabFor, groupState } from './group.js'
import { FILE_ICONS, displayName, groupOf } from './file-display.js'

// All `<finding-row>` / `<finding-card>` shadow-DOM markup is built
// here as Lit `html` template results so the components can render
// directly without `unsafeHTML`. Lit auto-escapes interpolated text
// and attribute values, so the previous string builders' manual
// `esc()` calls are gone — only structural HTML lives in the
// templates. Light-DOM-targeting helpers in render.js (e.g. flat
// list location headers) keep using the string-returning siblings
// in format.js.

// Display label for the .badge tier text. The class still gets the
// canonical severity string ('informational' / 'high_bug') so CSS
// color rules match; only the visible word is adjusted:
//   informational → info (shortened so it fits the shared badge slot)
//   high_bug      → "high bug" (underscore → space, reads naturally
//                   under the shared text-transform: uppercase)
function badgeLabel(severity) {
  if (severity === 'informational') return 'info'
  return severity.replace(/_/gu, ' ')
}

// First non-empty line of a description, for the table-view title.
// Markdown findings begin with a literal title line; JSON findings
// usually have a one-paragraph description and the whole thing
// becomes the title. CSS handles the visual ellipsis if it overflows.
function firstLine(text) {
  if (!text) return ''
  for (const line of text.split('\n')) {
    if (line.trim()) return line.trim()
  }
  return ''
}

// Combined `file:line` link for the table-view row's location cell —
// the row has no file header above it (unlike the list / grouped
// views) so file + line live together in one slot. Returns a
// TemplateResult when we have a source URL, plain text otherwise.
function rowLocationTemplate(f) {
  const url = fileUrl(f.file, f.repo?.github, f._repoFallback)
  const lineNum = parseInt(f.line, 10)
  const text = Number.isFinite(lineNum) ? `${f.file}:${f.line}` : f.file
  if (!url) return text
  const target = Number.isFinite(lineNum) ? `${url}#L${lineNum}` : url
  return html`<a href=${target} target="_blank" rel="noopener">${text}</a>`
}

// Commit-hash link for the codex `commit_hash` reference. Short SHA
// (first 7 chars) on display, full hash in the title. Falls back to a
// `<span>` (no link) when we don't have a repo to link against.
function commitLinkTemplate(githubRepo, hash) {
  if (!hash) return nothing
  const short = hash.slice(0, 7)
  const url = commitUrl(githubRepo, hash)
  if (!url) return html`<span title=${hash}>${short}</span>`
  return html`<a href=${url} target="_blank" rel="noopener" title=${hash}>${short}</a>`
}

// Speech-bubble glyph for the per-finding comment button. Outline
// when there's no comment, filled when a comment exists — the
// has-comment class flips `fill` via finding-card.css /
// finding-row.css.
const COMMENT_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <path class="bubble" d="M2.5 3h11a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-.5.5H8.4l-3 2.6V10.5H2.5a.5.5 0 0 1-.5-.5V3.5a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

// Wrench glyph for the per-finding fix-link button. Same has-x /
// outline-vs-fill pattern as the comment icon: empty button = no
// fix recorded; filled accent = a URL is set.
const FIX_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <path class="wrench" d="M10.4 2.6a3 3 0 0 0-3.6 4.5L2 12l2 2 4.9-4.8a3 3 0 0 0 4.5-3.6l-1.8 1.8-1.5-.4-.4-1.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

// Workspace-merged views show which report a finding came from.
// The chip mirrors the sidebar's file row (brand sticker + display
// name) and lives at the start of the action row. Single-file
// loads omit it (the title bar already shows the filename).
function reportChipTemplate(group) {
  if (!state.currentWorkspace) return nothing
  const reportName = group[0]?._reportName
  if (!reportName) return nothing
  const iconHtml = FILE_ICONS[groupOf(reportName)] ?? FILE_ICONS.default
  return html`<span class="report-chip" title=${reportName}>${unsafeHTML(iconHtml)}<span class="report-chip-label">${displayName(reportName)}</span></span>`
}

// Action buttons — workspace-only report chip + comment button +
// `<color-marker>` (the 4-dot color picker) plus either the delete
// `×` or the trash-mode `restore` button. The dots themselves live
// in their own component (see view/color-marker.js) so finding-row /
// finding-card don't carry duplicate `.mark-dot` styling. Click on
// a dot bubbles up as a composed `mark-color` event with
// `{ detail: { color } }` — events.js's delegate on `report`
// resolves the gid via the same `[data-gid]` walk used for the
// other buttons.
function actionButtonsTemplate(group, sortedTabs, groupSt, activeKey) {
  const reportChip = reportChipTemplate(group)
  const activeColor = state.markers.get(activeKey) ?? null
  const activeComment = state.comments.get(activeKey) ?? ''
  const activeFix = state.fixes.get(activeKey) ?? ''
  const commentTitle = activeComment ? `Edit comment: ${activeComment}` : 'Add comment'
  const fixTitle = activeFix ? `Edit fix link: ${activeFix}` : 'Add fix link (PR URL, etc.)'
  const commentBtn = html`<button type="button" class=${`mark-comment${activeComment ? ' has-comment' : ''}`} title=${commentTitle} aria-label=${commentTitle}>${COMMENT_ICON}</button>`
  const fixBtn = html`<button type="button" class=${`mark-fix${activeFix ? ' has-fix' : ''}`} title=${fixTitle} aria-label=${fixTitle}>${FIX_ICON}</button>`
  const picker = html`<color-marker .selected=${activeColor}></color-marker>`
  if (state.showDeleted) {
    return html`${reportChip}${commentBtn}${fixBtn}${picker}<button class="mark-restore" title="restore whole group">restore</button>`
  }
  const xTitle = groupSt.hasConflict
    ? 'delete active tab (colors mismatch — acts per-tab)'
    : (sortedTabs.length > 1 ? 'delete whole group' : 'delete')
  return html`${reportChip}${commentBtn}${fixBtn}${picker}<button class="mark-x" title=${xTitle}>×</button>`
}

// One tab button. Carries severity badge + (optional) confidence,
// plus per-tab color/deleted classes so multi-tab triage state is
// visible from the group header.
function tabTemplate(f, isActive) {
  const key = tabKey(f)
  const color = state.markers.get(key)
  const deleted = state.deletedIds.has(key)
  const classes = ['tab']
  if (isActive) classes.push('active')
  if (color) classes.push(`tab-mark-${color}`)
  if (deleted) classes.push('tab-deleted')
  return html`<button type="button" class=${classes.join(' ')} data-tid=${key}><span class="tab-label"><span class=${`badge ${f.severity}`}>${badgeLabel(f.severity)}</span> ${f.confidence !== undefined ? html`<span class="tab-conf">${f.confidence}/10</span>` : nothing}</span></button>`
}

// One tab body — finding-left (badge column) + the right-side stack
// (line row, description, recommendation, conf reason). Only the
// active body is `display: grid` on screen; print mode shows them
// all stacked. `idx` / `total` feed the print-only "N of M" subhead;
// suppressed for single-tab groups via the default args.
function tabBodyTemplate(f, isActive, idx = 0, total = 1) {
  const key = tabKey(f)
  const comment = state.comments.get(key) ?? ''
  const fix = state.fixes.get(key) ?? ''
  // Location is rendered as `file:line` (linkified when we have a
  // repo URL). Standalone cards (the table view's detail panel) need
  // the file here because there's no surrounding header above; list /
  // grouped modes hide the `.line-row` via `:host([in-group])` since
  // `.flat-group-loc` / `.file-header` already paint the same info
  // above the card. exportName joins with a comma when present.
  const url = fileUrl(f.file, f.repo?.github, f._repoFallback)
  const lineNum = parseInt(f.line, 10)
  const hasLine = Number.isFinite(lineNum)
  const locText = hasLine ? `${f.file}:${f.line}` : f.file
  const locLink = url
    ? html`<a href=${hasLine ? `${url}#L${lineNum}` : url} target="_blank" rel="noopener">${locText}</a>`
    : locText
  const exportName = f.exportName ?? ''
  const lineRowMain = exportName
    ? html`<span class="line-num">${locLink}, ${exportName}</span>`
    : html`<span class="line-num">${locLink}</span>`
  const meta = [f.type, prettyModel(f.model), f.effort, f.exportsMode].filter(Boolean).join(' · ')
  return html`<div class=${`tab-body${isActive ? ' active' : ''}`} data-tid=${key}>
    ${total > 1 ? html`<div class="print-case-label">${idx + 1} of ${total}</div>` : nothing}
    <div class="finding-left">
      <span class=${`badge ${f.severity}`}>${badgeLabel(f.severity)}</span>
      <div class="value-label">Severity</div>
      ${f.confidence !== undefined ? html`<div class="conf-score"><strong>${f.confidence}</strong>/10</div><div class="value-label">Confidence</div>` : nothing}
    </div>
    <div>
      <div class="line-row">
        ${lineRowMain}
        ${f.discoveredIn ? html`<span class="line-num">(found analyzing ${f.discoveredIn})</span>` : nothing}
        ${meta ? html`<span class="run-meta">${meta}</span>` : nothing}
      </div>
      <div class="desc">${stripExportMarker(f.description, f.exportName)}</div>
      ${f.recommendation ? html`<div class="recommendation">Recommendation: ${stripExportMarker(f.recommendation, f.exportName)}</div>` : nothing}
      ${f.confidenceReason ? html`<div class="conf-reason">${stripExportMarker(f.confidenceReason, f.exportName)}</div>` : nothing}
      ${comment ? html`<div class="comment-block"><span class="comment-label">Comment:</span> ${comment}</div>` : nothing}
      ${fix ? html`<div class="fix-block"><span class="fix-label">Fix:</span> <a href=${fix} target="_blank" rel="noopener">${fix}</a></div>` : nothing}
    </div>
  </div>`
}

// Group identifier — exposed so the <finding-card> / <finding-row>
// components can stamp it onto their host as `data-gid` (events.js's
// pathClosest('[data-gid]') resolves a row from action-button clicks).
export function findingCardGid(g) {
  return groupKey(g)
}

// State-derived host classes for a `<finding-card>`. The literal
// `finding` class is included so external selectors like
// `.flat-group .finding` still match the host element. `multi-case`
// is a print-only hook (drives the `Multiple reports of one finding`
// banner via :host(.multi-case) .card::before in finding-card.css).
export function findingCardClasses(g) {
  const groupSt = groupState(g)
  const sortedTabs = sortTabs(g)
  const isCritical = g.some((f) => f.critical || f.severity === 'critical')
  const classes = ['finding']
  if (isCritical) classes.push('is-critical')
  if (groupSt.hasConflict) classes.push('has-conflict')
  else if (groupSt.commonColor) classes.push(`mark-${groupSt.commonColor}`)
  if (state.showDeleted) classes.push('deleted')
  if (sortedTabs.length > 1) classes.push('multi-case')
  return classes
}

// Inner template for a `.finding` card — every tab body (only active
// is shown on screen; print stacks them) plus the bottom marks row
// (commit ref, multi-tab strip, action buttons). The wrapping
// `.finding` div is gone — the host element IS the card.
//
// Workspace mode lifts the "introduced in" line above the marks row.
// The action row in workspace mode carries a wide report-name chip
// at its left, which would otherwise squeeze the commit-ref span on
// the same row and force the hash to wrap mid-line.
export function findingCardInnerTemplate(g) {
  const groupSt = groupState(g)
  const sortedTabs = sortTabs(g)
  const active = activeTabFor(g)
  const activeKey = tabKey(active)
  const commitRef = active.commitHash
    ? html`<div class="commit-ref">introduced in ${commitLinkTemplate(active.repo?.github, active.commitHash)}</div>`
    : nothing
  const liftCommit = state.currentWorkspace && commitRef !== nothing
  return html`
    ${sortedTabs.map((f, i) => tabBodyTemplate(f, tabKey(f) === activeKey, i, sortedTabs.length))}
    ${liftCommit ? html`<div class="marks-commit-row">${commitRef}</div>` : nothing}
    <div class="marks">
      <div class="marks-left">
        ${liftCommit ? nothing : commitRef}
        ${sortedTabs.length > 1 ? html`<div class="tabs">${sortedTabs.map((f) => tabTemplate(f, tabKey(f) === activeKey))}</div>` : nothing}
      </div>
      ${actionButtonsTemplate(g, sortedTabs, groupSt, activeKey)}
    </div>
  `
}

// Compact block per finding for the table view. Layout:
//   ┌──────────┬──────────────────────────────────────┐
//   │  badge   │  title (first line, ellipsis)  type  │
//   │  conf?   │  file:line               actions     │
//   │          │  tab strip (multi-tab only)          │
//   └──────────┴──────────────────────────────────────┘
// The left column is fixed-width so badges line up across rows; the
// badge centers vertically against the title + meta rows (not the
// optional tab strip below) — see finding-row.css.
export function tableRowGid(g) {
  return groupKey(g)
}

// State-derived class list for a row's host element. Mirrors what the
// old renderTableRow baked into the wrapper, minus the `selected`
// class — that's owned by the host's `selected` property since the
// parent <finding-table> tracks selection there.
export function tableRowClasses(g) {
  const groupSt = groupState(g)
  const isCritical = g.some((f) => f.critical || f.severity === 'critical')
  const classes = []
  if (isCritical) classes.push('is-critical')
  if (groupSt.hasConflict) classes.push('has-conflict')
  else if (groupSt.commonColor) classes.push(`mark-${groupSt.commonColor}`)
  if (state.showDeleted) classes.push('deleted')
  return classes
}

// Inner template for a row — score column on the left, body column
// (title / meta / optional tab strip) on the right. The wrapping
// `.finding-row` div is no longer here: it's the <finding-row> host
// element. Layout/grid placement is handled by finding-row.css.
export function tableRowInnerTemplate(g) {
  const groupSt = groupState(g)
  const sortedTabs = sortTabs(g)
  const active = activeTabFor(g)
  const activeKey = tabKey(active)
  const f = active

  const title = firstLine(stripExportMarker(f.description, f.exportName))
  const typeLabel = [f.type, prettyModel(f.model), f.effort, f.exportsMode].filter(Boolean).join(' · ')
  const exportPart = f.exportName ? `, ${f.exportName}` : ''

  return html`
    <div class="row-score">
      <span class=${`badge ${f.severity}`}>${badgeLabel(f.severity)}</span>
      ${f.confidence !== undefined ? html`<span class="row-conf"><strong>${f.confidence}</strong>/10</span>` : nothing}
    </div>
    <div class="row-body">
      <div class="title-row">
        <span class="title" title=${title}>${title}</span>
        ${typeLabel ? html`<span class="row-type">${typeLabel}</span>` : nothing}
      </div>
      <div class="meta-row">
        <span class="row-loc">${rowLocationTemplate(f)}${exportPart}</span>
        <div class="marks">
          ${actionButtonsTemplate(g, sortedTabs, groupSt, activeKey)}
        </div>
      </div>
      ${sortedTabs.length > 1 ? html`<div class="tabs-row"><div class="tabs">${sortedTabs.map((tabF) => tabTemplate(tabF, tabKey(tabF) === activeKey))}</div></div>` : nothing}
    </div>
  `
}
