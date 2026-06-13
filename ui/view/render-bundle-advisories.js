// Advisories tab for the bundle slide. Stasis bundles carry
// per-module `{ name, version }` metadata (see
// `@exodus/stasis/bundle`'s `Bundle.modules` Map), so we can fan
// out a single bulk lookup against the npm registry's advisories
// endpoint and surface every CVE / advisory affecting the bundled
// versions. The relay's `/api/npm-advisories` route proxies the
// upstream call (the registry doesn't emit CORS headers for arbitrary
// callers — direct browser fetches would fail same-origin).
//
// Fetch state lives in a module-scoped cache keyed by bundle
// `integrity`. Each entry walks through:
//   * `loading`  — fetch in flight; renders a placeholder
//   * `ok`       — fetch landed; carries the per-package advisory
//                  rows merged across known versions
//   * `error`    — fetch failed (network / non-2xx / parse); shows
//                  the reason
//
// The cache is intentionally NOT in `state` — re-rendering the
// view shouldn't poke through observer-util on every tick when
// the fetch is still in flight. We call `render()` explicitly at
// the resolve / reject points to repaint the slide once the data
// lands.

import { html, nothing } from 'lit'
import { bundleKind } from './ingest.js'
import { bundlePackageVersions } from './bundle-sources.js'

const cache = new Map()

// One-time consent for the npm-advisories network call. Even though
// the proxy is same-origin and the upstream endpoint is public, the
// request sends the bundle's full (package → versions) inventory to
// a third party (the npm registry) on the user's behalf — so we ask
// first. The flag is persisted so subsequent bundle visits skip the
// prompt. Plain localStorage (matches the first-import-prompt
// pattern); the secure-storage vault is overkill for a boolean
// preference that's not personally identifying.
const CONSENT_KEY = 'deepview.advisories.proxyConsent'

function hasConsent() {
  try { return localStorage.getItem(CONSENT_KEY) === '1' } catch { return false }
}

export function grantAdvisoriesProxyConsent() {
  try { localStorage.setItem(CONSENT_KEY, '1') } catch {}
}

