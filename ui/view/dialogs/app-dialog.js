// `AppDialog` — base class for the app's modal dialogs: the shared `<dialog>`
// chrome (dialog-base.css, `.nwd-*`) and the open / focus / resolve plumbing.
//
// A base class rather than an `<app-dialog>` slot wrapper: the bodies style
// DEEP elements with the shared classes, which `::slotted` can't reach. Each
// subclass renders into its own shadow root where the inherited styles do; the
// CSSResult is one object, so the browser shares the adopted sheet.
//
// Subclasses render `html\`<dialog @close=${this._onClose}>…\`` and call
// `this._finish(result)` to close and resolve; `_onClose` (Esc, Cancel)
// resolves null unless overridden, and `focusInitial()` picks the first field.
//
// Stacking: `showModal()` stacks over an open modal rather than refusing, which
// nested and in-flow dialogs need (the re-check dialog opening the download
// one, a password prompt raised mid-upload). A dialog opened `exclusive`
// refuses instead and dispatches `modal-conflict` (see firstUpdated); the
// dialogs that open unprompted and retry later are opened so.
import { LitElement, unsafeCSS } from 'lit'
import { makeStackedModalError } from '../dom.js'
import { hasOpenModal } from '../open-modal.js'
import { installShadowTooltipListener } from '../tooltip.js'
import dialogBaseCSS from './dialog-base.css'

export class AppDialog extends LitElement {
  // Subclasses extend it: `static styles = [...AppDialog.styles, unsafeCSS(css)]`.
  static styles = [unsafeCSS(dialogBaseCSS)]

  // Fields holding a secret (a password, a key, bytes to decrypt), with the
  // empty value each is reset to on every way out, shown or not.
  static secrets = {}

  // Set by the open helper before the element is attached.
  exclusive = false

  firstUpdated() {
    // Every dialog is its own shadow root, so each needs the tooltip listener.
    installShadowTooltipListener(this.renderRoot)
    this.beforeOpen()
    const dialog = this.renderRoot.querySelector('dialog')
    if (!dialog) return
    if (this.exclusive && hasOpenModal()) {
      this._conflict(new DOMException('Another modal dialog is already open', 'InvalidStateError'))
      return
    }
    try {
      dialog.showModal()
    } catch (err) {
      // Not another modal (that stacks): the element was detached first, or
      // the dialog is already open.
      this._conflict(err)
      return
    }
    this.focusInitial()
  }

  // Never shown. Settled, so a stray `close` can't drive `_finish`, wiped,
  // and `modal-conflict` for the open helper's `conflict` to settle on.
  _conflict(cause) {
    this._settled = true
    Object.assign(this, this.constructor.secrets)
    this.dispatchEvent(new CustomEvent('modal-conflict', { detail: { cause } }))
  }

  // Seed state from the props the open helper assigned, before showModal.
  beforeOpen() {}

  focusInitial() {
    const el = this.renderRoot.querySelector('input, textarea')
      ?? this.renderRoot.querySelector('button.primary')
      ?? this.renderRoot.querySelector('button')
    el?.focus()
  }

  // Close and emit the one `resolve` the open helper awaits. Guarded, so
  // Enter followed by the `close` event resolves once.
  _finish(result) {
    if (this._settled) return
    this._settled = true
    Object.assign(this, this.constructor.secrets)
    this.renderRoot.querySelector('dialog')?.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: result }))
  }

  _onClose = () => this._finish(null)
  _onCancel = () => this._onClose()

  // Opt in with @click=${this._onBackdrop}. Backdrop clicks target the dialog
  // itself, as do clicks on its padding; only close from outside.
  _onBackdrop = (event) => {
    if (event.target !== event.currentTarget) return
    const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect()
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) this._onClose()
  }
}

// Append `tagName` with `props` to <body>; resolve with its result and remove
// it. A dialog that never showed dispatches `modal-conflict` instead, which
// `conflict(cause)` settles: with its return value, or by throwing. Without one
// the promise would never settle, so every `exclusive` dialog passes one.
export function openAppDialog(tagName, props = {}, { exclusive = false, conflict } = {}) {
  return new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement(tagName), props, { exclusive })
    const settle = (value) => {
      el.remove()
      try { resolve(value()) } catch (err) { reject(err) }
    }
    el.addEventListener('resolve', (e) => settle(() => e.detail))
    if (conflict) el.addEventListener('modal-conflict', (e) => settle(() => conflict(e.detail?.cause)))
    document.body.append(el)
  })
}

// `conflict` for callers that surface why the dialog didn't open.
export const rejectStacked = (cause) => { throw makeStackedModalError(cause) }
