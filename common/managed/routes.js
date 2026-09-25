// Managed client pages only. API paths and E2E share hashes are not routes.
export const MANAGED_PAGES = Object.freeze({
  manage: '/manage',
  'manage-bundles': '/manage/bundles',
  'manage-scans': '/manage/scans',
  'manage-reports': '/manage/reports',
  'manage-repos': '/manage/repositories',
  'admin-users': '/manage/users',
  'manage-teams': '/manage/teams',
  'manage-history': '/manage/history',
})

export function managedRoutePath(route) {
  if (route.view === 'home') return '/'
  if (Object.hasOwn(MANAGED_PAGES, route.view)) {
    const path = MANAGED_PAGES[route.view]
    return route.view === 'manage-history' && route.actor ? `${path}?actor=${encodeURIComponent(route.actor)}` : path
  }
  if (!['findings', 'files'].includes(route.view) || !route.teamId
      || [route.teamId, route.reportId].some(id => id != null && !/^[A-Za-z0-9_-]+$/u.test(id))) return null
  const team = `/teams/${encodeURIComponent(route.teamId)}`
  const report = route.reportId ? `/reports/${encodeURIComponent(route.reportId)}` : ''
  return `${team}${report}${route.view === 'files' ? '/files' : ''}`
}

export function parseManagedRoute(url) {
  const path = url.pathname.replace(/\/$/u, '') || '/'
  if (path === '/' || path === '/index.html') return { view: 'home' }
  const view = Object.keys(MANAGED_PAGES).find(key => MANAGED_PAGES[key] === path)
  if (view) return { view, ...(view === 'manage-history' && url.searchParams.get('actor') ? { actor: url.searchParams.get('actor') } : {}) }
  const match = /^\/teams\/([^/]+)(?:\/reports\/([^/]+))?(\/files)?$/u.exec(path)
  if (!match) return null
  try {
    const teamId = decodeURIComponent(match[1])
    const reportId = match[2] ? decodeURIComponent(match[2]) : null
    if ([teamId, reportId].some(id => id != null && !/^[A-Za-z0-9_-]+$/u.test(id))) return null
    return { view: match[3] ? 'files' : 'findings', teamId, reportId }
  } catch { return null }
}