// Collect every (packageName → Set<version>) the stasis bundle names
// in its `modules` map, restricted to upstream `node_modules/...`
// dependencies with concrete versions — exactly the bulk query the
// registry's advisories endpoint takes. This is the shared
// `bundlePackageVersions` extractor (see bundle-sources.js): stasis v1
// `scope: 'full'` bundles merge workspace sources into the same
// `Bundle.modules` Map, so the own-source `@scope/foo @ 0.0.0` would
// otherwise get sent to the registry as a real query (and resolve to
// an unrelated public package, or to nothing); the helper filters those
// out by directory key, and drops versionless (`null`) entries the
// endpoint can't accept.
function bundleAdvisoryQuery(details) {
  return bundlePackageVersions(details)
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
  if (!details || details.integrity !== entry.integrity) return true
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

// Kick the fetch if it hasn't been started for this bundle yet.
// Idempotent: a re-render that runs while the fetch is in flight
// finds the `loading` entry and skips re-issuing. Resolved AND
// errored entries are sticky — the cache is keyed by bundle
// `integrity` (SRI hash of bundle bytes), so a re-open of the same
// bundle returns the previous result without re-hitting the
// registry. An errored entry stays until the user clicks the error
// state's Retry button (`retryBundleAdvisories` below), which drops
// it and re-issues. Memory is bounded by the unique-bundle count
// per session (each entry is a few KB).
export async function ensureBundleAdvisories(details, renderFn) {
  if (!details?.integrity) return
  if (cache.has(details.integrity)) return
  // Gate the fetch behind the one-time consent prompt — the
  // renderBundleAdvisoriesTab path paints the consent UI when
  // hasConsent() returns false, and only after the user clicks
  // through does this function fire the request.
  if (!hasConsent()) return
  const query = bundleAdvisoryQuery(details)
  if (query.size === 0) {
    cache.set(details.integrity, { state: 'ok', byPackage: new Map(), query })
    return
  }
  cache.set(details.integrity, { state: 'loading', query })
  const integrity = details.integrity
  try {
    const res = await fetch('/api/npm-advisories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(queryToWire(query)),
    })
    if (!res.ok) {
      // Surface the proxy's `{ error, … }` envelope rather than a
      // bare `HTTP <status>` — the relay maps every documented
      // failure mode to a named string (`upstream-not-json`,
      // `payload-too-large`, `origin-denied`, `shutting-down`, …)
      // so the UI can show something more actionable than a
      // three-digit code. Falls back to the status if the body
      // isn't parseable JSON or doesn't carry an `error` field.
      let reason = `HTTP ${res.status}`
      try {
        const body = await res.json()
        if (body && typeof body.error === 'string' && body.error) {
          reason = `${body.error} (HTTP ${res.status})`
        }
      } catch {}
      cache.set(integrity, { state: 'error', reason, query })
      renderFn()
      return
    }
    const json = await res.json()
    const byPackage = new Map()
    if (json && typeof json === 'object') {
      for (const [name, list] of Object.entries(json)) {
        if (!Array.isArray(list)) continue
        // Normalise the array of advisories — strip anything that
        // doesn't carry the documented `severity` + `title`
        // pair so an upstream shape change doesn't paint half-
        // empty rows.
        const normalised = list.filter((a) => a && typeof a === 'object'
          && typeof a.title === 'string' && typeof a.severity === 'string')
        if (normalised.length > 0) byPackage.set(name, normalised)
      }
    }
    cache.set(integrity, { state: 'ok', byPackage, query })
  } catch (err) {
    cache.set(integrity, { state: 'error', reason: err?.message ?? 'fetch-failed', query })
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
  if (cache.get(details.integrity)?.state !== 'error') return
  cache.delete(details.integrity)
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

// Render the Advisories tab body. Three branches:
//   * Loading  — kicked the fetch, no data yet
//   * Error    — the relay or upstream rejected
//   * Data     — render one section per package with at least
//                one advisory, sorted by severity desc then by
//                package name
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

export function renderBundleAdvisoriesTab(details) {
  if (!details) return html`<div class="bundle-advisories-empty">Bundle not loaded yet.</div>`
  if (details.kind !== 'stasis' || !details.bundle) {
    return html`<div class="bundle-advisories-empty">Advisories are only available for stasis bundles.</div>`
  }
  // First visit (or post-`localStorage.clear()`) lands on a consent
  // prompt — the request sends the bundle's full (package → versions)
  // inventory to a third party (the npm registry, via the same-origin
  // relay) and we shouldn't fire it without an explicit opt-in. The
  // `data-advisories-consent` button is delegated through events.js
  // and writes the flag + re-renders.
  if (!hasConsent()) return renderConsentPrompt()
  const entry = cache.get(details.integrity)
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
        No advisories for the ${totalPackagesQueried} ${totalPackagesQueried === 1 ? 'package' : 'packages'} in this bundle.
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
  const cvssScore = typeof a?.cvss?.score === 'number' ? a.cvss.score.toFixed(1) : ''
  const cvssVector = typeof a?.cvss?.vectorString === 'string' && a.cvss.vectorString ? a.cvss.vectorString : ''
  const vulnerable = typeof a.vulnerable_versions === 'string' ? a.vulnerable_versions : null
  const url = typeof a.url === 'string' && /^https?:\/\//iu.test(a.url) ? a.url : null
  const ghsa = ghsaIdFrom(url)
  const cwes = Array.isArray(a.cwe) ? a.cwe.filter((c) => typeof c === 'string') : []
  // GHSA — pinned to the right of the title row when present. Click
  // opens the GitHub advisory page; the title itself stays a plain
  // span so it isn't a duplicate pointer at the same upstream
  // advisory (the GHSA chip is the single canonical link).
  const ghsaEl = ghsa && url
    ? html`<a class="bundle-advisory-ghsa" href=${url} target="_blank" rel="noopener noreferrer">${ghsa}${EXTERNAL_LINK_SVG}</a>`
    : (ghsa ? html`<span class="bundle-advisory-ghsa">${ghsa}</span>` : nothing)
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

