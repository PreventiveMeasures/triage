// Managed client pages only. API paths and E2E share hashes are not routes.
import { BUNDLE_TABS } from '../bundle-tabs.js'
import { MAX_FINDING_ID_LENGTH, isLinkableFindingId } from '../finding-id.js'
import { isNpmPackageName, isNpmPackageSpec } from './npm-packages.js'

// How Compare reviews the changes, past its Overview: `code`, beside the
// tree of changed files. A link names the mode after the bundle or version
// compared with; an older one's `diff`, a mode since folded into Code,
// opens Code.
const COMPARE_MODES = new Set(['code', 'diff'])
export const compareModeOf = mode => COMPARE_MODES.has(mode) ? 'code' : 'overview'
// A route's `compareMode` field, where `mode` is one; none for the Overview.
export const compareModeField = mode => COMPARE_MODES.has(mode) ? { compareMode: 'code' } : {}
const compareModeSuffix = mode => COMPARE_MODES.has(mode) ? '/code' : ''

export const MANAGED_PAGES = Object.freeze({
  manage: '/manage',
  'manage-bundles': '/manage/bundle',
  'manage-scans': '/manage/scans',
  'manage-reports': '/manage/report',
  'manage-repos': '/manage/repositories',
  'manage-repo-risk': '/manage/repositories/risk',
  'admin-users': '/manage/users',
  'manage-teams': '/manage/team',
  'manage-import': '/manage/import',
  'manage-links': '/manage/links',
  'manage-deduplication': '/manage/deduplication',
  'manage-history': '/manage/history',
})

// A team's lists, each at /team/<slug>/<what it lists>.
const WORKSPACE_CONTENT_VIEWS = new Set(['workspace-reports', 'workspace-bundles', 'workspace-repositories'])

// Dot-only path components are normalised away by URL parsers, even escaped.
function findingPath(id) {
  if (!isLinkableFindingId(id) || id === '.' || id === '..') return null
  try { return `/finding/${encodeURIComponent(id)}` } catch { return null }
}

