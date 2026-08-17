// `<storage-persist-dialog>` — "how do I actually get persistent
// storage" instructions, opened by the sidebar's storage-at-risk
// banner when a `persist()` request comes back denied. The denial is
// silent on Chromium and structural on Safari, so without this the
// banner click looks broken; the dialog says what the browser
// actually wants, per engine:
//
//   chromium — never prompts; grants silently to origins its
//              important-sites ranking accepts (installed app,
//              bookmark, engagement). Re-evaluated on every request,
//              so a Try-again button is meaningful after the user
//              installs/bookmarks.
//   firefox  — the only engine with a real permission prompt; a
//              dismissed/blocked prompt is remembered, so the fix is
//              clearing the old answer, then Try again.
//   webkit   — Safari + every iOS browser (all WebKit): persist()
//              does not exempt a normal tab from ITP's 7-day
//              cleanup; only installing the app does. No Try-again —
//              retrying can't help.
//
// Single-acknowledge dialog: extends `AppDialog` for the shared
// shadow-DOM <dialog> chrome (focus-trap + Esc-to-close). The open
// helper settles on `modal-conflict` too (mirrors
// persistence-degraded-dialog) so a conflicting modal can't leak the
// element or hang the caller.
import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog } from './app-dialog.js'
import { requestPersistentStorage } from '#client/index.js'
import storagePersistCSS from './dialog-storage-persist.css'

// Which grant model this browser follows. iOS/iPadOS browsers are
// all WebKit (CriOS / FxiOS / EdgiOS included) and desktop Safari
// carries no Blink token, so "AppleWebKit and not a Blink UA" is the
// ITP-governed population; the Blink tokens are slash-anchored where
// a WebKit sibling shares the prefix (EdgiOS vs Edg/, OPT vs OPR/).
// Desktop Firefox is the only Firefox with the prompt model (FxiOS
// is WebKit and lacks the `Firefox/` token). Everything else is
// treated as Chromium-style silent heuristics. UA sniffing is fine
// at instruction-copy stakes.
export function persistGrantFlavor() {
  const ua = navigator.userAgent
  if (/AppleWebKit/u.test(ua) && !/Chrome\/|Chromium|Edg\/|OPR\/|Android/u.test(ua)) return 'webkit'
  if (/Firefox\//u.test(ua)) return 'firefox'
  return 'chromium'
}

class StoragePersistDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(storagePersistCSS)]

  static properties = {
    _retryDenied: { state: true },
  }

  constructor() {
    super()
    this._retryDenied = false
  }

  // Focus the acknowledge button so Enter/Esc both just dismiss.
  focusInitial() {
    this.renderRoot.querySelector('button.primary')?.focus()
  }

  _onConfirm = () => this._finish(null)

  // Re-request under the dialog's user gesture. Granted → resolve
  // 'granted' so the opener refreshes the banner away; denied →
  // inline status instead of silently doing nothing (the exact
  // failure mode this dialog exists to end).
  _onRetry = async () => {
    const granted = await requestPersistentStorage()
    if (granted) {
      this._finish('granted')
      return
    }
    this._retryDenied = true
  }

  _chromiumBody() {
    // Plain `localhost` can never pass Chromium's importance check —
    // it ranks sites by registerable domain (IP literals excepted)
    // and localhost has none — so instructions that can't work there
    // get replaced by the one that can.
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
      <p class="nwd-note">
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
    const body = flavor === 'webkit' ? this._webkitBody()
      : flavor === 'firefox' ? this._firefoxBody()
      : this._chromiumBody()
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
        <button type="button" class="primary" @click=${this._onConfirm}>Got it</button>
      </footer>
    </dialog>`
  }
}

customElements.define('storage-persist-dialog', StoragePersistDialog)

// Own open helper (not the shared `openAppDialog`) so `modal-conflict`
// settles too — same rationale as persistence-degraded-dialog: if
// another modal is already up, showModal() throws and only a
// `modal-conflict` listener keeps this promise from hanging and the
// element from leaking. Resolves 'granted' when the in-dialog retry
// succeeded, null otherwise.
export function openStoragePersistDialog() {
  return new Promise((resolve) => {
    const el = document.createElement('storage-persist-dialog')
    const settle = (result) => { el.remove(); resolve(result) }
    el.addEventListener('resolve', (e) => settle(e.detail))
    el.addEventListener('modal-conflict', () => settle(null))
    document.body.append(el)
  })
}
