// Published advisories for bundled package versions. Local/e2e npm queries
// use the browser's inventory; managed queries use the authorized bundle ID.
// Keep results in memory, scoped to the current managed identity and teams.

import { html, nothing } from 'lit'
import { appMarkup } from './markup.js'
import { store } from '@rray/frontend/state-management'
import { state } from '#client/index.js'
import { fetchBundleAdvisories } from './client-managed.js'
import { bundleKind } from './ingest.js'
import { bundlePackageVersions } from '../../common/bundle-sources.js'
import { bundleScopes, scopeOptions } from '../../common/bundle-reasons.js'
import { isDirectoryEcosystem, malformedDirectoryPackage } from '../../common/managed/directory-packages.ts'
import { SCAN_ICON_SVG } from './icons.js'
import { advisoryRow } from './advisory-parts.js'
import './bundle-scope-selector.js'
import { openAdvisoryDetailsDialog, openWhyDialog } from './lazy-dialogs.js'

const localCache = new Map()
let managedCache = new Map(), managedScope = []
function advisoryCache(details) {
  if (!details?.managedId) return localCache
  const session = state.managedSession
  // Observers lazily wrap arrays. Normalize identity so opening a reactive
  // details popup does not mistake that wrapper for a team change.
  const teams = state.managedTeams && store(state.managedTeams)
  const scope = [session?.id, session?.role, session?.csrfToken, state.currentManagedTeam, teams]
  if (scope.some((value, index) => value !== managedScope[index])) {
    managedScope = scope
    managedCache = new Map()
  }
  return managedCache
}
const scopes = new WeakMap()
function advisoryScope(details) {
  if (!scopes.has(details)) scopes.set(details, { reasons: bundleScopes(details), selected: '' })
  return scopes.get(details)
}
function cacheKey(details, reason = advisoryScope(details).selected) { return JSON.stringify([details.managedId ?? details.integrity, reason]) }

// Local/e2e bundles are private from the server. Ask before sending their
// package inventory through the proxy to npm. Managed bundles are already
// server-readable and use the authorized bundle endpoint without this prompt.
const CONSENT_KEY = 'deepview.advisories.proxyConsent'

function hasConsent() {
  try { return localStorage.getItem(CONSENT_KEY) === '1' } catch { return false }
}

export function grantAdvisoriesProxyConsent() {
  try { localStorage.setItem(CONSENT_KEY, '1') } catch {}
}

// Whether a parsed Stasis bundle (sourcemaps have no modules) has a module
// `test(dir, info)` takes: a first-match test, so a large bundle isn't
// walked whole.
function someModule(details, test) {
  if (!details || details.kind !== 'stasis' || !details.bundle) return false
  for (const [dir, info] of details.bundle.modules) {
    if (test(dir, info)) return true
  }
  return false
}

// A module under node_modules with a name and a version (v0 bundles' are
// null): `bundlePackageVersions`'s filter, change both together.
const bundleHasAdvisoryCandidates = details => someModule(details, (dir, info) =>
  dir.includes('node_modules') && info?.name && typeof info.version === 'string' && info.version)

