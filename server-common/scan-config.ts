import { normalizeScanServer } from '../common/scan-server.ts'

export function configuredScanServer(value: string | undefined): string | null {
  if (!value?.trim()) return null
  const server = normalizeScanServer(value)
  if (!server) throw new Error('DEEPVIEW_SCAN_SERVER must be an absolute HTTP(S) URL without credentials, query, or fragment')
  return server
}

// Apply at serve time, before compression and ETag generation. Packaged HTML
// stays strict and does not bake in the build machine's configuration.
export function scanServerHtml(html: string, server: string | null, { advertise = false } = {}): string {
  if (!server) return html
  const origin = new URL(server).origin
  const result = html.replace(/(connect-src 'self')(?=[;"])/u, `$1 ${origin}`)
  if (!advertise) return result
  const content = server.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  return result.replace('</head>', `<meta name="deepview-scan-server" content="${content}">\n</head>`)
}
