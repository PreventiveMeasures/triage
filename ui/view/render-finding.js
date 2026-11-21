import { html, nothing, svg } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { styleMap } from './style-map.js'
import { appMarkup } from './markup.js'
import { bundlesForFileHash, duplicatesOf, encodeFindingRef, isLinkableFindingId, isManagedUiMode, isPlaceholderNpmPackage, reportRowsForFindingIds, reportsForFindingId, state } from '#client/index.js'
import { publicSharePath } from '../../client/managed/public-share.js'
import { reportRepoGithub } from '@preventive/report'
import { newIssueLabels } from '../../common/github-issue-labels.js'
import { NESTING_DEPTH, SEVERITY_ORDER, codeBlockSegments, commitUrl, correctedVariants, descriptionSections, displayFindingId, displayedSeverity, effectiveSeverity, evidenceMarkdown, evidenceNote, evidenceUrl, findingDisplayName, findingTitle, findingUrl, flowText, formatRunMeta, githubIssueUrl, githubRefLabel, hasSeverityCorrection, isHttpUrl, lineBlockSegments, lineRange, listSegments, locationLabel, markdownLinkToken, quoteSegments, revalidateStamp, revalidationShown, shortFindingId, snippetWindow, splitDescription, stripExportMarker, unquotedText } from './format.js'
import { activeTabFor, canEditTriage, canTriageFinding, findingRepo, findingRepoTarget, groupKey, groupState, groupTabsByLevel, scopedTriage, sortTabs, tabKey, tabTriage, triageEntry, triageScope, triageTabs } from './group.js'
import { highlightedCode } from './code-highlight.js'
import { attachedBundle, bundleDependencyRepo, bundleSource, findingSourcePath, focusCodePosition } from './focus-code.js'
import { samePos } from './focus-code-history.js'
import { FILE_ICONS, PRODUCER_LABELS, REPORT_LOGOS, displayName, findingBrand, groupOf } from './file-display.js'
import { CLAUDE_MARK_PATH, GITHUB_ICON_SVG } from './icons.js'
import { findingLinkFor } from './finding-link.js'
import { managedCommentsFor } from './managed-comments.js'
import { automaticFixFor, managedIssueFor } from './managed-issues.js'
import { createIssueDraft } from './issue-draft.js'
import { ignoresOwnRepo } from '../../common/finding-repo.js'
import { managedCommentTemplate } from './managed-comment.js'
import { renderCommentText } from './comment-text.js'
import { COPY_ICON } from './lit-icons.js'

export { renderCommentText } from './comment-text.js'

// All `<finding-row>` / `<finding-card>` shadow-DOM markup, as Lit
// templates: Lit escapes interpolated text and attributes.

// A severity's badge text: `informational` → info, `high_bug` → high bug.
// The class keeps the canonical string for the CSS.
export function badgeLabel(severity) {
  if (severity === 'informational') return 'info'
  return severity.replaceAll('_', ' ')
}

// The severity chip of the tab strip, the finding-left column and the table
// row, through the toolbar's `state.severityMode` lens. A corrected finding
// shows the tier shown beside the other (struck `was <original>` in
// corrected mode, outlined in original mode) and a ▲/▼ glyph, so the
// distinction is never color alone; a deduped finding whose correction
// differs across reports adds "varies". Variants: 'full' (finding-left),
// 'compact' (table row), 'tab' (primary and the glyph only).
function severityBadge(f, { variant = 'full' } = {}) {
  const mode = state.severityMode
  const shown = displayedSeverity(f, mode)
  const primary = html`<span class=${`badge ${shown}`}>${badgeLabel(shown)}</span>`
  const hasCorr = hasSeverityCorrection(f)
  // Divergence across reports is the group's, not a tab's.
  const variants = variant === 'tab' ? null : correctedVariants(f)
  if (!hasCorr && !variants) return primary

  const variesTip = variants && `Corrected severity varies across reports — ${Object.entries(variants).map(([r, v]) => `${r || '(this report)'}: ${badgeLabel(v.severity)}`).join('; ')}`
  const variesChip = variants ? html`<span class="badge-varies" data-tooltip=${variesTip} aria-label=${variesTip}>varies</span>` : nothing

  // A deduped sibling's correction alone.
  if (!hasCorr) return html`<span class=${`badge-pair badge-pair-${variant}`}>${primary}${variesChip}</span>`

  const original = displayedSeverity(f, 'original')
  const corrected = effectiveSeverity(f)
  const reason = f.correctedSeverityReason
  const raised = (SEVERITY_ORDER[corrected] ?? 0) > (SEVERITY_ORDER[original] ?? 0)
  const dirWord = raised ? 'up' : 'down'
  const arrow = raised ? '▲' : '▼'
  const showingCorrected = mode !== 'original'
  const tip = (showingCorrected
    ? `Corrected ${dirWord} from ${badgeLabel(original)}`
    : `Original severity — corrected ${dirWord} to ${badgeLabel(corrected)}`)
    + (reason ? ` — ${reason}` : '')
  const aria = `Severity ${badgeLabel(shown)}; ${showingCorrected
    ? `corrected ${dirWord} from ${badgeLabel(original)}`
    : `original, corrected to ${badgeLabel(corrected)}`}${reason ? `; reason: ${reason}` : ''}`

  if (variant === 'tab') {
    return html`<span class="badge-pair badge-pair-tab" data-tooltip=${tip} aria-label=${aria}>${primary}<span class=${`badge-corr-mark ${dirWord}`} aria-hidden="true">${arrow}</span></span>`
  }

  // The companion: the tier not shown, struck only as the original.
  const other = showingCorrected ? original : corrected
  return html`<span class=${`badge-pair badge-pair-${variant}`} data-tooltip=${tip} aria-label=${aria}>${primary}<span class="badge-orig-wrap"><span class=${`badge-arrow ${dirWord}`} aria-hidden="true">${arrow}</span>${showingCorrected ? html`<span class="badge-pre" aria-hidden="true">was</span>` : nothing}<span class=${`badge-orig ${other}${showingCorrected ? ' struck' : ''}`}>${badgeLabel(other)}</span></span>${variesChip}</span>`
}

// One run of prose with its inline marks: `[label](url)` a link in a new
// tab (one markdownLinkToken rejects stays text), `**bold**` and `_em_`
// (between underscores touching no word outside, so snake_case stays;
// inside, only an underscore within a word, so the scan stays linear), each
// holding inline text of its own; `` `code` `` a chip without its backticks,
// and a `"quote"` kept with its marks. The link leads the pattern so a label
// holding quotes or backticks stays one link. Plain text comes back as the
// string itself. Fenced code never reaches here (renderHighlighted).
const INLINE_HL_RE = /\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*|(?<![\p{L}\p{M}\p{N}_])_(?![\s_])(?:[^_\n]|(?<=[\p{L}\p{M}\p{N}])_(?=[\p{L}\p{M}\p{N}]))*?(?<!\s)_(?![\p{L}\p{M}\p{N}_])|"[^"\n]+"|`[^`\n]+`/gu
function renderInline(text) {
  const parts = []
  let lastIdx = 0
  // matchAll scans a copy of the pattern, so the nested call for what
  // emphasis wraps can't move this scan's place.
  for (const m of text.matchAll(INLINE_HL_RE)) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index))
    const c0 = m[0].codePointAt(0)
    if (c0 === 0x5B /* [ */) {
      const link = markdownLinkToken(m[0])
      parts.push(link
        ? html`<a href=${link.url} target="_blank" rel="noopener noreferrer" data-tooltip=${link.url}>${link.label}</a>`
        : m[0])
    } else if (c0 === 0x2A /* * */) {
      parts.push(html`<strong>${renderInline(m[0].slice(2, -2))}</strong>`)
    } else if (c0 === 0x5F /* _ */) {
      parts.push(html`<em>${renderInline(m[0].slice(1, -1))}</em>`)
    } else if (c0 === 0x60 /* ` */) {
      parts.push(html`<span class="inline-code">${m[0].slice(1, -1)}</span>`)
    } else {
      parts.push(html`<span class="inline-quote">${m[0]}</span>`)
    }
    lastIdx = m.index + m[0].length
  }
  if (lastIdx === 0) return text
  if (lastIdx < text.length) parts.push(text.slice(lastIdx))
  return parts
}

