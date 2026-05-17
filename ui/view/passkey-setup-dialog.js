// `<passkey-setup-dialog>` — opt-in dialog for enabling passkey-
// derived encryption-at-rest of triage data + OPFS reports. Shown
// when the user clicks the sidebar's "Enable encryption" affordance;
// after a successful run the vault is enabled + unlocked in this
// tab, all current local data is sealed under the just-registered
// passkey, and the dialog resolves true.
//
// Sibling of `<workspace-share-link-dialog>` /
// `<new-workspace-dialog>`: native <dialog> for focus-trap +
// Esc-to-cancel, light-DOM render so global stylesheet rules in
// sidebar.css apply. State machine mirrors the share-link dialog
// (form → busy → result).
//
// Migration is invoked from passkey-vault.enableEncryption — this
// dialog only collects the optional user-visible name (defaults to
// the origin's hostname) and surfaces progress/errors. The migration
// itself is wrapped in the vault's Web Lock so a sibling tab can't
// race a competing enable.

import { LitElement, html, nothing } from 'lit'
import { enableEncryption, hasOrphanedUserId, isEncryptionEnabled, isPasskeyEnvironmentSupported, onVaultStateChange, wipeAllVaultData } from '../../client/passkey-vault.js'
import { migrateTriageToEncrypted } from '../../client/triage.js'
import { migrateOpfsBundlesEncrypt, migrateOpfsFilesEncrypt } from '../../client/storage.js'
import { migrateToEncrypted as migrateSecureStorageToEncrypted } from '../../client/secure-storage.js'

class PasskeySetupDialog extends LitElement {
  static properties = {
    _userName: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _phase: { state: true },
    _success: { state: true },
    _orphan: { state: true },
    _orphanAck: { state: true },
    _canCancel: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this._userName = ''
    this._busy = false
    this._error = ''
    this._phase = ''
    this._success = false
    // Orphan state: a USER_ID_KEY survives in localStorage from a
    // previous vault whose metadata is gone (devtools wipe, profile
    // reset, partial setup). The old credential is unrecoverable, so
    // any data still on disk that was encrypted under it is
    // permanently unreadable. We surface this BEFORE the normal
    // enable flow so the user can't be surprised by silent data loss.
    this._orphan = false
    // Explicit acknowledgement that ALL local data (encrypted and
    // plaintext) will be deleted by the wipe. The "Wipe and continue"
    // button stays disabled until checked so a misclick can't trigger
    // a destructive irreversible action.
    this._orphanAck = false
    // Allow Cancel during the WebAuthn registration phase (the
    // AbortController plumbed into `registerPasskey` cleanly
    // unwinds it). Flipped false when we cross into migrate / wipe
    // phases where abort isn't propagated and a dialog close would
    // strand the operation mid-flight.
    this._canCancel = true
    this._abortController = null
  }

  updated(changed) {
    // When transitioning into the success state, move focus to the
    // primary Close button. Without this, focus stays on whatever
    // the user just clicked (often the now-removed "Enable" button)
    // and keyboard users have to Tab to find the close affordance.
    if (changed.has('_success') && this._success) {
      const btn = this.querySelector('footer button.primary')
      if (btn) btn.focus()
    }
  }

