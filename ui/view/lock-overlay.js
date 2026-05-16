// Full-screen overlay shown when the passkey vault is enabled but
// this tab hasn't unlocked it yet. The rationale: when encryption
// is on and locked, there's literally nothing the user can do that
// doesn't require the decrypted state — every list, badge, drop
// target depends on data we can't read. Rather than presenting a
// half-functional UI that surfaces "vault locked" errors on every
// click, we cover everything with an unlock affordance.
//
// Sole interactive surface during the locked-boot state. Clicking
// the primary button calls `unlockEncryption` DIRECTLY — no
// intermediate confirmation dialog. The same dialog used to layer
// on top here for symmetry with the icon-button path, but a
// dedicated dialog adds an extra click for no value: the overlay
// itself IS the unlock prompt.

import { isEncryptionEnabled, isPasskeyEnvironmentSupported, isUnlocked, onVaultStateChange, unlockEncryption, wipeAllVaultData } from '../../client/passkey-vault.js'

let overlayEl = null
let busy = false
let abortController = null

// Translate browser-raw WebAuthn errors into user-readable strings.
// The raw `.message` from a `SecurityError` / `InvalidStateError` /
// network-bound RP-id mismatch reads like spec text ("The relying
// party ID is not a registrable domain suffix…") — informative for
// a developer but useless for a user trying to unlock. NotAllowed
// is filtered upstream (vault treats it as silent cancel) but we
// keep it here for defense-in-depth.
function friendlyUnlockError(err) {
  if (!err) return 'Could not unlock. Try again.'
  const name = err.name ?? ''
  switch (name) {
    case 'NotAllowedError':
    case 'AbortError':
      return ''
    case 'SecurityError':
      return 'The site identity does not match the one this passkey was registered for. If you opened DeepView through a different URL (different subdomain, different port), reload via the original URL.'
    case 'InvalidStateError':
      return 'The passkey state on this device is inconsistent. Try reloading the page or removing and re-creating the passkey.'
    case 'NotSupportedError':
      return 'This browser does not support the WebAuthn PRF extension this site needs. Try a recent Chrome, Safari, or Edge with a platform authenticator.'
    case 'NetworkError':
      return 'A network error prevented the passkey from completing. Check your connection and try again.'
    case 'UnknownError':
      return 'The authenticator returned an unknown error. Try again, or use a different passkey.'
    default: {
      // Unrecognised — surface the message as a last resort so the
      // user has SOMETHING to search for. Truncate so a paragraph-
      // long spec quote doesn't blow out the overlay layout.
      const msg = err.message ?? String(err)
      return msg.length > 200 ? msg.slice(0, 197) + '…' : msg
    }
  }
}

function ensureOverlay() {
  if (overlayEl) return overlayEl
  overlayEl = document.createElement('div')
  overlayEl.id = 'lock-overlay'
  overlayEl.setAttribute('role', 'dialog')
  overlayEl.setAttribute('aria-modal', 'true')
  overlayEl.setAttribute('aria-label', 'Unlock DeepView')
  overlayEl.innerHTML = `
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
  `
  const btn = overlayEl.querySelector('button')
  const errEl = overlayEl.querySelector('.lock-overlay-error')
  btn.addEventListener('click', async () => {
    if (busy) return
    busy = true
    errEl.hidden = true
    errEl.textContent = ''
    btn.disabled = true
    btn.textContent = 'Waiting…'
    abortController = new AbortController()
    try {
      const ok = await unlockEncryption({ signal: abortController.signal })
      if (!ok) {
        // User cancelled OS prompt — silent, overlay stays so they
        // can retry.
      }
    } catch (err) {
      const msg = friendlyUnlockError(err)
      errEl.textContent = msg
      // Hide via the `hidden` attribute when the message is empty —
      // an empty `<p>` still claims its `margin-bottom` per the CSS,
      // so the overlay card visibly jumps on benign cancel paths.
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
    // Guard against the unlock button being in-flight when the
    // user clicks wipe — both paths would otherwise mutate vault
    // state concurrently (the unlock can succeed while wipe is
    // mid-clear, producing a session key bound to nothing).
    if (busy) return
    // Two-step confirm — losing a passkey is one thing, but losing
    // ALL the encrypted local data is the kind of irreversible step
    // that deserves explicit acknowledgement.
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
      // `refuseIfEnabled: true` matches the orphan-setup-dialog
      // wipe path. A sibling tab racing to enable encryption during
      // our two-confirm window would have its just-enabled vault
      // destroyed without this guard. The user clicked "Wipe local
      // data" because their original passkey is lost — that
      // assumption no longer holds if a sibling just enabled fresh
      // encryption, so refusing forces them to reload and try
      // again instead.
      await wipeAllVaultData({ refuseIfEnabled: true })
    } catch (err) {
      alert(`Wipe failed: ${err?.message ?? err}. Try again or clear localStorage manually via DevTools.`)
      return
    }
    // Reload so the page restarts with a clean slate.
    location.reload()
  })
  document.body.append(overlayEl)
  return overlayEl
}

function shouldShow() {
  if (!isPasskeyEnvironmentSupported()) return false
  return isEncryptionEnabled() && !isUnlocked()
}

function render() {
  if (shouldShow()) {
    const el = ensureOverlay()
    el.hidden = false
    // Move focus to the unlock button so Enter triggers it. Done
    // on every show because dialogs / other interactions may have
    // pulled focus elsewhere.
    const btn = el.querySelector('button')
    if (btn) btn.focus()
  } else if (overlayEl) {
    overlayEl.hidden = true
    // Abort any in-flight unlock attempt so the OS prompt closes
    // when the vault transitions out of locked (e.g. sibling tab
    // disabled the vault).
    if (abortController) {
      try { abortController.abort() } catch {}
    }
  }
}

onVaultStateChange(render)
render()
