// The host supplies transport. A separate scan service must never inherit
// the managed workspace's authentication or in-memory preview identity.
export function scanServerRequest(server, request = fetch, apiKey = '') {
  const base = new URL(server)
  return (path, options = {}) => {
    const url = new URL(path.replace(/^\/+/u, ''), base)
    if (url.origin !== base.origin) throw new Error('Scan requests must use the configured server')
    const headers = new Headers(options.headers)
    if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
    return request(url, { ...options, headers, credentials: 'omit', redirect: 'error' })
  }
}
