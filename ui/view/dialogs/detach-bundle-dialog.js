// `<detach-bundle-dialog>` — confirmation prompt that fronts the
// bundle drag-out path in `sidebar.js`'s `onSidebarDrop` when the
// source workspace's remote inventory holds a copy. Drag-out drops
// the source's remote tag (a fresh `openWorkspace(source)` would
// otherwise auto-download the bundle straight back, defeating the
// drag); the dialog surfaces that side-effect so the user can back
// out instead of silently losing the workspace's remote bundle.
//
// Drag-out for a bundle that ISN'T in the source workspace's remote
// skips the dialog entirely — there's nothing destructive to confirm,
// it's a pure local membership detach.
//
// Sibling of `<detach-report-dialog>` / `<delete-bundle-dialog>`:
// extends `AppDialog` for the shared shadow-DOM <dialog> chrome
// (focus-trap + Esc-to-cancel), with the `.lwd-*` list-dialog layer
// added on top. Public `openDetachBundleDialog({ name, workspaceName })`
// returns a Promise that resolves to `{ confirmed }`.
import { html } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog } from './confirmation-dialog.js'

class DetachBundleDialog extends ConfirmationDialog {
  static properties = {
    bundleName: { type: String },
    workspaceName: { type: String },
  }

  constructor() {
    super()
    this.bundleName = ''
    this.workspaceName = ''
  }

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Detach bundle</h3>
      </header>
      <p class="lwd-body">
        Detach <strong>"${this.bundleName}"</strong> from workspace <strong>"${this.workspaceName}"</strong>?
      </p>
      <p class="lwd-note">
        This bundle is also stored in the workspace's <strong>remote</strong> inventory and will be removed from there too. Newly synced workspace members won't see it; members who already downloaded it keep their local copy (and could re-upload). The bundle bytes stay on this device — drop it onto another workspace to attach it there.
      </p>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="danger" @click=${this._onConfirm}>Detach</button>
      </footer>
    </dialog>`
  }
}

customElements.define('detach-bundle-dialog', DetachBundleDialog)

// Public entry point. Resolves with `{ confirmed }`. Cancel / Esc /
// native close all resolve to `{ confirmed: false }`. Only call this
// when the source workspace's objstore session holds a copy of the
// bundle — drag-out for a bundle that isn't in remote has nothing to
// confirm and should skip straight to the detach.
export function openDetachBundleDialog({ name, workspaceName } = {}) {
  return openAppDialog('detach-bundle-dialog', {
    bundleName: name ?? '',
    workspaceName: workspaceName ?? '',
  })
}