// One fenced code block as a `<pre>`, its lines scrolling rather than
// folding, its language (```ts) its `data-lang` and header, and coloured
// once prism answers (async: `highlightedCode` is null till then, and the
// `codeBlockTick` read subscribes this card's autorun to it). Prism escapes
// the source, so its HTML goes in via `appMarkup`.
//
// One line on purpose: `.desc` / `.section-body` are `pre-wrap`, and dev
// builds skip the template minifier, so its own newlines would print.
function codeBlockTemplate({ lang, code }) {
  void state.codeBlockTick
  const coloured = highlightedCode(code, lang)
  return html`<div class="code-block" data-lang=${lang || nothing}>${lang ? html`<div class="code-block-lang">${lang}</div>` : nothing}<pre><code>${coloured ? appMarkup(coloured) : code}</code></pre></div>`
}

// One run of prose, split at its blank lines into `.para` elements: in a
// `pre-wrap` block a blank line would print as a full line, which no
// selector can space, where an element takes a margin. A single paragraph
// comes back bare, unless `wrap` (a body of several sibling blocks, whose
// gaps need an element to sit on). Single newlines stay, for pre-wrap; a
// heading or rule line (format.js lineBlockSegments) is a block of its own.
function proseTemplate(run, { wrap = false } = {}) {
  const paras = run.split(/\n{2,}/u).filter((p) => p.trim()).flatMap(lineBlockSegments)
  if (paras.length < 2 && typeof paras[0] !== 'object') {
    return wrap ? html`<div class="para">${renderInline(run)}</div>` : renderInline(run)
  }
  return paras.map((p) => (typeof p === 'string' ? html`<div class="para">${renderInline(p)}</div>` : lineBlockTemplate(p)))
}

// A heading by its role, not `<h2>`: a description's `##` is not the
// surface's own section.
function lineBlockTemplate({ level, text, rule }) {
  return rule ? html`<hr class="md-rule">` : html`<div class="md-heading" role="heading" aria-level=${level}>${renderInline(text)}</div>`
}

// One markdown list (format.js listSegments) as an `<ol>` / `<ul>`, each
// item's content rendered by markdownBody one `depth` deeper, so nested
// lists and snippets land inside it (an item is always shorter than its
// list, so this ends). `start` where it doesn't begin at 1; a task item
// (`- [x] …`) shows its box where the bullet would be.
const TASK_ITEM_RE = /^\[([ xX])\][ \t]+/u
function listTemplate({ ordered, start, items }, depth) {
  const entries = items.map((item) => {
    const task = TASK_ITEM_RE.exec(item)
    return task
      ? html`<li class="md-task"><input type="checkbox" disabled ?checked=${task[1] !== ' '}>${markdownBody(item.slice(task[0].length), depth + 1)}</li>`
      : html`<li>${markdownBody(item, depth + 1)}</li>`
  })
  return ordered
    ? html`<ol class="md-list" start=${start > 1 ? start : nothing}>${entries}</ol>`
    : html`<ul class="md-list">${entries}</ul>`
}

// A description body: lists, fenced code and quotes as blocks, the prose
// between them as paragraphs. Also drawn in light DOM by the bundle views
// (render-bundle.js), so report.css copies finding-card.css's .inline-* /
// .code-block / .md-list rules. `paragraphs: false` renders one inline flow,
// for the compact surfaces a line or two of summary has: no paragraphs,
// lists or quotes, a quote's `>`s and an alert's `[!NOTE]` shed
// (format.js unquotedText). CRLF comes in as `\n`.
export function renderHighlighted(raw, { paragraphs = true } = {}) {
  return markdownBody(raw, 0, { paragraphs, alerts: true })
}

// renderHighlighted's pass, which list items and quotes come back through.
// `alerts` only at the top, where GitHub draws them; past NESTING_DEPTH
// quotes and items (`depth`) a `>` or `- ` stays text: a report's text is
// untrusted, and every level parses what it holds again.
function markdownBody(raw, depth, { paragraphs = true, alerts = false } = {}) {
  if (!raw) return raw
  const crlf = raw.replaceAll('\r\n', '\n')
  const text = paragraphs ? crlf : unquotedText(crlf)
  const nests = paragraphs && depth < NESTING_DEPTH
  const blocks = nests ? listSegments(text) : [text]
  // Prose beside a list or a quote is wrapped, for a margin between them.
  const many = blocks.length > 1
  const flow = (run) => {
    const segments = codeBlockSegments(run)
    const parts = nests
      ? segments.flatMap((seg) => (typeof seg === 'string' ? quoteRuns(seg, alerts) : [seg]))
      : segments
    const wrap = many || parts.some((part) => part.quote)
    const prose = (seg) => (paragraphs ? proseTemplate(seg, { wrap }) : renderInline(seg))
    if (parts.length === 1 && typeof parts[0] === 'string') return prose(parts[0])
    return parts.map((part) => (typeof part === 'string' ? prose(part)
      : part.quote ? quoteTemplate(part, depth) : codeBlockTemplate(part)))
  }
  if (blocks.length === 1 && typeof blocks[0] === 'string') return flow(blocks[0])
  return blocks.map((b) => (typeof b === 'string' ? flow(b) : listTemplate(b, depth)))
}

// A run's quotes and the prose between them (format.js quoteSegments), the
// prose without the newlines around each quote, which `pre-wrap` would
// print beside its margins; blank lines alone between two quotes dropped.
function quoteRuns(run, alerts) {
  const segments = quoteSegments(run, { alerts })
  if (segments.length === 1) return segments
  return segments.flatMap((seg) => {
    if (typeof seg !== 'string') return [seg]
    let from = 0
    let to = seg.length
    while (from < to && seg[from] === '\n') from++
    while (to > from && seg[to - 1] === '\n') to--
    const prose = seg.slice(from, to)
    return prose.trim() ? [prose] : []
  })
}

