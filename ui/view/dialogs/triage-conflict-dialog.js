// Per-property triage conflicts, for workspace import (view/workspace-import.js)
// and report-attach hydration (view/hydration-conflict.js). One card per
// finding, with its context once and a choice per conflicting property.
//
// Unavoidable, with no default: each choice's radios are `required` and Apply
// is the form's submit (the bulk buttons set them all), Esc is blocked, and
// there's no Cancel, so no silent "keep all local" exit. Only a dialog that
// couldn't open rejects, which the callers turn into keep-local.
import { html, nothing, unsafeCSS } from 'lit'
import { isHttpUrl } from '../format.js'
import { AppDialog, openAppDialog, rejectStacked } from './app-dialog.js'
import severityCSS from './dialog-severity.css'
import conflictCSS from './dialog-conflict.css'
import { findingLocation, severityBadge } from './shared.js'

const none = html`<em>none</em>`
const emptyText = html`<span class="comment-text"><em>empty</em></span>`

// The properties in a card's order (the finding card's action row), each with
// its label, its summary noun and how a value shows. '' is the unset side of
// an unset-vs-set disagreement (triage-sync.ts); flags come as 'flagged' /
// 'not flagged' (triage-changeset normFlagged).
const PROPERTIES = {
  // Swatch hues are the global `--marker-*` properties, as the in-app picker's.
  color: ['Color', 'color', 'colors', (color) => color ? html`<span class="color">
    <span class=${`color-dot marker-${color}`}></span>
    <span class="color-name">${color}</span>
  </span>` : none],
  comment: ['Comment', 'comment', 'comments', (text) => text ? html`<span class="comment-text">${text}</span>` : emptyText],
  // Only http(s) links; a plain reference ("internal ticket #42") stays text.
  fix: ['Fix', 'fix', 'fixes', (text) => text
    ? html`<span class="fix-text">${isHttpUrl(text) ? html`<a href=${text} target="_blank" rel="noopener noreferrer">${text}</a>` : text}</span>`
    : emptyText],
  triage: ['Triage state', 'triage state', 'triage states', (value) => value ? html`<span class=${`triage triage-${value}`}>${value}</span>` : none],
  flagged: ['Flag', 'flag', 'flags', (value) => value ? html`<span class=${`flag-badge${value === 'flagged' ? ' on' : ''}`}>${value}</span>` : none],
}
const ORDER = Object.keys(PROPERTIES)
const rank = (property) => (property in PROPERTIES ? ORDER.indexOf(property) : 99)

const valueTemplate = (property, value) => PROPERTIES[property]?.[3](value) ?? html`${String(value)}`

function findingHeaderTemplate(meta, id) {
  const loc = findingLocation(meta)
  return html`
    <div class="card-head">
      ${severityBadge(meta?.severity)}
      ${loc ? html`<span class="loc" data-tooltip-truncated data-tooltip=${loc}>${loc}</span>` : nothing}
      <code class="id" data-tooltip=${id}>${id.slice(0, 8)}…</code>
    </div>
    ${meta?.description
      ? html`<div class="desc" data-tooltip-truncated data-tooltip=${meta.description}>${meta.description}</div>`
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

class TriageConflictDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(severityCSS), unsafeCSS(conflictCSS)]

  // No initial focus of ours: showModal's lands on the first bulk button (the
  // base's would take the first radio).
  focusInitial() {}

  _onClick = (e) => {
    const bulk = e.target.closest('[data-bulk]')
    if (!bulk) return
    for (const r of this.renderRoot.querySelectorAll(`input[type="radio"][value="${bulk.dataset.bulk}"]`)) r.checked = true
  }

  // Reached only once `required` validation passed: every conflict has a pick.
  _onSubmit = (e) => {
    e.preventDefault()
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
    const byId = Map.groupBy(this.conflicts, (c) => c.id)
    for (const list of byId.values()) list.sort((a, b) => rank(a.property) - rank(b.property))
    const summary = ORDER.map((property) => {
      const n = this.conflicts.filter((c) => c.property === property).length
      const [, one, many] = PROPERTIES[property]
      return n ? `${n} ${n === 1 ? one : many}` : ''
    }).filter(Boolean).join(', ')
    const findingsLabel = `${byId.size} finding${byId.size === 1 ? '' : 's'}`

    // `cancel` is Esc: prevented, so Apply stays the only way out.
    return html`<dialog
      @click=${this._onClick}
      @cancel=${(e) => e.preventDefault()}
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
                  return html`<div class="row" data-key=${key}>
                    <span class="row-label">${PROPERTIES[c.property]?.[0] ?? c.property}</span>
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
          <button type="submit" class="primary">${lbl.applyButton}</button>
        </footer>
      </form>
    </dialog>`
  }
}

customElements.define('triage-conflict-dialog', TriageConflictDialog)

// Resolves a `${id}:${property}` → 'local' | 'imported' map once every
// conflict is decided. Rejects when it can't open, so the caller can say the
// decisions were skipped (the merge then keeps local). `findingLookup`:
// Map<id, { severity, file, line, description }>; `labels` overrides
// DEFAULT_LABELS, for "import bundle" or "report attach".
export function resolveTriageConflicts(conflicts, findingLookup, labels = {}) {
  return openAppDialog('triage-conflict-dialog', {
    conflicts, findingLookup, labels: { ...DEFAULT_LABELS, ...labels },
  }, { conflict: rejectStacked })
}
