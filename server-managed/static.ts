import { type StaticHandler, loadStatic } from '../server-e2e/static.ts'
import { parseManagedRoute } from '../common/managed/routes.js'

// A deep page URL must still resolve every asset at the app root. Preload
// headers resolve against the request URL, so their hrefs must be absolute too.
export function managedPageHtml(html: string): string {
  return html.replaceAll(/(href|src)="\.\//gu, '$1="/')
}

export function loadManagedStatic(staticDir: string, { indexOnly = false, scanServer = null }: { indexOnly?: boolean, scanServer?: string | null } = {}): StaticHandler {
  const serve = loadStatic(staticDir, scanServer, { transformIndex: managedPageHtml, indexOnly })
  return (req, res) => {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return false
    const url = new URL(req.url, 'http://localhost')
    let path
    try { path = decodeURIComponent(url.pathname) } catch { return false }
    // No API request, including an unknown API route, may receive app HTML.
    if (path === '/api' || path.startsWith('/api/')) return false
    if (serve(req, res)) return true
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    // Finding IDs can contain dots (including URL-shaped IDs). Recognised
    // pages still receive HTML; missing assets retain a 404.
    if (path.split('/').at(-1)?.includes('.') && !parseManagedRoute(url)) return false
    const original = req.url
    req.url = '/'
    try { return serve(req, res) } finally { req.url = original }
  }
}
