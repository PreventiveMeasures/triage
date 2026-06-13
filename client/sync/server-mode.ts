// Sync-protocol detection. The server advertises its mode in the first
// `server-info` frame on a sync connection (right after the challenge; see
// server-e2e/ws-server.ts). The client parses it, caches it in localStorage,
// and refuses to switch a client already bound to one protocol over to the
// other: a cross-mode switch needs an explicit, user-confirmed migration (not
// built yet), so until then a mismatch fails closed rather than silently
// reinterpreting local data under the wrong protocol.
//
// PURE + dependency-free (no `state`, no DOM beyond `localStorage`), so the
// precedence/caching rules are unit-testable. The `ServerInfo` shape is the
// single source in common/server-info.ts (shared with the server); re-exported
// here so the client's import surface stays put and a shape change is a
// compile error on both sides.

import type { ManagedServerInfo, ServerInfo, ServerMode } from '../../common/server-info.ts'
export type { ManagedServerInfo, ServerInfo, ServerMode }

// localStorage slot holding the last-confirmed ServerInfo as JSON. Global
// (not per-URL): the cache reflects the protocol the local data set is bound
// to, which is exactly what a future e2e↔managed migration would convert.
export const SERVER_MODE_KEY = 'deepview.sync.serverInfo'

// Validate an untrusted `server-info` frame (or cached blob) into a ServerInfo
// (or null). Extra fields — e.g. the frame's `type` — are ignored.
export function parseServerInfo(body: unknown): ServerInfo | null {
  if (body == null || typeof body !== 'object') return null
  const mode = (body as { mode?: unknown }).mode
  if (mode !== 'e2e' && mode !== 'managed') return null
  let managed: ManagedServerInfo | null = null
  const m = (body as { managed?: unknown }).managed
  if (m != null && typeof m === 'object') {
    const loginPath = (m as { loginPath?: unknown }).loginPath
    const cookieName = (m as { cookieName?: unknown }).cookieName
    if (typeof loginPath === 'string' && typeof cookieName === 'string') {
      managed = { loginPath, cookieName }
    }
  }
  return { mode, managed }
}

export function readCachedServerInfo(): ServerInfo | null {
  try {
    const raw = localStorage.getItem(SERVER_MODE_KEY)
    if (raw == null) return null
    return parseServerInfo(JSON.parse(raw))
  } catch { return null }
}

export function writeCachedServerInfo(info: ServerInfo): void {
  try { localStorage.setItem(SERVER_MODE_KEY, JSON.stringify(info)) } catch {}
}

// Compare a freshly-detected mode against the cached one:
//   'first'    — nothing cached; accept + cache.
//   'match'    — same protocol; proceed normally.
//   'mismatch' — different protocol; REFUSE (needs a confirmed migration).
export type ModeClassification = 'first' | 'match' | 'mismatch'
export function classifyServerMode(cachedMode: ServerMode | null, detectedMode: ServerMode): ModeClassification {
  if (cachedMode == null) return 'first'
  return cachedMode === detectedMode ? 'match' : 'mismatch'
}
