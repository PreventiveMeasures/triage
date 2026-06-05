// `<workspace-membership-dialog>` — checklist editor for which
// workspaces contain a given report or bundle. Opened from the
// per-row "Manage workspaces" affordance in the sidebar.
//
// A report or bundle can be a member of any number of workspaces —
// membership is stored as independent per-workspace `reports` /
// `bundles` arrays (see client/workspaces.js), so the same identifier
// can be listed in several at once. This dialog presents every
// workspace with a checkbox reflecting current membership and
// resolves the SET the user wants. The caller diffs that set against
// the prior membership and applies the additive
// `addReportToWorkspace` / scoped `removeReportFromWorkspace`
// primitives (and the bundle twins), so the dialog itself stays free
// of storage + sync side-effects — the same separation the other
// dialogs keep (resolve a value; the caller acts).
//
// Extends `AppDialog` (./app-dialog.js) for the shared shadow-DOM
// <dialog> chrome (focus-trap + Esc-to-cancel) and composes the
// `.lwd-*` list-dialog layer plus a small inline `.wmd-*` checkbox-
// list layer. Public
// `openWorkspaceMembershipDialog({ itemLabel, itemKind, workspaces })`
// returns a Promise resolving to `{ confirmed, selectedIds }`
// (`selectedIds` is `[]` on cancel / Esc).
import { css, html, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import listCSS from './dialog-list.css'

class WorkspaceMembershipDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS), css`
    .wmd-list {
      margin: .2rem 0 .65rem;
      max-height: 320px; overflow-y: auto;
      border: 1px solid var(--border); border-radius: 6px;
      background: rgb(from var(--text) r g b / .03);
    }
    .wmd-option {
      display: flex; align-items: center; gap: .55rem;
      padding: .42rem .6rem; cursor: pointer;

      & + .wmd-option { border-top: 1px solid rgb(from var(--text) r g b / .05); }
      & input[type='checkbox'] { flex-shrink: 0; margin: 0; accent-color: var(--accent); }
      & .wmd-name {
        flex: 1; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--text); font-size: .82rem;
      }
    }
  `]

  static properties = {
    itemLabel: { type: String },
    itemKind: { type: String },
    // Assigned by the open() helper after createElement; `attribute:
    // false` keeps the array off the DOM attribute surface. Seeded
    // into the live `_choices` state by `willUpdate` below.
    workspaces: { attribute: false },
    _choices: { state: true },
  }

  constructor() {
    super()
    this.itemLabel = ''
    this.itemKind = 'report'
    this.workspaces = []
    // Working copy of the checklist — `{ id, name, checked }` rows the
    // checkboxes mutate. Seeded once from `workspaces` in `willUpdate`.
    this._choices = []
    this._seeded = false
  }

  // Seed `_choices` from the incoming `workspaces` snapshot BEFORE the
  // first render (not in `beforeOpen`, which runs in `firstUpdated`
  // after the first paint and would flash an empty list). The
  // `_seeded` guard makes this a one-shot so a later reactive update
  // never clobbers the user's in-progress checkbox toggles.
  willUpdate(changed) {
    if (changed.has('workspaces') && !this._seeded) {
      this._seeded = true
      this._choices = (this.workspaces ?? []).map((w) => ({
        id: w.id,
        name: w.name,
        checked: Boolean(w.checked),
      }))
    }
  }

  _onToggle(id) {
    this._choices = this._choices.map((c) =>
      c.id === id ? { ...c, checked: !c.checked } : c,
    )
  }

  _onSave = () => {
    const selectedIds = this._choices.filter((c) => c.checked).map((c) => c.id)
    this._finish({ confirmed: true, selectedIds })
  }

  _onCancel = () => this._finish({ confirmed: false, selectedIds: [] })

  // Native <dialog> close (Esc / programmatic) → cancel with the
  // no-op result shape (base returns `null`; callers here destructure
  // `{ confirmed, selectedIds }`, so give them a stable shape).
  _onClose = () => this._finish({ confirmed: false, selectedIds: [] })

  render() {
    const kindNoun = this.itemKind === 'bundle' ? 'bundle' : 'report'
    const empty = this._choices.length === 0
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Add to workspaces</h3>
      </header>
      <p class="lwd-body">
        Choose which workspaces contain the ${kindNoun}
        <strong>"${this.itemLabel}"</strong>. A ${kindNoun} can belong to
        more than one workspace.
      </p>
      ${empty
        ? html`<p class="lwd-empty">No workspaces yet — create one from the Workspaces section first.</p>`
        : html`<div class="wmd-list">
            ${this._choices.map((c) => html`<label class="wmd-option">
              <input
                type="checkbox"
                .checked=${c.checked}
                @change=${() => this._onToggle(c.id)}
              >
              <span class="wmd-name">${c.name}</span>
            </label>`)}
          </div>`}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="primary" ?disabled=${empty} @click=${this._onSave}>Save</button>
      </footer>
    </dialog>`
  }
}

customElements.define('workspace-membership-dialog', WorkspaceMembershipDialog)

// Public entry point. `workspaces` is `[{ id, name, checked }]` — the
// full workspace list with `checked` pre-set to current membership.
// Resolves `{ confirmed, selectedIds }`; Cancel / Esc / native close
// all resolve to `{ confirmed: false, selectedIds: [] }`, so callers
// branch on `confirmed` first.
export function openWorkspaceMembershipDialog({ itemLabel, itemKind, workspaces } = {}) {
  return openAppDialog('workspace-membership-dialog', {
    itemLabel: itemLabel ?? '',
    itemKind: itemKind === 'bundle' ? 'bundle' : 'report',
    workspaces: Array.isArray(workspaces) ? workspaces : [],
  })
}
