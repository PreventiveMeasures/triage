// Small shared helpers for the dialog components. Kept
// dependency-light (lit + plain functions) so it stays cheap to
// import from every dialog.
import { html, nothing } from 'lit'
import { isLinksFile } from '../file-display.js'

// Header tab strip for a dialog that opens on more than one thing —
// the workspace export's two exports, the report export's download and
// print. Renders the `role="tablist"` chrome (dialog-tabs.css) and
// carries the keyboard contract that role implies: arrows walk the
// strip, wrapping at the ends, and selection follows focus.
//
//   tabs     [{ id, label, icon? }] in strip order
//   current  the selected id
//   prefix   ids are `${prefix}-tab-${id}`, panels
//            `${prefix}-panel-${id}` — the caller labels its panel
//            with the same pair
//   select   called with the id to open
//   disabled locks the tabs that are not open (mid-export, say)
//
// The host re-renders on `select`, so the focus move waits a frame for
// the roving tabindex to land on the tab it is about to focus.
export function dialogTabs({ tabs, current, prefix, select, disabled = false }) {
  const onKeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const at = tabs.findIndex((t) => t.id === current)
    const step = e.key === 'ArrowRight' ? 1 : -1
    const next = tabs[(at + step + tabs.length) % tabs.length]
    if (!next || next.id === current) return
    const list = e.currentTarget
    select(next.id)
    requestAnimationFrame(() => list.querySelector(`#${prefix}-tab-${next.id}`)?.focus())
  }
  return html`
    <div class="dlg-tabs" role="tablist" @keydown=${onKeydown}>
      ${tabs.map((t) => html`<button
        type="button"
        role="tab"
        class="dlg-tab"
        id=${`${prefix}-tab-${t.id}`}
        aria-controls=${`${prefix}-panel-${t.id}`}
        aria-selected=${String(current === t.id)}
        tabindex=${current === t.id ? 0 : -1}
        ?disabled=${disabled && current !== t.id}
        @click=${() => select(t.id)}
      >${t.icon ?? nothing}${t.label}</button>`)}
    </div>
  `
}

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

// Three kinds, not the transfer layer's two. `item.kind` is the WIRE
// distinction — a report-shaped object versus a bundle — and a links
// file travels as a report because that is how it is stored, fetched
// and validated. What the reader is told it is, though, has to be
// what it is: naming a links file a report in a prompt about what is
// leaving this device is exactly the kind of quiet wrong these
// dialogs can't afford.
//
// The answer comes from the local counts cache, so a name this device
// has never analyzed — a remote-only object in the DOWNLOAD prompt —
// reads as a report. That is the honest default for something whose
// content we haven't seen: it is named for what it turns out to be
// the moment it lands.
function displayKind(item) {
  if (item.kind === 'bundle') return 'bundle'
  return isLinksFile(item.identifier) ? 'links file' : 'report'
}

// Count + pluralised kind noun for the sync-transfer prompts: a
// homogeneous list reads as "reports" / "bundles" / "links files", a
// mixed one as "items"; `singular` drives the one-item wording.
export function transferSummary(items) {
  const count = items.length
  const singular = count === 1
  const kinds = new Set(items.map(displayKind))
  let kindLabel = 'items'
  if (kinds.size === 1) {
    const only = [...kinds][0]
    kindLabel = singular ? only : `${only}s`
  }
  return { count, singular, kindLabel }
}

// Multi-item list for the sync-transfer prompts. Anything that isn't
// a plain report gets the inline kind chip, so a mixed list says per
// ROW what each thing is rather than leaving the reader to infer it
// from a filename.
export function transferItemsList(items) {
  return html`<ul class="lwd-list">
      ${items.map((i) => {
        const kind = displayKind(i)
        return html`<li>${itemDisplayLabel(i)}${kind === 'report' ? nothing : html` <span class="lwd-kind-tag">${kind}</span>`}</li>`
      })}
    </ul>`
}

// Per-item failure list shown once a transfer finishes with errors.
export function transferErrorsList(errors) {
  if (errors.length === 0) return nothing
  return html`<ul class="lwd-list" role="alert">
      ${errors.map((e) => html`<li><strong>${e.label}</strong> — ${e.reason}</li>`)}
    </ul>`
}
