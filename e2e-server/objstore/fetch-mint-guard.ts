// Anti-replay guard for the REST fetch-mint endpoint (POST
// /api/objstore/{tag}/{res}, see ./rest.ts). The WS fetch handshake binds
// the per-connection challenge nonce so a captured frame can't be
// replayed; the REST mint has no connection, so it binds a client
// timestamp instead and this guard supplies the matching freshness +
// dedup the nonce gave for free:
//
//   - FRESHNESS: reject a request whose `ts` is outside ±`windowMs` of
//     server time (an old captured request, or a future-dated one).
//   - DEDUP: within the window, a signature is accepted at most once — a
//     captured-and-replayed request (same `ts` ⇒ same signature) is
//     rejected on the second presentation.
//
// Memory: each accepted signature is held for `windowMs` then pruned.
// Entries share a uniform TTL and the Map preserves insertion order, so
// the oldest entries expire first and a cheap front-prune (amortised
// O(1) per entry) keeps the set bounded; a hard `maxEntries` cap drops
// the oldest beyond it as a flood backstop.
//
// Scope: per-process. In a multi-replica deployment a captured request
// could be replayed once per replica that hasn't seen its signature yet
// (bounded by the replica count, within the window) — acceptable because
// the mint only ever yields a short-TTL GET token over AEAD ciphertext
// the relay can't read. A shared-store dedup (Redis/Neon) would close
// that residual gap if ever needed.

export type FetchMintVerdict = 'ok' | 'stale' | 'replay'

export type FetchMintGuard = {
  // `signature` is the request's Ed25519 signature (unique per
  // (tag, res, ts) tuple, so it doubles as the dedup key). `ts` is the
  // client epoch-ms timestamp the signature commits to; `now` is the
  // server clock (injectable for tests).
  admit: (signature: string, ts: number, now?: number) => FetchMintVerdict
  size: () => number
}

export const DEFAULT_FETCH_MINT_WINDOW_MS = 60_000
export const DEFAULT_FETCH_MINT_MAX_ENTRIES = 50_000

export function createFetchMintGuard(
  { windowMs = DEFAULT_FETCH_MINT_WINDOW_MS, maxEntries = DEFAULT_FETCH_MINT_MAX_ENTRIES }:
    { windowMs?: number; maxEntries?: number } = {},
): FetchMintGuard {
  // signature → expiry (ms). Insertion-ordered; uniform TTL ⇒ the head is
  // always the soonest to expire.
  const seen = new Map<string, number>()

  function admit(signature: string, ts: number, now: number = Date.now()): FetchMintVerdict {
    // Freshness first — a stale/future request never touches the cache, so
    // it can't be used to grow the set.
    if (!Number.isFinite(ts) || Math.abs(now - ts) > windowMs) return 'stale'
    // Front-prune expired entries (contiguous at the head under the
    // uniform TTL). Breaks at the first live entry.
    for (const [key, exp] of seen) {
      if (exp > now) break
      seen.delete(key)
    }
    // Post-prune, any remaining entry is live, so a hit is a genuine replay.
    if (seen.has(signature)) return 'replay'
    seen.set(signature, now + windowMs)
    // Flood backstop: drop the oldest beyond the cap. Those are the
    // closest to expiry anyway; dropping them only shortens their dedup
    // window (still freshness-gated).
    while (seen.size > maxEntries) {
      const oldest = seen.keys().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
    return 'ok'
  }

  return { admit, size: () => seen.size }
}
