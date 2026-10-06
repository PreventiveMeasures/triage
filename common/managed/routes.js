// Managed client pages only. API paths and E2E share hashes are not routes.
import { BUNDLE_TABS } from '../bundle-tabs.js'
import { MAX_FINDING_ID_LENGTH, isLinkableFindingId } from '../finding-id.js'

export const MANAGED_PAGES = Object.freeze({
  manage: '/manage',
  'manage-bundles': '/manage/bundle',
  'manage-scans': '/manage/scans',
  'manage-reports': '/manage/report',
  'manage-repos': '/manage/repositories',
  'admin-users': '/manage/users',
  'manage-teams': '/manage/team',
  'manage-import': '/manage/import',
  'manage-links': '/manage/links',
  'manage-deduplication': '/manage/deduplication',
  'manage-history': '/manage/history',
})

// Dot-only path components are normalised away by URL parsers, even escaped.
function findingPath(id) {
  if (!isLinkableFindingId(id) || id === '.' || id === '..') return null
  try { return `/finding/${encodeURIComponent(id)}` } catch { return null }
}

export function managedRoutePath(route) {
  if (!route) return null
  if (route.view === 'home') return '/'
  if (route.view === 'bundles') {
    if (!/^[A-Za-z0-9_-]+$/u.test(route.bundleSlug ?? '')
        || (route.teamSlug != null && !/^[A-Za-z0-9_-]+$/u.test(route.teamSlug))) return null
    const tab = route.bundleTab ?? 'overview'
    if (!BUNDLE_TABS.has(tab)) return null
    const parent = route.teamSlug ? `/team/${route.teamSlug}` : '/manage'
    return `${parent}/bundle/${route.bundleSlug}${tab === 'overview' ? '' : `/${tab}`}`
  }
  if (Object.hasOwn(MANAGED_PAGES, route.view)) {
    const path = MANAGED_PAGES[route.view]
    if (route.view === 'manage-bundles' && Number.isSafeInteger(route.createRepoId) && route.createRepoId > 0) return `${path}?createRepo=${route.createRepoId}`
    if (route.view === 'manage-scans' && route.scanMode === 'link') return `${path}?mode=link`
    if (route.view === 'manage-scans' && route.bundleId) return `${path}?bundle=${encodeURIComponent(route.bundleId)}`
    return route.view === 'manage-history' && route.actor ? `${path}?actor=${encodeURIComponent(route.actor)}` : path
  }
  if (!['findings', 'files'].includes(route.view) || !route.teamSlug
      || [route.teamSlug, route.reportSlug].some(id => id != null && !/^[A-Za-z0-9_-]+$/u.test(id))) return null
  const team = `/team/${encodeURIComponent(route.teamSlug)}`
  const report = route.reportSlug ? `/report/${encodeURIComponent(route.reportSlug)}` : ''
  if (route.finding) {
    const suffix = findingPath(route.finding.id)
    return route.view === 'findings' && suffix ? `${team}${report}${suffix}` : null
  }
  return `${team}${report}${route.view === 'files' ? '/files' : ''}`
}

export function parseManagedRoute(url) {
  const path = url.pathname.replace(/\/$/u, '') || '/'
  if (path === '/' || path === '/index.html') return { view: 'home' }
  const view = Object.keys(MANAGED_PAGES).find(key => MANAGED_PAGES[key] === path)
  if (view) {
    const createRepoId = Number(url.searchParams.get('createRepo'))
    return { view,
      ...(view === 'manage-bundles' && Number.isSafeInteger(createRepoId) && createRepoId > 0 ? { createRepoId } : {}),
      ...(view === 'manage-history' && url.searchParams.get('actor') ? { actor: url.searchParams.get('actor') } : {}),
      ...(view === 'manage-scans' ? url.searchParams.get('mode') === 'link' ? { scanMode: 'link' }
        : url.searchParams.get('bundle') ? { bundleId: url.searchParams.get('bundle') } : {} : {}),
    }
  }
  const bundle = /^(?:\/team\/([A-Za-z0-9_-]+)|\/manage)\/bundle\/([A-Za-z0-9_-]+)(?:\/([a-z]+))?$/u.exec(path)
  if (bundle) {
    const bundleTab = bundle[3] ?? 'overview'
    return BUNDLE_TABS.has(bundleTab) ? { view: 'bundles', teamSlug: bundle[1] ?? null, bundleSlug: bundle[2], bundleTab } : null
  }
  const match = /^\/team\/([^/]+)(?:\/report\/([^/]+))?(?:\/(files)|\/finding\/([^/]+))?$/u.exec(path)
  if (!match) return null
  try {
    const teamSlug = decodeURIComponent(match[1])
    const reportSlug = match[2] ? decodeURIComponent(match[2]) : null
    if ([teamSlug, reportSlug].some(id => id != null && !/^[A-Za-z0-9_-]+$/u.test(id))) return null
    if (match[4]?.length > MAX_FINDING_ID_LENGTH * 9) return null
    const id = match[4] ? decodeURIComponent(match[4]) : null
    if (id != null && !findingPath(id)) return null
    return { view: match[3] ? 'files' : 'findings', teamSlug, reportSlug, ...(id == null ? {} : { finding: { id } }) }
  } catch { return null }
}

// URL tokens are exact server-assigned slugs. Application state and API calls
// continue to use UUIDs; never guess IDs from suffixes or accept ID aliases.
export function resolveManagedRoute(route, teams, adminBundles = []) {
  if (route.view === 'bundles') {
    const { teamSlug, bundleSlug, ...rest } = route
    const matches = teamSlug == null ? [] : teams.filter(team => team.slug === teamSlug)
    if (teamSlug != null && matches.length !== 1) return null
    const team = matches[0]
    const candidates = teamSlug == null ? adminBundles : teams.flatMap(entry => entry.bundles ?? [])
    const ids = new Set(candidates.filter(bundle => bundle.slug === bundleSlug).map(bundle => bundle.id))
    const bundle = (team?.bundles ?? adminBundles).find(entry => entry.slug === bundleSlug)
    return bundleSlug && bundle && ids.size === 1 ? { ...rest, teamId: team?.id ?? null, bundleId: bundle.id } : null
  }
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

export function managedRouteForIds(route, teams, adminBundles = []) {
  if (route.view === 'bundles') {
    const { teamId, bundleId, ...rest } = route
    const team = teams.find(entry => entry.id === teamId)
    if (teamId != null && !team?.slug) return null
    const bundle = (team?.bundles ?? adminBundles).find(entry => entry.id === bundleId)
    if (!bundle?.slug) return null
    const result = { ...rest, teamSlug: team?.slug ?? null, bundleSlug: bundle.slug }
    return resolveManagedRoute(result, teams, adminBundles) ? result : null
  }
  if (!['findings', 'files'].includes(route.view)) return route
  const { teamId, reportId, ...rest } = route
  const team = teams.find(entry => entry.id === teamId)
  const report = reportId == null ? null : team?.reports?.find(entry => entry.id === reportId)
  if (!team?.slug || (reportId != null && !report?.slug)) return null
  const result = { ...rest, teamSlug: team.slug, reportSlug: report?.slug ?? null }
  return resolveManagedRoute(result, teams) ? result : null
}
