import { html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { bundlesForFileHash, state } from '#client/index.js'
import { commitUrl, fileUrl, findingDisplayName, formatRunMeta, isHttpUrl, stripExportMarker } from './format.js'
import { activeTabFor, groupKey, groupState, isIgnored, sortTabs, tabKey } from './group.js'
import { FILE_ICONS, displayName, groupOf } from './file-display.js'

// All `<finding-row>` / `<finding-card>` shadow-DOM markup is built
// here as Lit `html` template results (no `unsafeHTML`). Lit
// auto-escapes interpolated text + attribute values, so only
// structural HTML lives in the templates — no manual `esc()`.
// Light-DOM helpers in render.js (e.g. flat list location headers)
// keep using the string-returning siblings in format.js.

// Display label for the .badge tier text. The class still gets the
// canonical severity string ('informational' / 'high_bug') so CSS
// color rules match; only the visible word is adjusted:
//   informational → info (shortened so it fits the shared badge slot)
//   high_bug      → "high bug" (underscore → space, reads naturally
//                   under the shared text-transform: uppercase)
export function badgeLabel(severity) {
  if (severity === 'informational') return 'info'
  return severity.replaceAll('_', ' ')
}

// First non-empty line of a description, for the table-view title.
// Markdown findings begin with a literal title line; JSON findings
// usually have a one-paragraph description and the whole thing
// becomes the title. CSS handles the visual ellipsis if it overflows.
export function firstLine(text) {
  if (!text) return ''
  for (const line of text.split('\n')) {
    if (line.trim()) return line.trim()
  }
  return ''
}

// Split a description into title + body for the card view's typographic
// layout. The first line acts as the title (bold heading) and the rest
// is the body. We only treat the first line as a title when there's
// actually a non-empty body after it — a single-line description stays
// rendered as a plain `.desc` so JSON findings with one-paragraph
// summaries don't get jarringly bolded.
function splitDescription(text) {
  if (!text) return { title: '', body: '' }
  const nl = text.indexOf('\n')
  if (nl < 0) return { title: '', body: text }
  const body = text.slice(nl + 1).replace(/^\s+/u, '')
  if (!body) return { title: '', body: text }
  return { title: text.slice(0, nl).trim(), body }
}

// Render prose with inline highlights for `"quoted"` strings and
// `` `code` `` spans — matches the prototype's `.summary q` /
// `.title em` styling (`design/prototypes/DeepView.0.html`). The
// surrounding delimiters are kept inside the highlighted region so a
// reader still sees the original quote / backtick characters. Returns
// the raw string when nothing matches so we don't churn out single-
// child arrays for the common case of plain text.
const INLINE_HL_RE = /"[^"\n]+"|`[^`\n]+`/gu
function renderHighlighted(text) {
  if (!text) return text
  INLINE_HL_RE.lastIndex = 0
  const parts = []
  let lastIdx = 0
  let m
  while ((m = INLINE_HL_RE.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index))
    const cls = m[0].codePointAt(0) === 0x60 /* ` */ ? 'inline-code' : 'inline-quote'
    parts.push(html`<span class=${cls}>${m[0]}</span>`)
    lastIdx = m.index + m[0].length
  }
  if (lastIdx === 0) return text
  if (lastIdx < text.length) parts.push(text.slice(lastIdx))
  return parts
}

