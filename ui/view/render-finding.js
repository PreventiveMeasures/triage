import { state } from './state.js'
import { esc, prettyModel, stripExportMarker, lineLink, fileUrl } from './format.js'
import { tabKey, groupKey, sortTabs, activeTabFor, groupState } from './group.js'

// Combined `file:line` link for the table-view location cell. lineLink
// only emits "line N" since the list view shows the filename in a
// separate file-header / flat-group-loc; the table view has no such
// header, so we need both pieces in one slot.
function rowLocationHtml(f) {
  const url = fileUrl(f.file, f.repo?.github)
  const lineNum = parseInt(f.line, 10)
  const text = Number.isFinite(lineNum) ? `${f.file}:${f.line}` : f.file
  if (!url) return esc(text)
  const target = Number.isFinite(lineNum) ? `${url}#L${lineNum}` : url
  return `<a href="${esc(target)}" target="_blank" rel="noopener">${esc(text)}</a>`
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

// Action buttons (color dots + ×/restore) shared by both the list-view
// .finding card and the table-view .finding-row. The styling is
// hoisted out of .finding scope (see findings.css) so the same
// markup works inside both containers.
function actionButtonsHtml(group, sortedTabs, groupSt, activeKey) {
  let html = ''
  const activeColor = state.markers.get(activeKey)
  for (const color of ['red', 'blue', 'green', 'gray']) {
    const activeCls = activeColor === color ? ' active' : ''
    const dotTitle = sortedTabs.length > 1
      ? `mark ${color} (applies to active tab)`
      : `mark ${color} (click again to clear)`
    html += `<button class="mark-dot mark-dot-${color}${activeCls}" data-color="${color}" title="${dotTitle}"></button>`
  }
  if (state.showDeleted) {
    html += `<button class="mark-restore" title="restore whole group">restore</button>`
  } else {
    const xTitle = groupSt.hasConflict
      ? 'delete active tab (colors mismatch — acts per-tab)'
      : (sortedTabs.length > 1 ? 'delete whole group' : 'delete')
    html += `<button class="mark-x" title="${xTitle}">×</button>`
  }
  return html
}

// Render a single tab button. Shows the tab's severity badge + conf, and
// carries its own color / deleted classes so per-tab triage is visible
// from the group header.
export function renderTab(f, isActive) {
  const key = tabKey(f)
  const color = state.markers.get(key)
  const deleted = state.deletedIds.has(key)
  const classes = ['tab']
  if (isActive) classes.push('active')
  if (color) classes.push(`tab-mark-${color}`)
  if (deleted) classes.push('tab-deleted')
  const confPart = f.confidence !== undefined ? `<span class="tab-conf">${f.confidence}/10</span>` : ''
  return `<button type="button" class="${classes.join(' ')}" data-tid="${esc(key)}"><span class="tab-label"><span class="badge ${esc(f.severity)}">${esc(f.severity)}</span> ${confPart}</span></button>`
}

// Render one tab's body (finding-left + content). Only the active tab
// body is shown on screen (CSS `.tab-body.active { display: grid }`);
// on print the CSS overrides to show every body stacked so paper output
// keeps all cases visible.
// `idx` / `total` feed the print-only "N of M" banner; on screen the tab
// strip already conveys group size, so `.print-case-label { display: none }`
// hides it. `.value-label` rows emit "Severity" / "Confidence" sub-captions
// below the badge / score on BOTH screen and paper — small enough to read
// as supporting metadata, big enough that someone unfamiliar with the UI
// conventions doesn't have to guess what a colored chip and a "5/10" mean.
export function renderTabBody(f, isActive, idx = 0, total = 1) {
  const key = tabKey(f)
  let html = `<div class="tab-body${isActive ? ' active' : ''}" data-tid="${esc(key)}">`
  if (total > 1) html += `<div class="print-case-label">${idx + 1} of ${total}</div>`
  html += '<div class="finding-left">'
  // Sub-captions sit AFTER their values (below them visually).
  html += `<span class="badge ${esc(f.severity)}">${esc(f.severity)}</span>`
  html += '<div class="value-label">Severity</div>'
  if (f.confidence !== undefined) {
    html += `<div class="conf-score"><strong>${f.confidence}</strong>/10</div>`
    html += '<div class="value-label">Confidence</div>'
  }
  html += '</div>'
  html += '<div>'
  // `.line-row` flexes line numbers (left) against run-meta (right).
  // Empty `.run-meta` collapses so the line-num still sits flush left.
  // In file-grouped mode this row is hidden in favor of the per-finding
  // `.finding-loc` header above the card (CSS rule under .file-group).
  html += '<div class="line-row">'
  // Line number anchor + (when present) the export name the finding
  // lives in, comma-separated. The exportName is plain text — only the
  // line number gets linkified by `lineLink`. Pass `f.repo?.github` so
  // a node_modules finding links to the package's upstream repo rather
  // than the user-typed project URL. Codex / Claude Security imports
  // don't carry line numbers (lineLink returns ''); skip the wrapping
  // span and the comma-separator entirely when both pieces are empty
  // so the line-row collapses to nothing instead of leaving "line ?".
  const lineHtml = lineLink(f.file, f.line, f.repo?.github)
  const exportName = f.exportName ? esc(f.exportName) : ''
  const lineRowText = lineHtml && exportName
    ? `${lineHtml}, ${exportName}`
    : (lineHtml || exportName)
  if (lineRowText) html += `<span class="line-num">${lineRowText}</span>`
  if (f.discoveredIn) html += ` <span class="line-num">(found analyzing ${esc(f.discoveredIn)})</span>`
  const meta = [f.type, prettyModel(f.model), f.effort, f.exportsMode].filter(Boolean).join(' · ')
  if (meta) html += `<span class="run-meta">${esc(meta)}</span>`
  html += '</div>'
  html += `<div class="desc">${esc(stripExportMarker(f.description, f.exportName))}</div>`
  if (f.recommendation) html += `<div class="recommendation">Recommendation: ${esc(stripExportMarker(f.recommendation, f.exportName))}</div>`
  if (f.confidenceReason) html += `<div class="conf-reason">${esc(stripExportMarker(f.confidenceReason, f.exportName))}</div>`
  html += '</div></div>'
  return html
}

// Render one group as a `.finding` card. Group-level wrapper carries:
//   - `is-critical` if ANY tab is critical (matches filter semantics)
//   - `has-conflict` if tab colors disagree (accent outline, ignore deleted)
//   - `mark-<color>` if tabs share a common color (no conflict)
//   - `deleted` when in trash view (opacity nudge)
// Marks row at the bottom is group-level: color dots act on the active
// tab; delete acts on the whole group when conflict-free, on the active
// tab when conflicted. See click handler in events.js for the inverse.
export function renderGroup(g) {
  const groupSt = groupState(g)
  const sortedTabs = sortTabs(g)
  const active = activeTabFor(g)
  const activeKey = tabKey(active)
  const isCritical = g.some((f) => f.critical || f.severity === 'critical')
  const classes = ['finding']
  if (isCritical) classes.push('is-critical')
  if (groupSt.hasConflict) classes.push('has-conflict')
  else if (groupSt.commonColor) classes.push(`mark-${groupSt.commonColor}`)
  if (state.showDeleted) classes.push('deleted')
  // `multi-case` is a print-only hook: when there's more than one tab in
  // the group, the print stylesheet uses this class to draw a banner above
  // the stacked cases so a paper reader can tell at a glance that the
  // entries below are reports of one finding, not unrelated findings.
  if (sortedTabs.length > 1) classes.push('multi-case')
  const gid = groupKey(g)

  let html = `<div class="${classes.join(' ')}" data-gid="${esc(gid)}">`
  // Render every tab body so print mode can show them all stacked. Only
  // the active one is display:grid on screen; others are display:none.
  // Pass idx/total so each tab body can emit its own "Case N of M" banner
  // in print (suppressed on single-tab groups via the default args).
  sortedTabs.forEach((f, i) => {
    html += renderTabBody(f, tabKey(f) === activeKey, i, sortedTabs.length)
  })
  // Marks row. Colors reflect the ACTIVE tab (since clicks apply there).
  // Delete button's title changes to signal the per-tab vs. per-group
  // behavior depending on conflict state. The tab strip lives here too
  // (on the left, pushed apart from the dots by `margin-right: auto`
  // in CSS) so multi-tab groups get their tab picker adjacent to the
  // other per-group controls — one action row per finding.
  html += '<div class="marks">'
  // Tab strip — only for multi-tab groups; single findings render
  // without tabs and the dots sit alone on the right.
  if (sortedTabs.length > 1) {
    html += '<div class="tabs">'
    for (const f of sortedTabs) html += renderTab(f, tabKey(f) === activeKey)
    html += '</div>'
  }
  html += actionButtonsHtml(g, sortedTabs, groupSt, activeKey)
  html += '</div>'
  html += '</div>'
  return html
}

// Compact block per finding for the table view. Layout:
//   ┌──────────┬──────────────────────────────────────┐
//   │  badge   │  title (first line, ellipsis)  type  │
//   │  conf?   │  file:line               actions     │
//   │          │  tab strip (multi-tab only)          │
//   │          │  full description (when expanded)    │
//   └──────────┴──────────────────────────────────────┘
// The left column is fixed-width so badges line up across rows; when
// confidence is absent the badge centers vertically against the body.
// Click anywhere outside a button / link toggles `.expanded` and
// reveals the description / recommendation / conf-reason. Never
// grouped by file — the file:line lives in the row's meta line.
export function renderTableRow(g) {
  const groupSt = groupState(g)
  const sortedTabs = sortTabs(g)
  const active = activeTabFor(g)
  const activeKey = tabKey(active)
  const isCritical = g.some((f) => f.critical || f.severity === 'critical')
  const classes = ['finding-row']
  if (isCritical) classes.push('is-critical')
  if (groupSt.hasConflict) classes.push('has-conflict')
  else if (groupSt.commonColor) classes.push(`mark-${groupSt.commonColor}`)
  if (state.showDeleted) classes.push('deleted')
  const gid = groupKey(g)
  const f = active

  const title = firstLine(stripExportMarker(f.description, f.exportName))
  // Compact type chip — same `analyzer · model · effort · exportsMode`
  // composition the list view's run-meta uses, just rendered as a
  // single muted suffix to the title row.
  const typeLabel = [f.type, prettyModel(f.model), f.effort, f.exportsMode].filter(Boolean).join(' · ')
  const exportPart = f.exportName ? `, ${esc(f.exportName)}` : ''

  let html = `<div class="${classes.join(' ')}" data-gid="${esc(gid)}">`

  // Left column: badge + (optional) confidence. Centered vertically
  // within the row by the parent's grid `align-items: center`, so when
  // conf is absent the badge ends up centered across the available
  // height instead of stuck at the top.
  html += '<div class="row-score">'
  html += `<span class="badge ${esc(f.severity)}">${esc(f.severity)}</span>`
  if (f.confidence !== undefined) {
    html += `<span class="row-conf"><strong>${f.confidence}</strong>/10</span>`
  }
  html += '</div>'

  // Right column: title row, meta row, optional tab strip, optional
  // expanded body. All rendered inside a flex column so they stack
  // with consistent gaps regardless of which optional sections appear.
  html += '<div class="row-body">'
  html += '<div class="title-row">'
  html += `<span class="title" title="${esc(title)}">${esc(title)}</span>`
  if (typeLabel) html += `<span class="row-type">${esc(typeLabel)}</span>`
  html += '</div>'
  html += '<div class="meta-row">'
  html += `<span class="row-loc">${rowLocationHtml(f)}${exportPart}</span>`
  html += '<div class="marks">'
  html += actionButtonsHtml(g, sortedTabs, groupSt, activeKey)
  html += '</div>'
  html += '</div>'
  if (sortedTabs.length > 1) {
    html += '<div class="tabs-row"><div class="tabs">'
    for (const tabF of sortedTabs) html += renderTab(tabF, tabKey(tabF) === activeKey)
    html += '</div></div>'
  }
  // Expanded section — hidden until the row carries `.expanded`.
  // Mirrors the list view's per-tab body content (full description,
  // recommendation, conf-reason, discoveredIn note) minus the badge
  // and confidence which the score column already shows.
  html += '<div class="expanded-content">'
  html += `<div class="desc">${esc(stripExportMarker(f.description, f.exportName))}</div>`
  if (f.recommendation) html += `<div class="recommendation">Recommendation: ${esc(stripExportMarker(f.recommendation, f.exportName))}</div>`
  if (f.confidenceReason) html += `<div class="conf-reason">${esc(stripExportMarker(f.confidenceReason, f.exportName))}</div>`
  if (f.discoveredIn) html += `<div class="discovered-in">found analyzing ${esc(f.discoveredIn)}</div>`
  html += '</div>'
  html += '</div>'  // /row-body
  html += '</div>'  // /finding-row
  return html
}
