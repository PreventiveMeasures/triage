// Published npm advisories for bundled package versions. Local/e2e queries
// use the browser's inventory; managed queries use the authorized bundle ID.
// Keep results in memory, scoped to the current managed identity and teams.

import { html, nothing } from 'lit'
import { state } from '#client/index.js'
import { fetchBundleAdvisories } from './client-managed.js'
import { bundleKind } from './ingest.js'
import { bundlePackageVersions } from './bundle-sources.js'
import { bundleReasons } from '../../common/bundle-reasons.js'
import './bundle-scope-selector.js'

const localCache = new Map()
let managedCache = new Map(), managedScope = []
function advisoryCache(details) {
  if (!details?.managedId) return localCache
  const session = state.managedSession
  const scope = [session?.id, session?.role, session?.csrfToken, state.currentManagedTeam, state.managedTeams]
  if (scope.some((value, index) => value !== managedScope[index])) {
    managedScope = scope
    managedCache = new Map()
  }
  return managedCache
}
const scopes = new WeakMap()
function advisoryScope(details) {
  if (!scopes.has(details)) scopes.set(details, { reasons: bundleReasons(details), selected: '' })
  return scopes.get(details)
}
function cacheKey(details) { return JSON.stringify([details.managedId ?? details.integrity, advisoryScope(details).selected]) }

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

// True when the parsed bundle has at least one stasis module that
// carries both a name AND a concrete version string under a
// `node_modules/...` path. Sourcemaps (no module metadata) and v0
// stasis bundles (modules merged into the map but with `version:
// null`) both miss out. Early-exit on the first qualifying entry
// so a large bundle (hundreds of modules) doesn't pay an O(n) scan.
//
// Module-private — callers go through `showAdvisoriesTab` below
// which adds the parse-window optimistic-show layer for
// stasis-by-filename bundles.
//
// Keeps its own copy of the `bundlePackageVersions` filter (node_modules
// dir + name + concrete version) rather than calling it: this is a
// first-match predicate, so it returns on the first qualifying module
// instead of building the whole Map. If that filter rule changes, update
// it here too.
function bundleHasAdvisoryCandidates(details) {
  if (!details || details.kind !== 'stasis' || !details.bundle) return false
  for (const [dir, info] of details.bundle.modules) {
    if (!dir.includes('node_modules')) continue
    if (info?.name && typeof info.version === 'string' && info.version) return true
  }
  return false
}

// Tab-visibility predicate. Tri-state:
//   * non-stasis filename → hide immediately (no parse needed; we
//     already know there'll be no version metadata).
//   * stasis filename, no matching parsed details yet → keep visible
//     optimistically. This is the window where the user has just
//     selected a stasis bundle and the parser is still running, OR
//     they switched between two stasis bundles and `bundleDetails`
//     still points at the previous one (different integrity). Without
//     the optimistic show, the tab flickers away mid-switch and the
//     `state.bundleDetailsTab === 'advisories'` coercion in
//     renderBundleSlide drops the user back to Overview before the
//     new bundle's modules land — visible as a tab strip jump + a
//     content swap on every navigation between stasis bundles.
//   * stasis filename, matching parsed details → defer to
//     `bundleHasAdvisoryCandidates` (so v0 stasis correctly hides).
export function showAdvisoriesTab(entry, details) {
  if (!entry || bundleKind(entry.name) !== 'stasis') return false
  if (entry.managedId || !details || details.integrity !== entry.integrity) return true
  return bundleHasAdvisoryCandidates(details)
}

