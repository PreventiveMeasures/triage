// An advisory's row, as bundle advisories (render-bundle-advisories.js) and
// an npm package's (npm-overview.js) list them: the severity rail, the title
// with its source and GHSA reference, and what it covers with CWE links.
import { html, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { GITHUB_ICON_SVG } from './icons.js'
import { sourceNpmIcon } from './source-file-icon.js'
import osvIcon from './osv-icon.svg'

const ADVISORY_SOURCES = new Map([
  ['registry', { label: 'Source: npm registry', icon: sourceNpmIcon }],
  ['repository', { label: 'Source: GitHub repository', icon: unsafeHTML(GITHUB_ICON_SVG) }],
  ['osv', { label: 'Source: OSV', icon: osvIcon }],
])

// Capitalise the npm severity tag for display.
function severityLabel(s) {
  if (s === 'unknown') return 'Unrated'
  return s.charAt(0).toUpperCase() + s.slice(1)
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

// An external link's glyph: a bare diagonal arrow filling its 16×16 box, in
// the text's color (muted by default, accent on hover). After a GHSA id, and
// after the npm package link in its header (render-bundle.js).
export const EXTERNAL_LINK_ICON = html`<svg class="external-link-icon" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13L13 3"/><path d="M5 3h8v8"/></svg>`

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

// Severity badge stacked above the CVSS score, where there is one.
function advisoryRail(severity, cvss) {
  return html`<div class="bundle-advisory-rail">
    <span class=${`bundle-advisory-severity sev-${severity}`}>${severityLabel(severity)}</span>
    ${typeof cvss === 'number' ? html`<span class="bundle-advisory-cvss-score">CVSS <span class="mono">${cvss.toFixed(1)}</span></span>` : nothing}
  </div>`
}

// Where the advisory comes from, and its id linking to its record: the
// GHSA where it has one, beside its source's icon.
function advisoryReference(a) {
  const url = typeof a.url === 'string' && /^https?:\/\//iu.test(a.url) ? a.url : null
  const advisoryId = a.ghsa ?? ghsaIdFrom(url) ?? (typeof a.id === 'string' ? a.id : null)
  const source = ADVISORY_SOURCES.get(a.source)
  if (!source && !(advisoryId && url)) return nothing
  return html`<span class="bundle-advisory-reference">
    ${source ? html`<span class="bundle-advisory-source" role="img" aria-label=${source.label}>${source.icon}</span>` : nothing}
    ${advisoryId && url ? html`<a class="bundle-advisory-ghsa" href=${url} target="_blank" rel="noopener noreferrer">${advisoryId}${EXTERNAL_LINK_ICON}</a>` : nothing}
  </span>`
}

function advisoryCwes(cwe) {
  const cwes = Array.isArray(cwe) ? cwe.filter((c) => typeof c === 'string') : []
  return cwes.length > 0 ? html`<span class="bundle-advisory-cwes">${cwes.map((c, i) => html`${i === 0 ? '' : ', '}${cweTemplate(c)}`)}</span>` : nothing
}

// Severity and CVSS in a rail of their own, so titles line up; the source and
// GHSA beside the title; the range it covers, versions matched, CWEs and CVSS
// vector under it. `onDetails` opens its text, where it has one.
export function advisoryRow(a, onDetails = null) {
  const cvssVector = typeof a.cvss?.vectorString === 'string' ? a.cvss.vectorString : ''
  const vulnerable = typeof a.vulnerable_versions === 'string' ? a.vulnerable_versions : null
  const matched = Array.isArray(a.versions) ? a.versions.filter(version => typeof version === 'string') : []
  return html`<li class="bundle-advisory-row">
    ${advisoryRail(a.severity, a.cvss?.score)}
    <div class="bundle-advisory-body">
      <div class="bundle-advisory-header">
        ${onDetails && typeof a.details === 'string' && a.details.trim()
          ? html`<button type="button" class="bundle-advisory-title" aria-haspopup="dialog" @click=${() => onDetails(a)}>${a.title}</button>`
          : html`<span class="bundle-advisory-title">${a.title}</span>`}
        ${advisoryReference(a)}
      </div>
      <div class="bundle-advisory-subrow">
        <div class="bundle-advisory-meta">
          ${a.informational ? html`<span>${a.informational}</span>` : nothing}
          ${vulnerable ? html`<span>Affected <span class="mono">${vulnerable}</span></span>` : nothing}
          ${matched.length > 0 ? html`<span>Matches <span class="mono">${matched.join(', ')}</span></span>` : nothing}
          ${advisoryCwes(a.cwe)}
        </div>
        ${cvssVector ? html`<div class="bundle-advisory-cvss-vector mono">${cvssVector}</div>` : nothing}
      </div>
    </div>
  </li>`
}