// GitHub's five alerts, each by the title it draws and a glyph for it:
// the circled i, the bulb, the speech bubble, the triangle, the octagon.
const ALERT_GLYPH = (paths) => html`<svg class="md-alert-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
const ALERTS = {
  note: ['Note', ALERT_GLYPH(svg`<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v3.5M8 5v.01"/>`)],
  tip: ['Tip', ALERT_GLYPH(svg`<path d="M6 12.5h4M6.75 14.75h2.5M8 1.25a4.25 4.25 0 0 0-2.5 7.69c.3.22.5.57.5.94v.87h4v-.87c0-.37.2-.72.5-.94A4.25 4.25 0 0 0 8 1.25Z"/>`)],
  important: ['Important', ALERT_GLYPH(svg`<path d="M2.75 1.75h10.5a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1H8.5l-3 2.75v-2.75H2.75a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1Z"/><path d="M8 4.25v3M8 9.25v.01"/>`)],
  warning: ['Warning', ALERT_GLYPH(svg`<path d="M7.13 2.25a1 1 0 0 1 1.74 0l5.9 10.5a1 1 0 0 1-.87 1.5H2.1a1 1 0 0 1-.87-1.5Z"/><path d="M8 6v3.25M8 11.75v.01"/>`)],
  caution: ['Caution', ALERT_GLYPH(svg`<path d="M5.3 1.5h5.4l3.8 3.8v5.4l-3.8 3.8H5.3l-3.8-3.8V5.3Z"/><path d="M8 4.75v3.75M8 11.25v.01"/>`)],
}

// A `>` quote as a `<blockquote>`, a GitHub alert as GitHub draws one
// (md-quote.css), its body rendered by the same pass. One line, as
// codeBlockTemplate's is.
function quoteTemplate({ alert, body }, depth) {
  const content = markdownBody(body, depth + 1)
  if (!alert) return html`<blockquote class="md-quote">${content}</blockquote>`
  const [title, icon] = ALERTS[alert]
  return html`<div class="md-alert md-alert-${alert}"><div class="md-alert-title">${icon}${title}</div>${content}</div>`
}

// "Duplicates:" — the findings the links files the user holds say are this
// one, reported elsewhere (`duplicatesOf`), between the report's account
// and the reader's own comment and fix. Each a `#finding=…` link, as a
// comment ref is, led by one brand sticker per producer of the reports
// holding it (none where the index hasn't placed it yet), its tooltip the
// full id and each report and producer by name.
//
// The ticks subscribe the card's autorun to the links and finding indexes,
// plain module Maps filling in the background on every load.
const producerLabel = reportName => PRODUCER_LABELS[groupOf(reportName)] ?? groupOf(reportName)
function duplicatesTemplate(f, tabIds) {
  void state.linksTick
  void state.findingIndexTick
  const id = tabKey(f)
  // Only copies the row's own tabs don't already show.
  const ids = isLinkableFindingId(id) ? duplicatesOf(id).filter((other) => !tabIds.has(other)) : []
  if (ids.length === 0) return nothing
  return html`<div class="duplicates-block"><span class="duplicates-label">Duplicates:</span>${
    ids.map((other) => {
      const displayId = displayFindingId(other)
      const reports = reportsForFindingId(other)
      const preview = state.currentView === 'links' && state.currentLinks?.managedId ? reportRowsForFindingIds([other])[0] : null
      const where = reports.length === 0
        ? ''
        : ` — in ${reports.map((r) => `${displayName(r)} (${producerLabel(r)})`).join(', ')}`
      return html`<a
        class="duplicate-ref"
        href=${isManagedUiMode() ? findingLinkFor({ id: other }, { teamOnly: true }) : `#${encodeFindingRef({ id: other })}`}
        data-links-preview=${preview ? other : nothing} data-preview-report=${preview?.report ?? nothing}
        data-preview-row=${preview?.index ?? nothing} data-preview-managed-report=${preview?.managedReportId ?? nothing}
        data-tooltip=${`${displayId}${where}`}
      >${[...new Set(reports.map(groupOf))].map((g) => appMarkup(FILE_ICONS[g] ?? FILE_ICONS.default))}<span
        class="duplicate-ref-id"
      >${shortFindingId(other) ?? displayId}</span></a>`
    })
  }</div>`
}

// The revalidation stamp (confirmed / refuted / unknown) on the rail, with
// its caption, as severity and confidence are; none for `revalidation`,
// which names the pass rather than a verdict.
function revalidateStampTemplate(f) {
  const stamp = revalidateStamp(f)
  if (!stamp) return nothing
  return html`<span class=${`revalidate-stamp ${stamp}`}>${stamp}</span>
    <div class="value-label">Revalidation</div>`
}

// The revalidation pass's reasoning, under the confidence rationale, only
// where its layer shows (format.js revalidationShown). One line, as every
// `pre-wrap` block on this card is.
function revalidateTemplate(f) {
  const verdict = revalidationShown() ? stripExportMarker(f.revalidateVerdict, f) : ''
  if (!verdict) return nothing
  return html`<div class="revalidate-verdict">${renderHighlighted(flowText(verdict))}</div>`
}

// One labelled body section, a small-caps header over its text: each
// `**Label:**` paragraph of the description (format.js descriptionSections)
// and the finding's own fields; `cls` colours it. `collapsible` makes one
// with a body a closed `<details>`, for what a reader turns to after
// triage (print opens them, finding-card.css).
function sectionTemplate(label, body, cls = 'section', { collapsible = false } = {}) {
  const inner = body ? html`<div class="section-body">${renderHighlighted(flowText(body))}</div>` : nothing
  if (!collapsible || !body) {
    return html`<div class=${cls}>
      <div class="section-label">${label}</div>
      ${inner}
    </div>`
  }
  return html`<details class=${cls}>
    <summary class="section-label">${label}</summary>
    ${inner}
  </details>`
}

// In the focus view, an evidence row's reference as a link into the code
// panel, where the attached bundle carries its file (as the `</>` mark
// beside it), else plain text; the GitHub mark stays either way.
function evidencePanelRef(bundle, row, label) {
  const file = bundle?.integrity && row?.file ? findingSourcePath(bundle, row.file) : null
  if (!file) return html`<span class="evidence-ref">${label}</span>`
  // A span with `role="link"`, not a `<button>`: Chromium keeps a button
  // inline-block, so a wrapping path pushed the marks beside it onto the
  // next line. `tabindex` and events.js's Enter handler stand in for an
  // anchor's.
  return html`<span
    class="evidence-ref"
    role="link"
    tabindex="0"
    data-code-nav-integrity=${bundle.integrity}
    data-code-nav-file=${file}
    data-code-nav-line=${row?.line ?? ''}
  >${label}</span>`
}

// The `## Evidence` list, a closed `<details>` (print opens it): a row per
// cited site, its link (the report's own URL, or one rebuilt, a
// dependency's at the commit its bundle records) and the report's note,
// in an `<ol>` so a wrapped note stays indented. Each row the attached
// bundle carries gets a `</>`; in the focus view its reference opens the
// code panel, the row it shows marked.
function evidenceTemplate(f, context) {
  const rows = Array.isArray(f.evidence) ? f.evidence : []
  if (rows.length === 0) return nothing
  const repoFallback = findingRepoTarget(f)
  const bundle = attachedBundle(f)
  const toPanel = context === 'focus' && bundle !== null
  const shown = toPanel ? focusCodePosition(f) : null
  const shipped = (row) => bundleDependencyRepo(f, row)
  return html`<details class="evidence">
    <summary class="section-label">Evidence<span class="evidence-count">(${rows.length})</span></summary>
    <ol class="evidence-list">${rows.map((row, i) => {
      const label = locationLabel(row)
      const url = evidenceUrl(row, f, repoFallback, i, shipped)
      const note = evidenceNote(row)
      // Indexed, so two rows citing the same place stay two marks too.
      const preview = codePreview(f, `ev${i}`, bundle, row?.file, row?.line)
      const ghRef = githubRef(url)
      const current = toPanel && samePos(shown, {
        integrity: bundle.integrity,
        file: findingSourcePath(bundle, row?.file),
        range: lineRange(row?.line),
      })
      return html`<li class=${classMap({ current })}>
        ${toPanel
          ? evidencePanelRef(bundle, row, label)
          : url
            ? html`<a class="evidence-ref" href=${url} target="_blank" rel="noopener">${label}</a>`
            : html`<span class="evidence-ref">${label}</span>`}
        ${preview?.mark ?? nothing}
        ${ghRef}
        ${preview?.tip ?? nothing}
        ${note ? html`<div class="evidence-note">${renderHighlighted(flowText(note))}</div>` : nothing}
        ${preview?.body ?? nothing}
      </li>`
    })}</ol>
  </details>`
}