// A dependency package as the managed audit inventories one
// (server-managed/bundle-advisory-inventory.ts), short of its evidence-file
// rule, which only the server applies: a module other than the root, with an
// ecosystem (recorded, or npm under node_modules), a name and a version; but
// one installed from a directory, the repository's own code, its record as
// Stasis records one (a malformed one is listed as not audited).
const bundleHasDependencyPackages = details => someModule(details, (dir, info) =>
  dir !== '.' && typeof info?.name === 'string' && info.name && typeof info.version === 'string' && info.version
    && !(isDirectoryEcosystem(info.ecosystem) && !malformedDirectoryPackage(info)) && (info.ecosystem || /(?:^|\/)node_modules\//u.test(dir)))

// A managed bundle offers no recheck or scan without dependency packages: by
// its modules, or once its unscoped audit answers, by the server's inventory.
function managedBundleHasNoDependencies(details) {
  if (details.bundle && !bundleHasDependencyPackages(details)) return true
  const audit = advisoryCache(details).get(cacheKey(details, ''))
  return audit?.state === 'ok' && audit.query.size === 0 && audit.skipped.length === 0
}

// Whether the Advisories tab shows. Managed bundles need security access.
// Never for a bundle known to have no package versions: a Stasis bundle
// before format version 1 (by its parse or its catalogue summary), or one
// whose summary counts no versioned packages (what the server's audit
// covers), which a managed bundle's says before it opens. While it is the
// `selected` tab, for any other bundle, sourcemaps too, so a switch or a
// link keeps it open, its body saying why it is empty. Else for a Stasis
// filename: while its details aren't parsed yet (or still the previous
// bundle's), so switching between Stasis bundles doesn't flicker the tab
// away and drop the user on Overview; once parsed, where it has advisory
// candidates, or a managed one dependency packages (none parsed keeps it:
// the server audits without the viewer's metadata).
export function showAdvisoriesTab(entry, details, selected = false) {
  if (!entry || (entry.managedId && !canReadManagedAdvisories(entry))) return false
  if (stasisVersion(entry, details) < 1 || entry.summary?.versionedPackages === 0) return false
  if (selected) return true
  if (bundleKind(entry.name) !== 'stasis') return false
  if (!details || details.integrity !== entry.integrity) return true
  if (entry.managedId) return !details.bundle || bundleHasDependencyPackages(details)
  return bundleHasAdvisoryCandidates(details)
}

// The bundle's Stasis format version, by its parsed details or its catalogue
// summary; Infinity while neither says.
function stasisVersion(entry, details) {
  const version = details?.integrity === entry.integrity && details.bundle ? details.bundle.version : entry.summary?.stasisVersion
  return Number.isSafeInteger(version) ? version : Infinity
}

function canReadManagedAdvisories(entry) {
  const role = state.managedSession?.role
  if (['admin', 'manage'].includes(role)) return true
  if (!['view', 'triage'].includes(role)) return false
  // Match the API's team scope, including a public link's own grant.
  return state.managedTeams.some(team => (state.currentManagedTeam == null || team.id === state.currentManagedTeam)
    && team.permissions?.security === true && team.bundles?.some(bundle => bundle.id === entry.managedId))
}

// Object.fromEntries safely preserves package names such as __proto__.
function queryToWire(query) {
  return Object.fromEntries([...query].map(([name, versions]) => [name, [...versions].toSorted()]))
}

const packageKey = pkg => pkg.ecosystem === 'npm' ? pkg.name : `${pkg.ecosystem}:${pkg.name}`

function managedAdvisory(row) {
  return {
    ...row, title: row.title || row.id, severity: row.severity ?? 'unknown',
    cvss: { score: row.cvss, vectorString: row.cvssVector }, vulnerable_versions: row.range,
  }
}

// Managed responses are flat rows; local and older managed responses are keyed by package.
function groupAdvisories(data) {
  const managed = Array.isArray(data)
  const groups = managed ? Map.groupBy(data.map(managedAdvisory), packageKey) : new Map(Object.entries(data ?? {}))
  for (const [name, rows] of groups) {
    const valid = Array.isArray(rows) ? rows.filter(row => row && typeof row.title === 'string' && typeof row.severity === 'string') : []
    if (valid.length > 0) groups.set(name, managed ? valid : valid.map(row => ({ ...row, source: 'registry' })))
    else groups.delete(name)
  }
  return groups
}

function canRecheckRepositories(details, entry) {
  return Boolean(details?.managedId && entry?.state === 'ok' && !entry.recheckingRepositories && entry.query.size > 0)
}

// Local/e2e mode already owns the bundle; managed mode supplies its ID and
// receives the package inventory with the advisories from the authorized API.
async function fetchLocalAdvisories(query) {
  const res = await fetch('/api/npm-advisories', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(queryToWire(query)),
  })
  if (!res.ok) {
    let reason = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (typeof body?.error === 'string' && body.error) reason = `${body.error} (HTTP ${res.status})`
    } catch {}
    throw new Error(reason)
  }
  return res.json()
}

// The bundle's advisories in its scope, asked for once; `repoAdvisories`
// (recheckBundleAdvisories) asks again, against its repositories too, the
// results meanwhile kept.
export async function ensureBundleAdvisories(details, renderFn, repoAdvisories = false) {
  if (!details?.integrity || (!details.managedId && !hasConsent())) return
  const cache = advisoryCache(details), key = cacheKey(details)
  const previous = cache.get(key)
  if (repoAdvisories) {
    if (!canRecheckRepositories(details, previous)) return
    cache.set(key, { ...previous, recheckingRepositories: true, repositoryError: null })
    renderFn()
  } else if (previous) return
  const { reasons, selected } = advisoryScope(details)
  let query = details.managedId ? new Map() : bundlePackageVersions(details, reasons.files(selected))
  if (!repoAdvisories) cache.set(key, { state: 'loading', query })
  try {
    let json, skipped = []
    if (details.managedId) {
      // Fetch full descriptions only on an explicit repository recheck.
      const result = await fetchBundleAdvisories(details.managedId, undefined, selected, repoAdvisories, repoAdvisories)
      // Accept the former npm-only shape during a client/server upgrade.
      query = Array.isArray(result.packages)
        ? new Map(result.packages.map(pkg => [packageKey(pkg), new Set(pkg.versions)]))
        : new Map(Object.entries(result.packages).map(([name, versions]) => [name, new Set(versions)]))
      json = result.advisories
      skipped = Array.isArray(result.skipped) ? result.skipped : []
    } else {
      json = query.size > 0 ? await fetchLocalAdvisories(query) : {}
    }
    cache.set(key, { state: 'ok', byPackage: groupAdvisories(json), query, skipped })
  } catch (err) {
    const reason = err?.message ?? 'fetch-failed'
    cache.set(key, repoAdvisories && ![401, 403, 404].includes(err?.status)
      ? { ...previous, recheckingRepositories: false, repositoryError: reason }
      : { state: 'error', reason, query })
  }
  renderFn()
}

