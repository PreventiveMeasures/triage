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
  if (!route) return null
  if (route.view === 'home') return '/'
  if (route.view === 'bundles') return /^[A-Za-z0-9_-]+$/u.test(route.bundleId ?? '') ? `/bundles/${encodeURIComponent(route.bundleId)}` : null
  if (Object.hasOwn(MANAGED_PAGES, route.view)) {
    const path = MANAGED_PAGES[route.view]
    return route.view === 'manage-history' && route.actor ? `${path}?actor=${encodeURIComponent(route.actor)}` : path
  }
  if (!['findings', 'files'].includes(route.view) || !route.teamSlug
      || [route.teamSlug, route.reportSlug].some(id => id != null && !/^[A-Za-z0-9_-]+$/u.test(id))) return null
  const team = `/teams/${encodeURIComponent(route.teamSlug)}`
  const report = route.reportSlug ? `/reports/${encodeURIComponent(route.reportSlug)}` : ''
  return `${team}${report}${route.view === 'files' ? '/files' : ''}`
}

export function parseManagedRoute(url) {
  const path = url.pathname.replace(/\/$/u, '') || '/'
  if (path === '/' || path === '/index.html') return { view: 'home' }
  const view = Object.keys(MANAGED_PAGES).find(key => MANAGED_PAGES[key] === path)
  if (view) return { view, ...(view === 'manage-history' && url.searchParams.get('actor') ? { actor: url.searchParams.get('actor') } : {}) }
  const bundle = /^\/bundles\/([A-Za-z0-9_-]+)$/u.exec(path)
  if (bundle) return { view: 'bundles', bundleId: bundle[1] }
  const match = /^\/teams\/([^/]+)(?:\/reports\/([^/]+))?(\/files)?$/u.exec(path)
  if (!match) return null
  try {
    const teamSlug = decodeURIComponent(match[1])
    const reportSlug = match[2] ? decodeURIComponent(match[2]) : null
    if ([teamSlug, reportSlug].some(id => id != null && !/^[A-Za-z0-9_-]+$/u.test(id))) return null
    return { view: match[3] ? 'files' : 'findings', teamSlug, reportSlug }
  } catch { return null }
}

// URL tokens are exact server-assigned slugs. Application state and API calls
// continue to use UUIDs; never guess IDs from suffixes or accept ID aliases.
export function resolveManagedRoute(route, teams) {
  if (!['findings', 'files'].includes(route.view)) return route
  const { teamSlug, reportSlug, ...rest } = route
  const matches = teams.filter(team => team.slug === teamSlug)
  if (!teamSlug || matches.length !== 1) return null
  const team = matches[0]
  if (reportSlug == null) return { ...rest, teamId: team.id, reportId: null }
  const reports = teams.flatMap(entry => entry.reports ?? []).filter(report => report.slug === reportSlug)
  const ids = new Set(reports.map(report => report.id))
  const report = (team.reports ?? []).find(entry => entry.slug === reportSlug)
  return report && ids.size === 1 ? { ...rest, teamId: team.id, reportId: report.id } : null
}

export function managedRouteForIds(route, teams) {
  if (!['findings', 'files'].includes(route.view)) return route
  const { teamId, reportId, ...rest } = route
  const team = teams.find(entry => entry.id === teamId)
  const report = reportId == null ? null : team?.reports?.find(entry => entry.id === reportId)
  if (!team?.slug || (reportId != null && !report?.slug)) return null
  const result = { ...rest, teamSlug: team.slug, reportSlug: report?.slug ?? null }
  return resolveManagedRoute(result, teams) ? result : null
}
