// Client-side discovery of the deployment's supported protocols. Combined
// modes advertise both isolated surfaces, with the first one as the reload
// default. The cache stores that advertisement, never the user's selection.
// No `state` or UI dependencies, so probing and cache rules are testable.

import { CONFIG_PATH, type ManagedServerInfo, type ServerMode as ServerProtocol, type ServerInfo as SingleServerInfo } from '../../common/server-info.ts'
import { normalizeScanServer } from '../../common/scan-server.ts'
export type { ManagedServerInfo, ServerProtocol }
// Accept future combined advertisements without changing what servers emit.
export type ServerMode = ServerProtocol | 'managed+e2e' | 'e2e+managed'
export type ServerInfo = Omit<SingleServerInfo, 'mode'> & { mode: ServerMode }
export { CONFIG_PATH }

// localStorage slot holding the last-confirmed deployment configuration.
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

export function isCombinedServerMode(mode: ServerMode | null): boolean {
  return mode === 'managed+e2e' || mode === 'e2e+managed'
}

export function resolveServerMode(mode: ServerMode, selection: ServerProtocol | null = null): ServerProtocol {
  if (selection && (isCombinedServerMode(mode) || mode === selection)) return selection
  return mode === 'managed' || mode === 'managed+e2e' ? 'managed' : 'e2e'
}

// An e2e connection describes its own protocol, not necessarily all modes
// served by /api/config. Keep a combined deployment switchable on reconnect.
export function mergeSyncServerInfo(configured: ServerInfo | null, frame: ServerInfo): ServerInfo {
  if (configured && isCombinedServerMode(configured.mode) && frame.mode === 'e2e') {
    return { ...configured, ...(frame.deepviewScanServer ? { deepviewScanServer: frame.deepviewScanServer } : {}) }
  }
  return frame
}

// Validate an untrusted `server-info` frame (or cached blob) into a ServerInfo
// (or null). Extra fields — e.g. the frame's `type` — are ignored.
export function parseServerInfo(body: unknown): ServerInfo | null {
  if (body == null || typeof body !== 'object') return null
  const mode = (body as { mode?: unknown }).mode
  if (mode !== 'e2e' && mode !== 'managed' && mode !== 'managed+e2e' && mode !== 'e2e+managed') return null
  let managed: ManagedServerInfo | null = null
  const m = (body as { managed?: unknown }).managed
  if (m != null && typeof m === 'object') {
    const loginPath = (m as { loginPath?: unknown }).loginPath
    const cookieName = (m as { cookieName?: unknown }).cookieName
    if (typeof loginPath === 'string' && typeof cookieName === 'string') {
      managed = { loginPath, cookieName }
    }
  }
  const deepviewScanServer = mode === 'managed' ? null : normalizeScanServer((body as { deepviewScanServer?: unknown }).deepviewScanServer)
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
//   'match'    — same protocol or an explicit combined advertisement.
//   'mismatch' — unrelated single-protocol deployments; refuse the change.
export type ModeClassification = 'first' | 'match' | 'mismatch'
export function classifyServerMode(cachedMode: ServerMode | null, detectedMode: ServerMode): ModeClassification {
  if (cachedMode == null) return 'first'
  return cachedMode === detectedMode || isCombinedServerMode(cachedMode) || isCombinedServerMode(detectedMode) ? 'match' : 'mismatch'
}