// Combined `file:line` link for the table-view row's location cell —
// the row has no file header above it (unlike the list / grouped
// views) so file + line live together in one slot. Returns a
// TemplateResult when we have a source URL, plain text otherwise.
function rowLocationTemplate(f) {
  const url = fileUrl(f.file, f.repo?.github, f._repoFallback ?? state.repoUrl)
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

// Clipboard / copy glyph for the `[copy]` shortcut button. Same
// size + stroke weight as the comment / fix icons so the row reads
// as a uniform action strip.
const COPY_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <rect x="3" y="2.5" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
  <rect x="5.5" y="5" width="8" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

// Claude mark for the `[hand off to Claude Code]` shortcut button.
// Same size + stroke weight as the other action icons.
const CLAUDE_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <g stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none">
    <line x1="8" y1="1.8" x2="8" y2="14.2"/>
    <line x1="1.8" y1="8" x2="14.2" y2="8"/>
    <line x1="3.6" y1="3.6" x2="12.4" y2="12.4"/>
    <line x1="12.4" y1="3.6" x2="3.6" y2="12.4"/>
  </g>
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

// Action buttons — workspace-only report chip + comment / fix /
// copy / claude buttons + `<color-marker>` (the 4-dot color picker)
// + triage menu. The dots live in their own component (see
// view/color-marker.js) so finding-row / finding-card don't carry
// duplicate `.mark-dot` styling. A dot click bubbles as a composed
// `mark-color` event `{ detail: { color } }`; events.js's delegate
// on `report` resolves the gid via the same `[data-gid]` walk used
// for the other buttons.
function actionButtonsTemplate(group, sortedTabs, groupSt, activeKey, context = null) {
  const reportChip = reportChipTemplate(group)
  const activeEntry = state.triage.get(activeKey)
  const activeColor = activeEntry?.color ?? null
  const activeComment = activeEntry?.comment ?? ''
  const activeFix = activeEntry?.fix ?? ''
  const commentTitle = activeComment ? `Edit comment: ${activeComment}` : 'Add comment'
  const fixTitle = activeFix ? `Edit fix link: ${activeFix}` : 'Add fix link (PR URL, etc.)'
  const isFocus = context === 'focus'
  // Focus-view variant gives each button a text label after the
  // icon so the row reads as primary chrome (`[ ⌐ Comment ]`,
  // `[ ⚙ Fix link ]`, `[ ⎘ Copy ]`). The list-view default keeps
  // icons-only for compactness.
  const commentLabel = activeComment ? 'Edit comment' : 'Comment'
  const fixLabel = activeFix ? 'Edit fix link' : 'Fix link'
  const commentBtn = html`<button type="button" class=${classMap({ 'mark-comment': true, 'has-comment': activeComment })} title=${commentTitle} aria-label=${commentTitle}>${COMMENT_ICON}${isFocus ? html`<span class="mark-btn-label">${commentLabel}</span>` : nothing}</button>`
  const fixBtn = html`<button type="button" class=${classMap({ 'mark-fix': true, 'has-fix': activeFix })} title=${fixTitle} aria-label=${fixTitle}>${FIX_ICON}${isFocus ? html`<span class="mark-btn-label">${fixLabel}</span>` : nothing}</button>`
  // Copy button — writes a labeled `File / Line / Description /
  // Confidence` block for the active tab to the clipboard (handler
  // in events.js, active tab resolved via the same gid lookup).
  const copyBtn = html`<button type="button" class="mark-copy" title="Copy file, line, description, confidence to clipboard" aria-label="Copy finding details to clipboard">${COPY_ICON}${isFocus ? html`<span class="mark-btn-label">Copy</span>` : nothing}</button>`
  // Claude button — hands off the same finding block the copy
  // button writes (prefixed with "Confirm and fix:") to Claude Code
  // via the `claude://code/new?q=…` URL scheme.
  const claudeBtn = html`<button type="button" class="mark-claude" title="Open in Claude Code (claude://) with a confirm-and-fix prompt" aria-label="Open finding in Claude Code">${CLAUDE_ICON}${isFocus ? html`<span class="mark-btn-label">Claude</span>` : nothing}</button>`
  const picker = html`<color-marker .selected=${activeColor}></color-marker>`
  // Triage menu — chevron button that opens a small popover with
  // Fixed / Invalid / Delete actions. In any triage view (Fixed /
  // Invalid / Deleted), the button's label switches to the current
  // bucket name (e.g. "Deleted ▾") and the menu prepends a Restore
  // option, so the user can flip a deleted finding to fixed without
  // first restoring + re-triaging. In the live view the button is
  // a chevron-only chip.
  // Conflict groups scope the action to the active tab.
  const menuTitle = groupSt.hasConflict
    ? 'change triage state (colors mismatch — acts per-tab)'
    : (sortedTabs.length > 1 ? 'change triage state for the whole group' : 'change triage state')
  return html`${reportChip}<span class="mark-action-group">${commentBtn}${fixBtn}</span><span class="mark-action-group">${copyBtn}${claudeBtn}</span>${picker}${triageMenuTemplate(group, menuTitle, context)}`
}

// Triage menu — chevron button toggling a popover with the Fixed /
// Invalid / Delete actions (and a Restore entry in a non-live
// triage view).
//
// Uses the native `popover="auto"` attribute, which lifts the menu
// into the top layer so it escapes any `overflow: hidden` parents
// (`.flat-group`, `.findings-table`) that would clip a dropdown
// next to a row's right edge or the last row in a list. The browser
// handles open/close (toggle via `popovertarget`, dismiss on
// outside click / Escape); position comes from `positionTriagePopover`
// below. The popover's data-gid (unique id derived from the group's
// gid) lets the action handler resolve the target group once the
// menu has moved to the top layer, out of the row's DOM scope.
// Position a triage popover under its trigger button. `beforetoggle`
// doesn't bubble, so this is bound directly on the popover via
// Lit's `@beforetoggle=` rather than a document-level delegate.
// Right-aligns the menu's right edge to the button's, dropping
// below by default; flips above when the viewport's bottom would
// clip. Reads from the popover's getRootNode() so the lookup
// works equally for shadow-DOM rows (`<finding-row>`) and the
// light-DOM finding cards.
function positionTriagePopover(e) {
  if (e.newState !== 'open') return
  const popover = e.currentTarget
  const root = popover.getRootNode()
  const btn = root.querySelector?.(`[popovertarget="${popover.id}"]`)
  if (!btn) return
  const btnRect = btn.getBoundingClientRect()
  // offsetWidth / offsetHeight are 0 when the popover is still
  // display:none (beforetoggle fires before the open paint), so
  // fall back to typical menu dimensions for the first measurement.
  const menuW = popover.offsetWidth || 110
  const menuH = popover.offsetHeight || 100
  const gap = 4
  let left = btnRect.right - menuW
  if (left < 4) left = 4
  if (left + menuW > window.innerWidth - 4) left = window.innerWidth - menuW - 4
  let top = btnRect.bottom + gap
  if (top + menuH > window.innerHeight - 4 && btnRect.top > menuH + gap) {
    top = btnRect.top - menuH - gap
  }
  popover.style.top = `${top}px`
  popover.style.left = `${left}px`
}

function triageMenuTemplate(group, title, context = null) {
  const gid = tabKey(group[0])
  const groupSt = groupState(group)
  const activeTab = activeTabFor(group)
  const activeKey = tabKey(activeTab)
  // Active tab's "current" bucket — triage state, else 'ignored'
  // when the per-report ignore key is set, else null. For
  // non-conflict groups, the rollup's commonTriage already folds
  // both axes, so we read it directly.
  const current = groupSt.hasConflict
    ? (state.triage.get(activeKey)?.triage
       ?? (isIgnored(activeTab) ? 'ignored' : null))
    : groupSt.commonTriage
  const STATE_LABELS = { fixed: 'Fixed', invalid: 'Invalid', deleted: 'Deleted', ignored: 'Ignored' }
  const ACTION_LABELS = { fixed: 'Fixed', invalid: 'Invalid', deleted: 'Delete', ignored: 'Ignore' }
  const inTriageView = Boolean(state.shownTriage)
  const buttonLabel = inTriageView ? STATE_LABELS[state.shownTriage] : null
  // Action order: triage states first (Fixed / Invalid / Delete),
  // then Ignore.
  //
  // Focus-view variant shows all four states as toggleable chips
  // with the active one marked `.active` (pressed); clicking it
  // toggles off (the duplicate-click semantic events.js already
  // implements), so no separate "Restore" entry is needed.
  //
  // List-view variant (the dropdown) prepends Restore in a triage
  // view and excludes the current state — as a popover menu, showing
  // the active bucket without a "press" affordance would confuse.
  const ALL_ACTIONS = ['fixed', 'invalid', 'deleted', 'ignored']
  const isFocus = context === 'focus'
  let actions
  if (isFocus) {
    actions = ALL_ACTIONS.map((s) => ({ key: s, label: ACTION_LABELS[s] }))
  } else if (inTriageView) {
    actions = [
      { key: 'restore', label: 'Restore' },
      ...ALL_ACTIONS
        .filter((s) => s !== state.shownTriage)
        .map((s) => ({ key: s, label: ACTION_LABELS[s] })),
    ]
  } else {
    actions = ALL_ACTIONS.map((s) => ({ key: s, label: ACTION_LABELS[s] }))
  }
  const btnClasses = ['mark-triage-menu']
  if (inTriageView) btnClasses.push('with-label', `triage-state-${state.shownTriage}`)
  // Stable popover id derived from gid — escape so
  // `f.id`/`String(f._id)` shapes that include `.` / `:` produce a
  // valid CSS-selectable id.
  const popId = `triage-menu-${gid.replaceAll(/[^A-Za-z0-9_-]/gu, '_')}`
  return html`<div class="triage-menu-wrap">
    <button type="button" class=${btnClasses.join(' ')} popovertarget=${popId} popovertargetaction="toggle" title=${title} aria-label=${title}>
      ${buttonLabel ? html`<span class="mark-triage-label">${buttonLabel}</span>` : nothing}
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div popover="auto" id=${popId} class="triage-menu" data-gid=${gid} role="menu" @beforetoggle=${positionTriagePopover}>
      ${actions.map((a) => html`<button
        type="button"
        class=${classMap({ 'triage-menu-item': true, [`triage-menu-${a.key}`]: true, active: current === a.key })}
        data-triage-action=${a.key}
        role="menuitem"
      >${a.label}</button>`)}
    </div>
  </div>`
}

// One tab button. Carries severity badge + (optional) confidence,
// plus per-tab color/deleted classes so multi-tab triage state is
// visible from the group header.
function tabTemplate(f, isActive) {
  const key = tabKey(f)
  const entry = state.triage.get(key)
  const color = entry?.color
  const triage = entry?.triage
  const ignored = isIgnored(f)
  const classes = ['tab']
  if (isActive) classes.push('active')
  if (color) classes.push(`tab-mark-${color}`)
  if (triage) classes.push(`tab-${triage}`)
  // `tab-ignored` is per-tab (each tab has its own report) and
  // mutually exclusive with the triage classes via the action
  // handler. Falls through to a muted opacity hint via finding-row
  // / finding-card CSS.
  else if (ignored) classes.push('tab-ignored')
  return html`<button type="button" class=${classes.join(' ')} data-tid=${key}><span class="tab-label"><span class=${`badge ${f.severity}`}>${badgeLabel(f.severity)}</span> ${f.confidence === undefined ? nothing : html`<span class="tab-conf">${f.confidence}/10</span>`}</span></button>`
}

// Confidence display for the finding-left badge column. The table
// view's side-details panel and the focus view's centered card
// both render a conic-gradient ring colored by severity (matching
// the design prototype); list / grouped modes keep the plain
// "<n>/10" stack so the regular cards stay compact.
function confTemplate(f) {
  if (state.viewMode === 'table' || state.viewMode === 'focus') {
    // Arc length in viewBox units. The circle's radius is 15.9155
    // (circumference ≈ 100), so stroke-dasharray = "<conf*10> 100"
    // draws an N% arc with the remainder invisible (no track ring).
    const arc = f.confidence * 10
    return html`<div class=${`conf-ring ${f.severity}`}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle class="conf-ring-track" cx="18" cy="18" r="15.9155"/>
        <circle class="conf-ring-arc" cx="18" cy="18" r="15.9155" style=${`stroke-dasharray: ${arc} 100`}/>
      </svg>
      <span>${f.confidence}<small>/10</small></span>
    </div>
    <div class="value-label">Confidence</div>`
  }
  return html`<div class="conf-score"><strong>${f.confidence}</strong>/10</div>
    <div class="value-label">Confidence</div>`
}

// Permissive npm-package-name shape — lowercase / digits / `-_.`
// with an optional `@scope/` prefix. Anything outside this set
// (whitespace, `?`, `#`, `..`, multiple slashes, etc.) suppresses
// the link rather than producing a URL that points at the wrong
// npm page. Not an XSS guard — Lit auto-escapes the interpolated
// href; this is purely about link correctness.
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu

// npm chip — small accent-tinted pill linking to npmjs.com. Returns
// `nothing` when the stamp is absent or malformed. Version is
// `encodeURIComponent`'d (semver tags are URL-safe but pre-release
// builds can carry `+` which would otherwise read as a space).
function npmChipTemplate(npm) {
  const name = npm?.name
  if (typeof name !== 'string' || !NPM_NAME_RE.test(name)) return nothing
  const version = npm?.version
  const hasVersion = typeof version === 'string' && version.length > 0
  const href = hasVersion
    ? `https://www.npmjs.com/package/${name}/v/${encodeURIComponent(version)}`
    : `https://www.npmjs.com/package/${name}`
  const label = hasVersion ? `${name}@${version}` : name
  return html`<span class="line-num"><a
    class="npm-link"
    href=${href}
    target="_blank"
    rel="noopener noreferrer"
    title=${`Open ${label} on npmjs.com`}
  >npm: ${label}</a></span>`
}

// One tab body — finding-left (badge column) + the right-side stack
// (line row, description, recommendation, conf reason). Only the
// active body is `display: grid` on screen; print mode shows them
// all stacked. `idx` / `total` feed the print-only "N of M" subhead;
// suppressed for single-tab groups via the default args.
function tabBodyTemplate(f, isActive, idx = 0, total = 1, context = null) {
  const key = tabKey(f)
  const entry = state.triage.get(key)
  const comment = entry?.comment ?? ''
  const fix = entry?.fix ?? ''
  // Location is rendered as `file:line` (linkified when we have a
  // repo URL). Standalone cards (the table view's detail panel) need
  // the file here because there's no surrounding header above; list /
  // grouped modes hide the `.line-row` via `:host([in-group])` since
  // `.flat-group-loc` / `.file-header` already paint the same info
  // above the card. exportName (or `exportName.methodName` when the
  // finding carries both) joins with a comma when present.
  const url = fileUrl(f.file, f.repo?.github, f._repoFallback ?? state.repoUrl)
  const lineNum = parseInt(f.line, 10)
  const hasLine = Number.isFinite(lineNum)
  const locText = hasLine ? `${f.file}:${f.line}` : f.file
  const locLink = url
    ? html`<a href=${hasLine ? `${url}#L${lineNum}` : url} target="_blank" rel="noopener">${locText}</a>`
    : locText
  const exportLabel = findingDisplayName(f)
  const lineRowMain = exportLabel
    ? html`<span class="line-num">${locLink}, ${exportLabel}</span>`
    : html`<span class="line-num">${locLink}</span>`
  const meta = formatRunMeta(f)
  // npm chip in the focused finding view's line-row — surfaces the
  // upstream package + version when the analyzer stamped
  // `package: { npm: { name, version? } }` on the finding (links to
  // npmjs.com; see npmChipTemplate for name validation). Focus-only:
  // it has the horizontal room and is the workbench surface, so the
  // chip reads as orientation rather than noise in the other views.
  const npmChip = context === 'focus' ? npmChipTemplate(f.package?.npm) : nothing
  // "Code →" shortcut — when this finding's `fileHash` is present
  // in any bundle the analyzer was run against (per-finding
  // `_bundleHashes`, stamped by ingest), the button points at the
  // first matching bundle's Code view at that file. The
  // bundle-hash index populates lazily — initially via the
  // ingest-time prefetch, and live as new bundles drop. Findings
  // without a hash, or hashes the analyzer didn't list any
  // bundle for, never get a button.
  let codeButton = nothing
  // Focus view already renders the source inline next to the
  // finding-card — surfacing a second "Code" button in the badge
  // rail would be redundant. The list / grouped / table-details
  // views keep it as their primary path into the bundle viewer.
  if (context !== 'focus' && f.fileHash && Array.isArray(f._bundleHashes) && f._bundleHashes.length > 0) {
    const allowed = new Set(f._bundleHashes)
    const match = bundlesForFileHash(f.fileHash).find(({ integrity }) => allowed.has(integrity))
    if (match) {
      codeButton = html`<button
        type="button"
        class="finding-code-btn"
        data-finding-code-bundle=${match.integrity}
        data-finding-code-file=${match.file}
        data-finding-code-line=${f.line ?? ''}
        title=${`Open ${match.file} in bundle source viewer`}
      >Code</button>`
    }
  }
  const { title: descTitle, body: descBody } = splitDescription(stripExportMarker(f.description, f))
  return html`<div class=${classMap({ 'tab-body': true, active: isActive })} data-tid=${key}>
    ${total > 1 ? html`<div class="print-case-label">${idx + 1} of ${total}</div>` : nothing}
    <div class="finding-left">
      <span class=${`badge ${f.severity}`}>${badgeLabel(f.severity)}</span>
      <div class="value-label">Severity</div>
      ${f.confidence === undefined ? nothing : confTemplate(f)}
      ${codeButton}
    </div>
    <div>
      <div class="line-row">
        ${lineRowMain}
        ${npmChip}
        ${f.discoveredIn ? html`<span class="line-num discovered-in">(found analyzing ${f.discoveredIn})</span>` : nothing}
        ${meta ? html`<span class="run-meta">${meta}</span>` : nothing}
      </div>
      ${descTitle ? html`<div class="desc-title">${descTitle}</div>` : nothing}
      ${descBody ? html`<div class="desc">${renderHighlighted(descBody)}</div>` : nothing}
      ${f.recommendation ? html`<div class="recommendation">Recommendation: ${renderHighlighted(stripExportMarker(f.recommendation, f))}</div>` : nothing}
      ${f.confidenceReason ? html`<div class="conf-reason">${renderHighlighted(stripExportMarker(f.confidenceReason, f))}</div>` : nothing}
      ${comment ? html`<div class="comment-block"><span class="comment-label">Comment:</span> ${comment}</div>` : nothing}
      ${fix
        ? html`<div class="fix-block"><span class="fix-label">Fix:</span> ${isHttpUrl(fix)
          ? html`<a href=${fix} target="_blank" rel="noopener noreferrer">${fix}</a>`
          : fix}</div>`
        : nothing}
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
  if (state.shownTriage) classes.push(`triage-${state.shownTriage}`)
  if (sortedTabs.length > 1) classes.push('multi-case')
  return classes
}

// Inner template for a `.finding` card — every tab body (only active
// shown on screen; print stacks them) plus the bottom marks row
// (commit ref, multi-tab strip, action buttons). The host element IS
// the card.
//
// Workspace mode lifts the "introduced in" line above the marks row:
// its action row carries a wide report-name chip on the left that
// would otherwise squeeze the commit-ref span and wrap the hash.
export function findingCardInnerTemplate(g, opts = {}) {
  const { context = null } = opts
  const groupSt = groupState(g)
  const sortedTabs = sortTabs(g)
  const active = activeTabFor(g)
  const activeKey = tabKey(active)
  const commitRef = active.commitHash
    ? html`<div class="commit-ref">introduced in ${commitLinkTemplate(active.repo?.github, active.commitHash)}</div>`
    : nothing
  const liftCommit = state.currentWorkspace && commitRef !== nothing
  return html`
    ${sortedTabs.map((f, i) => tabBodyTemplate(f, tabKey(f) === activeKey, i, sortedTabs.length, context))}
    ${liftCommit ? html`<div class="marks-commit-row">${commitRef}</div>` : nothing}
    <div class="marks">
      <div class="marks-left">
        ${liftCommit ? nothing : commitRef}
        ${sortedTabs.length > 1 ? html`<div class="tabs">${sortedTabs.map((f) => tabTemplate(f, tabKey(f) === activeKey))}</div>` : nothing}
      </div>
      ${actionButtonsTemplate(g, sortedTabs, groupSt, activeKey, context)}
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

// State-derived class list for a row's host element. Omits the
// `selected` class — that's owned by the host's `selected` property
// since the parent <finding-table> tracks selection there.
export function tableRowClasses(g) {
  const groupSt = groupState(g)
  const isCritical = g.some((f) => f.critical || f.severity === 'critical')
  const classes = []
  if (isCritical) classes.push('is-critical')
  if (groupSt.hasConflict) classes.push('has-conflict')
  else if (groupSt.commonColor) classes.push(`mark-${groupSt.commonColor}`)
  if (state.shownTriage) classes.push(`triage-${state.shownTriage}`)
  return classes
}

// Inner template for a row — score column on the left, body column
// (title / meta / optional tab strip) on the right. The <finding-row>
// host element is the wrapper; layout/grid is in finding-row.css.
export function tableRowInnerTemplate(g) {
  const groupSt = groupState(g)
  const sortedTabs = sortTabs(g)
  const active = activeTabFor(g)
  const activeKey = tabKey(active)
  const f = active

  const title = firstLine(stripExportMarker(f.description, f))
  const typeLabel = formatRunMeta(f)
  const exportLabel = findingDisplayName(f)
  const exportPart = exportLabel ? `, ${exportLabel}` : ''

  return html`
    <div class="row-score">
      <span class=${`badge ${f.severity}`}>${badgeLabel(f.severity)}</span>
      ${f.confidence === undefined ? nothing : html`<span class="row-conf"><strong>${f.confidence}</strong>/10</span>`}
    </div>
    <div class="row-body">
      <div class="title-row">
        <span class="title">${title}</span>
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
