import { state } from './state.js'
import { esc, prettyModel, stripExportMarker, lineLink } from './format.js'
import { tabKey, groupKey, sortTabs, activeTabFor, groupState } from './group.js'

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
  // Line number anchor + (when present) the export name the finding lives
  // in, comma-separated. The exportName is plain text — only the line
  // number gets linkified by `lineLink`. Pass `f.repo?.github` so a
  // node_modules finding links to the package's upstream repo rather
  // than the user-typed project URL.
  const exportPart = f.exportName ? `, ${esc(f.exportName)}` : ''
  html += `<span class="line-num">${lineLink(f.file, f.line, f.repo?.github)}${exportPart}</span>`
  if (f.discoveredIn) html += ` <span class="line-num">(found analyzing ${esc(f.discoveredIn)})</span>`
  const meta = [f.type, prettyModel(f.model), f.effort, f.exportsMode].filter(Boolean).join(' · ')
  if (meta) html += `<span class="run-meta">${esc(meta)}</span>`
  html += '</div>'
  html += `<div class="desc">${esc(stripExportMarker(f.description, f.exportName))}</div>`
  if (f.recommendation) html += `<div class="recommendation">Recommendation: ${esc(stripExportMarker(f.recommendation, f.exportName))}</div>`
  if (f.confidenceReason) html += `<div class="conf-reason">${esc(stripExportMarker(f.confidenceReason, f.exportName))}</div>`
  if (f.fileHash || f.treeHash) {
    const parts = []
    if (f.fileHash) parts.push(`file: ${esc(f.fileHash)}`)
    if (f.treeHash) parts.push(`tree: ${esc(f.treeHash)}`)
    html += `<div class="hashes">${parts.join(' | ')}</div>`
  }
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
  html += '</div>'
  html += '</div>'
  return html
}
