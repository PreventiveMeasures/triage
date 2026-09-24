// Sync-protocol detection. The server advertises its mode in the first
// `server-info` frame on a sync connection (right after the challenge; see
// server-e2e/ws-server.ts). The client parses it, caches it in localStorage,
// and refuses to switch a client already bound to one protocol over to the
// other: a cross-mode switch needs an explicit, user-confirmed migration (not
// built yet), so until then a mismatch fails closed rather than silently
// reinterpreting local data under the wrong protocol.
//
// No `state` or UI dependencies, so probing and cache rules are testable.
// The `ServerInfo` shape is the
// single source in common/server-info.ts (shared with the server); re-exported
// here so the client's import surface stays put and a shape change is a
// compile error on both sides.

import { CONFIG_PATH, type ManagedServerInfo, type ServerInfo, type ServerMode } from '../../common/server-info.ts'
import { normalizeScanServer } from '../../common/scan-server.ts'
export type { ManagedServerInfo, ServerInfo, ServerMode }
export { CONFIG_PATH }

// localStorage slot holding the last-confirmed ServerInfo as JSON. Global
// (not per-URL): the cache reflects the protocol the local data set is bound
// to, which is exactly what a future e2e↔managed migration would convert.
export const SERVER_MODE_KEY = 'deepview.sync.serverInfo'
// A local-startup hint only: unlike ServerInfo it never binds a protocol or
// skips the next probe, so a static deployment can gain a backend later.
const STANDALONE_PROBE_KEY = 'deepview.sync.standaloneProbe'

export function hasStandaloneProbeHint(): boolean {
  try { return localStorage.getItem(STANDALONE_PROBE_KEY) === '1' } catch { return false }
}

export function rememberStandaloneProbe(): void {
  try { localStorage.setItem(STANDALONE_PROBE_KEY, '1') } catch {}
}

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
  const deepviewScanServer = mode === 'e2e' ? normalizeScanServer((body as { deepviewScanServer?: unknown }).deepviewScanServer) : null
  return { mode, managed, ...(deepviewScanServer ? { deepviewScanServer } : {}) }
}

// Only an explicit 404 confirms a backend-less deployment. Network errors,
// other HTTP errors, and invalid configuration leave the protocol unknown.
export async function probeServerInfo(): Promise<ServerInfo | 'standalone' | null> {
  try {
    const res = await fetch(CONFIG_PATH, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
    if (res.status === 404) return 'standalone'
    return res.ok ? parseServerInfo(await res.json()) : null
  } catch { return null }
}

// Local data must remain available even if the server never answers. Bound
// startup's wait without aborting the probe: a late answer can restore sync.
export async function waitForServerInfo(probe: ReturnType<typeof probeServerInfo>, waitMs = 3000): ReturnType<typeof probeServerInfo> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      probe,
      new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), waitMs) }),
    ])
  } catch { return null }
  finally { clearTimeout(timeout) }
}

export function readCachedServerInfo(): ServerInfo | null {
  try {
    const raw = localStorage.getItem(SERVER_MODE_KEY)
    if (raw == null) return null
    const info = parseServerInfo(JSON.parse(raw))
    return info ? { mode: info.mode, managed: info.managed } : null
  } catch { return null }
}

export function writeCachedServerInfo(info: ServerInfo): void {
  try {
    localStorage.setItem(SERVER_MODE_KEY, JSON.stringify({ mode: info.mode, managed: info.managed }))
    localStorage.removeItem(STANDALONE_PROBE_KEY)
  } catch {}
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
