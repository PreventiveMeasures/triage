// `<triage-conflict-dialog>` — modal dialog for per-property
// triage conflicts. Shared by `ui/view/workspace-import.js`
// (workspace import path) and `ui/view/hydration-conflict.js`
// (report-attach hydration path).
//
// Conflicts are grouped by finding id so each card shows the
// finding's context (severity badge, file:line, first line of
// description) once and lists the per-property choices (color,
// comment, fix, triage) inside it. The host calls
// `resolveTriageConflicts(conflicts, lookup, labels)` and gets a
// Promise that resolves with a map keyed by `${id}:${property}`
// → `'local'` / `'imported'`, or `null` if cancelled (= keep
// local everywhere).
//
// Extends `AppDialog` for the shared shadow-DOM <dialog> chrome
// (focus-trap + Esc-to-cancel), with the severity-badge + conflict
// layers added on top.
import { html, nothing, unsafeCSS } from 'lit'
import { isHttpUrl } from '../format.js'
import { makeStackedModalError } from '../dom.js'
import { AppDialog } from './app-dialog.js'
import severityCSS from './dialog-severity.css'
import conflictCSS from './dialog-conflict.css'

// Swatch reads its hue from the global `--marker-*` custom
// properties (see theme.css); the matching `.conflict-color-dot`
// rules in dialog-conflict.css map a `marker-{red,blue,green,gray}`
// modifier class to the right `var(--marker-…)` background.
// One source for the four marker colors — change theme.css and
// both the in-app picker and these swatches follow.
function colorSwatchTemplate(color) {
  // Empty string = "unset". The conflict-detection three-way
  // compare in triage-sync.ts uses '' for the absent side of an
  // unset-vs-set disagreement (we cleared color locally, peer set
  // one — or vice versa); render that as a `<em>none</em>` chip
  // so the dialog can show both sides side-by-side without an
  // empty / undefined-named swatch.
  if (!color) return html`<em>none</em>`
  return html`<span class="conflict-color">
    <span class=${`conflict-color-dot marker-${color}`}></span>
    <span class="conflict-color-name">${color}</span>
  </span>`
}

function commentBlockTemplate(text) {
  return html`<span class="conflict-comment-text">${text || html`<em>empty</em>`}</span>`
}

function fixBlockTemplate(text) {
  if (!text) return html`<span class="conflict-comment-text"><em>empty</em></span>`
  // Only http(s) values get a clickable link — plain-text fix
  // references ("internal ticket #42") render as text inside the
  // same `.conflict-fix-text` span so the layout stays put.
  if (!isHttpUrl(text)) return html`<span class="conflict-fix-text">${text}</span>`
  return html`<span class="conflict-fix-text"><a href=${text} target="_blank" rel="noopener noreferrer">${text}</a></span>`
}

function triageBadgeTemplate(value) {
  if (!value) return html`<em>none</em>`
  return html`<span class=${`conflict-triage triage-${value}`}>${value}</span>`
}

function valueTemplate(property, value) {
  if (property === 'color') return colorSwatchTemplate(value)
  if (property === 'comment') return commentBlockTemplate(value)
  if (property === 'fix') return fixBlockTemplate(value)
  if (property === 'triage') return triageBadgeTemplate(value)
  return html`${String(value)}`
}

function severityBadgeTemplate(sev) {
  if (!sev) return nothing
  const label = sev.replaceAll('_', ' ')
  return html`<span class=${`conflict-sev sev-${sev}`}>${label}</span>`
}

function findingHeaderTemplate(meta, id) {
  const loc = meta?.file
    ? (meta.line ? `${meta.file}:${meta.line}` : meta.file)
    : ''
  return html`
    <div class="conflict-card-head">
      ${severityBadgeTemplate(meta?.severity)}
      ${loc ? html`<span class="conflict-loc" title=${loc}>${loc}</span>` : nothing}
      <code class="conflict-id" title=${id}>${id.slice(0, 8)}…</code>
    </div>
    ${meta?.description
      ? html`<div class="conflict-desc" title=${meta.description}>${meta.description}</div>`
      : nothing}
  `
}

const DEFAULT_LABELS = {
  title: 'Triage conflicts',
  intro: 'disagree with your local triage on',
  trailingNote: '',
  applyButton: 'Apply',
  importedSideLabel: 'Apply imported',
}

const PROP_ORDER = { color: 0, comment: 1, fix: 2, triage: 3 }
const PROP_LABEL = { color: 'Color', comment: 'Comment', fix: 'Fix', triage: 'Triage state' }

class TriageConflictDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(severityCSS), unsafeCSS(conflictCSS)]

  static properties = {
    conflicts: { attribute: false },
    findingLookup: { attribute: false },
    labels: { attribute: false },
    _settled: { state: true },
  }

  constructor() {
    super()
    this.conflicts = []
    this.findingLookup = new Map()
    this.labels = { ...DEFAULT_LABELS }
    this._settled = false
  }

  // No explicit initial focus — showModal()'s native autofocus lands
  // on the first bulk button, which is what we want (the base default
  // `focusInitial` would instead grab the first radio). Modal-conflict
  // (another dialog already open) is handled by the base
  // `firstUpdated`, which dispatches `modal-conflict`; the wrapper
  // rejects so the caller can alert that the imported peer's triage
  // decisions were skipped. Base `_finish` (close + resolve) and
  // `_onClose` (Esc / backdrop → resolve null = keep all current) are
  // inherited unchanged.
  focusInitial() {}

  _onClick = (e) => {
    const bulk = e.target.closest('[data-bulk]')
    if (bulk) {
      const value = bulk.dataset.bulk
      for (const r of this.renderRoot.querySelectorAll(`input[type="radio"][value="${value}"]`)) r.checked = true
      return
    }
    if (e.target.closest('[data-action="apply"]')) {
      const decisions = {}
      for (const c of this.conflicts) {
        const key = `${c.id}:${c.property}`
        const checked = this.renderRoot.querySelector(`input[name="conflict-${CSS.escape(key)}"]:checked`)
        decisions[key] = checked?.value ?? 'local'
      }
      this._finish(decisions)
      return
    }
    if (e.target.closest('[data-action="cancel"]')) this._finish(null)
  }

  render() {
    const lbl = this.labels
    // Group by finding id so a finding with both a color AND a
    // comment conflict shows up as a single card with two
    // decisions, instead of two unrelated rows.
    const byId = new Map()
    for (const c of this.conflicts) {
      if (!byId.has(c.id)) byId.set(c.id, [])
      byId.get(c.id).push(c)
    }
    // Sort properties within a card so order is stable: color
    // first, then comment, then fix, then triage — matches the
    // action-row ordering in the finding card.
    for (const list of byId.values()) {
      list.sort((a, b) => (PROP_ORDER[a.property] ?? 99) - (PROP_ORDER[b.property] ?? 99))
    }

    const colorN = this.conflicts.filter((c) => c.property === 'color').length
    const commentN = this.conflicts.filter((c) => c.property === 'comment').length
    const fixN = this.conflicts.filter((c) => c.property === 'fix').length
    const triageN = this.conflicts.filter((c) => c.property === 'triage').length
    const summary = [
      colorN ? `${colorN} color${colorN === 1 ? '' : 's'}` : '',
      commentN ? `${commentN} comment${commentN === 1 ? '' : 's'}` : '',
      fixN ? `${fixN} fix${fixN === 1 ? '' : 'es'}` : '',
      triageN ? `${triageN} triage state${triageN === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(', ')
    const findingsLabel = `${byId.size} finding${byId.size === 1 ? '' : 's'}`

    return html`<dialog
      @click=${this._onClick}
      @close=${this._onClose}
    >
      <header class="conflict-head">
        <h3>${lbl.title}</h3>
        <p>${findingsLabel} ${lbl.intro} ${summary}.${lbl.trailingNote ? ` ${lbl.trailingNote}` : ''}</p>
        <div class="conflict-bulk">
          <button type="button" data-bulk="local">Keep all current</button>
          <button type="button" data-bulk="imported">${lbl.importedSideLabel} (all)</button>
        </div>
      </header>
      <ul class="conflict-list">
        ${[...byId.entries()].map(([id, items]) => html`
          <li class="conflict-card" data-id=${id}>
            ${findingHeaderTemplate(this.findingLookup.get(id), id)}
            <div class="conflict-rows">
              ${items.map((c) => {
                const key = `${c.id}:${c.property}`
                const radioName = `conflict-${key}`
                return html`<div class="conflict-row" data-key=${key}>
                  <span class="conflict-row-label">${PROP_LABEL[c.property] ?? c.property}</span>
                  <label class="conflict-choice">
                    <input type="radio" name=${radioName} value="local" checked>
                    <span class="conflict-choice-label">Keep current</span>
                    <span class="conflict-choice-value">${valueTemplate(c.property, c.local)}</span>
                  </label>
                  <label class="conflict-choice">
                    <input type="radio" name=${radioName} value="imported">
                    <span class="conflict-choice-label">${lbl.importedSideLabel}</span>
                    <span class="conflict-choice-value">${valueTemplate(c.property, c.imported)}</span>
                  </label>
                </div>`
              })}
            </div>
          </li>
        `)}
      </ul>
      <footer class="conflict-actions">
        <button type="button" data-action="cancel">Cancel</button>
        <button type="button" data-action="apply" class="primary">${lbl.applyButton}</button>
      </footer>
    </dialog>`
  }
}

customElements.define('triage-conflict-dialog', TriageConflictDialog)

// Public API — same signature the imperative version exposed:
// caller awaits the Promise; resolves with a `${id}:${property}`
// → 'local' / 'imported' map, or null on cancel. Rejects when
// another modal is already open so the caller can surface that the
// conflict resolution was skipped (the merge layer otherwise
// silently keeps local for all disagreements).
//
// `findingLookup` is `Map<id, { severity, file, line, description }>`.
// `labels` overrides the default copy: { title, intro, trailingNote,
// applyButton, importedSideLabel }. The defaults read like the
// generic "triage conflicts" wording; pass labels to specialise for
// "import bundle" vs "report attach".
export function resolveTriageConflicts(conflicts, findingLookup, labels = {}) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('triage-conflict-dialog')
    el.conflicts = conflicts
    el.findingLookup = findingLookup
    el.labels = { ...DEFAULT_LABELS, ...labels }
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    el.addEventListener('modal-conflict', (e) => {
      el.remove()
      reject(makeStackedModalError(e.detail?.cause))
    })
    document.body.append(el)
  })
}