export function managedRoutePath(route) {
  if (!route) return null
  if (route.view === 'home') return '/'
  if (route.view === 'reviews') return '/my/reviews'
  if (route.view === 'profile') return '/my/profile'
  if (route.view === 'npm') return npmPackagePath(route)
  if (route.view === 'repository-code') return repositoryCodePath(route)
  if (WORKSPACE_CONTENT_VIEWS.has(route.view)) {
    return /^[A-Za-z0-9_-]+$/u.test(route.teamSlug ?? '') ? `/team/${route.teamSlug}/${route.view.slice(10)}` : null
  }
  if (route.view === 'bundles') {
    if (!/^[A-Za-z0-9_-]+$/u.test(route.bundleSlug ?? '')
        || [route.teamSlug, route.compareSlug].some(slug => slug != null && !/^[A-Za-z0-9_-]+$/u.test(slug))) return null
    const tab = route.bundleTab ?? 'overview'
    if (!BUNDLE_TABS.has(tab)) return null
    const parent = route.teamSlug ? `/team/${route.teamSlug}` : '/manage'
    // Code names its open file by number: 1-based in the bundle's sorted
    // sources, which its content hash fixes. Never by path from the bundle.
    // Its marked lines follow in the fragment, as #L42 or #L42-L69.
    const file = tab === 'code' && isLineNumber(route.file) ? `/${route.file}` : ''
    const lines = file && isLineNumber(route.line)
      ? `#L${route.line}${isLineNumber(route.endLine) && route.endLine > route.line ? `-L${route.endLine}` : ''}` : ''
    // Compare names the bundle compared with by its slug, then its mode
    // (COMPARE_MODES) past the Overview.
    const compare = tab === 'compare' && route.compareSlug != null
      ? `/${route.compareSlug}${compareModeSuffix(route.compareMode)}` : ''
    return `${parent}/bundle/${route.bundleSlug}${tab === 'overview' ? '' : `/${tab}`}${file}${compare}${lines}`
  }
  if (Object.hasOwn(MANAGED_PAGES, route.view)) {
    const path = MANAGED_PAGES[route.view]
    if (route.view === 'manage-deduplication' && route.linkId) return `${path}?report=${encodeURIComponent(route.linkId)}`
    if (route.view === 'manage-bundles' && Number.isSafeInteger(route.createRepoId) && route.createRepoId > 0) return `${path}?createRepo=${route.createRepoId}`
    if (route.view === 'manage-scans' && route.scanMode === 'link') return `${path}?mode=link`
    if (route.view === 'manage-scans' && route.bundleId) {
      return `${path}?bundle=${encodeURIComponent(route.bundleId)}${route.scanMode === 'dependencies' ? '&mode=dependencies' : ''}`
    }
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

// The npm viewer: its lookup page, or a package version's Overview, Code,
// Search, Compare or Treemap tab, `/npm/<name>[@<version or dist-tag>][/<tab>…]`. Code names
// its file by number and its lines in the fragment, as a bundle's Code
// does: `/code/<file>#L4`. Compare names the version compared with, then
// its mode past the Overview: `/compare/<version>/code` or `/diff`.
export const NPM_TABS = new Set(['overview', 'code', 'search', 'compare', 'review', 'treemap'])
function npmPackagePath(route) {
  if (route.packageName == null) return '/npm'
  const tab = route.bundleTab ?? 'overview'
  if (!isNpmPackageName(route.packageName) || (route.packageSpec != null && !isNpmPackageSpec(route.packageSpec)) || !NPM_TABS.has(tab)
      || (route.compareSpec != null && !isNpmPackageSpec(route.compareSpec))) return null
  if (tab === 'review') {
    if (route.reviewPackage != null && !isNpmPackageName(route.reviewPackage) || route.reviewSpec != null && !isNpmPackageSpec(route.reviewSpec)) return null
    const base = route.reviewPackage == null ? '' : `/${route.reviewPackage}${route.reviewSpec == null ? '' : `@${route.reviewSpec}`}`
    return `/npm/${route.packageName}${route.packageSpec == null ? '' : `@${route.packageSpec}`}/review${base}`
  }
  const file = tab === 'code' && isLineNumber(route.file) ? `/${route.file}` : ''
  const lines = file && isLineNumber(route.line)
    ? `#L${route.line}${isLineNumber(route.endLine) && route.endLine > route.line ? `-L${route.endLine}` : ''}` : ''
  const compare = tab === 'compare' && route.compareSpec != null ? `/${route.compareSpec}${compareModeSuffix(route.compareMode)}` : ''
  return `/npm/${route.packageName}${route.packageSpec == null ? '' : `@${route.packageSpec}`}${tab === 'overview' ? '' : `/${tab}`}${file}${compare}${lines}`
}

function parseNpmRoute(path, hash) {
  const review = /^\/npm\/((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?\/review(?:\/((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?)?$/u.exec(path)
  if (review) {
    if (!isNpmPackageName(review[1]) || review[2] != null && !isNpmPackageSpec(review[2])
      || review[3] != null && !isNpmPackageName(review[3]) || review[4] != null && !isNpmPackageSpec(review[4])) return null
    // The full dependency form is canonical; a bare version is a shortcut.
    const versionOnly = review[3] && /^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(review[3]) && review[4] == null
    return { view: 'npm', packageName: review[1], packageSpec: review[2] ?? null, bundleTab: 'review',
      ...(review[3] ? { reviewPackage: versionOnly ? review[1] : review[3], reviewSpec: versionOnly ? review[3] : review[4] ?? null } : {}) }
  }
  const match = /^\/npm(?:\/((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?(?:\/(code|search|compare|treemap)(?:\/([^/]+)(?:\/([a-z]+))?)?)?)?$/u.exec(path)
  if (!match) return undefined
  if (match[1] == null) return { view: 'npm' }
  if (!isNpmPackageName(match[1]) || (match[2] != null && !isNpmPackageSpec(match[2]))) return null
  const route = { view: 'npm', packageName: match[1], packageSpec: match[2] ?? null, bundleTab: match[3] ?? 'overview' }
  if (match[4] == null) return route
  if (route.bundleTab === 'compare') {
    return isNpmPackageSpec(match[4]) && (match[5] == null || COMPARE_MODES.has(match[5])) ? { ...route, compareSpec: match[4], ...compareModeField(match[5]) } : null
  }
  if (route.bundleTab !== 'code') return null
  const file = Number(match[4])
  return !match[5] && /^[1-9]\d*$/u.test(match[4]) && Number.isSafeInteger(file) ? { ...route, file, ...codeLines(hash) } : null
}

// The code viewer: a directory of a repository at a commit, on its Code,
// Search, Treemap, Compare, Commits, Issues, Pull requests, Agents, Pulse
// or Replay tab, `/manage/code/<repo id>/<commit>[/<tab>…][?path=<directory>]`,
// the repository's root where it names no directory. Code, the tab a bare
// link opens, names its file by number and its lines in the fragment, as a
// bundle's Code does: `/code/<file>#L4`. Compare names the commit compared
// with, then its mode past the Overview, as an npm version's does:
// `/compare/<commit>/code`. Without a commit,
// `/manage/code/<repo id>[?path=<directory>]`, it opens on the default
// branch's head, or on the revision a route held in memory names (`ref`),
// and its route then names the commit it opened.
export const REPOSITORY_CODE_TABS = new Set(['code', 'search', 'treemap', 'compare', 'commits', 'issues', 'pulls', 'agents', 'pulse', 'replay'])
// The tabs reading none of the directory's files, which a directory at a
// commit shows alone.
export const REPOSITORY_FILELESS_TABS = new Set(['commits', 'issues', 'pulls', 'agents', 'pulse', 'replay'])
const COMMIT = /^[a-f\d]{40}$/u
const MAX_DIRECTORY = 500
const isRepoId = value => Number.isSafeInteger(value) && value > 0

// A directory as the server takes one (server-managed/repo-path.ts), in its
// canonical form: `''` the root, else names with no empty, `.` or `..` one
// among them, nor control characters, backslashes or spaces around one.
export function isRepositoryDirectory(path) {
  return typeof path === 'string' && (path === '' || path.length <= MAX_DIRECTORY && !/[\p{Cc}\\]/u.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part === part.trim()))
}

function repositoryCodePath(route) {
  const tab = route.bundleTab ?? 'code'
  const path = route.path ?? ''
  if (!isRepoId(route.repoId) || (route.commit != null && !COMMIT.test(route.commit)) || !isRepositoryDirectory(path) || !REPOSITORY_CODE_TABS.has(tab)
      || (route.compareCommit != null && !COMMIT.test(route.compareCommit))) return null
  const directory = path ? `?path=${path.split('/').map(encodeURIComponent).join('/')}` : ''
  if (route.commit == null) return `/manage/code/${route.repoId}${directory}`
  const file = tab === 'code' && isLineNumber(route.file) ? `/code/${route.file}` : tab === 'code' ? '' : `/${tab}`
  const compare = tab === 'compare' && route.compareCommit != null ? `/${route.compareCommit}${compareModeSuffix(route.compareMode)}` : ''
  const lines = tab === 'code' && isLineNumber(route.file) && isLineNumber(route.line)
    ? `#L${route.line}${isLineNumber(route.endLine) && route.endLine > route.line ? `-L${route.endLine}` : ''}` : ''
  return `/manage/code/${route.repoId}/${route.commit}${file}${compare}${directory}${lines}`
}

function parseRepositoryCodeRoute(url) {
  const match = /^\/manage\/code\/([1-9]\d*)(?:\/([a-f\d]{40})(?:\/(code|search|treemap|compare|commits|history|issues|pulls|agents|pulse|replay)(?:\/([^/]+)(?:\/([a-z]+))?)?)?)?$/u
    .exec(url.pathname.replace(/\/$/u, ''))
  if (!match) return undefined
  const repoId = Number(match[1])
  const path = url.searchParams.get('path') ?? ''
  // Commits' tab was History's, `/history`, which links still name.
  const tab = match[3] === 'history' ? 'commits' : match[3] ?? 'code'
  if (!isRepoId(repoId) || !isRepositoryDirectory(path)) return null
  const route = { view: 'repository-code', repoId, commit: match[2] ?? null, path, bundleTab: tab }
  if (match[4] == null) return route
  if (tab === 'compare') {
    return COMMIT.test(match[4]) && (match[5] == null || COMPARE_MODES.has(match[5])) ? { ...route, compareCommit: match[4], ...compareModeField(match[5]) } : null
  }
  const file = Number(match[4])
  return tab === 'code' && match[5] == null && /^[1-9]\d*$/u.test(match[4]) && Number.isSafeInteger(file) ? { ...route, file, ...codeLines(url.hash) } : null
}

function isLineNumber(value) {
  return Number.isSafeInteger(value) && value > 0
}

// `#L42` or `#L42-L69`, in either order; anything else marks no lines.
function codeLines(hash) {
  const match = /^#L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(hash)
  const [first, last] = match ? [Number(match[1]), Number(match[2] ?? match[1])] : []
  if (!isLineNumber(first) || !isLineNumber(last)) return {}
  return first === last ? { line: first } : { line: Math.min(first, last), endLine: Math.max(first, last) }
}

export function parseManagedRoute(url) {
  const path = url.pathname.replace(/\/$/u, '') || '/'
  if (path === '/' || path === '/index.html') return { view: 'home' }
  if (path === '/my/reviews') return { view: 'reviews' }
  // Linking an account lands here, naming why GitHub's answer was refused,
  // which the page shows once: the address it settles on drops it.
  if (path === '/my/profile') {
    const linkError = url.searchParams.get('link-error')
    return { view: 'profile', ...(linkError && /^[a-z-]{1,64}$/u.test(linkError) ? { linkError } : {}) }
  }
  const view = Object.keys(MANAGED_PAGES).find(key => MANAGED_PAGES[key] === path)
  if (view) {
    const createRepoId = Number(url.searchParams.get('createRepo'))
    return { view,
      ...(view === 'manage-deduplication' && url.searchParams.get('report') ? { linkId: url.searchParams.get('report') } : {}),
      ...(view === 'manage-bundles' && Number.isSafeInteger(createRepoId) && createRepoId > 0 ? { createRepoId } : {}),
      ...(view === 'manage-history' && url.searchParams.get('actor') ? { actor: url.searchParams.get('actor') } : {}),
      ...(view === 'manage-scans' ? url.searchParams.get('mode') === 'link' ? { scanMode: 'link' }
        : url.searchParams.get('bundle') ? { bundleId: url.searchParams.get('bundle'),
          ...(url.searchParams.get('mode') === 'dependencies' ? { scanMode: 'dependencies' } : {}) } : {} : {}),
    }
  }
  const bundle = /^(?:\/team\/([A-Za-z0-9_-]+)|\/manage)\/bundle\/([A-Za-z0-9_-]+)(?:\/([a-z]+)(?:\/([A-Za-z0-9_-]+)(?:\/([a-z]+))?)?)?$/u.exec(path)
  if (bundle) {
    const bundleTab = bundle[3] ?? 'overview'
    if (!BUNDLE_TABS.has(bundleTab)) return null
    const route = { view: 'bundles', teamSlug: bundle[1] ?? null, bundleSlug: bundle[2], bundleTab }
    if (bundle[4] == null) return route
    if (bundleTab === 'compare') return bundle[5] == null || COMPARE_MODES.has(bundle[5]) ? { ...route, compareSlug: bundle[4], ...compareModeField(bundle[5]) } : null
    const file = Number(bundle[4])
    if (bundleTab !== 'code' || bundle[5] || !/^[1-9]\d*$/u.test(bundle[4]) || !Number.isSafeInteger(file)) return null
    return { ...route, file, ...codeLines(url.hash) }
  }
  const npm = parseNpmRoute(path, url.hash)
  if (npm !== undefined) return npm
  const code = parseRepositoryCodeRoute(url)
  if (code !== undefined) return code
  const contentList = /^\/team\/([A-Za-z0-9_-]+)\/(reports|bundles|repositories)$/u.exec(path)
  if (contentList) return { view: `workspace-${contentList[2]}`, teamSlug: contentList[1] }
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
  if (WORKSPACE_CONTENT_VIEWS.has(route.view)) {
    const matches = teams.filter(team => team.slug === route.teamSlug)
    return matches.length === 1 ? { view: route.view, teamId: matches[0].id } : null
  }
  if (route.view === 'bundles') {
    const { teamSlug, bundleSlug, compareSlug, compareMode, ...rest } = route
    const matches = teamSlug == null ? [] : teams.filter(team => team.slug === teamSlug)
    if (teamSlug != null && matches.length !== 1) return null
    const team = matches[0]
    const candidates = teamSlug == null ? adminBundles : teams.flatMap(entry => entry.bundles ?? [])
    const idsOf = slug => new Set(candidates.filter(bundle => bundle.slug === slug).map(bundle => bundle.id))
    const ids = idsOf(bundleSlug)
    const bundle = (team?.bundles ?? adminBundles).find(entry => entry.slug === bundleSlug)
    if (!bundleSlug || !bundle || ids.size !== 1) return null
    // The bundle compared with, by the same rule; one no longer listed drops
    // out, leaving Compare to pick again.
    const compared = compareSlug == null ? null : idsOf(compareSlug)
    const compare = compared?.size === 1 ? { compareId: [...compared][0], ...compareModeField(compareMode) } : {}
    return { ...rest, teamId: team?.id ?? null, bundleId: bundle.id, ...compare }
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
  if (WORKSPACE_CONTENT_VIEWS.has(route.view)) {
    const team = teams.find(entry => entry.id === route.teamId)
    const result = { view: route.view, teamSlug: team?.slug }
    return team?.slug && resolveManagedRoute(result, teams) ? result : null
  }
  if (route.view === 'bundles') {
    const { teamId, bundleId, compareId, compareMode, ...rest } = route
    const team = teams.find(entry => entry.id === teamId)
    if (teamId != null && !team?.slug) return null
    const bundle = (team?.bundles ?? adminBundles).find(entry => entry.id === bundleId)
    if (!bundle?.slug) return null
    const compared = compareId == null ? null
      : (teamId == null ? adminBundles : teams.flatMap(entry => entry.bundles ?? [])).find(entry => entry.id === compareId)
    const result = { ...rest, teamSlug: team?.slug ?? null, bundleSlug: bundle.slug,
      ...(compared?.slug ? { compareSlug: compared.slug, ...compareModeField(compareMode) } : {}) }
    const resolved = resolveManagedRoute(result, teams, adminBundles)
    if (!resolved) return null
    // A compared bundle whose slug doesn't name it alone leaves the route.
    if (result.compareSlug != null && resolved.compareId !== compareId) {
      const { compareSlug: _slug, compareMode: _mode, ...bare } = result
      return bare
    }
    return result
  }
  if (!['findings', 'files'].includes(route.view)) return route
  const { teamId, reportId, ...rest } = route
  const team = teams.find(entry => entry.id === teamId)
  const report = reportId == null ? null : team?.reports?.find(entry => entry.id === reportId)
  if (!team?.slug || (reportId != null && !report?.slug)) return null
  const result = { ...rest, teamSlug: team.slug, reportSlug: report?.slug ?? null }
  return resolveManagedRoute(result, teams) ? result : null
}