// A finding's `file:line`, linked where it has a source URL.
function rowLocationTemplate(f, url) {
  const text = locationLabel(f)
  if (!url) return text
  return html`<a href=${url} target="_blank" rel="noopener">${text}</a>`
}

// A `commit_hash` by its short SHA, the whole in its tooltip, linked where
// the repository is known.
function commitLinkTemplate(githubRepo, hash) {
  if (!hash) return nothing
  const short = hash.slice(0, 7)
  const url = commitUrl(githubRepo, hash)
  if (!url) return html`<span data-tooltip=${hash}>${short}</span>`
  return html`<a href=${url} target="_blank" rel="noopener" data-tooltip=${hash}>${short}</a>`
}

// The comment, fix-link and flag glyphs, outlined, filled by their
// `has-*` / `flagged` classes (finding-card.css, finding-row.css); the
// kanban card (render.js) and the toolbar filter use them too.
export const COMMENT_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <path class="bubble" d="M2.5 3h11a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-.5.5H8.4l-3 2.6V10.5H2.5a.5.5 0 0 1-.5-.5V3.5a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

export const FIX_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <path class="wrench" d="M10.4 2.6a3 3 0 0 0-3.6 4.5L2 12l2 2 4.9-4.8a3 3 0 0 0 4.5-3.6l-1.8 1.8-1.5-.4-.4-1.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

// The Link button's chain, sized as the strip's other icons.
const LINK_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
    <path d="M6.2 11.2H4.8a3.2 3.2 0 0 1 0-6.4h1.4"/>
    <path d="M9.8 4.8h1.4a3.2 3.2 0 0 1 0 6.4H9.8"/>
    <path d="M5.6 8h4.8"/>
  </g>
</svg>`

// `</>`, the source preview's toggle, a mark on the line it previews.
const CODE_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4.4 4.6 1.3 8l3.1 3.4"/>
    <path d="m11.6 4.6 3.1 3.4-3.1 3.4"/>
    <path d="M9.8 2.6 6.2 13.4"/>
  </g>
</svg>`

// The GitHub mark beside a location, saying where its link goes (the same
// `src/a.ts:42` may be in any of a card's repositories), the target in the
// shared tooltip (view/tooltip.js); none where the URL isn't a GitHub blob.
const GITHUB_ICON = appMarkup(GITHUB_ICON_SVG)
function githubRef(url) {
  const label = githubRefLabel(url)
  if (!label) return nothing
  return html`<a
    class="gh-ref-btn"
    href=${url}
    target="_blank"
    rel="noopener noreferrer"
    data-tooltip=${label}
    aria-label=${`Open ${label} on GitHub`}
  >${GITHUB_ICON}</a>`
}

// Source previews: with a bundle attached, the `</>` beside each link to
// code opens the lines around it in place, a mark per link whose path the
// bundle carries (bundleFilePath answers off the hash index, never a
// parse). Open ones are kept in `state.codePreviews`, keyed by the site on
// the card as well as the place: an evidence row citing the finding's own
// `file:line` is usual, and must stay a control of its own.
function codePreviewKey(f, site, path, range) {
  return `${tabKey(f)}\u0000${site}\u0000${path}\u0000${range ? `${range.start}-${range.end}` : ''}`
}

// The mark the pointer is on, and the card that drew it: its hover snippet
// alone is built, not one per mark of a long list. Not in `state`, which
// would make every card on the page depend on the pointer; the one or two
// cards involved are asked to update instead.
let hoveredPreview = { key: null, host: null }

function hoverPreview(key, target) {
  if (hoveredPreview.key === key) return
  const previous = hoveredPreview.host
  // The template renders only in `<finding-card>`'s shadow root.
  const host = key === null ? null : target?.getRootNode?.()?.host ?? null
  hoveredPreview = { key, host }
  previous?.requestUpdate?.()
  if (host !== previous) host?.requestUpdate?.()
}

// The lines themselves (format.js snippetWindow), numbered, every cited
// line marked, the window highlighted by its extension (code-highlight.js:
// tags span lines, so the whole file's HTML can't be cut). The caller reads
// `focusCodeTick` for the bundle; `codeBlockTick` here is prism's settle.
function codeSnippetTemplate(content, range, path) {
  void state.codeBlockTick
  const { text, lines, startLine } = snippetWindow(content, range)
  if (lines.length === 0) return nothing
  const dot = path.lastIndexOf('.')
  const coloured = highlightedCode(text, dot < 0 ? '' : path.slice(dot + 1))
  const lastNo = startLine + lines.length - 1
  return html`<div class="code-preview" style=${styleMap({ '--lineno-width': `${String(lastNo).length}ch` })}>
    <aside class="code-preview-gutter" aria-hidden="true">${lines.map((_, i) => {
      const ln = startLine + i
      const cited = Boolean(range) && ln >= range.start && ln <= range.end
      return html`<div class=${classMap({ 'code-preview-lineno': true, cited })}>${ln}</div>`
    })}</aside>
    <pre class="code-preview-source"><code>${coloured ? appMarkup(coloured) : text}</code></pre>
  </div>`
}

// A link's `</>` mark (`mark`), its hover snippet (`tip`) and the snippet
// it opens (`body`), apart for callers to place: the finding's own link is
// in a flex `.line-row` the snippet must land below. `site` names the link
// on the card; null where the bundle carries no file at `path`.
function codePreview(f, site, bundle, path, line) {
  // Before the guards: the index they answer off is a plain module Map,
  // empty as a stored report first paints, and this read is what subscribes
  // the card to its filling.
  void state.bundleHashTick
  if (!bundle || !path) return null
  const file = findingSourcePath(bundle, path)
  if (!file) return null
  // A span (`20-30`) shows whole (format.js lineRange).
  const range = lineRange(line)
  const key = codePreviewKey(f, site, path, range)
  const open = state.codePreviews.has(key)
  // Always: a hover starts a load too, whose settle must reach this card.
  void state.focusCodeTick
  const enter = (e) => { hoverPreview(key, e.currentTarget); bundleSource(bundle.integrity, file, { reportId: bundle.reportId }) }
  const leave = (e) => { if (hoveredPreview.key === key) hoverPreview(null, e.currentTarget) }
  const mark = html`<button
    type="button"
    class=${classMap({ 'code-preview-btn': true, open })}
    data-code-preview=${key}
    aria-expanded=${String(open)}
    aria-label=${open ? `Hide the source at ${path}` : `Show the source at ${path}`}
    @mouseenter=${enter}
    @mouseleave=${leave}
    @focus=${enter}
    @blur=${leave}
  >${CODE_ICON}</button>`
  if (open) {
    const source = bundleSource(bundle.integrity, file, { reportId: bundle.reportId })
    const body = !source || source.loading
      ? html`<div class="code-preview code-preview-pending">${source ? 'Loading source…' : 'Source unavailable'}</div>`
      : codeSnippetTemplate(source.content, range, file)
    return { mark, tip: nothing, body }
  }
  // The hover tooltip, for the mark pointed at alone, from what is already
  // loaded (`kick: false`): the pointer's `enter` asks for the rest.
  if (hoveredPreview.key !== key) return { mark, tip: nothing, body: nothing }
  const peek = bundleSource(bundle.integrity, file, { kick: false, reportId: bundle.reportId })
  const tip = peek && !peek.loading
    ? html`<div class="code-preview-tip" role="tooltip">${codeSnippetTemplate(peek.content, range, file)}</div>`
    : nothing
  return { mark, tip, body: nothing }
}

