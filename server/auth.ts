// Operator-side password gate. Optionally gates the FIRST action
// against a never-before-seen workspace tag behind a shared password
// (config.json). Once a connection completes the `authenticate
// { password }` handshake its Peer is marked authorized and every
// subsequent first-action bypasses the gate; once a workspace exists
// on the server the gate is off for it regardless of connection.
//
// Comparison is HMAC-SHA-256 under a per-process random key derived
// here: the configured password is HMAC'd once at construction (the
// raw bytes aren't retained), and each `authenticate` HMACs the
// submitted password and compares with `timingSafeEqual`. Fixed
// 32-byte digests mean no length-equal precondition (no length leak),
// and any residual timing variance reveals only HMAC bytes useless
// without the per-process key. `null` configured HMAC = no gate.

import type { WebSocket } from 'ws'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { PeerRegistry } from './peer.ts'

// Server → Client `unauthorized` frame context. The explicit `kind`
// discriminator is the wire contract: callers MUST switch on it rather
// than infer from field presence. The client's wire dispatcher and the
// objstore client's put-begin recv predicate both pin on `kind`.
export type UnauthorizedContext =
  | { kind: 'gated'; workspaceTag: string; base: string | null }       // workspace-save gated
  | { kind: 'gated'; workspaceTag: string; resourceTag: string }       // objstore-put-begin gated
  | { kind: 'auth-failed' }                                             // authenticate-failed

export type AuthenticateMsg = { password?: unknown }

export type Auth = {
  // True iff the gate is configured AND this socket hasn't authenticated.
  requiresAuth(socket: WebSocket): boolean
  handleAuthenticate(socket: WebSocket, msg: AuthenticateMsg): void
  sendUnauthorized(socket: WebSocket, ctx: UnauthorizedContext): void
}

// Pre-shape gate: a submitted password must be a non-empty string,
// length-capped so a peer can't make us HMAC megabytes per frame
// (this handler is fast-inlined outside the per-socket inflight cap).
// 4096 is far above any real password, well below the 4 MiB frame cap.
const MAX_AUTH_PASSWORD_LEN = 4096

export function createAuth(deps: {
  peers: PeerRegistry
  password: string | null
  send: (socket: WebSocket, msg: object) => void
  debug: boolean
}): Auth {
  const { peers, password, send, debug } = deps
  const PASSWORD_HMAC_KEY = new Uint8Array(randomBytes(32))
  // `null` is the "no gate" sentinel every check reads (absent / empty).
  const CONFIGURED_PASSWORD_HMAC: Uint8Array<ArrayBuffer> | null =
    password == null || password === ''
      ? null
      : new Uint8Array(createHmac('sha256', PASSWORD_HMAC_KEY).update(password, 'utf8').digest())

  function isAuthorized(socket: WebSocket): boolean {
    return peers.get(socket)?.authorized === true
  }
  function markAuthorized(socket: WebSocket): void {
    const peer = peers.get(socket)
    if (peer) peer.authorized = true
  }
  function requiresAuth(socket: WebSocket): boolean {
    if (CONFIGURED_PASSWORD_HMAC == null) return false
    return !isAuthorized(socket)
  }
  function passwordMatches(submitted: string): boolean {
    if (CONFIGURED_PASSWORD_HMAC == null) return false
    const submittedHmac = new Uint8Array(createHmac('sha256', PASSWORD_HMAC_KEY).update(submitted, 'utf8').digest())
    return timingSafeEqual(submittedHmac, CONFIGURED_PASSWORD_HMAC)
  }
  function sendUnauthorized(socket: WebSocket, ctx: UnauthorizedContext): void {
    send(socket, { type: 'unauthorized', ...ctx })
  }
  function handleAuthenticate(socket: WebSocket, msg: AuthenticateMsg): void {
    if (typeof msg.password !== 'string' || msg.password.length === 0 || msg.password.length > MAX_AUTH_PASSWORD_LEN) return
    // No-config short-circuit: when not gating, treat any authenticate
    // as success so a client can cache + replay its password on
    // reconnect even against an un-gated server (wire shape stays
    // consistent).
    if (CONFIGURED_PASSWORD_HMAC == null) {
      markAuthorized(socket)
      send(socket, { type: 'authenticated' })
      return
    }
    if (!passwordMatches(msg.password)) {
      if (debug) console.warn('authenticate: wrong password')
      sendUnauthorized(socket, { kind: 'auth-failed' })
      return
    }
    markAuthorized(socket)
    if (debug) console.log('authenticate: success')
    send(socket, { type: 'authenticated' })
  }

  return { requiresAuth, handleAuthenticate, sendUnauthorized }
}
