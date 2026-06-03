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
// Promise resolving to a map keyed by `${id}:${property}`
// → `'local'` / `'imported'`, or `null` if cancelled (= keep
// local everywhere).
//
// No side is pre-selected. Each property's two radios are `required`
// members of one group, and Apply is the form's submit button, so
// native constraint validation blocks Apply until the user has picked
// a side for every conflict (the bulk buttons set them all at once).
// Cancelling is still "keep all local", but that's a deliberate
// action, not a silent default that could flip a peer's value on a
// stray Apply.
//
// Extends `AppDialog` for the shared shadow-DOM <dialog> chrome
// (focus-trap + Esc-to-cancel), plus severity-badge + conflict layers.
import { html, nothing, unsafeCSS } from 'lit'
import { isHttpUrl } from '../format.js'
import { makeStackedModalError } from '../dom.js'
import { AppDialog } from './app-dialog.js'
import severityCSS from './dialog-severity.css'
import conflictCSS from './dialog-conflict.css'
import { severityBadge } from './shared.js'

// Swatch hue comes from the global `--marker-*` custom properties
// (theme.css); `.color-dot` rules in dialog-conflict.css map a
// `marker-{red,blue,green,gray}` class to the right `var(--marker-…)`.
// Single source for the four marker colors — change theme.css and both
// the in-app picker and these swatches follow.
function colorSwatchTemplate(color) {
  // Empty string = "unset": the three-way compare in triage-sync.ts
  // uses '' for the absent side of an unset-vs-set disagreement (we
  // cleared color locally, peer set one, or vice versa). Render it as a
  // `<em>none</em>` chip so both sides show side-by-side without an
  // empty/undefined-named swatch.
  if (!color) return html`<em>none</em>`
  return html`<span class="color">
    <span class=${`color-dot marker-${color}`}></span>
    <span class="color-name">${color}</span>
  </span>`
}

function commentBlockTemplate(text) {
  return html`<span class="comment-text">${text || html`<em>empty</em>`}</span>`
}

function fixBlockTemplate(text) {
  if (!text) return html`<span class="comment-text"><em>empty</em></span>`
  // Only http(s) values get a clickable link; plain-text fix
  // references ("internal ticket #42") render as text in the same
  // `.fix-text` span so the layout stays put.
  if (!isHttpUrl(text)) return html`<span class="fix-text">${text}</span>`
  return html`<span class="fix-text"><a href=${text} target="_blank" rel="noopener noreferrer">${text}</a></span>`
}

function triageBadgeTemplate(value) {
  if (!value) return html`<em>none</em>`
  return html`<span class=${`triage triage-${value}`}>${value}</span>`
}

function valueTemplate(property, value) {
  if (property === 'color') return colorSwatchTemplate(value)
  if (property === 'comment') return commentBlockTemplate(value)
  if (property === 'fix') return fixBlockTemplate(value)
  if (property === 'triage') return triageBadgeTemplate(value)
  return html`${String(value)}`
}

