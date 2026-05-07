import { html, nothing } from 'lit'
import { state } from './state.js'
import { prettyModel, stripExportMarker, fileUrl, commitUrl } from './format.js'
import { tabKey, groupKey, sortTabs, activeTabFor, groupState } from './group.js'

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
  const url = fileUrl(f.file, f.repo?.github)
  const lineNum = parseInt(f.line, 10)
  const text = Number.isFinite(lineNum) ? `${f.file}:${f.line}` : f.file
  if (!url) return text
  const target = Number.isFinite(lineNum) ? `${url}#L${lineNum}` : url
  return html`<a href=${target} target="_blank" rel="noopener">${text}</a>`
}

// "line N" link for the tab-body line row. Returns `nothing` when
// the line number isn't a finite integer (codex / claude-security
// imports stub the line as '?'); callers compose the result inline,
// so `nothing` collapses cleanly.
function lineLinkTemplate(file, line, githubRepo) {
  const lineNum = parseInt(line, 10)
  if (!Number.isFinite(lineNum)) return nothing
  const url = fileUrl(file, githubRepo)
  const text = `line ${lineNum}`
  if (!url) return text
  return html`<a href=${`${url}#L${lineNum}`} target="_blank" rel="noopener">${text}</a>`
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

// Action buttons (color dots + ×/restore) shared by both the list-view
// .finding card and the table-view .finding-row. The styling is
// hoisted out of any container scope so the same markup works inside
// both finding-row.css and finding-card.css.
function actionButtonsTemplate(group, sortedTabs, groupSt, activeKey) {
  const activeColor = state.markers.get(activeKey)
  const dots = ['red', 'blue', 'green', 'gray'].map((color) => {
    const cls = `mark-dot mark-dot-${color}${activeColor === color ? ' active' : ''}`
    const dotTitle = sortedTabs.length > 1
      ? `mark ${color} (applies to active tab)`
      : `mark ${color} (click again to clear)`
    return html`<button class=${cls} data-color=${color} title=${dotTitle}></button>`
  })
  if (state.showDeleted) {
    return html`${dots}<button class="mark-restore" title="restore whole group">restore</button>`
  }
  const xTitle = groupSt.hasConflict
    ? 'delete active tab (colors mismatch — acts per-tab)'
    : (sortedTabs.length > 1 ? 'delete whole group' : 'delete')
  return html`${dots}<button class="mark-x" title=${xTitle}>×</button>`
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
  const lineLink = lineLinkTemplate(f.file, f.line, f.repo?.github)
  // Line-num span composes the line link + (when present) the
  // exportName, comma-separated. Both pieces optional; the wrapping
  // span is suppressed when both are empty so the line-row collapses
  // to nothing instead of leaving a stray "line ?".
  const hasLineLink = lineLink !== nothing
  const exportName = f.exportName ?? ''
  let lineRowMain = nothing
  if (hasLineLink && exportName) lineRowMain = html`<span class="line-num">${lineLink}, ${exportName}</span>`
  else if (hasLineLink) lineRowMain = html`<span class="line-num">${lineLink}</span>`
  else if (exportName) lineRowMain = html`<span class="line-num">${exportName}</span>`
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
export function findingCardInnerTemplate(g) {
  const groupSt = groupState(g)
  const sortedTabs = sortTabs(g)
  const active = activeTabFor(g)
  const activeKey = tabKey(active)
  return html`
    ${sortedTabs.map((f, i) => tabBodyTemplate(f, tabKey(f) === activeKey, i, sortedTabs.length))}
    <div class="marks">
      <div class="marks-left">
        ${active.commitHash ? html`<div class="commit-ref">introduced in ${commitLinkTemplate(active.repo?.github, active.commitHash)}</div>` : nothing}
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
