// Small shared helpers for the dialog components. Kept
// dependency-light (lit + plain functions) so it stays cheap to
// import from every dialog.
import { html, nothing } from 'lit'

// Severity chip shown in the finding-context header of the comment,
// fix-link, and triage-conflict dialogs. Palette is themed via
// theme.css per-severity custom properties; the `.conflict-sev` /
// `.sev-*` rules live in dialog-severity.css (shared shadow layer).
//
// Takes an ALREADY-RESOLVED severity string: callers holding a finding
// pass `displayedSeverity(f, state.severityMode)` so the chip agrees
// with the card the dialog was opened from (see view/format.js). The
// conflict dialog passes the sync metadata's severity as-is — wire
// metadata carries no correction.
export function severityBadge(sev) {
  if (!sev) return nothing
  const label = sev.replaceAll('_', ' ')
  return html`<span class=${`conflict-sev sev-${sev}`}>${label}</span>`
}

// Short, stable display label for a bundle integrity — used by the
// sync-download / sync-upload item lists when an item carries no
// explicit label.
export function bundleShortLabel(integrity) {
  return `bundle-${integrity.slice('sha512-'.length, 'sha512-'.length + 12)}…`
}

// Display label for a sync-transfer item: the explicit label, the
// short bundle hash for bundles, or the raw report filename.
export function itemDisplayLabel(item) {
  if (item.kind === 'bundle') return item.label ?? bundleShortLabel(item.identifier)
  return item.identifier
}

// Count + pluralised kind noun for the sync-transfer prompts: a
// homogeneous list reads as "reports" / "bundles", a mixed one as
// "items"; `singular` drives the one-item wording.
export function transferSummary(items) {
  const count = items.length
  const singular = count === 1
  const reportCount = items.filter((i) => i.kind === 'report').length
  const bundleCount = count - reportCount
  let kindLabel = 'items'
  if (bundleCount === 0) kindLabel = singular ? 'report' : 'reports'
  else if (reportCount === 0) kindLabel = singular ? 'bundle' : 'bundles'
  return { count, singular, kindLabel }
}

// Multi-item list for the sync-transfer prompts; bundles get the
// inline kind chip so they read as distinct from reports.
export function transferItemsList(items) {
  return html`<ul class="lwd-list">
      ${items.map((i) => html`<li>${itemDisplayLabel(i)}${i.kind === 'bundle' ? html` <span class="lwd-kind-tag">bundle</span>` : nothing}</li>`)}
    </ul>`
}

// Per-item failure list shown once a transfer finishes with errors.
export function transferErrorsList(errors) {
  if (errors.length === 0) return nothing
  return html`<ul class="lwd-list" role="alert">
      ${errors.map((e) => html`<li><strong>${e.label}</strong> — ${e.reason}</li>`)}
    </ul>`
}
