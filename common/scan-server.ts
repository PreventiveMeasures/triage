export const DEFAULT_SCAN_SERVER = 'http://127.0.0.1:3123/'

// Discovery is optional: malformed scan configuration must never prevent
// opening local data or recognizing the server's sync protocol.
export function normalizeScanServer(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    url.pathname = url.pathname.replace(/\/+$/u, '') + '/'
    return url.href
  } catch { return null }
}
