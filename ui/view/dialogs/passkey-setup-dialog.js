// Opt-in to passkey-derived encryption at rest of triage and OPFS reports,
// from the sidebar's "Enable encryption". Resolves true once the vault is on
// and unlocked and current local data sealed under the new passkey. The sweep
// is passkey-vault's enableEncryption, inside the vault's Web Lock so a sibling
// tab can't race it; this collects the passkey's label (the hostname by
// default) and shows progress.
import { html, nothing, unsafeCSS } from 'lit'
import { enableEncryption, hasOrphanedUserId, isEncryptionEnabled, isPasskeyEnvironmentSupported, migrateOpfsBundlesEncrypt, migrateOpfsFilesEncrypt, migrateSecureStorageToEncrypted, migrateTriageToEncrypted, onVaultStateChange, wipeAllVaultData } from '#client/index.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import shareCSS from './dialog-share.css'

const ENABLED_ELSEWHERE = 'Encryption was just enabled in another tab.'

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
    // A user id left from a vault whose metadata is gone (devtools wipe,
    // profile reset, partial setup): whatever it encrypted is unreadable for
    // good, which is said before anything is enabled.
    this._orphan = false
    // The wipe that clears it deletes ALL local data, so it waits for this.
    this._orphanAck = false
    // Cancel works while registering (its AbortController unwinds it), not
    // while migrating or wiping, which take no abort and would be stranded.
    this._canCancel = true
    this._abortController = null
  }

  // On success the Enable button is gone; give its focus to Close.
  updated(changed) {
    if (changed.has('_success') && this._success) this.renderRoot.querySelector('footer button.primary')?.focus()
  }

  beforeOpen() {
    // The label the OS passkey manager shows, as `user.name`.
    if (typeof location !== 'undefined') this._userName = location.hostname || 'DeepView'
    this._orphan = hasOrphanedUserId()
    // A sibling tab enabling or wiping meanwhile invalidates the orphan body
    // (or races `_onEnable`); view.js's cross-tab reload alert takes over.
    this._vaultStateUnsub = onVaultStateChange(() => {
      if (this._settled) return
      const stillOrphan = hasOrphanedUserId()
      if (this._orphan && !stillOrphan && isEncryptionEnabled()) {
        this._error = `${ENABLED_ELSEWHERE} Close this dialog and reload to unlock.`
        this._busy = false
        this._canCancel = true
      } else if (this._orphan !== stillOrphan) {
        this._orphan = stillOrphan
      }
    })
  }

  // After the render `beforeOpen`'s `_orphan` asked for, or there's no field yet.
  async focusInitial() {
    await this.updateComplete
    this.renderRoot.querySelector(this._orphan ? 'input[data-role="orphan-ack"]' : 'input[data-role="name"]')?.focus()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    try { this._vaultStateUnsub?.() } catch {}
    this._vaultStateUnsub = null
  }

  // Aborts a ceremony in flight, so the OS prompt goes; enableEncryption
  // retracts the credential it created (signalUnknownCredential).
  _finish(success) {
    if (this._settled) return
    try { this._abortController?.abort() } catch {}
    super._finish(Boolean(success))
  }

  _onClose = () => this._finish(this._success)
  // The Cancel button, disabled while blocked, and Esc's native `cancel`.
  _onCancel = (e) => {
    if (this._busy && !this._canCancel) e?.preventDefault()
    else this._finish(false)
  }

  _onNameInput = (e) => { this._userName = e.target.value }
  _onOrphanAckInput = (e) => { this._orphanAck = e.target.checked }

  // Clears the user id, every secure-storage key and the OPFS report and
  // bundle dirs, then goes on to the normal enable flow.
  _onWipeOrphan = async () => {
    if (this._busy || !this._orphanAck) return
    // Spares the lock wait; the wipe's own `refuseIfEnabled` check inside
    // VAULT_LOCK is the guarantee.
    if (isEncryptionEnabled()) {
      this._error = `${ENABLED_ELSEWHERE} Reload this page to unlock.`
      return
    }
    this._busy = true
    this._canCancel = false
    this._error = ''
    this._phase = 'Clearing previous vault state…'
    try {
      await wipeAllVaultData({ refuseIfEnabled: true })
      // In-memory state outlives the wipe (bundle and finding indices, the
      // storage read cache, rendered UI naming deleted files), as on the lock
      // overlay's wipe; setup is run again after.
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
    this._canCancel = true
    this._error = ''
    this._phase = 'Registering passkey…'
    this._abortController = new AbortController()
    try {
      // Each helper is a no-op with nothing to convert.
      const ok = await enableEncryption({
        userName: this._userName.trim() || 'DeepView user',
        rpName: 'DeepView',
        signal: this._abortController.signal,
        migrate: async ({ seal }) => {
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
      // A cancel during the ceremony aborts; that's no failure.
      this._error = err?.name === 'AbortError' ? '' : err?.message ?? String(err)
      this._phase = ''
    } finally {
      this._busy = false
      this._canCancel = true
      this._abortController = null
    }
  }

  _status() {
    return html`${this._phase ? html`<p class="nwd-note">${this._phase}</p>` : nothing}
      ${this._error ? html`<p class="wsl-error">${this._error}</p>` : nothing}`
  }

  _footer(label, disabled, action) {
    return html`<footer class="nwd-actions">
      <span class="nwd-spacer"></span>
      <button type="button" ?disabled=${this._busy && !this._canCancel} @click=${this._onCancel}>Cancel</button>
      <button
        type="button"
        class="primary"
        ?disabled=${disabled}
        @click=${action}
      >${this._busy ? 'Working…' : label}</button>
    </footer>`
  }

  _orphanBody() {
    return html`
      <p class="wsl-error">
        DeepView found an abandoned passkey setup on this device. The
        original passkey can no longer be accessed, so any local data
        still encrypted under it is <strong>unreadable</strong> and
        cannot be recovered.
      </p>
      <p class="nwd-note ui-hint">
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
      ${this._status()}
      ${this._footer('Wipe and continue', this._busy || !this._orphanAck, this._onWipeOrphan)}
    `
  }

  _enableBody() {
    const supported = isPasskeyEnvironmentSupported()
    return html`
      <p class="nwd-note ui-hint">
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
      <p class="nwd-note ui-hint">
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
      ${this._status()}
      ${this._footer('Enable encryption', !supported || this._busy, this._onEnable)}
    `
  }

  _successBody() {
    return html`
      <p class="nwd-note ui-hint">
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

  render() {
    return html`<dialog @close=${this._onClose} @cancel=${this._onCancel}>
      <header>
        <h3>${this._success ? 'Encryption enabled' : this._orphan ? 'Previous passkey setup detected' : 'Enable passkey encryption'}</h3>
      </header>
      ${this._orphan ? this._orphanBody() : this._success ? this._successBody() : this._enableBody()}
    </dialog>`
  }
}

customElements.define('passkey-setup-dialog', PasskeySetupDialog)

export function openPasskeySetupDialog() {
  return openAppDialog('passkey-setup-dialog')
}
