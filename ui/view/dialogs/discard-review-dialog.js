import { html } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog } from './confirmation-dialog.js'

class DiscardReviewDialog extends ConfirmationDialog {
  static properties = { reviewTitle: { type: String } }

  firstUpdated() {
    if (this.signal?.aborted) { this._onCancel(); return }
    this.signal?.addEventListener('abort', this._onCancel, { once: true })
    super.firstUpdated()
  }

  disconnectedCallback() {
    this.signal?.removeEventListener('abort', this._onCancel)
    super.disconnectedCallback()
  }

  confirmationResult(confirmed) { return { confirmed: confirmed && !this.signal?.aborted } }

  render() {
    return html`<dialog aria-labelledby="discard-review-title" @close=${this._onClose}>
      <header><h3 id="discard-review-title">Discard unpublished review?</h3></header>
      <p class="lwd-body"><strong>${this.reviewTitle}</strong></p>
      <p class="lwd-note">This permanently deletes this review and all its file verdicts and notes. This cannot be undone.</p>
      <footer class="nwd-actions"><span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="danger" @click=${this._onConfirm}>Discard review</button>
      </footer>
    </dialog>`
  }
}
customElements.define('discard-review-dialog', DiscardReviewDialog)

export function openDiscardReviewDialog(props) { return openAppDialog('discard-review-dialog', props) }
