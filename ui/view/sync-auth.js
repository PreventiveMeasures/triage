// The operator password prompt, as triage-sync's AuthenticationResolver
// (installed at boot from view.js). It runs when the relay's first-action
// gate fires (server-e2e/sync-handlers.ts: `requiresAuth(socket) &&
// !workspaceExists(tag)`) with no cached password to replay. The entered
// string is sent as `authenticate { password }`; null cancels, leaving the
// save pending for a later trigger.
import { setAuthenticationResolver } from './client-sync.js'
// Up front, not in the dialogs' bundle (lazy-dialogs.js says why).
import { openSyncAuthDialog } from './dialogs/sync-auth-dialog.js'

export function installSyncAuthResolver() {
  setAuthenticationResolver(async ({ retry }) => {
    try {
      return await openSyncAuthDialog({ retry })
    } catch (err) {
      // Another modal is open: bail (the user edits again once it closes).
      // The resolver must never throw and abort triage-sync's `runAuthFlow`.
      console.warn('Sync auth dialog failed to open:', err)
      return null
    }
  })
}