function findingHeaderTemplate(meta, id) {
  const loc = meta?.file
    ? (meta.line ? `${meta.file}:${meta.line}` : meta.file)
    : ''
  return html`
    <div class="card-head">
      ${severityBadge(meta?.severity)}
      ${loc ? html`<span class="loc" title=${loc}>${loc}</span>` : nothing}
      <code class="id" title=${id}>${id.slice(0, 8)}…</code>
    </div>
    ${meta?.description
      ? html`<div class="desc" title=${meta.description}>${meta.description}</div>`
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
  // on the first bulk button (the base default would grab the first
  // radio). Modal-conflict is handled by base `firstUpdated`; the
  // wrapper rejects so the caller can alert that the peer's triage
  // decisions were skipped. Base `_finish` and `_onClose` (Esc /
  // backdrop → resolve null = keep all current) are inherited.
  focusInitial() {}

  _onClick = (e) => {
    const bulk = e.target.closest('[data-bulk]')
    if (bulk) {
      const value = bulk.dataset.bulk
      for (const r of this.renderRoot.querySelectorAll(`input[type="radio"][value="${value}"]`)) r.checked = true
      return
    }
    if (e.target.closest('[data-action="cancel"]')) this._finish(null)
  }

  // Apply is the form's submit button, so the browser runs constraint
  // validation first: this fires only once every conflict's `required`
  // radio group has a pick. An unresolved row blocks submit and the UA
  // points the user at it — no manual gate, no invented default.
  _onSubmit = (e) => {
    e.preventDefault()  // resolve via _finish; don't navigate the page
    const decisions = {}
    for (const c of this.conflicts) {
      const key = `${c.id}:${c.property}`
      const checked = this.renderRoot.querySelector(`input[name="conflict-${CSS.escape(key)}"]:checked`)
      if (checked) decisions[key] = checked.value
    }
    this._finish(decisions)
  }

  render() {
    const lbl = this.labels
    // Group by finding id so a finding with both a color AND a comment
    // conflict shows as one card with two decisions, not two rows.
    const byId = new Map()
    for (const c of this.conflicts) {
      if (!byId.has(c.id)) byId.set(c.id, [])
      byId.get(c.id).push(c)
    }
    // Stable property order within a card (color, comment, fix,
    // triage) — matches the action-row ordering in the finding card.
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
      <header>
        <h3>${lbl.title}</h3>
        <p>${findingsLabel} ${lbl.intro} ${summary}.${lbl.trailingNote ? ` ${lbl.trailingNote}` : ''}</p>
        <div class="bulk">
          <button type="button" data-bulk="local">Keep all current</button>
          <button type="button" data-bulk="imported">${lbl.importedSideLabel} (all)</button>
        </div>
      </header>
      <form @submit=${this._onSubmit}>
        <ul class="list">
          ${[...byId.entries()].map(([id, items]) => html`
            <li class="card" data-id=${id}>
              ${findingHeaderTemplate(this.findingLookup.get(id), id)}
              <div class="rows">
                ${items.map((c) => {
                  const key = `${c.id}:${c.property}`
                  const radioName = `conflict-${key}`
                  // Both radios carry `required`: with neither
                  // pre-checked, the group stays invalid until the user
                  // picks a side, so the form's submit (Apply) is
                  // blocked and the UA scrolls to + flags the first
                  // unresolved row. No default is ever invented.
                  return html`<div class="row" data-key=${key}>
                    <span class="row-label">${PROP_LABEL[c.property] ?? c.property}</span>
                    <label class="choice">
                      <input type="radio" name=${radioName} value="local" required>
                      <span class="choice-label">Keep current</span>
                      <span class="choice-value">${valueTemplate(c.property, c.local)}</span>
                    </label>
                    <label class="choice">
                      <input type="radio" name=${radioName} value="imported" required>
                      <span class="choice-label">${lbl.importedSideLabel}</span>
                      <span class="choice-value">${valueTemplate(c.property, c.imported)}</span>
                    </label>
                  </div>`
                })}
              </div>
            </li>
          `)}
        </ul>
        <footer class="actions">
          <button type="button" data-action="cancel">Cancel</button>
          <button type="submit" class="primary">${lbl.applyButton}</button>
        </footer>
      </form>
    </dialog>`
  }
}

customElements.define('triage-conflict-dialog', TriageConflictDialog)

// Public API. Caller awaits the Promise; resolves with a
// `${id}:${property}` → 'local' / 'imported' map, or null on cancel.
// Rejects when another modal is already open so the caller can surface
// that conflict resolution was skipped (otherwise the merge layer
// silently keeps local for all disagreements).
//
// `findingLookup` is `Map<id, { severity, file, line, description }>`.
// `labels` overrides the default copy { title, intro, trailingNote,
// applyButton, importedSideLabel } to specialise the generic wording
// for "import bundle" vs "report attach".
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
