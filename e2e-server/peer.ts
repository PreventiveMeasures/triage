// Per-connection server state. One `Peer` per accepted WebSocket. The
// connection handler constructs one on accept and holds it in a
// closure, so the hot paths (message dispatch, pong, close) touch
// fields directly; the few cross-function call sites look it up via
// `peers.get(socket)`.
//
// Held in a `WeakMap<WebSocket, Peer>` so a closed socket's state GCs
// with the socket; the close handler also `delete`s it explicitly
// because `ws` keeps the socket strongly referenced well past close.

import type { WebSocket } from 'ws'

export class Peer {
  // Per-connection challenge nonce (round-9 H2), issued in a
  // `challenge` frame before any client frame and bound into every
  // `workspace-subscribe` signature — blocks cross-connection replay
  // of a captured subscribe frame.
  readonly challenge: string
  // Password-gate flag. Once the `authenticate` handshake succeeds,
  // first-actions on this socket bypass the new-workspace gate.
  authorized = false
  // Heartbeat liveness. The sweep flips it `false` after each `ping()`;
  // the `pong` listener flips it back. A socket still `false` on the
  // next sweep is terminated.
  alive = true
  // In-flight async message handlers spawned for this socket, capped by
  // MAX_INFLIGHT_PER_SOCKET. Incremented at dispatch, decremented in
  // the handler's `finally`.
  inflight = 0
  // Workspace tags this socket is subscribed to — the per-socket
  // reverse index used to detach from `subscribers` on close.
  readonly tags = new Set<string>()
  constructor(challenge: string) { this.challenge = challenge }
}

export type PeerRegistry = WeakMap<WebSocket, Peer>
