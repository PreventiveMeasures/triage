// Host ARIA for light-DOM components whose host IS the control (a
// `role="group"` chip set, a `role="button"` toggle), from their
// connectedCallback. An attribute the host already declares wins.
export function ensureHostAria(host, attrs) {
  for (const [name, value] of Object.entries(attrs)) {
    if (!host.hasAttribute(name)) host.setAttribute(name, value)
  }
}
