// WS fan-out hub: the subscriber registry plus the backpressure-aware
// send / broadcast primitives. Created once at boot with the shared
// `peers` registry; the connection handler, the triage-sync handlers,
// the objstore plane, and the REST PUT broadcast all go through the
// returned methods. Kept separate from the protocol handlers so the
// transport concern (who's subscribed, backpressure, fan-out) is
// testable and reasoned about on its own.

import type { WebSocket } from 'ws'
import type { PeerRegistry } from './peer.ts'

export type Hub = {
  subscribe(socket: WebSocket, tag: string): void
  unsubscribeAll(socket: WebSocket): void
  send(socket: WebSocket, msg: object): void
  // Lower-level send for an already-serialised payload (broadcast
  // fan-out stringifies once, sends N times).
  sendRaw(socket: WebSocket, payload: string): void
  // `except: null` is the REST-originated path — byte transfer landed
  // via HTTP, not a particular WS socket, so it hits every subscriber.
  // WS-originated broadcasts pass the originator so it doesn't see its
  // own message echoed back. Local-only: callers that ALSO want a
  // cross-instance fan-out are expected to publish to the pubsub bus
  // alongside this call (server-e2e/pubsub.ts). The hub deliberately stays
  // ignorant of the bus so its transport invariants (backpressure cap,
  // stringify-once, terminate-on-overflow) are unchanged.
  broadcast(tag: string, msg: object, except: WebSocket | null): void
  // Broadcasts an ALREADY-SERIALISED payload to every local subscriber
  // for `tag`. Used by the pubsub bus receiver
  // (server-e2e/bus-receiver.ts, wired up from server-e2e/index.ts) to relay
  // a remote-instance event into this instance's fan-out. No `except`:
  // the originator is on a different instance by construction.
  broadcastLocalRaw(tag: string, payload: string): void
}

export function createHub(deps: { peers: PeerRegistry; maxBufferedBytes: number; debug: boolean }): Hub {
  const { peers, maxBufferedBytes, debug } = deps
  // workspaceTag → Set<WebSocket>. The per-socket reverse index lives on
  // `Peer.tags` (see ./peer.ts) and is read by `unsubscribeAll` on close.
  const subscribers = new Map<string, Set<WebSocket>>()

  function subscribe(socket: WebSocket, tag: string): void {
    let set = subscribers.get(tag)
    if (!set) {
      set = new Set()
      subscribers.set(tag, set)
    }
    set.add(socket)
    peers.get(socket)?.tags.add(tag)
  }

  function unsubscribeAll(socket: WebSocket): void {
    const tags = peers.get(socket)?.tags
    if (!tags) return
    for (const tag of tags) {
      const set = subscribers.get(tag)
      if (!set) continue
      set.delete(socket)
      if (set.size === 0) subscribers.delete(tag)
    }
  }

  function send(socket: WebSocket, msg: object): void {
    sendRaw(socket, JSON.stringify(msg))
  }

  function sendRaw(socket: WebSocket, payload: string): void {
    if (socket.readyState !== socket.OPEN) return
    // Backpressure cap. `socket.bufferedAmount` is the count of bytes
    // queued in the `ws` send pipeline that haven't drained to the
    // kernel yet — a slow / blackholed peer accumulates them unboundedly
    // during fan-out broadcasts. Drop above the cap and terminate the
    // socket so the heartbeat doesn't keep it alive on ping/pong while
    // every broadcast piles up. Transport audit `server-e2e/index.ts:225`.
    if (socket.bufferedAmount > maxBufferedBytes) {
      if (debug) console.warn(`drop broadcast: socket buffered ${socket.bufferedAmount}B > cap`)
      try { socket.terminate() } catch {}
      return
    }
    // Wrap send() in try/catch — readyState can transition from OPEN to
    // CLOSING between the check above and the send() call (TOCTOU window
    // in `ws`'s event loop). Without this, a socket dying mid-broadcast
    // would throw and abort the broadcast loop, skipping every
    // subscriber after the dead one. Audit M4.
    try { socket.send(payload) } catch {}
  }

  function broadcast(tag: string, msg: object, except: WebSocket | null): void {
    const set = subscribers.get(tag)
    if (!set) return
    // Stringify ONCE outside the fan-out loop. For a workspace-state
    // catch-up with a multi-MB ciphertext × N subscribers, per-recipient
    // JSON.stringify would dominate CPU; this is the cheap win.
    const payload = JSON.stringify(msg)
    fanOut(set, payload, except)
  }

  function broadcastLocalRaw(tag: string, payload: string): void {
    const set = subscribers.get(tag)
    if (!set) return
    fanOut(set, payload, null)
  }

  function fanOut(set: Set<WebSocket>, payload: string, except: WebSocket | null): void {
    // Snapshot before iterating — a socket transitioning to CLOSED
    // mid-broadcast triggers `unsubscribeAll` from the 'close' handler,
    // mutating `set` while we walk it. The snapshot also keeps a future
    // refactor (different collection, async send) from silently skipping
    // subscribers. Audit M4 round-3.
    for (const s of [...set]) {
      if (s === except) continue
      sendRaw(s, payload)
    }
  }

  return { subscribe, unsubscribeAll, send, sendRaw, broadcast, broadcastLocalRaw }
}
