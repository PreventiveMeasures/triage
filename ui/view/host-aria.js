// Tiny shared helper for setting host-element ARIA attributes from
// inside a custom element's `connectedCallback`. Several light-DOM
// StateElement components (severity-chips, source-filter,
// view-mode-buttons, slide-triage-tabs, triage-filter,
// triage-selector) carry `role="group"` + `aria-label="..."` on
// the host element (because the host IS the group container, not
// just a wrapper around one). Each was repeating the same
// `if (!this.hasAttribute('role'))…` boilerplate; this collapses
// to one call.
//
// Skips attributes the host already declares so a parent template
// that explicitly stamps `role="…"` on the host wins.
//
// Usage:
//   connectedCallback() {
//     super.connectedCallback()
//     ensureHostAria(this, { role: 'group', 'aria-label': 'Source filter' })
//   }
export function ensureHostAria(host, attrs) {
  for (const [name, value] of Object.entries(attrs)) {
    if (!host.hasAttribute(name)) host.setAttribute(name, value)
  }
}
