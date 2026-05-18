// Singleton `SocketTransport` shared between the two v1 triage-sync
// consumers: `client/triage-sync.ts` and the production wiring of
// `client/objstore.ts` (via `ui/view/objstore-presence.js`). Both
// target the same relay; one WebSocket carries both planes.
//
// Lifecycle: triage-sync holds an acquire while `isActive()` (URL
// + userEnabled + !forcedOff); each open objstore workspace
// session holds one for its lifetime. Refcount > 0 ⇒ socket open.
//
// Tests intentionally bypass this singleton: `createObjstoreSession`
// and `createObjstoreClient` (no `transport` dep) each create their
// own isolated transport for peer-broadcast isolation.

import { type SocketTransport, createSocketTransport } from './socket-transport.ts'

export type AuthenticationResolver = (context: { retry: boolean }) => Promise<string | null | undefined>

// Late-bound: `setSharedAuthResolver` runs at app boot, AFTER the
// transport below is constructed. The `authResolver` closure below
// reads through this binding so calls reach the live resolver.
let authenticationResolver: AuthenticationResolver | null = null

export function setSharedAuthResolver(fn: AuthenticationResolver | null): void {
  authenticationResolver = typeof fn === 'function' ? fn : null
}

const sharedTransport: SocketTransport = createSocketTransport({
  // Empty URL — triage-sync's `setServerUrl` populates later.
  // Production objstore never calls setServerUrl on the shared
  // transport; triage-sync drives it.
  serverUrl: '',
  authResolver: (ctx) => authenticationResolver == null
    ? Promise.resolve(null)
    : authenticationResolver(ctx),
})

export function getSharedTransport(): SocketTransport {
  return sharedTransport
}