// The Claude hand-off's mark (the report sticker's) and the issue's ring,
// sized as the strip's other icons.
const CLAUDE_ICON = html`<svg viewBox="4 5 8 8" width="11" height="11" fill="currentColor" aria-hidden="true">
  <path d="${CLAUDE_MARK_PATH}"/>
</svg>`
const ISSUE_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <circle cx="8" cy="8" r="1.7" fill="currentColor"/>
</svg>`
export const FLAG_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <path class="flag-cloth" d="M5 1.5h6v13l-3-2.7-3 2.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
</svg>`

// The attention flag's toggle, for the active tab (events.js walks unset →
// true → false, `false` the tombstone that syncs a removal).
function flagButtonTemplate(f, isFocus = false) {
  const flagged = triageEntry(f)?.flagged === true
  const title = flagged ? 'Remove flag' : 'Flag this finding'
  return html`<button
    type="button"
    class=${classMap({ 'mark-flag': true, flagged })}
    data-flag-toggle=${tabKey(f)}
    ?disabled=${!canEditTriage(f)}
    aria-label=${title}
    aria-pressed=${String(flagged)}
  >${FLAG_ICON}${isFocus ? html`<span class="mark-btn-label">${flagged ? 'Flagged' : 'Flag'}</span>` : nothing}</button>`
}

// An issue's title: the finding's, else its file, capped for `?title=`.
function issueTitle(f) {
  const base = findingTitle(f) || f.file || 'Security finding'
  return base.length > 120 ? `${base.slice(0, 119)}…` : base
}

// What an issue draft (issue-draft.js) takes from the view, the same for
// both ways of opening one: the card's source and Evidence links, and
// whether the revalidation layer shows.
export function issueDraftOptions(f) {
  const repoFallback = findingRepoTarget(f)
  const shipped = (row) => bundleDependencyRepo(f, row)
  return { sourceUrl: findingUrl(f, repoFallback), evidence: evidenceMarkdown(f, { repoFallback, shipped }), showRevalidation: revalidationShown() }
}

// A workspace's chip naming the report a finding came from, opening it there.
function reportChipTemplate(finding) {
  if (!state.currentWorkspace) return nothing
  const reportName = finding._reportName
  if (!reportName) return nothing
  if (isManagedUiMode() && !finding._managedReportId) return nothing
  const logo = REPORT_LOGOS[groupOf(reportName)] ?? REPORT_LOGOS.default
  const label = html`${appMarkup(logo)}<span class="report-chip-label report-button-label">${displayName(reportName)}</span>`
  if (isManagedUiMode()) {
    const href = findingLinkFor(finding, { reportId: finding._managedReportId })
    if (href) return html`<a class="report-chip report-button comment-self-ref" href=${publicSharePath(href)}>${label}</a>`
  }
  return html`<button type="button" class="report-chip report-button"
    data-links-report=${reportName} data-links-finding=${tabKey(finding)}
    data-managed-report=${isManagedUiMode() ? finding._managedReportId : nothing}
  >${label}</button>`
}

// The action row: a workspace's report chip, comment / fix / flag, copy /
// link / issue / Claude (handlers in events.js, by the `[data-gid]` walk),
// the `<color-marker>` dots (a composed `mark-color` event) and the triage
// menu.
function actionButtonsTemplate(group, sortedTabs, groupSt, activeTab, context = null) {
  // Not on a table row, whose workspace row says the report already.
  const reportChip = context === 'table' ? nothing : reportChipTemplate(activeTab)
  const activeEntry = triageEntry(activeTab)
  // Comments open the managed discussion, which reading alone allows; the
  // other marks are edits.
  const disabled = !canTriageFinding(activeTab)
  const readOnly = !canEditTriage(activeTab)
  const activeColor = activeEntry?.color ?? null
  const activeComment = activeEntry?.comment ?? ''
  const activeFix = activeEntry?.fix ?? ''
  const commentTitle = isManagedUiMode() ? 'View comments' : activeComment ? `Edit comment: ${activeComment}` : 'Add comment'
  const fixTitle = activeFix ? `Edit fix link: ${activeFix}` : 'Add fix link (PR URL, etc.)'
  // Labelled in the focus view, unless the report chip shares the row.
  const showActionLabels = context === 'focus' && reportChip === nothing
  const label = text => showActionLabels ? html`<span class="mark-btn-label">${text}</span>` : nothing
  const commentLabel = isManagedUiMode() ? 'Comments' : activeComment ? 'Edit comment' : 'Comment'
  const fixLabel = activeFix ? 'Edit fix link' : 'Fix link'
  const commentBtn = html`<button type="button" ?disabled=${disabled} class=${classMap({ 'mark-comment': true, 'has-comment': activeComment })} data-tooltip=${activeComment && !isManagedUiMode() ? commentTitle : nothing} aria-label=${commentTitle}>${COMMENT_ICON}${label(commentLabel)}</button>`
  const fixBtn = html`<button type="button" ?disabled=${readOnly} class=${classMap({ 'mark-fix': true, 'has-fix': activeFix })} data-tooltip=${activeFix ? fixTitle : nothing} aria-label=${fixTitle}>${FIX_ICON}${label(fixLabel)}</button>`
  const flagBtn = flagButtonTemplate(activeTab, showActionLabels)
  const copyBtn = html`<button type="button" class="mark-copy" aria-label="Copy finding details to clipboard">${COPY_ICON}${label('Copy')}</button>`
  // None for a session-local id, which the next load hands out again.
  const linkBtn = findingLinkFor(activeTab)
    ? html`<button type="button" class="mark-link" aria-label="Copy a link to this finding">${LINK_ICON}${label('Link')}</button>`
    : nothing
  // An issue on GitHub, for a finding of a github.com repository: managed,
  // a button, so no modified click skips the check for an existing issue or
  // reservation, the dialog drafting the body; else a link to GitHub's
  // pre-filled form. Managed, the server's finding/report target names the
  // repository, not the local package index.
  const findingRepoId = isManagedUiMode()
    ? reportRepoGithub({ repo: { github: (ignoresOwnRepo(activeTab, activeTab._repoFallback) ? '' : activeTab.repo?.github) || activeTab._repoFallback } })
    : findingRepo(activeTab)
  const managedIssue = isManagedUiMode() && state.managedSession && !state.managedSession.publicShare && state.currentManagedTeam
  // None once the finding has its issue.
  const issueHref = managedIssueFor(activeTab) ? null : githubIssueUrl(findingRepoId, { title: issueTitle(activeTab),
    body: managedIssue ? '' : createIssueDraft(activeTab, { ...issueDraftOptions(activeTab), allSections: true }).body,
    labels: newIssueLabels(activeTab.isSecurity === true, state.githubNewIssueLabels) })
  const issueContent = html`${ISSUE_ICON}${label('Issue')}`
  const issueBtn = issueHref
    ? managedIssue
      ? html`<button type="button" class="mark-issue" data-issue-form=${issueHref} data-tooltip=${showActionLabels ? nothing : 'Create a GitHub issue for this finding'} aria-label="Create a GitHub issue for this finding">${issueContent}</button>`
      : html`<a class="mark-issue" href=${issueHref} target="_blank" rel="noopener" data-tooltip=${showActionLabels ? nothing : 'Create a GitHub issue for this finding'} aria-label="Create a GitHub issue for this finding">${issueContent}</a>`
    : nothing
  // Hands the copy button's block, as "Confirm and fix:", to claude://.
  const claudeBtn = html`<button type="button" class="mark-claude" data-tooltip=${showActionLabels ? nothing : 'Open in Claude Code (claude://) with a confirm-and-fix prompt'} aria-label="Open finding in Claude Code">${CLAUDE_ICON}${label('Claude')}</button>`
  const picker = html`<color-marker .selected=${activeColor} .disabled=${readOnly}></color-marker>`
  // Conflict groups scope the action to the active tab.
  const mixedLevels = triageTabs(group) !== group
  const menuTitle = group.linkedTabs
    ? 'change triage state for linked findings'
    : mixedLevels
    ? 'change triage state for App and own-source findings'
    : groupSt.hasConflict
    ? 'change triage state (colors mismatch — acts per-tab)'
    : (sortedTabs.length > 1 ? 'change triage state for the whole group' : 'change triage state')
  return html`<div class="finding-actions">${reportChip}<div class="finding-action-controls"><span class="mark-action-group">${commentBtn}${fixBtn}${flagBtn}</span><span class="mark-action-group">${copyBtn}${linkBtn}${issueBtn}${claudeBtn}</span>${picker}${triageMenuTemplate(group, menuTitle, context, groupSt, activeTab)}</div></div>`
}

