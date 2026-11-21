import { html } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog } from './confirmation-dialog.js'

class DiscardReviewDialog extends ConfirmationDialog {
  render() {
    return this.prompt({
      title: 'Discard unpublished review?', titleId: 'discard-review-title', action: 'Discard review',
      body: html`<strong>${this.reviewTitle}</strong>`,
      notes: html`<p class="lwd-note">This permanently deletes this review and all its file verdicts and notes. This cannot be undone.</p>`,
    })
  }
}
customElements.define('discard-review-dialog', DiscardReviewDialog)

export function openDiscardReviewDialog(props) { return openAppDialog('discard-review-dialog', props) }