export const recheckBundleAdvisories = (details, renderFn) => ensureBundleAdvisories(details, renderFn, true)

// The error state's Retry (events.js `data-advisories-retry`): a failed
// lookup asked again, so a passing failure doesn't wedge the tab; nothing
// for one loading or loaded.
export async function retryBundleAdvisories(details, renderFn) {
  if (!details?.integrity) return
  const cache = advisoryCache(details), key = cacheKey(details)
  if (cache.get(key)?.state !== 'error') return
  cache.delete(key)
  await ensureBundleAdvisories(details, renderFn)
}

// The npm advisories endpoint's severities, worst first; any other last.
const SEVERITY_RANK = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 }
const severityRank = s => SEVERITY_RANK[s] ?? 999

// What a first lookup sends (package names and versions, through the
// same-origin relay), asked once for every bundle. The host, not the origin,
// as `registry.npmjs.org` beside it is.
function renderConsentPrompt() {
  const proxyHost = typeof window === 'undefined' ? '' : window.location.host
  return html`<div class="bundle-advisories-consent">
    <div class="bundle-advisories-consent-card">
      <p class="bundle-advisories-consent-text">
        This bundle's dependency names and versions will be sent to the
        npm registry through a same-origin proxy
        (<span class="mono">${proxyHost}</span> →
        <span class="mono">registry.npmjs.org</span>) to look up
        published security advisories.
      </p>
      <button
        type="button"
        class="bundle-advisories-consent-btn"
        data-advisories-consent
      >Confirm</button>
      <p class="bundle-advisories-consent-note">This preference will be saved and reused for other bundles.</p>
    </div>
  </div>`
}

// The Advisories tab: consent first for a local or e2e bundle, then the
// lookup's state, and a section for each package with advisories, worst
// first. A managed bundle with dependency packages has its repository
// recheck, and `onScan`, where the viewer may scan it, a Validate button
// opening its Dependency alerts scan.
export function renderBundleAdvisoriesTab(details, renderFn = () => {}, onScan = null) {
  const scope = details ? advisoryScope(details) : null
  const reasons = scope ? scopeOptions(scope.reasons) : []
  // The lookup in the scope shown.
  const entry = details ? advisoryCache(details).get(cacheKey(details)) : undefined
  const summary = renderAdvisoriesSummary(details, entry)
  const actions = Boolean(details?.managedId) && !managedBundleHasNoDependencies(details)
  return html`<div class="bundle-advisories-panel">
    ${summary !== nothing || reasons.length > 0 || actions ? html`<div class="bundle-advisories-toolbar">
    ${summary}
    ${reasons.length > 0 || actions ? html`<div class="bundle-advisories-scopes">
    ${actions ? renderRepositoryRecheck(details, entry, renderFn) : nothing}
    ${reasons.length > 0 ? html`<bundle-scope-selector
      .reasons=${reasons} .value=${scope.selected} label="Choose advisory scope"
      @scope-change=${event => {
        scope.selected = scope.reasons.has(event.detail.value) ? event.detail.value : ''
        const loading = ensureBundleAdvisories(details, renderFn)
        renderFn()
        return loading
      }}></bundle-scope-selector>` : nothing}
    ${actions && onScan ? html`<button type="button" class="bundle-advisories-retry bundle-advisories-scan" @click=${onScan}>
      ${appMarkup(SCAN_ICON_SVG)}<span>Validate</span>
    </button>` : nothing}
    </div>` : nothing}
    </div>` : nothing}
    ${renderAdvisoriesBody(details, entry)}
  </div>`
}

function renderRepositoryRecheck(details, entry, renderFn) {
  const busy = Boolean(entry?.recheckingRepositories)
  return html`<button type="button" class="bundle-advisories-retry bundle-advisories-recheck"
    ?disabled=${!canRecheckRepositories(details, entry)}
    aria-busy=${String(busy)} @click=${() => recheckBundleAdvisories(details, renderFn)}>
    ${busy ? 'Rechecking…' : 'Recheck against repositories'}
  </button>`
}

