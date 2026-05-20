// Cached references to the static DOM scaffolding declared in index.html.
// Looking these up once at module load is cheaper than repeatedly
// querying — and keeps every consumer module's import list short.
import { html, render as litRender } from 'lit'

export const dropZone = document.querySelector('#drop-zone')
export const report = document.querySelector('#report')
// The sidebar is now the `<app-sidebar>` shadow-DOM component
// (view/sidebar.js). The host element stays in light DOM, so the
// collapse-state toggle (`view.js` boot + the in-component toggle
// button) still works on `.classList`. `#file-list` moved into the
// component's shadow root, so it's no longer exported here — only
// sidebar.js touches it, through its own shadow-root reference.
export const sidebar = document.querySelector('app-sidebar')

// Trigger a browser download for the given Blob via a transient
// hidden anchor. Lit-rendered (rather than raw createElement) so
// href + download flow through the same auto-escape path the rest
// of the UI uses. Shared by the workspace export and the global
// triage backup — both produce a `.gz` blob + filename and want
// the same one-shot click + cleanup dance.
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const host = document.createElement('span')
  host.style.display = 'none'
  litRender(html`<a href=${url} download=${filename}></a>`, host)
  document.body.append(host)
  host.firstElementChild.click()
  host.remove()
  URL.revokeObjectURL(url)
}

// `<dialog>.showModal()` throws `InvalidStateError` when another modal is
// already open. Every dialog wrapper that turns that throw into a promise
// rejection uses this so the user-facing copy stays consistent.
export function makeStackedModalError(cause) {
  return new Error('Another dialog is already open. Close it and try again.', { cause })
}
