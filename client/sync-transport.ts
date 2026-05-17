// Singleton `SocketTransport` shared between the two v1 triage-sync
// consumers: `client/triage-sync.ts` and the production wiring of
// `client/objstore.ts` (via `ui/view/objstore-presence.js`). Both
// subsystems target the same relay endpoint, so collapsing them onto
// one WebSocket cuts the per-client TCP connection count in half,
// shares one `authenticate` round-trip, and shares one heartbeat —
// the wins steps 1-3 of the unification PR set up but couldn't yet
// realize because each consumer still held its own transport.
//
// Lifecycle:
//   * Triage-sync acquires while `isActive()` (URL + userEnabled
//     + !forcedOff).
//   * Each open objstore workspace session acquires for its lifetime.
//   The transport's refcount stays > 0 as long as ANY consumer wants
//   the socket — so toggling sync off without closing workspaces
//   keeps the socket open for objstore, and closing the last
//   workspace without disabling sync keeps it open for triage-sync.
//
// Auth resolver:
//   The transport calls `authenticationResolver` for the operator-
//   side first-action password gate. `setAuthenticationResolver(fn)`
//   installs the live binding from app boot; the wrapper below is
//   late-binding so calls to `runAuthFlow()` reach the resolver
//   installed AFTER the transport was constructed.
//
// Tests intentionally do NOT use this singleton. `createObjstoreSession`
// and `createObjstoreClient` (when called without a `transport` dep)
// each create their own isolated transport so peer-broadcast tests
// can run two clients against the same server on separate sockets.

import { type SocketTransport, createSocketTransport } from './socket-transport.ts'

export type AuthenticationResolver = (context: { retry: boolean }) => Promise<string | null | undefined>

let authenticationResolver: AuthenticationResolver | null = null

export function setSharedAuthResolver(fn: AuthenticationResolver | null): void {
  authenticationResolver = typeof fn === 'function' ? fn : null
}

const sharedTransport: SocketTransport = createSocketTransport({
  // Server URL starts empty; triage-sync's `setServerUrl` populates
  // it via `sharedTransport.setServerUrl(url)`. Production objstore
  // never calls `setServerUrl` on the shared transport — it expects
  // triage-sync to drive that.
  serverUrl: '',
  authResolver: (ctx) => authenticationResolver == null
    ? Promise.resolve(null)
    : authenticationResolver(ctx),
})

export function getSharedTransport(): SocketTransport {
  return sharedTransport
}
