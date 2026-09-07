// The Links view — what one links file says, and nothing more.
//
// A links file (client/linked-findings.js) is a list of links; each
// link names two or more findings that are the same finding, reported
// twice. It carries no findings of its own, so this page deliberately
// shows none: for every linked finding it prints the id, where that
// finding actually lives — which of the user's reports carry it — and
// a link that takes them to it. Reading the finding is the findings
// view's job; this page's job is to get you there and to make the
// shape of the file legible.
//
// Which is also why there is no filter, no sort and no triage
// selector here: those all operate on findings, and this page holds
// none. What it holds is a file the user dropped, listed as written.
//
// `renderLinksView()` is the single export; `render.js` calls it for
// `state.currentView === 'links'`, painting whatever `state.currentLinks`
// holds (set by `switchToFile` when the file it read turned out to be
// links).
//
// Two indexes feed it, both filled in the background and both re-read
// on every paint (events.js re-renders this view when either lands):
// the OPFS-wide finding index answers "which reports hold this id",
// and the counts cache answers what each of those reports IS, for its
// row icon.
import { html, nothing } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { encodeFindingRef, ensureBundleFindingsIndexed, reportsForFindingId, state } from '#client/index.js'
import { FILE_ICONS, displayName, groupOf } from './file-display.js'
import { shortFindingId } from './format.js'

// One linked finding, as a row: the id (a deep link into whichever
// report holds it) and the reports it was found in.
//
// The id is a `#finding=…` anchor exactly like the ones in a comment —
// same fragment format, same in-page navigation, same `hashchange`
// handler in ui/view.js — so following one lands on the finding with
// its report opened, its filters cleared if they hid it, and a ring
// around it. `encodeFindingRef` is safe to call unguarded: the parser
// only keeps ids `isLinkableFindingId` accepts, which is the same test
// this throws on.
//
// A finding no report of the user's carries still renders as a link.
// The index knows what is on disk RIGHT NOW; the link's own resolution
// re-checks (and says so plainly if it comes up empty), and a report
// dropped a minute from now makes the same link work. Muting it here
// would be the page pretending to a certainty it doesn't have — so it
// says "not in your reports" beside it instead, which is the honest
// version of the same information.
function linkedFindingRow(id) {
  const reports = reportsForFindingId(id).toSorted((a, b) => displayName(a).localeCompare(displayName(b)))
  const label = shortFindingId(id) ?? id
  return html`<li class="links-finding">
    <a class="links-finding-id mono" href=${`#${encodeFindingRef({ id })}`} title=${`Show ${id}`}>${label}</a>
    ${reports.length === 0
      ? html`<span class="links-finding-missing">not in your reports</span>`
      : html`<span class="links-finding-reports">${reports.map((r) => html`<button
          type="button"
          class="links-finding-report"
          title=${r}
          data-package-report=${r}
        >${unsafeHTML(FILE_ICONS[groupOf(r)] ?? FILE_ICONS.default)}<span class="links-finding-report-label">${displayName(r)}</span></button>`)}</span>`}
  </li>`
}

// One link — the findings it holds, in the order the file wrote them.
// Numbered rather than titled because a link has no name: the file
// gives it none, and inventing one from a member finding would put the
// reader's eye on one of them as though it were the original.
function linkGroupTemplate(group, index) {
  return html`<li class="links-group">
    <div class="links-group-head">
      <span class="links-group-index">Link ${index + 1}</span>
      <span class="links-group-count">${group.length} findings</span>
    </div>
    <ul class="links-group-findings">${group.map((id) => linkedFindingRow(id))}</ul>
  </li>`
}

// n of a thing, with the plural picked for it.
function count(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`
}

export function renderLinksView() {
  const open = state.currentLinks
  if (!open) return nothing
  // The reports this page attributes findings to come from the
  // OPFS-wide index; kick its walk if nothing else has. Rows fill in
  // as it goes — the subscriber in events.js repaints this view.
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
        <h1>Links</h1>
        <div class="meta-row">
          <span class="links-file-name" title=${name}>${unsafeHTML(FILE_ICONS[groupOf(name)] ?? FILE_ICONS.default)}${displayName(name)}</span>
          <span>${count(groups.length, 'link', 'links')}</span>
          <span>${count(linkedIds.size, 'finding', 'findings')}</span>
          ${holders.size > 0 ? html`<span>found in ${count(holders.size, 'report', 'reports')}</span>` : nothing}
        </div>
      </div>
    </header>
    <p class="links-lede">
      Each link below says its findings are the same finding, reported more than
      once. This file names them and nothing else — follow an id to read the
      finding in the report that carries it. Linked findings also list their
      duplicates at the bottom of their own card.
    </p>
    ${located < linkedIds.size ? html`<p class="links-note">${
      count(linkedIds.size - located, 'linked finding is', 'linked findings are')
    } not in any report you hold. Import the reports they came from and this page fills in.</p>` : nothing}
    ${skipped > 0 ? html`<p class="links-note">${
      count(skipped, 'entry', 'entries')
    } in this file could not be linked — an id the app can't follow (a session-local number, or something that isn't an id at all).</p>` : nothing}
    ${groups.length === 0
      ? html`<p class="links-empty">This file declares no links: every entry in it named fewer than two findings this app can reach.</p>`
      : html`<ol class="links-list">
        ${/* Keyed on the position AND the ids: a file is free to write
              the same link twice, and two identical keys would have Lit
              reusing one row for both. */
          repeat(groups, (g, i) => `${i}:${g.join(' ')}`, (g, i) => linkGroupTemplate(g, i))}
      </ol>`}
  </div>`
}