function renderAdvisoriesSummary(details, entry) {
  if (!details || (!details.managedId && !hasConsent()) || entry?.state !== 'ok') return nothing
  const totalPackagesQueried = entry.query.size
  const packagesWithAdvisories = entry.byPackage.size
  if (packagesWithAdvisories === 0) return nothing
  const totalAdvisories = [...entry.byPackage.values()].reduce((n, list) => n + list.length, 0)
  return html`<div class="bundle-advisories-summary">
    ${totalAdvisories} ${totalAdvisories === 1 ? 'advisory' : 'advisories'}
    across ${packagesWithAdvisories} of ${totalPackagesQueried} ${totalPackagesQueried === 1 ? 'package' : 'packages'}
  </div>`
}

function renderNoAdvisories(details, entry) {
  const count = entry.query.size
  if (count === 0 && entry.skipped.length > 0) return html`No packages could be audited.`
  return html`No advisories for the ${count} ${entry.skipped.length > 0 ? 'audited ' : ''}${count === 1 ? 'package' : 'packages'} in ${advisoryScope(details).selected ? 'this scope' : 'this bundle'}.`
}

function renderAdvisoriesBody(details, entry) {
  if (!details) return html`<div class="bundle-advisories-empty">Bundle not loaded yet.</div>`
  if (details.kind !== 'stasis' || (!details.managedId && !details.bundle)) {
    return html`<div class="bundle-advisories-empty">Advisories are only available for stasis bundles.</div>`
  }
  if (!details.managedId && !hasConsent()) return renderConsentPrompt()
  if (!entry || entry.state === 'loading') {
    return html`<div class="bundle-advisories-empty">Loading advisories…</div>`
  }
  if (entry.state === 'error') {
    return html`<div class="bundle-advisories-empty is-error">
      <span>Failed to fetch advisories: ${entry.reason}</span>
      <button type="button" class="bundle-advisories-retry" data-advisories-retry>Retry</button>
    </div>`
  }
  const empty = entry.byPackage.size === 0
    ? html`<div class="bundle-advisories-empty"><span>${renderNoAdvisories(details, entry)}</span></div>` : nothing
  if (entry.byPackage.size === 0 && entry.skipped.length === 0 && !entry.repositoryError) return empty
  const worst = list => Math.min(...list.map((a) => severityRank(a.severity)))
  const sections = [...entry.byPackage.entries()].toSorted(([na, la], [nb, lb]) => worst(la) - worst(lb) || na.localeCompare(nb))
  return html`${empty}<div class="bundle-advisories">
    ${entry.repositoryError ? html`<div class="bundle-advisories-empty is-error" role="alert">
      Repository recheck failed: ${entry.repositoryError}. Previous results are shown.
    </div>` : nothing}
    ${entry.skipped.length > 0 ? html`<section class="bundle-advisories-skipped" aria-label="Dependencies not audited">
      <h3>Not audited</h3>
      <ul>${entry.skipped.map(pkg => html`<li><span class="mono">${packageKey(pkg)}@${pkg.version}</span>: ${pkg.because}</li>`)}</ul>
    </section>` : nothing}
    <ul class="bundle-advisories-list">
      ${sections.map(([pkg, list]) => renderAdvisorySection(details, pkg, list, entry.query.get(pkg), () => advisoryCache(details).get(cacheKey(details))?.byPackage === entry.byPackage))}
    </ul>
  </div>`
}

function renderAdvisorySection(details, pkg, advisories, queriedVersions, isCurrent) {
  const sorted = advisories.toSorted((a, b) => severityRank(a.severity) - severityRank(b.severity) || (a.title ?? '').localeCompare(b.title ?? ''))
  const versions = queriedVersions ? [...queriedVersions].toSorted() : []
  return html`<li class="bundle-advisories-section">
    <div class="bundle-advisories-package">
      <span class="bundle-advisories-section-name">${pkg}</span>
      ${versions.length > 0 ? html`<span class="bundle-advisories-section-versions">
        ${versions.map(version => html`<button type="button" class="bundle-advisories-version" aria-haspopup="dialog"
          aria-label=${`Why is ${pkg}@${version} here?`}
          @click=${() => openWhyDialog({ details, packageKey: pkg, version, scope: advisoryScope(details).selected, isCurrent })}>${version}</button>`)}
      </span>` : nothing}
    </div>
    <ul class="bundle-advisories-rows">
      ${sorted.map((a) => advisoryRow(a, ({ title, severity, details: markdown }) => openAdvisoryDetailsDialog({ heading: title, severity, markdown, isCurrent })))}
    </ul>
  </li>`
}

