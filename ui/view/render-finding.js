import { html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { styleMap } from 'lit/directives/style-map.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { bundleFilePath, bundlesForFileHash, isLinkableFindingId, isPlaceholderNpmPackage, state } from '#client/index.js'
import { SEVERITY_ORDER, codeBlockSegments, commitUrl, correctedVariants, descriptionSections, displayedSeverity, effectiveSeverity, evidenceMarkdown, evidenceNote, evidenceUrl, findingDisplayName, findingTitle, findingUrl, flowText, formatRunMeta, githubIssueUrl, githubRefLabel, hasSeverityCorrection, isHttpUrl, lineRange, listSegments, locationLabel, markdownLinkToken, parseCommentRefs, revalidateStamp, revalidationShown, snippetWindow, splitDescription, stripExportMarker } from './format.js'
import { activeTabFor, findingRepo, findingRepoFallback, groupKey, groupState, isIgnored, scopedTriage, sortTabs, tabKey } from './group.js'
import { highlightedCode } from './code-highlight.js'
import { attachedBundle, bundleSource, focusCodePosition } from './focus-code.js'
import { samePos } from './focus-code-history.js'
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

// ── Severity badge (corrected + original) ────────────────────────────
// Single source for the finding severity chip across the tab strip, the
// finding-left column, and the table-row score column. Reads the global
// `state.severityMode` lens through format.js's `displayedSeverity`, so
// the toolbar switch flips every site at once.
//
// When the finding carries a severity correction (and we're showing
// corrected — the default), the primary chip is the corrected tier and a
// muted, struck `was <original>` companion + a ▲/▼ direction glyph render
// alongside it; in 'original' mode the primary is the original tier and an
// outlined companion shows the corrected target. `correctedVariants` adds
// a "varies" chip when a deduped finding's correction differs across the
// reports it appeared in (workspace view). The ▲/▼ glyph + strikethrough
// are shape cues so the corrected/original distinction is never conveyed
// by color alone; the full detail rides the `title` + `aria-label`.
//   variant 'full'    — finding-left / focus (companion stacks below)
//   variant 'compact' — table row (companion stacks below; tighter)
//   variant 'tab'     — tab strip (primary + a small ▲/▼ marker only)
export function severityBadge(f, { variant = 'full' } = {}) {
  const mode = state.severityMode
  const shown = displayedSeverity(f, mode)
  const primary = html`<span class=${`badge ${shown}`}>${badgeLabel(shown)}</span>`
  const hasCorr = hasSeverityCorrection(f)
  // Cross-report divergence is a per-survivor (group-level) concept — not
  // meaningful on the tiny per-tab badge, so skip it there.
  const variants = variant === 'tab' ? null : correctedVariants(f)
  if (!hasCorr && !variants) return primary

  const variesTip = variants
    ? `Corrected severity varies across reports — ${Object.entries(variants).map(([r, v]) => `${r || '(this report)'}: ${badgeLabel(v.severity)}`).join('; ')}`
    : null
  const variesChip = variants
    ? html`<span class="badge-varies" title=${variesTip} aria-label=${variesTip}>varies</span>`
    : nothing

  if (!hasCorr) {
    // Divergence only — this report's survivor carries no own-correction
    // but a deduped sibling did. Show the plain primary + the varies hint.
    return html`<span class=${`badge-pair badge-pair-${variant}`}>${primary}${variesChip}</span>`
  }

  const original = f.severity
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
    return html`<span class="badge-pair badge-pair-tab" title=${tip} aria-label=${aria}>${primary}<span class=${`badge-corr-mark ${dirWord}`} aria-hidden="true">${arrow}</span></span>`
  }

  // The companion: the value NOT currently primary. In corrected mode
  // that's the (struck) original; in original mode it's the corrected
  // target (outlined, not struck — it isn't superseded in this view).
  const other = showingCorrected ? original : corrected
  return html`<span class=${`badge-pair badge-pair-${variant}`} title=${tip} aria-label=${aria}>${primary}<span class="badge-orig-wrap"><span class=${`badge-arrow ${dirWord}`} aria-hidden="true">${arrow}</span>${showingCorrected ? html`<span class="badge-pre" aria-hidden="true">was</span>` : nothing}<span class=${`badge-orig ${other}${showingCorrected ? ' struck' : ''}`}>${badgeLabel(other)}</span></span>${variesChip}</span>`
}