  firstUpdated() {
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.showModal()
    // Default name = origin hostname so the user has a reasonable
    // label without typing. They can still edit it; the value rides
    // through to the authenticator as the "user.name" field, which
    // shows up in the OS-level passkey manager.
    if (typeof location !== 'undefined') this._userName = location.hostname || 'DeepView'
    // Detect orphan AFTER the default-name fill so the orphan body
    // renders with the right state on first paint.
    this._orphan = hasOrphanedUserId()
    // Wait for Lit to re-render with the orphan/normal body before
    // querying for the input element — `firstUpdated` runs after
    // the first render, but the synchronous `_orphan = true` above
    // hasn't been reflected yet. Without the await, the
    // `input[data-role="orphan-ack"]` query returns null and focus
    // is silently skipped, leaving keyboard users on the dialog
    // body with no visible focus indicator.
    const focusInitial = () => {
      const selector = this._orphan ? 'input[data-role="orphan-ack"]' : 'input[data-role="name"]'
      const el = this.querySelector(selector)
      if (el) el.focus()
    }
    void this.updateComplete.then(focusInitial)
    // Watch for cross-tab vault state changes while the dialog is
    // open. A sibling tab enabling encryption (or wiping) while the
    // user is reading the orphan warning invalidates the dialog's
    // assumptions: the orphan body would still offer to wipe a
    // state that no longer exists, or our `_onEnable` would race a
    // freshly-enabled vault. Auto-close with `_finish(false)` so
    // view.js's cross-tab reload alert can take over.
    this._vaultStateUnsub = onVaultStateChange(() => {
      if (this._settled) return
      // Re-evaluate orphan; if it's still consistent with our
      // current body, no action needed.
      const stillOrphan = hasOrphanedUserId()
      if (this._orphan && !stillOrphan && isEncryptionEnabled()) {
        // A sibling tab finished an enable that consumed the orphan
        // userId. Surface the change as an error and let the user
        // close (or rely on view.js's reload).
        this._error = 'Encryption was just enabled in another tab. Close this dialog and reload to unlock.'
        this._busy = false
        this._canCancel = true
      } else if (this._orphan !== stillOrphan) {
        this._orphan = stillOrphan
      }
    })
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    if (this._vaultStateUnsub) {
      try { this._vaultStateUnsub() } catch {}
      this._vaultStateUnsub = null
    }
  }

