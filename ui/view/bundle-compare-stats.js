import { html, nothing } from 'lit'
import { formatBytes } from './format.js'

// Signed count for a summary metric delta: `+3` / `−2` / `±0`. Uses a
// real minus (−) to match the typographic style elsewhere in the
// chrome and so it never reads as a hyphen in a path. Used by the
// Files and Deps metrics.
function formatCountDelta(n) {
  if (n === 0) return '±0'
  return `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString()}`
}

// Signed byte size for a delta cell, sized like the totals beside it:
// `+1.2 KiB` / `−340 B` / `±0 B`.
export function formatDelta(n) {
  if (n === 0) return '±0 B'
  return `${n > 0 ? '+' : '−'}${formatBytes(Math.abs(n))}`
}

// CSS direction suffix for a signed number: 'up' (green) / 'down'
// (red) / '' (neutral). Shared by the summary metric deltas and the
// per-row size deltas.
export function dirClass(n) {
  return n > 0 ? 'up' : n < 0 ? 'down' : ''
}

// Percent change of a byte delta against the base total. Empty when
// the base is zero (every byte is new, so a percentage is meaningless).
function formatPct(delta, baseBytes) {
  if (!baseBytes) return ''
  const pct = (delta / baseBytes) * 100
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±'
  return `${sign}${Math.abs(pct).toFixed(1)}%`
}

export function renderCompareStats(diff) {
  const totals = diff.totals
  const vt = diff.versionUpdates?.totals ?? { baseDeps: 0, otherDeps: 0 }
  // Dependency count only means something when at least one side
  // carries version metadata (stasis v1); hide the metric for
  // sourcemap / v0 pairs rather than show a hollow `0 → 0`.
  const showDeps = vt.baseDeps > 0 || vt.otherDeps > 0
  const depDelta = vt.otherDeps - vt.baseDeps
  const pct = formatPct(totals.byteDelta, totals.baseBytes)
  return html`<div class="bundle-compare-stats">
    ${showDeps ? html`<div class="bundle-compare-metric">
      <span class="bundle-compare-metric-label">Deps</span>
      <span class="bundle-compare-metric-value">${vt.baseDeps.toLocaleString()} → ${vt.otherDeps.toLocaleString()}</span>
      <span class=${`bundle-compare-metric-delta ${dirClass(depDelta)}`}>${formatCountDelta(depDelta)}</span>
    </div>` : nothing}
    <div class="bundle-compare-metric">
      <span class="bundle-compare-metric-label">Size</span>
      <span class="bundle-compare-metric-value">${formatBytes(totals.baseBytes)} → ${formatBytes(totals.otherBytes)}</span>
      <span class=${`bundle-compare-metric-delta ${dirClass(totals.byteDelta)}`}>${formatDelta(totals.byteDelta)}${pct ? html`${' '}<span class="bundle-compare-pct">(${pct})</span>` : nothing}</span>
    </div>
    ${totals.baseLines > 0 || totals.otherLines > 0 ? html`<div class="bundle-compare-metric">
      <span class="bundle-compare-metric-label">LoC</span>
      <span class="bundle-compare-metric-value">${totals.baseLines.toLocaleString()} → ${totals.otherLines.toLocaleString()}</span>
      <span class=${`bundle-compare-metric-delta ${dirClass(totals.otherLines - totals.baseLines)}`}>${formatCountDelta(totals.otherLines - totals.baseLines)}</span>
    </div>` : nothing}
    <div class="bundle-compare-files">
      <div class="bundle-compare-metric">
        <span class="bundle-compare-metric-label">Files</span>
        <span class="bundle-compare-metric-value">${totals.baseFiles.toLocaleString()} → ${totals.otherFiles.toLocaleString()}</span>
        <span class=${`bundle-compare-metric-delta ${dirClass(totals.fileDelta)}`}>${formatCountDelta(totals.fileDelta)}</span>
      </div>
      <div class="bundle-compare-chips">
        ${totals.onlyBaseFiles > 0 ? html`<span class="bundle-compare-chip removed">−${totals.onlyBaseFiles.toLocaleString()} removed</span>` : nothing}
        ${totals.onlyOtherFiles > 0 ? html`<span class="bundle-compare-chip added">+${totals.onlyOtherFiles.toLocaleString()} added</span>` : nothing}
        ${totals.changedFiles > 0 ? html`<span class="bundle-compare-chip changed">${totals.changedFiles.toLocaleString()} changed${totals.renamedFiles > 0 ? ` (${totals.renamedFiles.toLocaleString()} renamed)` : ''}</span>` : nothing}
        <span class="bundle-compare-chip unchanged">${totals.unchangedFiles.toLocaleString()} unchanged</span>
        ${diff.resolutions?.totalChanges > 0 ? html`<span class="bundle-compare-chip changed">${diff.resolutions.totalChanges.toLocaleString()} repointed ${diff.resolutions.totalChanges === 1 ? 'resolution' : 'resolutions'}</span>` : nothing}
      </div>
    </div></div>`
}
