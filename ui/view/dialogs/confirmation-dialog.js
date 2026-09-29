import { unsafeCSS } from 'lit'
import { AppDialog } from './app-dialog.js'
import listCSS from './dialog-list.css'

// Destructive list prompts share Cancel-first focus and a boolean decision.
// Subclasses supply their wording and may add fields to the result.
export class ConfirmationDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS)]

  focusInitial() {
    this.renderRoot.querySelector('button[data-role="cancel"]')?.focus()
  }

  confirmationResult(confirmed) {
    return { confirmed }
  }

  _finish(confirmed) {
    if (this._settled) return
    super._finish(this.confirmationResult(Boolean(confirmed)))
  }

  _onClose = () => this._finish(false)
  _onCancel = () => this._finish(false)
  _onConfirm = () => this._finish(true)
}