// Materialise the query as the wire shape the npm registry expects:
// `{ packageName: [version, version, ...] }`. Versions are sorted
// so the request body is byte-stable across re-issues for the same
// bundle. `Object.create(null)` over `{}` — a hostile / malformed
// bundle could in principle stamp `__proto__` or `constructor` as
// a module name; the prototype-less object makes the subsequent
// `obj[name] = …` strictly a property write rather than reaching
// Object.prototype's setter. JSON.stringify treats both forms
// identically on the wire.
function queryToWire(query) {
  const obj = Object.create(null)
  for (const [name, versions] of query) {
    obj[name] = [...versions].toSorted()
  }
  return obj
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

export async function ensureBundleAdvisories(details, renderFn) {
  if (!details?.integrity || (!details.managedId && !hasConsent())) return
  const cache = advisoryCache(details), key = cacheKey(details)
  if (cache.has(key)) return
  const { reasons, selected } = advisoryScope(details)
  let query = details.managedId ? new Map() : bundlePackageVersions(details, reasons.get(selected) ?? null)
  cache.set(key, { state: 'loading', query })
  try {
    let json
    if (details.managedId) {
      const result = await fetchBundleAdvisories(details.managedId, undefined, selected)
      query = new Map(Object.entries(result.packages).map(([name, versions]) => [name, new Set(versions)]))
      json = result.advisories
    } else {
      json = query.size > 0 ? await fetchLocalAdvisories(query) : {}
    }
    const byPackage = new Map()
    if (json && typeof json === 'object') {
      for (const [name, list] of Object.entries(json)) {
        if (!Array.isArray(list)) continue
        const normalised = list.filter(a => a && typeof a === 'object'
          && typeof a.title === 'string' && typeof a.severity === 'string')
        if (normalised.length > 0) byPackage.set(name, normalised)
      }
    }
    cache.set(key, { state: 'ok', byPackage, query })
  } catch (err) {
    cache.set(key, { state: 'error', reason: err?.message ?? 'fetch-failed', query })
  }
  renderFn()
}

// Drop a sticky error entry and re-issue the lookup. Wired to the
// error state's Retry button (events.js `data-advisories-retry`
// delegate) so a transient failure — relay restarting, offline
// moment — doesn't wedge the tab for the rest of the session.
// No-op unless the cached entry is actually an error: `loading`
// must not be re-entered (double fetch) and `ok` is the result we
// wanted anyway.
export async function retryBundleAdvisories(details, renderFn) {
  if (!details?.integrity) return
  const cache = advisoryCache(details), key = cacheKey(details)
  if (cache.get(key)?.state !== 'error') return
  cache.delete(key)
  await ensureBundleAdvisories(details, renderFn)
}

// Severity ordering. The npm advisories endpoint emits
// `critical | high | moderate | low | info`. Anything else (an
// unknown future-only value) sorts to the end via the fallback
// 999, keeping the rest deterministic.
const SEVERITY_RANK = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 }

function severityRank(s) {
  return SEVERITY_RANK[s] ?? 999
}

