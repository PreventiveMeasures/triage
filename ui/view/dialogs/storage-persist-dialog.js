// "How do I actually get persistent storage", from the sidebar's
// storage-at-risk banner when a `persist()` request comes back denied. The
// denial is silent on Chromium and structural on Safari, so the dialog says
// what each engine wants:
//   chromium — never prompts; grants silently to sites its importance ranking
//              accepts (installed, bookmarked, engaged), re-evaluated on every
//              request, so Try again helps after the user installs/bookmarks.
//   firefox  — a real prompt, whose dismissal is remembered until cleared.
//   webkit   — Safari and every iOS browser: persist() doesn't exempt a normal
//              tab from ITP's 7-day cleanup, only installing does. No Try again.
import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { requestPersistentStorage } from '#client/index.js'
import { persistGrantFlavor } from '../storage-status.js'
import storagePersistCSS from './dialog-storage-persist.css'

class StoragePersistDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(storagePersistCSS)]

  static properties = { _retryDenied: { state: true } }

  constructor() {
    super()
    this._retryDenied = false
  }

  // Asks again under this dialog's user gesture: 'granted' lets the opener
  // drop the banner, a denial says so rather than seeming to do nothing.
  _onRetry = async () => {
    if (await requestPersistentStorage()) this._finish('granted')
    else this._retryDenied = true
  }

  _chromiumBody() {
    // Chromium ranks sites by registrable domain (IP literals excepted), which
    // plain `localhost` lacks, so it can never qualify.
    const localhostNote = location.hostname === 'localhost'
      ? html` Plain <code>localhost</code> can never qualify — for local
          testing open the app via <code>127.0.0.1</code> instead.`
      : nothing
    return html`
      <p class="nwd-intro">
        Chromium-based browsers (Chrome, Edge, Brave, …) never show a
        prompt — persistence is granted silently, and only to sites the
        browser considers important. Any of these qualifies it:
      </p>
      <ul class="spd-list">
        <li><strong>Install the app</strong> — the install icon at the right
          end of the address bar, or the browser menu's Install entry.</li>
        <li><strong>Bookmark</strong> this page.</li>
        <li>Keep using the site — regular visits raise its engagement
          score.</li>
      </ul>
      <p class="nwd-note ui-hint">
        The browser re-evaluates on every request, so after any of the
        above press <strong>Try again</strong>.${localhostNote}
      </p>`
  }

  _firefoxBody() {
    return html`
      <p class="nwd-intro">
        Firefox asks with a permission prompt. A dismissed or blocked
        prompt is remembered, and the site can't re-ask until the old
        answer is cleared:
      </p>
      <ol class="spd-list">
        <li>Click the permissions icon next to the address bar.</li>
        <li>Clear the <strong>Store Data in Persistent Storage</strong>
          entry if it's blocked.</li>
        <li>Press <strong>Try again</strong> below and choose
          <strong>Allow</strong>.</li>
      </ol>`
  }

  _webkitBody() {
    return html`
      <p class="nwd-intro">
        Safari — and every iOS browser — additionally deletes a site's
        storage after <strong>7 days</strong> of browser use without
        interacting with the site, and no permission exempts a normal
        tab. Installing the app is what does:
      </p>
      <ul class="spd-list">
        <li>On iPhone / iPad: open the <strong>Share</strong> menu, choose
          <strong>Add to Home Screen</strong>, and use the app from that
          icon.</li>
        <li>In Safari on macOS: choose <strong>File → Add to Dock…</strong>
          and use the app from the Dock.</li>
        <li>Installed web apps are exempt from the 7-day cleanup.
          Otherwise, use the site at least once a week.</li>
      </ul>`
  }

  render() {
    const flavor = persistGrantFlavor()
    const body = flavor === 'webkit' ? this._webkitBody() : flavor === 'firefox' ? this._firefoxBody() : this._chromiumBody()
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Protect stored data</h3>
      </header>
      <p class="nwd-intro">
        Reports, bundles and triage live in the browser's
        <strong>best-effort storage</strong> — the browser is allowed to
        delete all of it at once under disk pressure or after long
        inactivity, without asking. The persistent-storage request that
        would prevent this was just declined.
      </p>
      ${body}
      <footer class="nwd-actions">
        ${this._retryDenied
          ? html`<span class="spd-denied" role="status">Still not granted.</span>`
          : nothing}
        <span class="nwd-spacer"></span>
        ${flavor === 'webkit'
          ? nothing
          : html`<button type="button" @click=${this._onRetry}>Try again</button>`}
        <button type="button" class="primary" @click=${this._onClose}>Got it</button>
      </footer>
    </dialog>`
  }
}

customElements.define('storage-persist-dialog', StoragePersistDialog)

// Resolves 'granted' when Try again succeeded, else null. Opened from a click,
// so it stacks over another modal; one that can't show resolves null.
export function openStoragePersistDialog() {
  return openAppDialog('storage-persist-dialog', {}, { conflict: () => null })
}
