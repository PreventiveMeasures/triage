// Small shared helpers for the dialog components. Kept
// dependency-light (lit + plain functions) so it stays cheap to
// import from every dialog.
import { html, nothing } from 'lit'

// Severity chip shown in the finding-context header of the comment,
// fix-link, and triage-conflict dialogs. Palette is themed via
// theme.css per-severity custom properties; the `.conflict-sev` /
// `.sev-*` rules live in dialog-severity.css (shared shadow layer).
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
