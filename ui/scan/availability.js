import { DEFAULT_SCAN_SERVER, normalizeScanServer } from '../../common/scan-server.ts'

export function availableScanServer({ hostname, devServer, serverMode, localMode, deepviewScanServer }) {
  if (serverMode === 'managed' && !localMode) return null
  if (serverMode === 'e2e') return normalizeScanServer(deepviewScanServer)
  return normalizeScanServer(devServer)
    ?? (hostname === '127.0.0.1' ? DEFAULT_SCAN_SERVER : null)
}
