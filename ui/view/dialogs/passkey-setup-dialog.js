// `<passkey-setup-dialog>` — opt-in dialog for enabling passkey-
// derived encryption-at-rest of triage data + OPFS reports. Shown
// when the user clicks the sidebar's "Enable encryption" affordance;
// after a successful run the vault is enabled + unlocked in this
// tab, all current local data is sealed under the just-registered
// passkey, and the dialog resolves true.
//
// Sibling of `<workspace-share-link-dialog>` /
// `<new-workspace-dialog>`: extends `AppDialog` for the shared
// shadow-DOM dialog chrome (native <dialog> focus-trap +
// Esc-to-cancel). State machine mirrors the share-link dialog
// (form → busy → result).
//
// Migration runs in passkey-vault.enableEncryption — this dialog only
// collects the optional user-visible name (defaults to the origin's
// hostname) and surfaces progress/errors. The migration is wrapped in
// the vault's Web Lock so a sibling tab can't race a competing enable.

import { html, nothing, unsafeCSS } from 'lit'
import { enableEncryption, hasOrphanedUserId, isEncryptionEnabled, isPasskeyEnvironmentSupported, migrateOpfsBundlesEncrypt, migrateOpfsFilesEncrypt, migrateSecureStorageToEncrypted, migrateTriageToEncrypted, onVaultStateChange, wipeAllVaultData } from '#client/index.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import shareCSS from './dialog-share.css'

class PasskeySetupDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(shareCSS)]

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
    // any data on disk encrypted under it is permanently unreadable.
    // Surfaced BEFORE the normal enable flow so the user isn't
    // surprised by silent data loss.
    this._orphan = false
    // Explicit acknowledgement that ALL local data (encrypted and
    // plaintext) will be deleted by the wipe. "Wipe and continue"
    // stays disabled until checked so a misclick can't trigger the
    // destructive irreversible action.
    this._orphanAck = false
    // Allow Cancel during WebAuthn registration (the AbortController
    // plumbed into `registerPasskey` unwinds it). Flipped false at the
    // migrate / wipe phases where abort isn't propagated and a close
    // would strand the operation mid-flight.
    this._canCancel = true
    this._abortController = null
  }

  updated(changed) {
    // On success, move focus to the primary Close button — otherwise
    // it stays on the now-removed "Enable" button and keyboard users
    // must Tab to find the close affordance.
    if (changed.has('_success') && this._success) {
      const btn = this.renderRoot.querySelector('footer button.primary')
      if (btn) btn.focus()
    }
  }

  // Seed default name + orphan state + cross-tab listener before the
  // base `firstUpdated` calls `showModal()`, so the first modal
  // interaction already reflects them.
  beforeOpen() {
    // Default name = origin hostname so the user has a label without
    // typing. Editable; rides through to the authenticator as
    // "user.name", visible in the OS-level passkey manager.
    if (typeof location !== 'undefined') this._userName = location.hostname || 'DeepView'
    // Detect orphan AFTER the default-name fill so the orphan body
    // renders with the right state.
    this._orphan = hasOrphanedUserId()
    // A sibling tab enabling (or wiping) while the user reads the
    // orphan warning invalidates our assumptions: the orphan body
    // would offer to wipe a state that no longer exists, or `_onEnable`
    // would race a freshly-enabled vault. Auto-close so view.js's
    // cross-tab reload alert can take over.
    this._vaultStateUnsub = onVaultStateChange(() => {
      if (this._settled) return
      // No action needed if orphan state is still consistent.
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

  // Await the orphan/normal re-render before querying the input:
  // `beforeOpen` set `_orphan` synchronously but the render hasn't
  // landed yet. Without the await the query returns null and focus is
  // silently skipped, leaving keyboard users no visible focus.
  async focusInitial() {
    await this.updateComplete
    const selector = this._orphan ? 'input[data-role="orphan-ack"]' : 'input[data-role="name"]'
    this.renderRoot.querySelector(selector)?.focus()
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
    // Abort any in-flight WebAuthn ceremony so the system prompt
    // disappears on cancel. The vault's enableEncryption cleans up the
    // credential it just created via signalUnknownCredential.
    if (this._abortController) {
      try { this._abortController.abort() } catch {}
    }
    super._finish(!!success)
  }

  _onClose = () => this._finish(this._success)
  _onCancel = () => {
    // Cancel is ONLY safe when not busy (form / orphan-ack / success)
    // or in a phase whose wired AbortController unwinds cleanly.
    // `_abortController` is set during `registerPasskey` (abort closes
    // the OS prompt + cleans up the credential) and stays set through
    // migrate, but `_canCancel` flips false at the migrate phase since
    // the abort signal isn't plumbed through it — a close there would
    // silently abandon a partial encryption sweep. Without the guard, a
    // user stuck on an OS prompt they can't fulfil (no platform
    // authenticator, key not connected) had no way out but killing the
    // tab.
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

  // Wipe orphan state, then continue with the normal enable flow.
  // wipeAllVaultData clears USER_ID_KEY, every secure-storage key, and
  // the OPFS report/bundle dirs — anything on disk encrypted under the
  // lost passkey was unreadable anyway.
  _onWipeOrphan = async () => {
    if (this._busy) return
    if (!this._orphanAck) return
    // Fast-path guard against a sibling tab having enabled the vault.
    // The load-bearing guarantee is the wipe's own re-check inside
    // `VAULT_LOCK` with `refuseIfEnabled: true`; this just spares the
    // user the lock wait before seeing the error.
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
      // bundle-finding/bundle-hash indices, state.bundles/reports/
      // findings, the storage.js read cache, rendered UI referencing
      // now-deleted files. Without it, a finding's "Code →" hits "File
      // not found" because the index still points at wiped OPFS keys.
      // Matches the lock-overlay wipe path (also reloads). User
      // re-triggers setup after — fine for a destructive one-shot.
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
      // The migration callback walks both layers in sequence — triage
      // first (small, fast), then OPFS reports (potentially many
      // files). Each helper is no-op-safe when there's nothing to
      // convert, so an empty-vault user gets a sealed-empty state.
      const ok = await enableEncryption({
        userName: this._userName.trim() || 'DeepView user',
        rpName: 'DeepView',
        signal: this._abortController.signal,
        migrate: async ({ seal }) => {
          // Abort signal isn't propagated through the migration sweep,
          // so a Cancel here would strand a partial encryption. Block it.
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
      // The vault wraps "PRF unsupported" into a friendly message; pass
      // the rest through as-is. AbortError surfaces here on Cancel
      // during the ceremony — suppress it, it's not a failure.
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
      // Orphan-resolve phase: no name input or Enable button — the
      // user must consciously acknowledge the data loss first.
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
    return html`<dialog @close=${this._onClose} @cancel=${this._onDialogCancel}>
      <header>
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
  return openAppDialog('passkey-setup-dialog')
}
