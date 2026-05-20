// First-time encryption nudge — fires the first time the user
// performs a meaningful action that creates new local data
// (currently: dropping a file, creating a workspace), provided:
//   1. The passkey vault is NOT already enabled.
//   2. The browser exposes WebAuthn (passkeys are usable).
//   3. We haven't asked before (gated by a localStorage flag).
//
// If the user accepts, the setup dialog runs and migrates whatever
// happens to already be on disk; the action that triggered the
// prompt then proceeds and lands as ENCRYPTED data (the session
// key is set by setup before the awaited prompt resolves).
// Declining sets the flag too, so we don't pester the user on
// every subsequent action. The flag can be cleared by manually
// removing the localStorage key — there's no in-app affordance
// for that, but the encryption icon in the sidebar header is
// still always available for an explicit later enable.

import { isEncryptionEnabled, isPasskeyEnvironmentSupported } from '#client/index.js'
import { openPasskeySetupDialog } from './dialogs/passkey-setup-dialog.js'

const PROMPTED_KEY = 'deepview.passkey.firstImportPrompted'

function alreadyPrompted() {
  try { return localStorage.getItem(PROMPTED_KEY) === '1' } catch { return false }
}
function markPrompted() {
  try { localStorage.setItem(PROMPTED_KEY, '1') } catch {}
}

// Decide-and-run. Resolves once the prompt (and any follow-up
// setup dialog) has settled — caller awaits this BEFORE the
// action that creates new local data so any encryption setup the
// user chooses takes effect for that data.
//
// Flag semantics — only set the prompted flag on a SETTLED outcome:
//   - explicit Cancel on the native confirm → user said "no",
//     don't pester on subsequent actions.
//   - setup dialog completed AND vault is now enabled → success;
//     no need to re-prompt.
//   - user accepted confirm but cancelled the setup dialog, or the
//     WebAuthn ceremony failed → leave the flag UNSET so the next
//     action re-asks. Without this, a single mis-click on the
//     confirm followed by a setup-dialog cancel would permanently
//     shut the user out of the prompt with no in-app affordance
//     to bring it back.
export async function maybePromptFirstUse() {
  if (isEncryptionEnabled()) return
  if (!isPasskeyEnvironmentSupported()) return
  if (alreadyPrompted()) return
  // Cheap, native, consistent with the "Disable encryption?"
  // confirm in the sidebar header toggle. A full-fledged dialog
  // would duplicate what the setup dialog already explains; we
  // just gate the launch.
  const accept = confirm(
    'Encrypt your DeepView data with a passkey?\n\n'
    + 'Your triage notes, workspaces, and report files are stored on this device. '
    + 'Encryption locks them under a passkey (TouchID, Windows Hello, security key) '
    + 'so scripts running here can\'t read them without the passkey.\n\n'
    + 'You can change this anytime from the lock icon in the sidebar header.',
  )
  if (!accept) {
    markPrompted()
    return
  }
  await openPasskeySetupDialog()
  if (isEncryptionEnabled()) markPrompted()
}

// Back-compat alias — existing call sites use the import name.
export const maybePromptFirstImport = maybePromptFirstUse
