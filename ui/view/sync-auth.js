// Wire the operator-side password prompt into triage-sync's
// `AuthenticationResolver` slot. Called once at app boot from
// view.js, alongside `installHydrationConflictResolver`.
//
// The resolver runs each time the relay's first-action gate fires
// (server-side `requiresAuth(socket) && !workspaceExists(tag)` in
// server-e2e/index.ts) and the client has no cached password to replay
// silently. Returning the entered string sends
// `authenticate { password }` over the wire; returning null cancels
// — the pending save sits in `pendingSave` until a future trigger
// (the user can re-edit, or pick "retry" once they remember the
// password).
import { setAuthenticationResolver } from './client-sync.js'
import { openSyncAuthDialog } from './dialogs/sync-auth-dialog.js'

export function installSyncAuthResolver() {
  setAuthenticationResolver(async ({ retry }) => {
    try {
      return await openSyncAuthDialog({ retry })
    } catch (err) {
      // Stacked-modal failure (another modal is open). No useful
      // recovery — the auth flow bails on the null return; the user
      // re-triggers by editing again once the blocking modal closes.
      // Log so a debug session can correlate. Mirrors
      // hydration-conflict.js: never let the resolver throw and abort
      // triage-sync's `runAuthFlow`.
      console.warn('Sync auth dialog failed to open:', err)
      return null
    }
  })
}