// A triage popover placed under its button, right edges aligned, above it
// where the viewport's bottom would clip. Bound on the popover itself, as
// `beforetoggle` doesn't bubble; its button found in whichever shadow root
// drew it.
function positionTriagePopover(e) {
  if (e.newState !== 'open') return
  const popover = e.currentTarget
  const root = popover.getRootNode()
  const btn = root.querySelector?.(`[popovertarget="${popover.id}"]`)
  if (!btn) return
  const btnRect = btn.getBoundingClientRect()
  // Still display:none before the open paint: a typical menu's size.
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

const TRIAGE_STATES = { inprogress: 'In progress', fixed: 'Fixed', invalid: 'Invalid', deleted: 'Deleted', ignored: 'Ignored' }
const TRIAGE_ACTIONS = { inprogress: 'In progress', fixed: 'Fixed', invalid: 'Invalid', deleted: 'Delete', ignored: 'Ignore' }

// The triage menu: a chevron toggling a native `popover="auto"`, in the top
// layer so no `overflow: hidden` row clips it, its `data-gid` naming the
// group for the action handler once it has left the row's DOM. In a triage
// view the button names the bucket shown, and the dropdown leads with
// Restore in place of that bucket; the focus view's chips mark the current
// one instead, a click toggling it off. `current` is what `scopedTriage`
// says, as triageActionPlan decides set-vs-clear by.
function triageMenuTemplate(group, title, context, groupSt, activeTab) {
  const gid = groupKey(group)
  const disabled = !canEditTriage(activeTab) || triageScope(group, groupSt).length === 0
  const current = disabled ? null : scopedTriage(group, groupSt, activeTab)
  const shown = state.shownTriage
  const listed = Object.entries(TRIAGE_ACTIONS)
  const actions = shown && context !== 'focus' ? [['restore', 'Restore'], ...listed.filter(([key]) => key !== shown)] : listed
  // A gid's `.` / `:` escaped, for a selectable id.
  const popId = `triage-menu-${gid.replaceAll(/[^A-Za-z0-9_-]/gu, '_')}`
  return html`<div class="triage-menu-wrap">
    <button type="button" class=${shown ? `mark-triage-menu with-label triage-state-${shown}` : 'mark-triage-menu'} popovertarget=${popId} popovertargetaction="toggle" aria-label=${title} ?disabled=${disabled}>
      ${shown && TRIAGE_STATES[shown] ? html`<span class="mark-triage-label">${TRIAGE_STATES[shown]}</span>` : nothing}
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div popover="auto" id=${popId} class="triage-menu" data-gid=${gid} role="menu" @beforetoggle=${positionTriagePopover}>
      ${actions.map(([key, label]) => html`<button
        type="button"
        class=${classMap({ 'triage-menu-item': true, [`triage-menu-${key}`]: true, active: current === key })}
        data-triage-action=${key}
        ?disabled=${disabled}
        role="menuitem"
      >${label}</button>`)}
    </div>
  </div>`
}

// A tab's comment, fix and flag, as inert marks at its end, where it has
// them.
function tabMarksTemplate(entry, finding) {
  const marks = [[entry?.comment, 'has-comment', 'Has a comment', COMMENT_ICON], [entry?.fix || automaticFixFor(finding), 'has-fix', 'Has a fix link', FIX_ICON],
    [entry?.flagged === true, 'flagged', 'Flagged', FLAG_ICON]].filter(([shown]) => shown)
  if (marks.length === 0) return nothing
  return html`<span class="tab-marks">${marks.map(([, cls, label, glyph]) => html`<span class=${cls} role="img" aria-label=${label}>${glyph}</span>`)}</span>`
}

function tabsTemplate(tabs, activeKey, groupSt) {
  const { app, source } = groupTabsByLevel(tabs)
  const renderTab = (f) => tabTemplate(f, tabKey(f) === activeKey, groupSt)
  return html`<div class="tabs">
    ${app.map(renderTab)}
    ${app.length > 0 && source.length > 0 ? html`<span class="tab-level-separator" aria-hidden="true">•</span>` : nothing}
    ${source.map(renderTab)}
  </div>`
}

// One tab: its severity, analyzer mark (or confidence) and marks, its color
// class, and its own triage state's class only where the group can't say
// it (`commonTriage` null: the tabs disagree, or a color conflict hides
// the rollup). Ignore goes by `allIgnored` instead: syncGroupTriage never
// levels a per-report ignore, so the tab carrying one is worth pointing at
// till every tab does.
function tabTemplate(f, isActive, groupSt) {
  const key = tabKey(f)
  const entry = triageEntry(f)
  const color = entry?.color
  const triage = tabTriage(f, entry)
  const classes = ['tab', `tab-severity-${displayedSeverity(f, state.severityMode)}`]
  if (isActive) classes.push('active')
  if (color) classes.push(`tab-mark-${color}`)
  if (triage === 'ignored' && !groupSt.allIgnored) classes.push('tab-ignored')
  else if (triage && triage !== 'ignored' && groupSt.commonTriage === null) classes.push(`tab-${triage}`)
  const analyzer = findingBrand(f)
  const logo = analyzer ? REPORT_LOGOS[analyzer] : null
  const hasConfidence = !logo && f.confidence != null
  if (logo) classes.push('tab-with-analyzer')
  else if (hasConfidence) classes.push('tab-with-confidence')
  const detail = logo
    ? html`<span class="tab-analyzer" role="img" aria-label=${PRODUCER_LABELS[analyzer]}>${appMarkup(logo)}</span>`
    : hasConfidence ? html`<span class="tab-conf" aria-label=${`Confidence ${f.confidence} out of 10`}>${f.confidence}<span class="tab-conf-max">/10</span></span>` : nothing
  return html`<button type="button" class=${classes.join(' ')} data-tid=${key} aria-pressed=${isActive} aria-description=${color ? `${color} color label` : nothing}><span class="tab-label"><span class="tab-severity">${severityBadge(f, { variant: 'tab' })}</span><span class="tab-indicators">${tabMarksTemplate(entry, f)}</span></span>${detail}</button>`
}

// The rail's confidence: a ring in the severity's color in the table's
// details and the focus view, else a compact "<n>/10".
function confTemplate(f) {
  if (state.viewMode === 'table' || state.viewMode === 'focus') {
    // A radius of 15.9155 makes the circumference 100: the arc is percents.
    const arc = f.confidence * 10
    return html`<div class=${`conf-ring ${displayedSeverity(f, state.severityMode)}`}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle class="conf-ring-track" cx="18" cy="18" r="15.9155"/>
        <circle class="conf-ring-arc" cx="18" cy="18" r="15.9155" style=${styleMap({ 'stroke-dasharray': `${arc} 100` })} />
      </svg>
      <span>${f.confidence}<small>/10</small></span>
    </div>
    <div class="value-label">Confidence</div>`
  }
  return html`<div class="conf-score"><strong>${f.confidence}</strong>/10</div>
    <div class="value-label">Confidence</div>`
}

// An npm package name, for a link to the right page (Lit escapes the href).
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu

// The package the analyzer stamped, linking to npmjs.com (the version
// encoded: a build's `+`); none for a malformed one or the placeholder
// (`solidity-bundle@0.0.0`), which is no registry entry.
function npmChipTemplate(npm) {
  if (isPlaceholderNpmPackage(npm)) return nothing
  const name = npm?.name
  if (typeof name !== 'string' || !NPM_NAME_RE.test(name)) return nothing
  const version = npm?.version
  const hasVersion = typeof version === 'string' && version.length > 0
  return html`<span class="line-num"><a
    class="npm-link"
    href=${`https://www.npmjs.com/package/${name}${hasVersion ? `/v/${encodeURIComponent(version)}` : ''}`}
    target="_blank"
    rel="noopener noreferrer"
  >npm: ${hasVersion ? `${name}@${version}` : name}</a></span>`
}

// One tab's body: the rail, and the finding beside it. Only the active one
// shows on screen, print stacks them all, each "N of M" (`idx`, `total`).
// `tabIds`, the card's tabs, are left out of its Duplicates.
function tabBodyTemplate(f, isActive, idx, total, context, tabIds) {
  const key = tabKey(f)
  const entry = triageEntry(f)
  const comment = entry?.comment ?? ''
  const fix = entry?.fix ?? ''
  const automaticFix = automaticFixFor(f), issue = managedIssueFor(f)
  // `file:line` (its export after a comma), linked where the repository is
  // known; the list views hide the `.line-row`, their headers saying it.
  const url = findingUrl(f, findingRepoTarget(f))
  const locLink = rowLocationTemplate(f, url)
  const exportLabel = findingDisplayName(f)
  const bundle = attachedBundle(f)
  const linePreview = codePreview(f, 'loc', bundle, f.file, f.line)
  // The marks inside `.line-num`: `.line-row` is a `space-between` flex
  // line, which would spread another item to its middle. The tooltip sits
  // beside it, positioned against `.line-row`.
  const ghRef = githubRef(url)
  const lineRowMain = html`<span class="line-num">${
    exportLabel ? html`${locLink}, ${exportLabel}` : locLink
  }${linePreview?.mark ?? nothing}${ghRef}</span>`
  const meta = formatRunMeta(f)
  // The file the analyzer was reading, where it isn't the finding's own.
  const foundIn = String(f.discoveredIn ?? '').trim()
  const discoveredIn = foundIn === String(f.file ?? '').trim() ? '' : foundIn
  // The package the analyzer stamped, in the focus view, which has room.
  const npmChip = context === 'focus' ? npmChipTemplate(f.package?.npm) : nothing
  // Code: the source in the bundle viewer, managed by the report's
  // sources, else the first bundle the analyzer ran against (its
  // `_bundleHashes`) holding the file's `fileHash`; none in the focus
  // view, whose panel shows it already.
  let codeButton = nothing
  if (context !== 'focus' && isManagedUiMode() && linePreview) {
    codeButton = html`<button type="button" class="finding-code-btn"
      data-finding-code-report=${bundle.reportId}
      data-finding-code-file=${f.file}
      data-finding-code-line=${f.line ?? ''}
      aria-label=${`Open full source for ${f.file}`}>Code</button>`
  } else if (context !== 'focus' && !isManagedUiMode() && f.fileHash && Array.isArray(f._bundleHashes) && f._bundleHashes.length > 0) {
    // The index is a plain module Map: this read subscribes the card to it.
    void state.bundleHashTick
    const allowed = new Set(f._bundleHashes)
    const match = bundlesForFileHash(f.fileHash).find(({ integrity }) => allowed.has(integrity))
    if (match) {
      codeButton = html`<button
        type="button"
        class="finding-code-btn"
        data-finding-code-bundle=${match.integrity}
        data-finding-code-file=${match.file}
        data-finding-code-line=${f.line ?? ''}
        data-tooltip=${`Open ${match.file} in bundle source viewer`}
      >Code</button>`
    }
  }
  const { title: descTitle, body: descBody } = splitDescription(f)
  // The prose leading the body, then the evidence, then the labelled
  // sections in document order, as a claude-security report writes them;
  // then the finding's own fields, in the same blocks, so a field and a
  // `**Impact:**` paragraph read alike. In the grid's second column,
  // `.finding-body` lets print move the evidence, open on paper, last
  // (finding-card.css).
  const sections = descriptionSections(descBody)
  const firstLabel = sections.findIndex((s) => s.label !== null)
  const lead = firstLabel === -1 ? sections : sections.slice(0, firstLabel)
  const labelled = firstLabel === -1 ? [] : sections.slice(firstLabel)
  return html`<div class=${classMap({ 'tab-body': true, active: isActive })} data-tid=${key}>
    ${total > 1 ? html`<div class="print-case-label">${idx + 1} of ${total}</div>` : nothing}
    <div class="finding-left">
      ${entry?.color || entry?.flagged === true ? html`<div class=${entry?.color ? `finding-top-marks color-${entry.color}` : 'finding-top-marks'}>
        ${entry?.color ? html`<span
          class="finding-color-mark"
          role="img"
          aria-label=${`Color label: ${entry.color}`}
        ></span>` : nothing}
        ${entry?.flagged === true ? html`<span
          class="finding-bookmark-mark"
          role="img"
          aria-label="Bookmarked"
        ></span>` : nothing}
      </div>` : nothing}
      ${severityBadge(f, { variant: 'full' })}
      <div class="value-label">Severity</div>
      ${f.confidence === undefined ? nothing : confTemplate(f)}
      ${revalidateStampTemplate(f)}
      ${codeButton}
    </div>
    <div class="finding-body">
      <div class="line-row">
        ${lineRowMain}
        ${linePreview?.tip ?? nothing}
        ${npmChip}
        ${discoveredIn ? html`<span class="line-num discovered-in">(found analyzing ${discoveredIn})</span>` : nothing}
        ${meta ? html`<span class="run-meta">${meta}</span>` : nothing}
      </div>
      ${linePreview?.body ?? nothing}
      ${descTitle ? html`<div class="desc-title">${renderInline(descTitle)}</div>` : nothing}
      ${lead.map((s) => html`<div class="desc">${renderHighlighted(flowText(s.body))}</div>`)}
      ${evidenceTemplate(f, context)}
      ${labelled.map((s) => (s.label === null
        ? html`<div class="desc">${renderHighlighted(flowText(s.body))}</div>`
        : sectionTemplate(s.label, s.body)))}
      ${f.impact ? sectionTemplate('Impact', stripExportMarker(f.impact, f)) : nothing}
      ${f.reproduction ? sectionTemplate('Reproduction', stripExportMarker(f.reproduction, f), 'section', { collapsible: true }) : nothing}
      ${f.recommendation ? sectionTemplate('Recommendation', stripExportMarker(f.recommendation, f), 'recommendation', { collapsible: true }) : nothing}
      ${f.confidenceReason ? html`<div class="conf-reason">${renderHighlighted(stripExportMarker(f.confidenceReason, f))}</div>` : nothing}
      ${revalidateTemplate(f)}
      ${f.revalidateRecommendation && revalidationShown()
        ? sectionTemplate('Revalidation recommendation', stripExportMarker(f.revalidateRecommendation, f), 'recommendation', { collapsible: true })
        : nothing}
      ${hasSeverityCorrection(f) && f.correctedSeverityReason ? html`<div class="severity-reason"><span class="severity-reason-label">Severity correction:</span> ${renderHighlighted(f.correctedSeverityReason)}</div>` : nothing}
      ${duplicatesTemplate(f, tabIds)}
      ${isManagedUiMode() ? managedCommentsFor(f).map(item => html`<div class="comment-block">
        ${managedCommentTemplate(item, renderCommentText(item.body))}
      </div>`) : comment ? html`<div class="comment-block"><span class="comment-label">Comment:</span> ${renderCommentText(comment)}</div>` : nothing}
      ${issue ? html`<div class="fix-block"><span class="fix-label">Issue:</span> <managed-fix-link .url=${issue.url}></managed-fix-link></div>` : nothing}
      ${issue?.duplicateOf ? html`<div class="fix-block"><span class="fix-label">Duplicate of:</span> <managed-fix-link .url=${issue.duplicateOf}></managed-fix-link></div>` : nothing}
      ${fix
        ? html`<div class="fix-block"><span class="fix-label">Fix:</span> ${isHttpUrl(fix)
          ? html`<managed-fix-link .url=${fix}></managed-fix-link>`
          : fix}</div>`
        : nothing}
      ${automaticFix && automaticFix !== fix ? html`<div class="fix-block"><span class="fix-label">Fix from issue:</span> <managed-fix-link .url=${automaticFix}></managed-fix-link></div>` : nothing}
    </div>
  </div>`
}

// A `<finding-card>` host's classes: `finding`, for `.flat-group .finding`,
// and `multi-case`, print's "Multiple reports" banner (finding-card.css).
export function findingCardClasses(g) {
  const classes = ['finding', ...tableRowClasses(g)]
  if (sortTabs(g).length > 1) classes.push('multi-case')
  return classes
}

// A card's inside: every tab body, and the marks row (commit, tabs,
// actions). A workspace lifts "introduced in" above it, clear of the
// report chip, which would wrap the hash.
export function findingCardInnerTemplate(g, opts = {}) {
  const { context = null } = opts
  const groupSt = groupState(g)
  const sortedTabs = sortTabs(g)
  const tabIds = new Set(sortedTabs.map(tabKey))
  const active = activeTabFor(g)
  const activeKey = tabKey(active)
  const commitRef = active.commitHash
    ? html`<div class="commit-ref">introduced in ${commitLinkTemplate(active.repo?.github, active.commitHash)}</div>`
    : nothing
  const liftCommit = state.currentWorkspace && commitRef !== nothing
  return html`
    ${sortedTabs.map((f, i) => tabBodyTemplate(f, tabKey(f) === activeKey, i, sortedTabs.length, context, tabIds))}
    ${liftCommit ? html`<div class="marks-commit-row">${commitRef}</div>` : nothing}
    <div class="marks">
      <div class="marks-left">
        ${liftCommit ? nothing : commitRef}
        ${sortedTabs.length > 1 ? tabsTemplate(sortedTabs, activeKey, groupSt) : nothing}
      </div>
      ${actionButtonsTemplate(g, sortedTabs, groupSt, active, context)}
    </div>
  `
}

// Every class tableRowClasses can give a host, for the hosts to toggle off
// one that no longer applies.
export const ROW_HOST_CLASSES = ['is-critical', 'mark-red', 'mark-blue', 'mark-green', 'mark-gray', 'has-conflict',
  'triage-inprogress', 'triage-fixed', 'triage-invalid', 'triage-deleted', 'triage-ignored']

// A row host's classes, but `selected`, which its `selected` property owns.
export function tableRowClasses(g) {
  const groupSt = groupState(g)
  const isCritical = g.some((f) => f.critical || displayedSeverity(f, state.severityMode) === 'critical')
  const classes = []
  if (isCritical) classes.push('is-critical')
  if (groupSt.hasConflict) classes.push('has-conflict')
  else if (groupSt.commonColor) classes.push(`mark-${groupSt.commonColor}`)
  if (state.shownTriage) classes.push(`triage-${state.shownTriage}`)
  return classes
}

// A table row's inside (finding-row.css lays it out): the badge and
// confidence, then the title and type, `file:line` and the actions, and
// the tabs of a multi-tab group.
export function tableRowInnerTemplate(g) {
  const groupSt = groupState(g)
  const sortedTabs = sortTabs(g)
  const f = activeTabFor(g)
  const activeKey = tabKey(f)
  const title = findingTitle(f)
  const typeLabel = formatRunMeta(f)
  const exportLabel = findingDisplayName(f)
  const exportPart = exportLabel ? `, ${exportLabel}` : ''
  const url = findingUrl(f, findingRepoTarget(f))

  return html`
    <div class="row-score">
      ${severityBadge(f, { variant: 'compact' })}
      ${f.confidence === undefined ? nothing : html`<span class="row-conf"><strong>${f.confidence}</strong>/10</span>`}
    </div>
    <div class="row-body">
      <div class="title-row">
        <span class="title">${title}</span>
        ${typeLabel ? html`<span class="row-type">${typeLabel}</span>` : nothing}
      </div>
      <div class="meta-row">
        <span class="row-loc">${rowLocationTemplate(f, url)}${exportPart}</span>
        ${githubRef(url)}
        <div class="marks">
          ${actionButtonsTemplate(g, sortedTabs, groupSt, f, 'table')}
        </div>
      </div>
      ${sortedTabs.length > 1 ? html`<div class="tabs-row">${tabsTemplate(sortedTabs, activeKey, groupSt)}</div>` : nothing}
    </div>
  `
}