  _finish(success) {
    if (this._settled) return
    this._settled = true
    // Abort any in-flight WebAuthn ceremony so the system prompt
    // disappears when the user cancels via our dialog. The vault's
    // enableEncryption is responsible for cleaning up the credential
    // it just created via signalUnknownCredential.
    if (this._abortController) {
      try { this._abortController.abort() } catch {}
    }
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: !!success }))
  }

  _onClose = () => this._finish(this._success)
  _onCancel = () => {
    // Cancel is ONLY safe when:
    //   - Not busy at all (form / orphan-ack / success), OR
    //   - We're in a phase that has a wired AbortController and
    //     aborting actually unwinds the in-flight work cleanly.
    //     `_abortController` is set during `registerPasskey`
    //     (the WebAuthn ceremony — abort closes the OS prompt and
    //     cleans up the credential) AND remains set during the
    //     subsequent migrate. The `_canCancel` flag flips false
    //     when we cross into the migrate phase, since the abort
    //     signal isn't plumbed through migrate and the close
    //     would silently abandon a partial encryption sweep.
    //
    // Without this distinction, a user stuck on an OS prompt
    // they can't fulfil (no platform authenticator, hardware key
    // not connected) had no way out except killing the tab.
    if (this._busy && !this._canCancel) return
    this._finish(false)
  }
  // Native <dialog> dispatches `cancel` on Esc. Same guard as the
  // Cancel button.
  _onDialogCancel = (e) => {
    if (this._busy && !this._canCancel) {
      e.preventDefault()
      return
    }
    this._finish(false)
  }

  _onNameInput = (e) => { this._userName = e.target.value }
  _onOrphanAckInput = (e) => { this._orphanAck = e.target.checked }

  // Wipe the orphan state, then continue with the normal enable
  // flow. wipeAllVaultData clears USER_ID_KEY, every secure-storage
  // key, and the OPFS report/bundle directories — anything still on
  // disk encrypted under the lost passkey was unreadable anyway.
  _onWipeOrphan = async () => {
    if (this._busy) return
    if (!this._orphanAck) return
    // Cheap pre-flight guard against a sibling tab having enabled
    // the vault while this dialog was open. The wipe itself
    // re-checks inside `VAULT_LOCK` with `refuseIfEnabled: true`,
    // which is the load-bearing guarantee — this synchronous check
    // is just a fast-path so the user doesn't wait for the lock
    // before seeing the error.
    if (isEncryptionEnabled()) {
      this._error = 'Encryption was just enabled in another tab. Reload this page to unlock.'
      return
    }
    this._busy = true
    this._canCancel = false  // wipe phase: no abort signal, block Cancel
    this._error = ''
    this._phase = 'Clearing previous vault state…'
    try {
      await wipeAllVaultData({ refuseIfEnabled: true })
      // Reload to drop in-memory state that survives `wipeAllVaultData`:
      // the bundle-finding / bundle-hash indices, state.bundles /
      // state.reports / state.findings, the storage.js read cache,
      // any rendered UI referencing the now-deleted files. Without
      // the reload, the user could click a finding's "Code →"
      // affordance and hit "File not found" because the in-memory
      // index still points at OPFS keys that were wiped. Matches the
      // lock-overlay wipe path (also reloads). User has to re-trigger
      // the setup dialog after — acceptable, since wipe is a
      // destructive one-shot and a fresh start is the intended
      // outcome.
      location.reload()
    } catch (err) {
      this._error = `Could not clear previous vault state: ${err?.message ?? err}`
      this._phase = ''
    } finally {
      this._busy = false
      this._canCancel = true
    }
  }

  _onEnable = async () => {
    if (this._busy) return
    if (!isPasskeyEnvironmentSupported()) {
      this._error = 'Passkeys are not supported in this browser.'
      return
    }
    this._busy = true
    this._canCancel = true  // register phase: AbortController is wired
    this._error = ''
    this._phase = 'Registering passkey…'
    this._abortController = new AbortController()
    try {
      // The migration callback walks both data layers in sequence
      // — triage first (small, fast), then OPFS reports (potentially
      // many files). Each layer's helper is no-op-safe when there's
      // nothing to convert, so an empty-vault user just gets a no-op
      // sealed-empty state.
      const ok = await enableEncryption({
        userName: this._userName.trim() || 'DeepView user',
        rpName: 'DeepView',
        signal: this._abortController.signal,
        migrate: async ({ seal }) => {
          // Crossing into migrate — abort signal isn't propagated
          // through the migration sweep, so a Cancel here would
          // strand the partial encryption. Block Cancel.
          this._canCancel = false
          this._phase = 'Encrypting workspaces and metadata…'
          await migrateSecureStorageToEncrypted({ seal })
          this._phase = 'Encrypting triage data…'
          await migrateTriageToEncrypted({ seal })
          this._phase = 'Encrypting report files…'
          await migrateOpfsFilesEncrypt({ seal })
          this._phase = 'Encrypting bundles…'
          await migrateOpfsBundlesEncrypt({ seal })
        },
      })
      if (ok) {
        this._success = true
        this._phase = ''
      }
    } catch (err) {
      // WebAuthn errors surface with `.name` that's useful (e.g.
      // `NotAllowedError` when the user cancels the prompt). The
      // vault wraps "PRF unsupported" into a friendly message; pass
      // the rest through as-is so the user sees what the browser said.
      // AbortError surfaces here when the user clicks Cancel during
      // the ceremony — surface a friendlier wording.
      if (err?.name === 'AbortError') {
        this._error = ''
      } else {
        this._error = err?.message ?? String(err)
      }
      this._phase = ''
    } finally {
      this._busy = false
      this._canCancel = true
      this._abortController = null
    }
  }

  _body() {
    if (this._orphan) {
      // Orphan-resolve phase. We don't render the name input or the
      // Enable button here — the user has to consciously acknowledge
      // the data loss before they get to the normal flow.
      return html`
        <p class="wsl-error">
          DeepView found an abandoned passkey setup on this device. The
          original passkey can no longer be accessed, so any local data
          still encrypted under it is <strong>unreadable</strong> and
          cannot be recovered.
        </p>
        <p class="nwd-note">
          To enable encryption, DeepView will <strong>permanently delete
          ALL local DeepView data on this device</strong> — including
          any plaintext workspaces or reports you may have added after
          the previous passkey was lost — and then register a fresh
          passkey. This is irreversible. There is no backup.
        </p>
        <label class="wsl-ack">
          <input
            type="checkbox"
            data-role="orphan-ack"
            .checked=${this._orphanAck}
            ?disabled=${this._busy}
            @change=${this._onOrphanAckInput}
          >
          <span>I understand all local DeepView data on this device will be deleted.</span>
        </label>
        ${this._phase ? html`<p class="nwd-note">${this._phase}</p>` : nothing}
        ${this._error ? html`<p class="wsl-error">${this._error}</p>` : nothing}
        <footer class="nwd-actions">
          <span class="nwd-spacer"></span>
          <button type="button" ?disabled=${this._busy && !this._canCancel} @click=${this._onCancel}>Cancel</button>
          <button
            type="button"
            class="primary"
            ?disabled=${this._busy || !this._orphanAck}
            @click=${this._onWipeOrphan}
          >${this._busy ? 'Working…' : 'Wipe and continue'}</button>
        </footer>
      `
    }
    if (this._success) {
      return html`
        <p class="nwd-note">
          <strong>Encryption is on.</strong> Your triage data and report
          files are now sealed under your passkey. You'll be asked to
          unlock with the passkey on every fresh load.
        </p>
        <footer class="nwd-actions">
          <span class="nwd-spacer"></span>
          <button type="button" class="primary" @click=${() => this._finish(true)}>Close</button>
        </footer>
      `
    }
    const supported = isPasskeyEnvironmentSupported()
    return html`
      <p class="nwd-note">
        Passkey encryption protects your local triage and report data
        with a hardware-backed key (TouchID, Windows Hello, security
        key). Without the passkey, the data on disk is unreadable —
        even to scripts running on this origin.
      </p>
      <p class="wsl-error">
        <strong>If you lose access to this passkey, your data
        CANNOT be recovered.</strong> DeepView has no backup key,
        no recovery code, and no escrow. Make sure your passkey
        is backed up (iCloud Keychain / Google Password Manager
        sync, or a second registered device) before relying on
        encryption for important data.
      </p>
      <p class="nwd-note">
        <strong>Opt-in.</strong> You can disable encryption later from
        the lock icon in the sidebar header — the data is rewritten as
        plaintext and DeepView signals your authenticator to remove
        the passkey (where supported).
      </p>
      ${supported ? nothing : html`
        <p class="wsl-error">
          Your browser doesn't expose the WebAuthn passkey API. Try
          Chrome, Safari, Edge, or Firefox in a recent version on a
          device with a platform authenticator.
        </p>`}
      <label class="wsl-field">
        <span>Passkey label</span>
        <input
          type="text"
          class="nwd-input"
          data-role="name"
          placeholder="DeepView"
          maxlength="200"
          .value=${this._userName}
          @input=${this._onNameInput}
        >
      </label>
      ${this._phase ? html`<p class="nwd-note">${this._phase}</p>` : nothing}
      ${this._error ? html`<p class="wsl-error">${this._error}</p>` : nothing}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" ?disabled=${this._busy && !this._canCancel} @click=${this._onCancel}>Cancel</button>
        <button
          type="button"
          class="primary"
          ?disabled=${!supported || this._busy}
          @click=${this._onEnable}
        >${this._busy ? 'Working…' : 'Enable encryption'}</button>
      </footer>
    `
  }

  render() {
    return html`<dialog class="new-workspace-dialog workspace-share-dialog" @close=${this._onClose} @cancel=${this._onDialogCancel}>
      <header class="nwd-head">
        <h3>${
          this._success ? 'Encryption enabled'
          : this._orphan ? 'Previous passkey setup detected'
          : 'Enable passkey encryption'
        }</h3>
      </header>
      ${this._body()}
    </dialog>`
  }
}

customElements.define('passkey-setup-dialog', PasskeySetupDialog)

export function openPasskeySetupDialog() {
  return new Promise((resolve) => {
    const el = document.createElement('passkey-setup-dialog')
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    document.body.append(el)
  })
}