// Capitalise the npm severity tag for display.
function severityLabel(s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// First-time consent UI for the Advisories tab: explains what gets
// sent (package names + versions, via the same-origin relay) before
// the first request. The preference persists — no per-bundle re-prompt
// after the first Confirm.
function renderConsentPrompt() {
  // `window.location.host` (vs `.origin`) mirrors the bare
  // `registry.npmjs.org` shape on the right side of the arrow —
  // host:port pair without the scheme noise. Browser-side render
  // only; the relay's `/api/npm-advisories` resolves under this
  // host via fetch's default origin handling.
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

// Render the Advisories tab body. Four branches:
//   * Consent  — first local/e2e visit; explains the outbound query (see
//                renderConsentPrompt) before anything is fetched
//   * Loading  — kicked the fetch, no data yet
//   * Error    — the relay or upstream rejected
//   * Data     — render one section per package with at least
//                one advisory, sorted by severity desc then by
//                package name (or a one-line summary when none)
export function renderBundleAdvisoriesTab(details, renderFn = () => {}) {
  const scope = details ? advisoryScope(details) : null
  const reasons = [...(scope?.reasons.keys() ?? [])].map(reason => ({ id: `reason:${reason}`, label: reason }))
  return html`<div class="bundle-advisories-panel">
    ${reasons.length > 0 ? html`<div class="bundle-advisories-scopes"><bundle-scope-selector
      .reasons=${reasons} .value=${scope.selected ? `reason:${scope.selected}` : ''} label="Choose advisory scope"
      @scope-change=${event => {
        const reason = event.detail.value.replace(/^reason:/u, '')
        scope.selected = scope.reasons.has(reason) ? reason : ''
        const loading = ensureBundleAdvisories(details, renderFn)
        renderFn()
        return loading
      }}></bundle-scope-selector></div>` : nothing}
    ${renderAdvisoriesBody(details)}
  </div>`
}

function renderAdvisoriesBody(details) {
  if (!details) return html`<div class="bundle-advisories-empty">Bundle not loaded yet.</div>`
  if (details.kind !== 'stasis' || (!details.managedId && !details.bundle)) {
    return html`<div class="bundle-advisories-empty">Advisories are only available for stasis bundles.</div>`
  }
  if (!details.managedId && !hasConsent()) return renderConsentPrompt()
  const entry = advisoryCache(details).get(cacheKey(details))
  if (!entry || entry.state === 'loading') {
    return html`<div class="bundle-advisories-empty">Loading advisories from npm registry…</div>`
  }
  if (entry.state === 'error') {
    return html`<div class="bundle-advisories-empty is-error">
      <span>Failed to fetch advisories: ${entry.reason}</span>
      <button type="button" class="bundle-advisories-retry" data-advisories-retry>Retry</button>
    </div>`
  }
  // `ok` branch — paint the per-package sections. The tab is
  // hidden by `bundleHasAdvisoryCandidates` when the bundle has no
  // queryable packages at all, so we don't need a dedicated
  // `totalPackagesQueried === 0` branch here.
  const totalPackagesQueried = entry.query.size
  const packagesWithAdvisories = entry.byPackage.size
  if (packagesWithAdvisories === 0) {
    return html`<div class="bundle-advisories">
      <div class="bundle-advisories-summary">
        No advisories for the ${totalPackagesQueried} ${totalPackagesQueried === 1 ? 'package' : 'packages'} in ${advisoryScope(details).selected ? 'this scope' : 'this bundle'}.
      </div>
    </div>`
  }
  // Sort sections by the worst severity inside the section, then
  // by name — surfaces the most urgent stuff at the top while
  // keeping the rest deterministic across re-renders.
  const sections = [...entry.byPackage.entries()].toSorted(([na, la], [nb, lb]) => {
    const wa = Math.min(...la.map((a) => severityRank(a.severity)))
    const wb = Math.min(...lb.map((a) => severityRank(a.severity)))
    if (wa !== wb) return wa - wb
    return na.localeCompare(nb)
  })
  const totalAdvisories = [...entry.byPackage.values()].reduce((n, l) => n + l.length, 0)
  return html`<div class="bundle-advisories">
    <div class="bundle-advisories-summary">
      ${totalAdvisories} ${totalAdvisories === 1 ? 'advisory' : 'advisories'}
      across ${packagesWithAdvisories} of ${totalPackagesQueried} ${totalPackagesQueried === 1 ? 'package' : 'packages'}
    </div>
    <ul class="bundle-advisories-list">
      ${sections.map(([pkg, list]) => renderAdvisorySection(pkg, list, entry.query.get(pkg)))}
    </ul>
  </div>`
}

function renderAdvisorySection(pkg, advisories, queriedVersions) {
  const sorted = [...advisories].toSorted((a, b) => {
    const r = severityRank(a.severity) - severityRank(b.severity)
    if (r !== 0) return r
    return (a.title ?? '').localeCompare(b.title ?? '')
  })
  const versions = queriedVersions ? [...queriedVersions].toSorted() : []
  return html`<li class="bundle-advisories-section">
    <div class="bundle-advisories-section-header">
      <span class="bundle-advisories-section-name">${pkg}</span>
      ${versions.length > 0 ? html`<span class="bundle-advisories-section-versions">
        ${versions.map((v) => html`<span class="bundle-advisories-version-chip">${v}</span>`)}
      </span>` : nothing}
      <span class="bundle-advisories-section-count">${sorted.length} ${sorted.length === 1 ? 'advisory' : 'advisories'}</span>
    </div>
    <ul class="bundle-advisories-rows">
      ${sorted.map((a) => renderAdvisoryRow(a))}
    </ul>
  </li>`
}

// Extract the GHSA id from the advisory URL. The npm registry's
// response carries the id only as part of the URL
// (`https://github.com/advisories/GHSA-xxxx-xxxx-xxxx`), not as a
// dedicated field — pull it out via regex so we can render it as a
// stable chip alongside the title. Returns null when the URL is
// missing or doesn't follow the documented shape.
function ghsaIdFrom(url) {
  if (typeof url !== 'string') return null
  const m = /\/(GHSA-[a-z0-9-]+)(?:[/?#]|$)/iu.exec(url)
  return m ? m[1] : null
}

// External-link glyph rendered next to the GHSA id — bare diagonal
// arrow filling the full 16×16 viewBox. `currentColor` so it tints
// with the surrounding text (muted by default, accent on hover).
const EXTERNAL_LINK_SVG = html`<svg class="bundle-advisory-ghsa-icon" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 13L13 3"/>
  <path d="M5 3h8v8"/>
</svg>`

// MITRE CWE link for a `CWE-1234`-shaped id — link form is
// https://cwe.mitre.org/data/definitions/<n>.html. Anything else
// (a non-canonical CWE label, a plain string like "n/a") renders
// as plain text. Surfaces the numeric id only; the link is the
// only side-channel the user gets to the upstream definition.
function cweTemplate(c) {
  const m = /^CWE-(\d+)$/u.exec(c)
  if (!m) return html`<span>${c}</span>`
  const url = `https://cwe.mitre.org/data/definitions/${m[1]}.html`
  return html`<a class="bundle-advisory-cwe" href=${url} target="_blank" rel="noopener noreferrer">${c}</a>`
}

function renderAdvisoryRow(a) {
  const sev = a.severity
  const title = a.title
  const cvssScore = typeof a.cvss?.score === 'number' ? a.cvss.score.toFixed(1) : ''
  const cvssVector = typeof a.cvss?.vectorString === 'string' && a.cvss.vectorString ? a.cvss.vectorString : ''
  const vulnerable = typeof a.vulnerable_versions === 'string' ? a.vulnerable_versions : null
  const url = typeof a.url === 'string' && /^https?:\/\//iu.test(a.url) ? a.url : null
  const ghsa = ghsaIdFrom(url)
  const cwes = Array.isArray(a.cwe) ? a.cwe.filter((c) => typeof c === 'string') : []
  // GHSA — pinned to the right of the title row when present. Click
  // opens the GitHub advisory page; the title itself stays a plain
  // span so it isn't a duplicate pointer at the same upstream
  // advisory (the GHSA chip is the single canonical link).
  const ghsaEl = ghsa
    ? html`<a class="bundle-advisory-ghsa" href=${url} target="_blank" rel="noopener noreferrer">${ghsa}${EXTERNAL_LINK_SVG}</a>`
    : nothing
  return html`<li class="bundle-advisory-row">
    <div class="bundle-advisory-rail">
      <span class=${`bundle-advisory-severity sev-${sev}`}>${severityLabel(sev)}</span>
      ${cvssScore ? html`<span class="bundle-advisory-cvss-score">CVSS <span class="mono">${cvssScore}</span></span>` : nothing}
    </div>
    <div class="bundle-advisory-body">
      <div class="bundle-advisory-header">
        <span class="bundle-advisory-title">${title}</span>
        ${ghsaEl}
      </div>
      <div class="bundle-advisory-subrow">
        <div class="bundle-advisory-meta">
          ${vulnerable ? html`<span>Affected <span class="mono">${vulnerable}</span></span>` : nothing}
          ${cwes.length > 0 ? html`<span class="bundle-advisory-cwes">${cwes.map((c, i) => html`${i === 0 ? '' : ', '}${cweTemplate(c)}`)}</span>` : nothing}
        </div>
        ${cvssVector ? html`<div class="bundle-advisory-cvss-vector mono">${cvssVector}</div>` : nothing}
      </div>
    </div>
  </li>`
}

