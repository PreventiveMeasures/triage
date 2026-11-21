import { html, nothing } from 'lit'
import { formatBytes } from './format.js'

const count = n => n.toLocaleString()
// A signed delta, `+3` / `−2` / `±0`, with a real minus so it never reads as a hyphen.
const signed = (n, format) => `${n === 0 ? '±' : n > 0 ? '+' : '−'}${format(Math.abs(n))}`
const formatCountDelta = n => signed(n, count)

// A signed byte size, sized like the totals beside it: `+1.2 KiB` / `−340 B` / `±0 B`.
export const formatDelta = n => signed(n, formatBytes)

// CSS direction suffix for a signed number: 'up' (green) / 'down' (red) / '' (neutral).
export function dirClass(n) {
  return n > 0 ? 'up' : n < 0 ? 'down' : ''
}

// The import resolutions the open one drops, adds and repoints, a chip for each kind it has.
function resolutionChips({ onlyBase, onlyOther, changed }) {
  return [['removed', '−', onlyBase], ['added', '+', onlyOther], ['repointed', '', changed]].filter(([, , rows]) => rows.length > 0)
    .map(([kind, sign, rows]) => html`<span class=${`bundle-compare-chip ${kind === 'repointed' ? 'changed' : kind}`}>${sign}${rows.length.toLocaleString()} ${kind} ${rows.length === 1 ? 'resolution' : 'resolutions'}</span>`)
}

// Percent change of a byte delta against the base total; empty where the base is zero.
function formatPct(delta, baseBytes) {
  if (!baseBytes) return ''
  const pct = (delta / baseBytes) * 100
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±'
  return `${sign}${Math.abs(pct).toFixed(1)}%`
}

// A summary metric: its label, `from → to` as `show` formats them, and its delta.
const metric = (label, from, to, delta, show = count, said = formatCountDelta(delta)) => html`<div class="bundle-compare-metric">
      <span class="bundle-compare-metric-label">${label}</span>
      <span class="bundle-compare-metric-value">${show(from)} → ${show(to)}</span>
      <span class=${`bundle-compare-metric-delta ${dirClass(delta)}`}>${said}</span>
    </div>`

export function renderCompareStats(diff) {
  const totals = diff.totals
  const vt = diff.versionUpdates?.totals ?? { baseDeps: 0, otherDeps: 0 }
  const pct = formatPct(totals.byteDelta, totals.baseBytes)
  // Dependency counts only where a side carries version metadata (stasis
  // v1), rather than a hollow `0 → 0`.
  return html`<div class="bundle-compare-stats">
    ${vt.baseDeps > 0 || vt.otherDeps > 0 ? metric('Deps', vt.baseDeps, vt.otherDeps, vt.otherDeps - vt.baseDeps) : nothing}
    ${metric('Size', totals.baseBytes, totals.otherBytes, totals.byteDelta, formatBytes,
      html`${formatDelta(totals.byteDelta)}${pct ? html`${' '}<span class="bundle-compare-pct">(${pct})</span>` : nothing}`)}
    ${totals.baseLines > 0 || totals.otherLines > 0 ? metric('LoC', totals.baseLines, totals.otherLines, totals.otherLines - totals.baseLines) : nothing}
    <div class="bundle-compare-files">
      ${metric('Files', totals.baseFiles, totals.otherFiles, totals.fileDelta)}
      <div class="bundle-compare-chips">
        ${totals.onlyBaseFiles > 0 ? html`<span class="bundle-compare-chip removed">−${totals.onlyBaseFiles.toLocaleString()} removed</span>` : nothing}
        ${totals.onlyOtherFiles > 0 ? html`<span class="bundle-compare-chip added">+${totals.onlyOtherFiles.toLocaleString()} added</span>` : nothing}
        ${totals.changedFiles > 0 ? html`<span class="bundle-compare-chip changed">${totals.changedFiles.toLocaleString()} changed${totals.renamedFiles > 0 ? ` (${totals.renamedFiles.toLocaleString()} renamed)` : ''}</span>` : nothing}
        <span class="bundle-compare-chip unchanged">${totals.unchangedFiles.toLocaleString()} unchanged</span>
        ${diff.resolutions ? resolutionChips(diff.resolutions) : nothing}
      </div>
    </div></div>`
}
