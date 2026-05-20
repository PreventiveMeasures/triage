// `AppDialog` — base class for the app's modal dialogs. Owns the
// shared shadow-DOM chrome (the `dialog` frame + `.nwd-*` inner
// classes, via styles/dialog-base.css) and the common open/close
// plumbing, so each concrete dialog is just its body template +
// behavior.
//
// Why a base class rather than a `<app-dialog>` slot wrapper: the
// dialog bodies hang their shared `.nwd-*` / `.wsl-*` / `.lwd-*`
// classes on DEEP elements, and a wrapper could only style
// top-level slotted nodes (`::slotted` doesn't reach descendants).
// Subclassing puts each dialog's body in its OWN shadow root where
// the inherited `static styles` reach every element, with no
// per-dialog duplication — the shared base CSSResult is a single
// object, so the browser shares one adoptedStyleSheet across all
// dialog instances.
//
// Contract for subclasses:
//   - `render()` returns `html\`<dialog @close=${this._onClose}>…\``
//     (the bare `dialog`; the base styles target it).
//   - call `this._finish(result)` to close + resolve.
//   - the public `open*()` helper appends the element to <body> and
//     resolves on the `resolve` event (see openAppDialog below).
//   - override `focusInitial()` / `_onClose` when the defaults
//     (focus first field, Esc → resolve null) don't fit.
import { LitElement, unsafeCSS } from 'lit'
import dialogBaseCSS from '../styles/dialog-base.css'

export class AppDialog extends LitElement {
  // Array so subclasses extend it: `static styles = [...AppDialog.styles,
  // unsafeCSS(extraCSS)]`. The base CSSResult is one shared object,
  // so the browser dedupes the underlying adoptedStyleSheet across
  // every dialog instance.
  static styles = [unsafeCSS(dialogBaseCSS)]

  firstUpdated() {
    this.beforeOpen()
    const dialog = this.renderRoot.querySelector('dialog')
    if (!dialog) return
    try {
      dialog.showModal()
    } catch (err) {
      // Another modal is already open (showModal throws
      // InvalidStateError). Mark settled so a stray `close` event
      // can't drive `_finish` after the conflict, then dispatch:
      // dialogs whose open() helper listens for `modal-conflict`
      // turn this into a rejection (and wipe any wrapper-set secret
      // in that listener); the rest just stay closed (their open()
      // promise never resolves — matches the pre-component behavior).
      this._settled = true
      this.dispatchEvent(new CustomEvent('modal-conflict', { detail: { cause: err } }))
      return
    }
    this.focusInitial()
  }

  // Override hook: seed reactive state from properties before the
  // dialog opens (the public open() helper assigns props after
  // createElement, so they're set by firstUpdated time). Default
  // no-op.
  beforeOpen() {}

  // Initial focus target. Default: first text field, else the
  // primary action button, else the first button.
  focusInitial() {
    const el = this.renderRoot.querySelector('input, textarea')
      ?? this.renderRoot.querySelector('button.primary')
      ?? this.renderRoot.querySelector('button')
    el?.focus()
  }

  // Close the native dialog + emit the single `resolve` event the
  // `open*()` helper awaits. Guarded so a double-finish (e.g. Enter
  // then the `close` event) resolves once.
  _finish(result) {
    if (this._settled) return
    this._settled = true
    this.renderRoot.querySelector('dialog')?.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: result }))
  }

  // Native <dialog> close (Esc / programmatic) → cancel. Subclasses
  // that need a non-null cancel value override this.
  _onClose = () => this._finish(null)
}

// Shared open-helper: create the element, append to <body>, resolve
// with the dialog's `resolve` detail (and remove the element). Each
// dialog's public `open*()` wrapper delegates here so the
// create / listen / cleanup dance isn't copy-pasted 16×.
export function openAppDialog(tagName, props = {}) {
  return new Promise((resolve) => {
    const el = document.createElement(tagName)
    Object.assign(el, props)
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    document.body.append(el)
  })
}
