// Template pieces several dialogs share. Dependency-light: one of its
// importers is held up front (view/lazy-dialogs.js).
import { html, nothing } from 'lit'
import { state } from '#client/index.js'
import { displayedSeverity } from '../format.js'

// Severity chip (`.conflict-sev`, dialog-severity.css), of an already resolved
// severity: a finding's as its card shows it, or sync metadata's as is.
export function severityBadge(sev) {
  if (!sev) return nothing
  return html`<span class=${`conflict-sev sev-${sev}`}>${sev.replaceAll('_', ' ')}</span>`
}

export const findingLocation = (f) => f?.file ? (f.line ? `${f.file}:${f.line}` : f.file) : ''

// The finding an editor annotates, under its title: severity, location and
// description, each truncated with the whole on hover.
export function findingContext(f) {
  const loc = findingLocation(f)
  return html`<div class="finding">
      ${severityBadge(displayedSeverity(f, state.severityMode))}
      ${loc ? html`<span class="loc" data-tooltip-truncated data-tooltip=${loc}>${loc}</span>` : nothing}
    </div>
    ${f.description ? html`<div class="desc" data-tooltip-truncated data-tooltip=${f.description}>${f.description}</div>` : nothing}`
}

// Enter runs `action`: single-line fields, no wrapping <form>.
export const onEnter = (action) => (e) => {
  if (e.key !== 'Enter') return
  e.preventDefault()
  action()
}

// A labelled `.wsl-field` (dialog-share.css).
export const field = (label, control) => html`<label class="wsl-field">
  <span>${label}</span>
  ${control}
</label>`

// A one-off secret (a sync-server or share-link password), which password
// managers are told not to save or fill.
export const secretInput = ({ name, value, input, keydown, maxlength = 1024, placeholder = nothing, disabled = false }) => html`<input
  type="password"
  class="nwd-input"
  placeholder=${placeholder}
  autocomplete="off"
  data-1p-ignore="true"
  data-lpignore="true"
  data-bwignore="true"
  data-form-type="other"
  name=${name}
  maxlength=${maxlength}
  ?disabled=${disabled}
  .value=${value}
  @input=${input}
  @keydown=${keydown}
>`
