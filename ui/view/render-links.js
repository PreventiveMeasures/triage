// A links file names ids; the reports supply their titles and card boundaries.
// Identical cards share their report chips, while overlapping cards remain
// separate. The OPFS finding index preserves this without reading reports again.
import { html, nothing } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { bucketOf, encodeFindingRef, ensureBundleFindingsIndexed, findingTitleForId, isLinkableFindingId, isReportIgnored, reportRowsForFindingIds, reportsForFindingId, state } from '#client/index.js'
import { FILE_ICONS, REPORT_LOGOS, displayName, groupOf } from './file-display.js'
import { displayFindingId, shortFindingId } from './format.js'
import { groupLinkedReportRows } from './linked-report-rows.js'
import { TRIAGE_LABELS } from '../../report/index.js'

function count(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`
}

function statusTemplate(id, reports) {
  const triage = bucketOf(state.triage.get(id))
  const ignored = reports.filter(({ name }) => isReportIgnored(state.triage, id, name))
  const status = triage ?? (ignored.length > 0 ? 'ignored' : null)
  if (!status) return nothing
  const partial = status === 'ignored' && ignored.length < reports.length
  const label = partial ? `Ignored in ${ignored.length}/${reports.length} reports` : TRIAGE_LABELS[status]
  return html`<span class=${`links-finding-status triage-${status}`}
    data-tooltip=${partial ? ignored.map(({ name }) => displayName(name)).join(', ') : nothing}
  >${label}</span>`
}

function memberTemplate({ id, title }, reports = [], linked = true, chips = nothing) {
  const report = reports[0]?.name
  const displayId = displayFindingId(id)
  const label = shortFindingId(id) ?? displayId
  return html`<li class=${linked ? 'links-finding' : 'links-finding links-finding-context'}>
    ${report ? html`<button type="button" class="links-finding-id mono"
      data-links-preview=${id} data-preview-report=${report}
      data-preview-row=${reports[0].rowIndex ?? nothing}
      data-tooltip=${displayId} aria-haspopup="dialog"
    >${label}</button>` : isLinkableFindingId(id) ? html`<a class="links-finding-id mono"
      href=${`#${encodeFindingRef({ id })}`} data-tooltip=${displayId}
    >${label}</a>` : html`<span class="links-finding-id mono">${label}</span>`}
    ${title ? html`<span class="links-finding-title">${title}</span>` : nothing}
    ${statusTemplate(id, reports)}
    ${linked ? nothing : html`<span class="links-member-context">not in this link</span>`}
    ${chips}
  </li>`
}

function reportChipsTemplate(reports) {
  return html`<div class="links-finding-reports">${reports.map(({ name, findingId }) => html`<button
    type="button" class="links-finding-report" data-tooltip=${displayName(name)}
    data-links-report=${name} data-links-finding=${findingId}
  >${unsafeHTML(REPORT_LOGOS[groupOf(name)] ?? REPORT_LOGOS.default)}<span class="links-finding-report-label">${displayName(name)}</span></button>`)}</div>`
}

function reportRowTemplate(row, linked) {
  const reports = row.reports.toSorted((a, b) => displayName(a.name).localeCompare(displayName(b.name)))
  if (row.members.length === 1) {
    const member = row.members[0]
    return html`<li class="links-report-row links-report-row-single">
      <ul class="links-row-members">${memberTemplate(member, reports, linked.has(member.id), reportChipsTemplate(reports))}</ul>
    </li>`
  }
  return html`<li class="links-report-row">
    <div class="links-report-row-head">
      <span class="links-row-count">${count(row.members.length, 'finding', 'findings')} in row</span>
      ${reportChipsTemplate(reports)}
    </div>
    <ul class="links-row-members">${row.members.map((f) => memberTemplate(f, reports, linked.has(f.id)))}</ul>
  </li>`
}

function linkGroupTemplate(group, index) {
  const { rows, missing } = groupLinkedReportRows(group, reportRowsForFindingIds(group))
  const linked = new Set(group)
  return html`<li class="links-group">
    <div class="links-group-head">
      <span class="links-group-index">Link ${index + 1}</span>
      <span class="links-group-count">${count(group.length, 'finding', 'findings')}</span>
    </div>
    <ul class="links-group-rows">${repeat(rows, (row) => row.key, (row) => reportRowTemplate(row, linked))}</ul>
    ${missing.length > 0 ? html`<div class="links-unlocated">
      <div class="links-finding-missing">Not in your reports</div>
      <ul class="links-row-members">${missing.map((id) => memberTemplate({ id, title: findingTitleForId(id) }))}</ul>
    </div>` : nothing}
  </li>`
}

export function renderLinksView(badge = nothing) {
  const open = state.currentLinks
  if (!open) return nothing
  // The index subscriber repaints as reports become available or change.
  ensureBundleFindingsIndexed().catch(() => {})
  const { name, groups, skipped } = open
  const linkedIds = new Set()
  const holders = new Set()
  let located = 0
  for (const group of groups) {
    for (const id of group) {
      if (linkedIds.has(id)) continue
      linkedIds.add(id)
      const reports = reportsForFindingId(id)
      if (reports.length === 0) continue
      located++
      for (const r of reports) holders.add(r)
    }
  }
  return html`<div class="links-view">
    <header class="page-head">
      <div class="page-title">
        <h1>Links${badge}</h1>
        <div class="meta-row">
          <span class="links-file-name" data-tooltip=${name}>${unsafeHTML(FILE_ICONS[groupOf(name)] ?? FILE_ICONS.default)}${displayName(name)}</span>
          <span>${count(groups.length, 'link', 'links')}</span>
          <span>${count(linkedIds.size, 'finding', 'findings')}</span>
          ${holders.size > 0 ? html`<span>found in ${count(holders.size, 'report', 'reports')}</span>` : nothing}
        </div>
      </div>
    </header>
    ${located < linkedIds.size ? html`<p class="links-note">${
      count(linkedIds.size - located, 'linked finding is', 'linked findings are')
    } not in any report you hold. Import the reports they came from and this page fills in.</p>` : nothing}
    ${skipped > 0 ? html`<p class="links-note">${
      count(skipped, 'entry', 'entries')
    } in this file could not be linked — an id the app can't follow (a session-local number, or something that isn't an id at all).</p>` : nothing}
    ${groups.length === 0
      ? html`<p class="links-empty">This file declares no links: every entry in it named fewer than two findings this app can reach.</p>`
      : html`<ol class="links-list">${
        repeat(groups, (g, i) => `${i}:${g.join(' ')}`, (g, i) => linkGroupTemplate(g, i))
      }</ol>`}
  </div>`
}
