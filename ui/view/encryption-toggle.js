// Sidebar-header encryption toggle — single-button affordance sitting
// to the LEFT of the sidebar-toggle (hamburger). Three visual states:
//   - open lock (muted)    → encryption is OFF. Click opens the setup
//                            dialog.
//   - closed lock (accent) → encryption is ON and unlocked in this
//                            tab. Click → confirm to disable.
//   - closed lock (warn)   → encryption is ON but this tab hasn't
//                            unlocked yet (user dismissed the boot
//                            dialog, or a sibling tab just enabled).
//                            Click → re-launches the unlock dialog.
//                            Visually distinct so the user notices
//                            their data is currently inaccessible
//                            rather than just absent.
//
// Hidden entirely when the environment doesn't expose WebAuthn —
// there's no path forward and the button would just be confusing.

import { html, render as litRender } from 'lit'
import { disableEncryption, isEncryptionEnabled, isPasskeyEnvironmentSupported, isUnlocked, migrateOpfsBundlesDecrypt, migrateOpfsFilesDecrypt, migrateSecureStorageToPlaintext, migrateTriageToPlaintext, onVaultStateChange } from '#client/index.js'
import { openPasskeySetupDialog } from './dialogs/passkey-setup-dialog.js'
import { openPasskeyUnlockDialog } from './dialogs/passkey-unlock-dialog.js'

// Two lock glyphs, 16×16 viewbox at 13×13 render, stroke-width 1.4
// (matching the hamburger). Follow Lucide's lock/unlock convention.
// The open version's shackle pivots up-and-away on the right (arc
// terminating in mid-air) rather than just being the closed version
// with a shorter leg, so open-vs-closed reads at a glance even at
// small sizes. Closed (symmetric horseshoe) is used for the
// encrypted states, styled by the `.encrypted` / `.locked-pending`
// modifiers.
const LOCKED_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="10" height="6" rx="1"/><path d="M5 8V5.5a3 3 0 0 1 6 0V8"/></svg>`
const UNLOCKED_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="10" height="6" rx="1"/><path d="M5 8V5a3 3 0 0 1 6 -0.5"/></svg>`

// Set by `initEncryptionToggle(el)` once the sidebar component has
// rendered the `#encryption-toggle` button into its shadow DOM.
// Before that the module's functions no-op on the null button.
let button = null

function render() {
  if (!button) return
  if (!isPasskeyEnvironmentSupported()) {
    button.hidden = true
    return
  }
  button.hidden = false
  const enabled = isEncryptionEnabled()
  const unlocked = isUnlocked()
  // Three states keyed on (enabled, unlocked). `.encrypted` paints
  // the closed-lock + accent treatment; `.locked-pending` overrides
  // the accent with a warning tint so dismissed-boot-dialog state is
  // visually distinct from working-encrypted state.
  button.classList.toggle('encrypted', enabled && unlocked)
  button.classList.toggle('locked-pending', enabled && !unlocked)
  if (enabled && unlocked) {
    button.title = 'Encryption on — click to disable'
    button.setAttribute('aria-label', 'Disable encryption')
    litRender(LOCKED_ICON, button)
  } else if (enabled) {
    button.title = 'Encryption on, locked — click to unlock'
    button.setAttribute('aria-label', 'Unlock encrypted data')
    litRender(LOCKED_ICON, button)
  } else {
    button.title = 'Encryption off — click to enable'
    button.setAttribute('aria-label', 'Enable encryption')
    litRender(UNLOCKED_ICON, button)
  }
}

// Disable encryption: confirm, run the decrypt-everything migration,
// then nudge the user to verify the passkey has been removed.
// The WebAuthn Signal API (`signalUnknownCredential` /
// `signalAllAcceptedCredentials`) is Chrome 132+ only AND only
// honored by Chrome's password manager — iCloud Keychain, 1Password,
// Bitwarden, hardware keys (YubiKey etc.) all IGNORE the hint. The
// only reliable cleanup is the user manually removing the entry from
// their OS / password manager settings. The confirm copy and the
// post-disable alert both spell that out so the user isn't
// surprised by an orphan entry sticking around.
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
        // Order mirrors the enable flow in passkey-setup-dialog:
        // secure-storage → triage → reports → bundles. The four
        // stores are independent, so the order isn't load-bearing
        // — but keeping it consistent in both directions makes
        // partial-migration diagnostics easier to reason about.
        await migrateSecureStorageToPlaintext({ open })
        await migrateTriageToPlaintext({ open })
        await migrateOpfsFilesDecrypt({ open })
        await migrateOpfsBundlesDecrypt({ open })
      },
    })
    if (result?.disabled) {
      // Spell out what to do next. Most users don't know where
      // their passkeys are managed; mention the common locations.
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

async function handleEnable() {
  await openPasskeySetupDialog()
}

// Called by the sidebar component from its `firstUpdated` with the
// `#encryption-toggle` button it just rendered into shadow DOM. The
// button used to be static light-DOM markup `document.querySelector`-ed
// at module load; now that the sidebar is a shadow-DOM component the
// wiring is deferred until the host hands us the live element.
// Idempotent on a repeat call with the same element.
export function initEncryptionToggle(el) {
  if (!el || el === button) return
  button = el
  // Re-entrancy guard. Without this, a user clicking the icon
  // during an in-flight handle* (e.g. clicking again during the
  // disable migration's busy window — `fireVaultStateChange` is
  // deferred to AFTER migrate, so the icon visually stays in the
  // enabled state) would queue a second confirm dialog and a
  // second disable call. The second call hits the early-return in
  // `disableEncryption` once metadata is cleared, but the user
  // wasted a confirm interaction. Refusing clicks while busy is
  // the right UX.
  let handlingClick = false
  button.addEventListener('click', async () => {
    if (handlingClick) return
    handlingClick = true
    try {
      if (!isEncryptionEnabled()) {
        await handleEnable()
        return
      }
      // Enabled. If this tab hasn't unlocked yet (user dismissed
      // the boot dialog, or vault was just enabled by a sibling
      // tab), the disable flow would throw — re-launch the unlock
      // prompt first so the user lands on the working state with
      // one click.
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
