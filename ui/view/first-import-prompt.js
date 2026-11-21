// The first-use encryption nudge, before the first action creating local
// data (a file drop, a new workspace), when the vault isn't enabled, the
// browser has passkeys, and it hasn't asked before (a localStorage flag; the
// sidebar's lock icon stays for a later enable). Accepted, setup runs and
// migrates what is on disk, and the action then lands encrypted.

import { isEncryptionEnabled, isPasskeyEnvironmentSupported } from '#client/index.js'
import { openPasskeySetupDialog } from './lazy-dialogs.js'

const PROMPTED_KEY = 'deepview.passkey.firstImportPrompted'

function alreadyPrompted() {
  try { return localStorage.getItem(PROMPTED_KEY) === '1' } catch { return false }
}
function markPrompted() {
  try { localStorage.setItem(PROMPTED_KEY, '1') } catch {}
}

// Awaited before the action, so a chosen encryption covers its data. The
// flag is set only on a settled answer — a Cancel, or a vault now enabled —
// so a setup cancelled after accepting (or a failed ceremony) asks again:
// one mis-click mustn't shut the prompt out for good.
export async function maybePromptFirstUse() {
  if (isEncryptionEnabled()) return
  if (!isPasskeyEnvironmentSupported()) return
  if (alreadyPrompted()) return
  // A native confirm, as the header toggle's disable is: the setup dialog
  // explains the rest.
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