// Render ONE run of prose with inline highlights for `[markdown](links)`,
// `"quoted"` strings, `` `code` `` spans, and `**bold**` emphasis. The
// quote / code pair match the prototype's `.summary q` / `.title em`
// styling (`design/prototypes/DeepView.0.html`). A quote keeps its
// marks — they're punctuation, and the sentence reads as the report
// wrote it — but a code span DROPS its backticks: those are markdown
// syntax for the chip the CSS already draws, so printing them inside
// it says the same thing twice. (The chip carries its own padding
// where the backticks used to sit — see `.inline-code`.) Bold spans
// likewise render as real `<strong>` emphasis with the asterisks
// dropped, so parser-emitted labels (parse-piolium's `**Impact:**` /
// `**Root Cause:**`) and source-report emphasis read as emphasis
// rather than literal markers. Unpaired asterisks stay literal.
//
// A `[label](url)` pair becomes a real link, opening in a new
// tab like every other outbound link here: the claude-security
// `## Evidence` list cites each site that way and parse-md.js carries
// that whole section into the description, so these anchors are the
// only path to the files it names beyond the first. Each href is the
// report's own, so a row points at ITS file rather than at the
// finding's; a target `markdownLinkToken` rejects (non-http,
// malformed) stays plain text. Returns the raw string when nothing
// matches so we don't churn out single-child arrays for the common
// case of plain text.
//
// The link alternative leads the pattern so a label carrying quotes or
// backticks is consumed as part of the link rather than chipped up
// inside it.
//
// Fenced code never reaches here — renderHighlighted splits the blocks
// out first — so a snippet's quotes and backticks stay the code they
// are instead of being chipped up as markup.
const INLINE_HL_RE = /\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*|"[^"\n]+"|`[^`\n]+`/gu
function renderInline(text) {
  INLINE_HL_RE.lastIndex = 0
  const parts = []
  let lastIdx = 0
  let m
  while ((m = INLINE_HL_RE.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index))
    const c0 = m[0].codePointAt(0)
    if (c0 === 0x5B /* [ */) {
      const link = markdownLinkToken(m[0])
      parts.push(link
        ? html`<a href=${link.url} target="_blank" rel="noopener noreferrer" title=${link.url}>${link.label}</a>`
        : m[0])
    } else if (c0 === 0x2A /* * */) {
      parts.push(html`<strong>${m[0].slice(2, -2)}</strong>`)
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

// One fenced code block as a real `<pre>`. Everything about a snippet
// that the prose treatment gets wrong is fixed here: the block keeps
// its own line breaks and indentation, its long lines SCROLL instead
// of folding (a wrapped line changes what the code says), and the
// inline pass never sees it. The fence's language tag (```ts) rides in
// as `data-lang` plus the small header above the code, so the block
// says what it is — the same thing the tag is there to tell a reader.
//
// The tag also colours the block, for the languages
// prism-highlight.js's allowlist names. Prism can only answer async
// (its first call downloads the bundle), so the block paints plain on
// the first pass and repaints coloured when the highlight settles:
// `highlightedCode` returns null until then, and the `codeBlockTick`
// read below is what subscribes this card's autorun to that settle.
// Prism escapes the source, so its HTML goes in via `unsafeHTML`;
// everything else — an unlisted language, an empty block, the first
// pass — renders `code` as the text it is.
//
// The whole template is one line on purpose: `.desc` / `.section-body`
// are `white-space: pre-wrap`, and in dev builds (which skip the
// template minifier) an indented template's own newlines would print
// as blank lines inside the block's chrome.
function codeBlockTemplate({ lang, code }) {
  void state.codeBlockTick
  const coloured = highlightedCode(code, lang)
  return html`<div class="code-block" data-lang=${lang || nothing}>${lang ? html`<div class="code-block-lang">${lang}</div>` : nothing}<pre><code>${coloured ? unsafeHTML(coloured) : code}</code></pre></div>`
}

// One run of prose, split at its blank lines into real paragraphs.
//
// The blank line a report writes between paragraphs used to render as
// a literal empty line: the prose blocks are `white-space: pre-wrap`,
// so the break came through as a full line of space — at these
// line-heights that reads as a gap between SECTIONS, not between
// paragraphs. And it can't be styled down, because an empty line is a
// line box rather than an element: no selector reaches it. Real
// elements can be spaced, so paragraphs become elements and the gap
// becomes a margin (`.para`, half the line it replaces).
//
// A single-paragraph run — the common case — is returned as the bare
// inline result, no wrapper. Runs of two or more blank lines collapse
// to the one paragraph gap: the measure is the measure, however many
// blank lines the report happened to leave in. Single newlines are
// untouched, so the line breaks `flowText` deliberately kept (an
// indented snippet, a table) still render through the pre-wrap.
//
// `wrap` keeps even a single paragraph in its element, for a body that
// draws as several sibling blocks. A bare run is a TEXT NODE, which no
// selector reaches: the gap between a lead-in line and the list under
// it has to be a margin on something, and the something is this.
function proseTemplate(run, { wrap = false } = {}) {
  const paras = run.split(/\n{2,}/u).filter((p) => p.trim())
  if (paras.length < 2) {
    return wrap ? html`<div class="para">${renderInline(run)}</div>` : renderInline(run)
  }
  return paras.map((p) => html`<div class="para">${renderInline(p)}</div>`)
}

// One markdown list as a real `<ol>` / `<ul>` (format.js listSegments
// cut it out). Reproduction steps and affected-file rundowns used to
// render as their own source text — the marker sitting in the prose,
// every item flat against the left margin, a wrapped step running on
// as if it were the next one. A list element gets the reader the
// markers, the hanging indent, and the browser's own numbering.
//
// Each item's content is rendered by the pass that rendered the body
// it came out of, which is what puts a nested list, a paragraph, or a
// fenced snippet INSIDE its item. The recursion terminates because an
// item is always shorter than the list it came from (its marker and
// indentation are gone).
//
// `start` only when the list doesn't begin at 1: markdown numbers from
// the first marker, so a rundown continuing at `10.` keeps its place.
function listTemplate({ ordered, start, items }) {
  const entries = items.map((item) => html`<li>${renderHighlighted(item)}</li>`)
  return ordered
    ? html`<ol class="md-list" start=${start > 1 ? start : nothing}>${entries}</ol>`
    : html`<ul class="md-list">${entries}</ul>`
}

// Render a description body: lists as lists, fenced code blocks as
// blocks, everything between them as prose (see renderInline above for
// the inline pass).
//
// Exported for the bundle views (render-bundle.js), whose finding
// descriptions — source-viewer side panel, Issues tab rows, code-rail
// issue results — get the same treatment. Those render in light DOM,
// so report.css carries a copy of the .inline-* / .code-block /
// .md-list rules that live in finding-card.css for this card's shadow
// root (`<strong>` needs no rule — the UA styles it in both trees;
// anchors take their accent color from theme.css in light DOM and from
// finding-card.css in the shadow root).
//
// A body with no list and no fence in it takes the inline path
// directly, so the common case costs two scans and nothing else.
//
// `paragraphs: false` renders a run as ONE flow, blank lines and all,
// for the compact surfaces that want a finding's prose as a single
// blob rather than a stack of paragraphs (see proseTemplate). Lists
// stay out of that mode for the same reason paragraphs do: those
// surfaces are a line or two of summary in a row or a side panel, and
// a block element opening a list there would break the line they get.
export function renderHighlighted(text, { paragraphs = true } = {}) {
  if (!text) return text
  const blocks = paragraphs ? listSegments(text) : [text]
  // More than one block means the prose runs have LIST SIBLINGS, and
  // the gap between them is a margin — which needs an element to sit
  // on (see proseTemplate's `wrap`).
  const many = blocks.length > 1
  const prose = (run) => (paragraphs ? proseTemplate(run, { wrap: many }) : renderInline(run))
  const flow = (run) => {
    const segments = codeBlockSegments(run)
    if (segments.length === 1 && typeof segments[0] === 'string') return prose(segments[0])
    return segments.map((seg) => (typeof seg === 'string' ? prose(seg) : codeBlockTemplate(seg)))
  }
  if (blocks.length === 1 && typeof blocks[0] === 'string') return flow(blocks[0])
  return blocks.map((b) => (typeof b === 'string' ? flow(b) : listTemplate(b)))
}

// Render a triage comment, linkifying any GitHub issue / PR / commit /
// security-advisory URL the user pasted, plus any per-finding deep link
// into this instance ("duplicate of https://…/#finding=…").
// parseCommentRefs (format.js) does the strict validation + tokenisation;
// here we only map its segments to templates — plain `string` runs pass
// through untouched (an all-prose comment comes back as a single string),
// and each validated token becomes a compact `<a>`.
//
// The two token kinds render differently on purpose. An external ref
// (`owner/repo#123`, `owner/repo@sha`, `GHSA-xxxx-xxxx-xxxx`) opens in a
// new tab with the full URL in `title`. A self-link carries a
// fragment-only href and must navigate IN PLACE: `target="_blank"` would
// boot a second copy of the app just to show a finding the reader is
// already three inches away from. Its `title` names the action rather
// than the href, which is an opaque id the reader can't act on.
function renderCommentText(text) {
  return parseCommentRefs(text).map((seg) => {
    if (typeof seg === 'string') return seg
    if (seg.self) {
      return html`<a class="comment-self-ref" href=${seg.url} title="Show this finding">${seg.label}</a>`
    }
    return html`<a href=${seg.url} target="_blank" rel="noopener noreferrer" title=${seg.url}>${seg.label}</a>`
  })
}

// The verdict stamp — `revalidate` itself (confirmed / refuted /
// unknown), the one word that says which way the pass went.
//
// It rides the `.finding-left` rail rather than the verdict prose:
// the rail is where this card states what the finding IS at a glance
// (severity, confidence), which is the same question the stamp
// answers, and inline it read as the first word of the verdict
// sentence and left the following lines wrapping under it. Rail idiom
// is value + caption, so it wears a `.value-label` like the two above
// it — "REFUTED" alone under a confidence ring doesn't say refuted by
// what.
//
// A row stamped `revalidation` gets nothing: that value names the pass
// rather than a judgement on anything. A stamp shows whether or not
// the row carries verdict PROSE — the one-word outcome stands on its
// own, and a report is free to send it without the reasoning.
function revalidateStampTemplate(f) {
  const stamp = revalidateStamp(f)
  if (!stamp) return nothing
  return html`<span class=${`revalidate-stamp ${stamp}`}>${stamp}</span>
    <div class="value-label">Revalidation</div>`
}

// The revalidation pass's reasoning, in the same muted italic under
// the same dashed divider as the confidence rationale it sits below:
// both are a remark ABOUT the finding rather than part of it, and a
// second note that shouted would unbalance the pair. What the pass
// concluded doesn't need weight here anyway — the one-word outcome is
// up in the rail (revalidateStampTemplate above).
function revalidateTemplate(f) {
  // The pass's own words go with its layer (format.js
  // revalidationShown): the card showing the code view must not still
  // be explaining a re-rating that view doesn't apply.
  const verdict = revalidationShown() ? stripExportMarker(f.revalidateVerdict, f) : ''
  if (!verdict) return nothing
  // One line, like every other `pre-wrap` block on this card: the
  // template's own newlines would print as whitespace inside it.
  return html`<div class="revalidate-verdict">${renderHighlighted(flowText(verdict))}</div>`
}

// One labelled body section — a small-caps header over its text. Used
// for every `**Label:**` paragraph the description carries (see
// format.js descriptionSections) and for the finding's own
// `recommendation` field, so a long section reads as its own block
// rather than as one bold run the eye slides past. `cls` picks up the
// per-section colouring (`.recommendation` is green).
//
// `collapsible` makes it a `<details>`, closed, with its header as the
// `<summary>` — the same disclosure Evidence wears below, and for the
// same reason. Reproduction and the two recommendations are what a
// reader turns to AFTER deciding a finding is worth acting on: steps
// to follow and a fix to weigh, each often longer than the finding
// itself. Left open they push the next finding off the screen for
// every reader still triaging. The native element carries the
// keyboard and screen-reader behaviour and keeps the open state on
// itself, so nothing here has to track it — and print forces them all
// open (see the @media print block in finding-card.css), because paper
// has no disclosure to click.
//
// A section with no body never collapses: a disclosure that opens onto
// nothing is a trap, not a saving.
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

// The `## Evidence` list a claude-security import carries — one row per
// cited site: a link to that site (its own URL from the report, or the
// reconstruction for a row that named no link) plus the report's note
// about it (`text` / `observation` — see evidenceNote). A real `<ol>`
// rather than the body text's newlines, because a note is usually long
// enough to wrap and only markup can keep the wrapped lines indented
// under the reference instead of dropping them back to the margin.
// Rows that named no line render the bare path.
//
// A `<details>`, closed: the list is a citation apparatus — where the
// finding was seen, one line per site — and a reader opens a card for
// the finding, not for its footnotes. Collapsed it costs one line and
// says how many sites are under it; the disclosure is the native one,
// so keyboard and screen readers get it for free and the open state
// belongs to the element rather than to any state we have to carry.
// Paper has no disclosure, so print forces it open (finding-card.css).
// A row's reference, as a link into the CODE PANEL. Only the focus
// view has a panel to load, and only a bundle can answer for the path
// — everywhere else, and with no bundle attached, the reference is the
// GitHub link it has always been.
//
// Presence follows the bundle's contents, exactly like the `</>` mark
// beside it (bundleFilePath): a row the bundle carries is a link, a
// row it doesn't is plain text. Which is the honest answer, and a
// better one for the TEXT than the reconstruction it replaces — the
// panel opens the file we are holding, so there is nothing to get
// wrong about which revision of which repository it came from.
//
// The GitHub mark stays either way. What moves here is where the
// reference itself takes you; going out to the repository is a
// different errand, and the mark beside the row is how you still run
// it.
function evidencePanelRef(bundle, row, label) {
  const file = bundle && row?.file ? bundleFilePath(bundle.integrity, row.file) : null
  if (!file) return html`<span class="evidence-ref">${label}</span>`
  // A span carrying `role="link"`, not a `<button>`: a button is
  // inline-BLOCK and cannot be talked out of it — Chromium coerces
  // `display: inline` straight back — so a path long enough to wrap
  // made the button's box the whole line and pushed the `</>` beside
  // it onto the next one. A span wraps as text does, and the marks
  // stay on the last line of it where they belong.
  //
  // `role="link"` because that is what it does: it takes you to a
  // place in the code, the same as the `<a>` the other views render,
  // only the destination is the panel next to it rather than a URL.
  // `tabindex` and the Enter handler in events.js are what a real
  // anchor would have given for free.
  return html`<span
    class="evidence-ref"
    role="link"
    tabindex="0"
    data-code-nav-integrity=${bundle.integrity}
    data-code-nav-file=${file}
    data-code-nav-line=${row?.line ?? ''}
  >${label}</span>`
}

function evidenceTemplate(f, context) {
  const rows = Array.isArray(f.evidence) ? f.evidence : []
  if (rows.length === 0) return nothing
  const repoFallback = findingRepoFallback(f)
  // Every row cites a place in the code, so every row that the
  // attached bundle can answer for gets a `</>` beside its link.
  const bundle = attachedBundle(f)
  // …and in the focus view, where a code panel is on screen to load
  // into, that same bundle decides where the REFERENCE goes. Only the
  // reference: the GitHub mark after it is unaffected, and is what
  // keeps the way out to the repository open.
  const toPanel = context === 'focus' && bundle !== null
  // Which row the panel is showing, so the list can say so. Only
  // meaningful with a panel open: everywhere else the rows point out
  // of the app and none of them is "current".
  const shown = toPanel ? focusCodePosition(f) : null
  return html`<details class="evidence">
    <summary class="section-label">Evidence<span class="evidence-count">(${rows.length})</span></summary>
    <ol class="evidence-list">${rows.map((row, i) => {
      const label = locationLabel(row)
      const url = evidenceUrl(row, f, repoFallback, i)
      const note = evidenceNote(row)
      // Indexed, so two rows citing the same place stay two marks too.
      const preview = codePreview(f, `ev${i}`, bundle, row?.file, row?.line)
      const ghRef = githubRef(url)
      const current = toPanel && samePos(shown, {
        integrity: bundle.integrity,
        file: bundleFilePath(bundle.integrity, row?.file),
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

// Combined `file:line` link for the table-view row's location cell —
// the row has no file header above it (unlike the list / grouped
// views) so file + line live together in one slot. Returns a
// TemplateResult when we have a source URL, plain text otherwise.
function rowLocationTemplate(f, url) {
  const lineNum = parseInt(f.line, 10)
  const text = Number.isFinite(lineNum) ? `${f.file}:${f.line}` : f.file
  if (!url) return text
  return html`<a href=${url} target="_blank" rel="noopener">${text}</a>`
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
// finding-row.css. Exported (like FLAG_ICON) for the kanban card's
// compact comment shortcut in render.js.
export const COMMENT_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <path class="bubble" d="M2.5 3h11a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-.5.5H8.4l-3 2.6V10.5H2.5a.5.5 0 0 1-.5-.5V3.5a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

// Wrench glyph for the per-finding fix-link button. Same has-x /
// outline-vs-fill pattern as the comment icon: empty button = no
// fix recorded; filled accent = a URL is set. Exported (like
// FLAG_ICON) for the kanban card's compact fix shortcut in render.js.
export const FIX_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <path class="wrench" d="M10.4 2.6a3 3 0 0 0-3.6 4.5L2 12l2 2 4.9-4.8a3 3 0 0 0 4.5-3.6l-1.8 1.8-1.5-.4-.4-1.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

// Clipboard / copy glyph for the `[copy]` shortcut button. Same
// size + stroke weight as the comment / fix icons so the row reads
// as a uniform action strip.
const COPY_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <rect x="3" y="2.5" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
  <rect x="5.5" y="5" width="8" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

// Chain-link glyph for the `[link]` shortcut button — copies a
// `#finding=…` deep link to this finding (see view/finding-link.js).
// Same size + stroke weight as the copy / issue / claude icons so the
// strip stays uniform.
const LINK_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
    <path d="M6.2 11.2H4.8a3.2 3.2 0 0 1 0-6.4h1.4"/>
    <path d="M9.8 4.8h1.4a3.2 3.2 0 0 1 0 6.4H9.8"/>
    <path d="M5.6 8h4.8"/>
  </g>
</svg>`

// `</>` for the source-preview toggle beside a code link. It sits
// INSIDE a line of text rather than in a row of buttons, so it reads
// as a mark on that line and not as a control docked next to it — and
// it says what it opens, which is the source, in the notation a reader
// of code already knows.
const CODE_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4.4 4.6 1.3 8l3.1 3.4"/>
    <path d="m11.6 4.6 3.1 3.4-3.1 3.4"/>
    <path d="M9.8 2.6 6.2 13.4"/>
  </g>
</svg>`

// GitHub mark, beside the `</>`. The location text is already a link;
// this says WHERE it goes, which the text can't — `src/proxy.ts:42`
// is the same string whichever repo it is in, and a card can carry
// rows from several. The tooltip spells the target out.
const GITHUB_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
</svg>`

// One template, mark and tooltip together in a wrapper — unlike the
// source preview, whose snippet is flow content and has to be hung off
// the row. This tooltip is a short line of text, so it belongs BESIDE
// the mark, and beside is a thing only the mark's own box can say: an
// absolute offset measured from the row would have to know how wide
// the location text happened to be.
//
// `nothing` when the URL isn't a GitHub blob — a report linking to
// some other host, or to nothing at all. No mark, no tooltip, and the
// location link stands as it always did.
function githubRef(url) {
  const label = githubRefLabel(url)
  if (!label) return nothing
  return html`<span class="gh-ref"><a
    class="gh-ref-btn"
    href=${url}
    target="_blank"
    rel="noopener noreferrer"
    aria-label=${`Open ${label} on GitHub`}
  >${GITHUB_ICON}</a><span class="gh-ref-tip" role="tooltip">${label}</span></span>`
}

// ── Source preview ───────────────────────────────────────────────────
// A finding's links to code point OUT — to GitHub, or to the bundle
// viewer. When a bundle is attached we already hold the source, so the
// `</>` beside each link opens the few lines around it in place:
// enough to see whether a citation says what the prose claims, without
// losing the prose to a tab switch.
//
// Offered per LINK, not per finding, so an evidence row citing another
// file gets its own — resolved against the same bundle by path
// (bundleFilePath, which answers synchronously off the hash index, so
// deciding whether to draw a mark never costs a bundle parse). A path
// the bundle doesn't carry simply gets no mark.
//
// Open state lives in `state.codePreviews` keyed by this, so it
// survives the re-render each toggle triggers and several previews can
// be open at once.
//
// Keyed by the SITE as well as the place, because the same place is
// routinely cited twice on one card — an evidence row pointing at the
// finding's own `file:line` is the normal shape of a report, not an
// edge case. Keyed on the location alone, those two marks are one
// control with two faces: clicking either opens both.
function codePreviewKey(f, site, path, range) {
  return `${tabKey(f)}\u0000${site}\u0000${path}\u0000${range ? `${range.start}-${range.end}` : ''}`
}

// Which mark the pointer is on, and the card that drew it.
//
// The hover snippet used to be rendered for EVERY mark whose file
// happened to be loaded — the template can't know where the pointer
// is, so it built one and let CSS reveal the right one. On a card
// that is fine. On a list of two thousand it is thousands of
// highlighted ten-line snippets in the DOM, all but one of them
// hidden, and the cost lands the moment the first file loads rather
// than when the list is built, so it reads as the list going bad on
// its own.
//
// Deliberately NOT in `state`: a tracked read would put every card on
// the page in the pointer's dependency set, and moving between two
// marks would re-render all of them. A module variable plus a direct
// `requestUpdate` on the one or two cards involved is the whole
// mechanism.
let hoveredPreview = { key: null, host: null }

function hoverPreview(key, target) {
  if (hoveredPreview.key === key) return
  const previous = hoveredPreview.host
  // `findingCardInnerTemplate` only ever renders inside
  // `<finding-card>`'s shadow root, so the root's host is the card.
  const host = key === null ? null : target?.getRootNode?.()?.host ?? null
  hoveredPreview = { key, host }
  previous?.requestUpdate?.()
  if (host !== previous) host?.requestUpdate?.()
}

// The lines themselves, once the bundle has loaded. Numbered from
// wherever the window starts (format.js snippetWindow), with the cited
// line marked — a snippet the reader can't place against the `file:42`
// they opened it from is a snippet they have to trust.
//
// Highlighting goes through code-highlight.js, the same cache the
// description's fenced blocks use: it takes the file's extension as
// the language tag, keys by content, and re-renders once prism
// settles. Highlighting the WINDOW rather than slicing the whole
// file's HTML — tags span lines, so there is no safe cut.
function codeSnippetTemplate(content, range, path) {
  // Two ticks, because two caches settle behind this: focus-code.js
  // bumps `focusCodeTick` when the BUNDLE lands (read by the caller,
  // which needs it before there is any content), and code-highlight.js
  // bumps `codeBlockTick` when PRISM does. Both have to reach this
  // card's autorun or the snippet paints as plain text and stays that
  // way until something else re-renders it.
  void state.codeBlockTick
  const { text, lines, startLine } = snippetWindow(content, range)
  if (lines.length === 0) return nothing
  const dot = path.lastIndexOf('.')
  const coloured = highlightedCode(text, dot < 0 ? '' : path.slice(dot + 1))
  const lastNo = startLine + lines.length - 1
  return html`<div class="code-preview" style=${styleMap({ '--lineno-width': `${String(lastNo).length}ch` })}>
    <aside class="code-preview-gutter" aria-hidden="true">${lines.map((_, i) => {
      const ln = startLine + i
      // Every line of the range, not just the one it opens on — a span
      // shown with only its first line marked hides what was cited.
      const cited = Boolean(range) && ln >= range.start && ln <= range.end
      return html`<div class=${classMap({ 'code-preview-lineno': true, cited })}>${ln}</div>`
    })}</aside>
    <pre class="code-preview-source"><code>${coloured ? unsafeHTML(coloured) : text}</code></pre>
  </div>`
}

// The mark and the snippet it opens, as two templates rather than one:
// the finding's own link lives in a flex `.line-row`, where the
// snippet has to land BELOW the row rather than beside its parts,
// while an evidence row can carry both inside its `<li>`. Callers
// place each where it belongs.
//
// `null` when there is no bundle, or none of it answers to this path —
// the link then stands alone, exactly as it did before. `bundle` is
// the finding's attached bundle; `path` is where the link points, in
// the report's own terms; `site` says WHICH link on the card this is,
// so two pointing at the same place stay two controls.
function codePreview(f, site, bundle, path, line) {
  // BEFORE the guards, because the guards are what this read is for:
  // both the caller's `attachedBundle` and the lookup below answer off
  // a plain module Map, which this card's autorun cannot see fill in.
  // On a reload the index starts empty and the stored report paints
  // straight away, so the first pass asks too early, gets nothing, and
  // draws no marks — and a read placed after `return null` would never
  // subscribe the card to hearing otherwise. Same tick and the same
  // reason as the `Code →` branch below.
  void state.bundleHashTick
  if (!bundle || !path) return null
  const file = bundleFilePath(bundle.integrity, path)
  if (!file) return null
  // `line` arrives as the report wrote it, which may be a span
  // (`20-30`); the preview shows all of it (format.js lineRange).
  const range = lineRange(line)
  const key = codePreviewKey(f, site, path, range)
  const open = state.codePreviews.has(key)
  // Unconditional, not just while a preview is open: the tick is what
  // subscribes this card's autorun to the loader's settle events, and
  // a HOVER can start a load too (below). Without the read, the card
  // that kicked one would never re-render to show what arrived.
  void state.focusCodeTick
  const mark = html`<button
    type="button"
    class=${classMap({ 'code-preview-btn': true, open })}
    data-code-preview=${key}
    aria-expanded=${String(open)}
    aria-label=${open ? `Hide the source at ${path}` : `Show the source at ${path}`}
    @mouseenter=${(e) => { hoverPreview(key, e.currentTarget); bundleSource(bundle.integrity, file) }}
    @mouseleave=${(e) => { if (hoveredPreview.key === key) hoverPreview(null, e.currentTarget) }}
    @focus=${(e) => { hoverPreview(key, e.currentTarget); bundleSource(bundle.integrity, file) }}
    @blur=${(e) => { if (hoveredPreview.key === key) hoverPreview(null, e.currentTarget) }}
  >${CODE_ICON}</button>`
  if (open) {
    const source = bundleSource(bundle.integrity, file)
    const body = !source || source.loading
      ? html`<div class="code-preview code-preview-pending">${source ? 'Loading source…' : 'Source unavailable'}</div>`
      : codeSnippetTemplate(source.content, range, file)
    // No tooltip while the preview is open — it would say the same
    // thing twice, over the copy the reader asked to keep.
    return { mark, tip: nothing, body }
  }
  // The hover tooltip: the same snippet, shown while the pointer is on
  // the mark, for a look that doesn't cost a click and doesn't push the
  // prose around.
  //
  // Built for THIS mark only while it is the one being pointed at
  // (hoverPreview above) — one snippet in the document rather than one
  // per mark on the page. The handlers on the button re-render this
  // card when the pointer arrives and again when it leaves, so the
  // snippet is in the DOM within a frame of the pointer landing.
  //
  // Read from what is ALREADY loaded — `kick: false` — so arriving on
  // a mark shows what we have and asks for the rest; the POINTER does
  // the kicking (`mouseenter` above) and the settle comes back through
  // the tick.
  if (hoveredPreview.key !== key) return { mark, tip: nothing, body: nothing }
  const peek = bundleSource(bundle.integrity, file, { kick: false })
  const tip = peek && !peek.loading
    ? html`<div class="code-preview-tip" role="tooltip">${codeSnippetTemplate(peek.content, range, file)}</div>`
    : nothing
  return { mark, tip, body: nothing }
}

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

// GitHub "issue opened" glyph (circle + center dot) for the `[github
// issue]` shortcut link. Same size + stroke weight as the other action
// icons so the strip stays uniform.
const ISSUE_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <circle cx="8" cy="8" r="1.7" fill="currentColor"/>
</svg>`

// Pennant flag for the per-finding attention flag (the comment/fix
// action group, the kanban card indicator, and the toolbar filter). A
// pole-less vertical pennant (swallowtail at the bottom) that fills the
// icon height; outline by default, the `.flagged` button fills the cloth
// + turns accent via CSS. Exported so the kanban card (render.js) and
// the toolbar `<annotation-filter>` reuse the identical glyph.
export const FLAG_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <path class="flag-cloth" d="M5 1.5h6v13l-3-2.7-3 2.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
</svg>`

// Attention-flag toggle — sits in the comment/fix action group of the
// finding card/row (and gains a text label in the focus view, like its
// siblings). Tri-state under the hood (see TriageEntry.flagged): the
// events.js click handler walks unset/false → true → false, writing the
// explicit `false` tombstone on un-flag (never undefined) so the removal
// syncs. Keyed to the active tab's `key`, mirroring the per-tab color /
// comment / fix marks beside it.
function flagButtonTemplate(key, isFocus = false) {
  const flagged = state.triage.get(key)?.flagged === true
  const title = flagged ? 'Remove flag' : 'Flag this finding'
  return html`<button
    type="button"
    class=${classMap({ 'mark-flag': true, flagged })}
    data-flag-toggle=${key}
    title=${title}
    aria-label=${title}
    aria-pressed=${String(flagged)}
  >${FLAG_ICON}${isFocus ? html`<span class="mark-btn-label">${flagged ? 'Flagged' : 'Flag'}</span>` : nothing}</button>`
}

// Issue title — the finding's title (the same one the table view
// shows), capped so the pre-filled `?title=` stays a sane length;
// falls back to the file path, then a generic label.
function issueTitle(f) {
  const base = findingTitle(f) || f.file || 'Security finding'
  return base.length > 120 ? `${base.slice(0, 119)}…` : base
}

// Issue body — the finding detail for the pre-filled `?body=`. Tailored
// for a GitHub issue rather than reusing the copy / Claude handoff
// block: no `Repo:` line (the issue already lives on that repo), the
// description sits on its own as a bare paragraph (no label), and
// file:line is a Markdown link to the source on GitHub — the same
// target the card / row file links use, falling back to plain
// `file:line` text when the path can't be linked (e.g. a node_modules
// file with no resolvable upstream repo). Blocks join with a blank line
// so the file link and confidence bracket the description paragraph.
function issueBody(f) {
  const href = findingUrl(f, findingRepoFallback(f))
  const lineNum = parseInt(f.line, 10)
  const loc = Number.isFinite(lineNum) ? `${f.file}:${f.line}` : f.file
  const blocks = []
  if (f.file) blocks.push(`File: ${href ? `[${loc}](${href})` : loc}`)
  if (f.description) blocks.push(f.description)
  const evidence = evidenceMarkdown(f)
  if (evidence) blocks.push(evidence)
  if (f.confidence !== undefined && f.confidence !== null) blocks.push(`Confidence: ${f.confidence}/10`)
  return blocks.join('\n\n')
}

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
function actionButtonsTemplate(group, sortedTabs, groupSt, activeTab, context = null) {
  const reportChip = reportChipTemplate(group)
  const activeKey = tabKey(activeTab)
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
  // Attention flag — third chip in the comment/fix group.
  const flagBtn = flagButtonTemplate(activeKey, isFocus)
  // Copy button — writes a labeled `File / Line / Description /
  // Confidence` block for the active tab to the clipboard (handler
  // in events.js, active tab resolved via the same gid lookup).
  const copyBtn = html`<button type="button" class="mark-copy" title="Copy file, line, description, confidence to clipboard" aria-label="Copy finding details to clipboard">${COPY_ICON}${isFocus ? html`<span class="mark-btn-label">Copy</span>` : nothing}</button>`
  // Link button — copies a `#finding=<id>` URL that reopens the app on
  // THIS finding (handler in events.js; resolution in
  // view/finding-link.js). Suppressed for a session-local numeric id:
  // those are handed out by an in-memory counter and re-assigned on the
  // next load, so the link would point somewhere else — better no
  // affordance than one that quietly rots. Sits next to Copy, the other
  // "take this with you" action.
  const linkBtn = isLinkableFindingId(activeKey)
    ? html`<button type="button" class="mark-link" title="Copy a link to this finding" aria-label="Copy a link to this finding">${LINK_ICON}${isFocus ? html`<span class="mark-btn-label">Link</span>` : nothing}</button>`
    : nothing
  // GitHub-issue link — a plain anchor (no JS handoff) to GitHub's
  // pre-filled new-issue form for the finding's repo, with the finding
  // detail (file:line linked to source, description, confidence) as the
  // body. Only rendered when the finding resolves to a github.com repo
  // (issues live on github.com; githubIssueUrl returns null for a
  // gitlab / self-hosted / unknown base), so non-GitHub findings show
  // the group without it. Third in the handoff group:
  // copy | link | issue | claude.
  const findingRepoId = findingRepo(activeTab)
  const issueHref = githubIssueUrl(findingRepoId, { title: issueTitle(activeTab), body: issueBody(activeTab) })
  const issueBtn = issueHref
    ? html`<a class="mark-issue" href=${issueHref} target="_blank" rel="noopener" title="Create a pre-filled GitHub issue for this finding" aria-label="Create a GitHub issue for this finding">${ISSUE_ICON}${isFocus ? html`<span class="mark-btn-label">Issue</span>` : nothing}</a>`
    : nothing
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
  return html`${reportChip}<span class="mark-action-group">${commentBtn}${fixBtn}${flagBtn}</span><span class="mark-action-group">${copyBtn}${linkBtn}${issueBtn}${claudeBtn}</span>${picker}${triageMenuTemplate(group, menuTitle, context, groupSt, activeTab)}`
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

// `groupSt` / `activeTab` arrive precomputed from actionButtonsTemplate
// (which got them from the row / card template) so a single row render
// resolves them once rather than once per nested helper.
function triageMenuTemplate(group, title, context, groupSt, activeTab) {
  const gid = tabKey(group[0])
  // What the scope currently shows — the active tab's bucket on a
  // conflicted group, the rollup's otherwise. `scopedTriage` is the
  // one definition `triageActionPlan` also decides set-vs-clear from,
  // so the item marked active here is exactly the one a click
  // switches off.
  const current = scopedTriage(group, groupSt, activeTab)
  const STATE_LABELS = { inprogress: 'In progress', fixed: 'Fixed', invalid: 'Invalid', deleted: 'Deleted', ignored: 'Ignored' }
  const ACTION_LABELS = { inprogress: 'In progress', fixed: 'Fixed', invalid: 'Invalid', deleted: 'Delete', ignored: 'Ignore' }
  const inTriageView = Boolean(state.shownTriage)
  const buttonLabel = inTriageView ? STATE_LABELS[state.shownTriage] : null
  // Action order: triage states first (In progress / Fixed / Invalid
  // / Delete), then Ignore.
  //
  // Focus-view variant shows all five states as toggleable chips
  // with the active one marked `.active` (pressed); clicking it
  // toggles off (the duplicate-click semantic events.js already
  // implements), so no separate "Restore" entry is needed.
  //
  // List-view variant (the dropdown) prepends Restore in a triage
  // view and excludes the current state — as a popover menu, showing
  // the active bucket without a "press" affordance would confuse.
  const ALL_ACTIONS = ['inprogress', 'fixed', 'invalid', 'deleted', 'ignored']
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

// Read-only annotation marks for a group tab — the speech-bubble /
// wrench / pennant glyphs (shared with the action row) shown at the
// trailing edge of the tab (after the severity badge + confidence) when
// that tab's finding carries a comment, fix link, and/or attention flag.
// Lets triage annotations read off the collapsed tab strip without
// activating each sibling. Inert <span>s (the tab is the button); always
// in the filled/accent state since they only render when the annotation
// is present. `nothing` when the tab is unannotated.
function tabMarksTemplate(entry) {
  const hasComment = Boolean(entry?.comment)
  const hasFix = Boolean(entry?.fix)
  const flagged = entry?.flagged === true
  if (!hasComment && !hasFix && !flagged) return nothing
  return html`<span class="tab-marks">${
    hasComment ? html`<span class="has-comment" title="Has a comment">${COMMENT_ICON}</span>` : nothing
  }${
    hasFix ? html`<span class="has-fix" title="Has a fix link">${FIX_ICON}</span>` : nothing
  }${
    flagged ? html`<span class="flagged" title="Flagged">${FLAG_ICON}</span>` : nothing
  }</span>`
}

// One tab button. Carries severity badge + (optional) confidence +
// annotation marks (comment / fix / flag, when present), plus the
// per-tab color class and — when it still says something the group
// doesn't — the per-tab state class behind that state's glyph (`◐` /
// `✓` / `⊘` / `👁` / a struck-through label).
//
// A tab's state is worth showing exactly when the GROUP can't show it.
// `commonTriage` is the group's own state, and it is null precisely
// when the card has nothing to display: the tabs' buckets disagree, or
// a color conflict has suppressed the rollup. With a common state the
// card already says "in progress" / "fixed" / "deleted", so repeating
// it once per tab reads as a per-tab annotation the user never made.
//
// Ignore is the exception, and `allIgnored` (not `commonTriage`) gates
// it: the rollup calls a group ignored off one annotated tab, but
// `syncGroupTriage` deliberately never levels a per-report ignore, so
// the tab that actually carries it stays worth pointing at until every
// tab does.
function tabTemplate(f, isActive, groupSt) {
  const key = tabKey(f)
  const entry = state.triage.get(key)
  const color = entry?.color
  const triage = entry?.triage
  const classes = ['tab']
  if (isActive) classes.push('active')
  if (color) classes.push(`tab-mark-${color}`)
  if (triage) {
    if (groupSt.commonTriage === null) classes.push(`tab-${triage}`)
  } else if (!groupSt.allIgnored && isIgnored(f)) {
    // Per-tab by nature — each tab carries its own report — and
    // mutually exclusive with the triage classes via the action
    // handler. Falls through to a muted opacity hint via finding-row
    // / finding-card CSS.
    classes.push('tab-ignored')
  }
  return html`<button type="button" class=${classes.join(' ')} data-tid=${key}><span class="tab-label">${severityBadge(f, { variant: 'tab' })} ${f.confidence === undefined ? nothing : html`<span class="tab-conf">${f.confidence}/10</span>`}${tabMarksTemplate(entry)}</span></button>`
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
    return html`<div class=${`conf-ring ${displayedSeverity(f, state.severityMode)}`}>
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
  // The analyzer's "couldn't determine the package" placeholder
  // (`solidity-bundle@0.0.0`) is not a real registry entry — suppress
  // the chip rather than linking to a 404 npm page.
  if (isPlaceholderNpmPackage(npm)) return nothing
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
  const url = findingUrl(f, findingRepoFallback(f))
  const lineNum = parseInt(f.line, 10)
  const locText = Number.isFinite(lineNum) ? `${f.file}:${f.line}` : f.file
  const locLink = url
    ? html`<a href=${url} target="_blank" rel="noopener">${locText}</a>`
    : locText
  const exportLabel = findingDisplayName(f)
  // The finding's own location, previewable in place when a bundle
  // carries it. Resolved once here and passed to the evidence rows
  // too — one lookup per card, not one per link.
  const bundle = attachedBundle(f)
  const linePreview = codePreview(f, 'loc', bundle, f.file, f.line)
  // The marks ride INSIDE `.line-num`, not beside it: `.line-row` is a
  // `space-between` flex line, so a second item there would be spread
  // to the middle of the row rather than left against the location it
  // belongs to — and the run-meta on the far end would shift with it.
  const ghRef = githubRef(url)
  const lineRowMain = html`<span class="line-num">${
    exportLabel ? html`${locLink}, ${exportLabel}` : locLink
  }${linePreview?.mark ?? nothing}${ghRef}</span>`
  // The tooltip is absolutely positioned against `.line-row`, so it
  // sits beside `.line-num` rather than inside it — a snippet is flow
  // content and that span is not a box to put one in.
  const meta = formatRunMeta(f)
  // The file the analyzer was reading when it found this. A note worth
  // making when it isn't the finding's own location — a bug in `a.js`
  // spotted while reading `b.js` says something about how it surfaced
  // — and pure noise when it's the same file, where the row already
  // reads `src/a.js:42` and the note only adds "(found analyzing
  // src/a.js)" after it.
  const foundIn = String(f.discoveredIn ?? '').trim()
  const discoveredIn = foundIn === String(f.file ?? '').trim() ? '' : foundIn
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
    // The lookup below reads a plain module Map, which this card's
    // autorun can't see change. `bundleHashTick` is the state read
    // that subscribes it to the index filling in (or a bundle being
    // deleted out of it) — without it a card rendered before the
    // hashes landed keeps its "no bundle, no button" answer until
    // something else happens to re-render it. Same shape as the
    // `codeBlockTick` read in codeBlockTemplate.
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
        title=${`Open ${match.file} in bundle source viewer`}
      >Code</button>`
    }
  }
  const { title: descTitle, body: descBody } = splitDescription(f)
  // The narrative first, then the evidence list, then the report's
  // labelled sections — the order a claude-security report writes them
  // in, and the one that reads right for the formats whose labels all
  // trail their prose (parse-piolium). `lead` is the prose that opens
  // the body; everything from the first label on keeps document order.
  //
  // The finding's own structured fields (`impact`, `reproduction`,
  // `recommendation`) follow, in the order a reader needs them: what it
  // means, how to trigger it, how to fix it. They wear the same header
  // + body block as the labelled sections above, so a report that
  // carries them as FIELDS and one that writes `**Impact:**` into its
  // description read identically — which is what parse-md emits for the
  // same two names.
  const sections = descriptionSections(descBody)
  const firstLabel = sections.findIndex((s) => s.label !== null)
  const lead = firstLabel === -1 ? sections : sections.slice(0, firstLabel)
  const labelled = firstLabel === -1 ? [] : sections.slice(firstLabel)
  return html`<div class=${classMap({ 'tab-body': true, active: isActive })} data-tid=${key}>
    ${total > 1 ? html`<div class="print-case-label">${idx + 1} of ${total}</div>` : nothing}
    <div class="finding-left">
      ${severityBadge(f, { variant: 'full' })}
      <div class="value-label">Severity</div>
      ${f.confidence === undefined ? nothing : confTemplate(f)}
      ${revalidateStampTemplate(f)}
      ${codeButton}
    </div>
    <div>
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
      ${comment ? html`<div class="comment-block"><span class="comment-label">Comment:</span> ${renderCommentText(comment)}</div>` : nothing}
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
  const isCritical = g.some((f) => f.critical || displayedSeverity(f, state.severityMode) === 'critical')
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
        ${sortedTabs.length > 1 ? html`<div class="tabs">${sortedTabs.map((f) => tabTemplate(f, tabKey(f) === activeKey, groupSt))}</div>` : nothing}
      </div>
      ${actionButtonsTemplate(g, sortedTabs, groupSt, active, context)}
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
  const isCritical = g.some((f) => f.critical || displayedSeverity(f, state.severityMode) === 'critical')
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

  const title = findingTitle(f)
  const typeLabel = formatRunMeta(f)
  const exportLabel = findingDisplayName(f)
  const exportPart = exportLabel ? `, ${exportLabel}` : ''
  const url = findingUrl(f, findingRepoFallback(f))

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
          ${actionButtonsTemplate(g, sortedTabs, groupSt, active)}
        </div>
      </div>
      ${sortedTabs.length > 1 ? html`<div class="tabs-row"><div class="tabs">${sortedTabs.map((tabF) => tabTemplate(tabF, tabKey(tabF) === activeKey, groupSt))}</div></div>` : nothing}
    </div>
  `
}
