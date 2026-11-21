// Full-screen overlay while the passkey vault is enabled but this tab hasn't
// unlocked it: every list, badge and drop target needs decrypted state, so
// one unlock affordance covers everything rather than a UI spamming "vault
// locked" errors. The overlay IS the unlock prompt: its button calls
// `unlockEncryption` directly.

import { isEncryptionEnabled, isManagedUiMode, isPasskeyEnvironmentSupported, isUnlocked, onVaultStateChange, unlockEncryption, wipeAllVaultData } from '#client/index.js'
import { ensureClientMode } from './sidebar.js'
import { html, render as litRender } from 'lit'

let overlayEl = null
let busy = false
let abortController = null

// WebAuthn's raw messages read like spec text ("The relying party ID is not
// a registrable domain suffix…"). A cancel says nothing (the vault already
// treats NotAllowed as one).
const UNLOCK_ERRORS = {
  NotAllowedError: '',
  AbortError: '',
  SecurityError: 'The site identity does not match the one this passkey was registered for. If you opened DeepView through a different URL (different subdomain, different port), reload via the original URL.',
  InvalidStateError: 'The passkey state on this device is inconsistent. Try reloading the page or removing and re-creating the passkey.',
  NotSupportedError: 'This browser does not support the WebAuthn PRF extension this site needs. Try a recent Chrome, Safari, or Edge with a platform authenticator.',
  NetworkError: 'A network error prevented the passkey from completing. Check your connection and try again.',
  UnknownError: 'The authenticator returned an unknown error. Try again, or use a different passkey.',
}

function friendlyUnlockError(err) {
  if (!err) return 'Could not unlock. Try again.'
  const name = err.name ?? ''
  if (Object.hasOwn(UNLOCK_ERRORS, name)) return UNLOCK_ERRORS[name]
  // Something to search for, cut short of blowing out the card's layout.
  const msg = err.message ?? String(err)
  return msg.length > 200 ? msg.slice(0, 197) + '…' : msg
}

function ensureOverlay() {
  if (overlayEl) return overlayEl
  overlayEl = document.createElement('div')
  overlayEl.id = 'lock-overlay'
  overlayEl.setAttribute('role', 'dialog')
  overlayEl.setAttribute('aria-modal', 'true')
  overlayEl.setAttribute('aria-label', 'Unlock DeepView')
  litRender(html`
    <div class="lock-overlay-card">
      <div class="lock-overlay-icon" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="15" width="18" height="12" rx="1.5"/><path d="M11 15v-4a5 5 0 0 1 10 0v4"/></svg>
      </div>
      <h2 class="lock-overlay-title">DeepView is locked</h2>
      <p class="lock-overlay-body">
        Your triage data and reports are encrypted with a passkey on
        this device. Unlock to continue.
      </p>
      <p class="lock-overlay-error" hidden></p>
      <button type="button" class="lock-overlay-button primary">Unlock with passkey</button>
      <p class="lock-overlay-footer">
        Lost your passkey?
        <a href="#" class="lock-overlay-wipe">Wipe local data and start over</a>
      </p>
    </div>
  `, overlayEl)
  const btn = overlayEl.querySelector('button')
  const errEl = overlayEl.querySelector('.lock-overlay-error')
  btn.addEventListener('click', async () => {
    if (busy || !shouldShow()) return
    busy = true
    errEl.hidden = true
    errEl.textContent = ''
    btn.disabled = true
    btn.textContent = 'Waiting…'
    abortController = new AbortController()
    try {
      // A cancelled OS prompt resolves `false`: the overlay stays, to retry.
      await unlockEncryption({ signal: abortController.signal })
    } catch (err) {
      const msg = friendlyUnlockError(err)
      errEl.textContent = msg
      // An empty `<p>` still claims its margin, jumping the card on a cancel.
      errEl.hidden = !msg
    } finally {
      busy = false
      abortController = null
      btn.disabled = false
      btn.textContent = 'Unlock with passkey'
    }
  })
  const wipeLink = overlayEl.querySelector('.lock-overlay-wipe')
  wipeLink.addEventListener('click', async (e) => {
    e.preventDefault()
    // Not while an unlock is in flight: it could succeed mid-wipe, binding a
    // session key to nothing.
    if (busy || !shouldShow()) return
    // Two confirms: all the encrypted local data goes, irrecoverably.
    if (!confirm(
      'Wipe ALL local DeepView data and start over?\n\n'
      + 'This deletes your encrypted triage, all reports, and the '
      + 'passkey registration on this device. The data CANNOT be '
      + 'recovered after this — there is no backup.\n\n'
      + 'Use this only if you have lost access to your passkey and '
      + 'have no other way to unlock.',
    )) return
    if (!confirm('Really wipe everything? This cannot be undone.')) return
    try {
      // No `refuseIfEnabled: true`: this overlay shows *because* the vault is
      // enabled, the inverse of the orphan-setup-dialog wipe, which runs with
      // the vault not enabled and guards against a sibling racing an enable.
      await wipeAllVaultData()
    } catch (err) {
      alert(`Wipe failed: ${err?.message ?? err}. Try again or clear localStorage manually via DevTools.`)
      return
    }
    location.reload()
  })
  document.body.append(overlayEl)
  return overlayEl
}

function shouldShow() {
  // Server-owned reports never depend on this origin's local vault.
  if (isManagedUiMode()) return false
  if (!isPasskeyEnvironmentSupported()) return false
  return isEncryptionEnabled() && !isUnlocked()
}

async function render() {
  // On an uncached visit the default mode is e2e until detection completes.
  // Do not flash an unlock/wipe prompt over a managed landing in that window.
  await ensureClientMode()
  if (shouldShow()) {
    const el = ensureOverlay()
    el.hidden = false
    // Focus the unlock button on every show, so Enter triggers it.
    const btn = el.querySelector('button')
    if (btn) btn.focus()
  } else if (overlayEl) {
    overlayEl.hidden = true
    // Leaving the locked state (a sibling tab disabled the vault, say)
    // closes an in-flight unlock's OS prompt.
    if (abortController) {
      try { abortController.abort() } catch {}
    }
  }
}

onVaultStateChange(render)
document.addEventListener('managed-client-mode-change', render)
void render()
