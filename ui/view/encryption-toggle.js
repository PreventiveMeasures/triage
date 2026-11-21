// The sidebar header's encryption toggle, left of the hamburger, in three
// states: an open lock (encryption off; opens setup), a closed lock in the
// accent (on and unlocked here; offers to disable), and a closed lock in the
// warning tint (on, but this tab hasn't unlocked — a dismissed boot dialog,
// or a sibling tab just enabled it; re-opens the unlock), so data that is
// inaccessible doesn't read as absent. Hidden without WebAuthn, and in
// managed mode.

import { html, render as litRender } from 'lit'
import { disableEncryption, isEncryptionEnabled, isManagedUiMode, isPasskeyEnvironmentSupported, isUnlocked, migrateOpfsBundlesDecrypt, migrateOpfsFilesDecrypt, migrateSecureStorageToPlaintext, migrateTriageToPlaintext, onVaultStateChange } from '#client/index.js'
import { openPasskeySetupDialog } from './lazy-dialogs.js'
// Up front, not in the dialogs' bundle (lazy-dialogs.js says why).
import { openPasskeyUnlockDialog } from './dialogs/passkey-unlock-dialog.js'
import { ensureClientMode } from './sidebar.js'

// Lucide's lock / unlock: the open shackle swings up and away, so the two
// read apart even at 13px.
const LOCKED_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="10" height="6" rx="1"/><path d="M5 8V5.5a3 3 0 0 1 6 0V8"/></svg>`
const UNLOCKED_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="10" height="6" rx="1"/><path d="M5 8V5a3 3 0 0 1 6 -0.5"/></svg>`

// The sidebar's shadow-DOM button, once initEncryptionToggle hands it over.
let button = null

async function render() {
  if (!button) return
  await ensureClientMode()
  if (isManagedUiMode() || !isPasskeyEnvironmentSupported()) {
    button.hidden = true
    return
  }
  const enabled = isEncryptionEnabled()
  button.hidden = false
  const unlocked = isUnlocked()
  button.classList.toggle('encrypted', enabled && unlocked)
  button.classList.toggle('locked-pending', enabled && !unlocked)
  const [tooltip, label, icon] = enabled
    ? unlocked ? ['Encryption on — click to disable', 'Disable encryption', LOCKED_ICON] : ['Encryption on, locked — click to unlock', 'Unlock encrypted data', LOCKED_ICON]
    : ['Encryption off — click to enable', 'Enable encryption', UNLOCKED_ICON]
  button.dataset.tooltip = tooltip
  button.setAttribute('aria-label', label)
  litRender(icon, button)
}

// Disable: confirm, decrypt everything, then ask the user to remove the
// passkey themselves. The WebAuthn Signal API that could hint its removal is
// Chrome 132+ and honored only by Chrome's password manager (iCloud
// Keychain, 1Password, Bitwarden and hardware keys ignore it), so both
// messages spell that out rather than leave a surprise orphan entry.
async function handleDisable() {
  if (!confirm(
    'Disable encryption?\n\n'
    + 'Your local triage and report data will be rewritten as plaintext.\n\n'
    + 'IMPORTANT: DeepView cannot directly delete your passkey. '
    + 'Most browsers / password managers require you to remove the '
    + 'entry manually after disabling. You can re-enable encryption later.',
  )) {
    return
  }
  try {
    const result = await disableEncryption({
      migrate: async ({ open }) => {
        // The enable flow's order (passkey-setup-dialog), for consistent
        // partial-migration diagnostics; the stores are independent.
        await migrateSecureStorageToPlaintext({ open })
        await migrateTriageToPlaintext({ open })
        await migrateOpfsFilesDecrypt({ open })
        await migrateOpfsBundlesDecrypt({ open })
      },
    })
    if (result?.disabled) {
      alert(
        'Encryption disabled. Your data is now plaintext.\n\n'
        + 'To complete cleanup, remove the DeepView passkey from your '
        + 'password manager / OS settings:\n'
        + '  • macOS / iOS: Settings → Passwords\n'
        + '  • Windows: Settings → Accounts → Sign-in options → Passkeys\n'
        + '  • Chrome: chrome://settings/passkeys\n'
        + '  • Hardware security key: use the vendor\'s management tool',
      )
    }
  } catch (err) {
    alert(`Could not disable encryption: ${err?.message ?? err}`)
  }
}

// For the sidebar, when the server mode changes: not a vault-state event.
export function refreshEncryptionToggle() { render() }

// Idempotent for the same element.
export function initEncryptionToggle(el) {
  if (!el || el === button) return
  button = el
  // Clicks while a handler is busy are refused: the icon keeps its state
  // through the disable migration (the vault-state event comes after it),
  // and a second click would queue a second confirm.
  let handlingClick = false
  button.addEventListener('click', async () => {
    await ensureClientMode()
    if (isManagedUiMode()) return
    if (handlingClick) return
    handlingClick = true
    try {
      if (!isEncryptionEnabled()) {
        await openPasskeySetupDialog()
        return
      }
      // A tab that hasn't unlocked can't disable: unlock first, landing on
      // the working state in one click.
      if (!isUnlocked()) {
        await openPasskeyUnlockDialog()
        return
      }
      await handleDisable()
    } finally {
      handlingClick = false
    }
  })
  onVaultStateChange(render)
  render()
}
