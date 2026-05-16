// Cached references to the static DOM scaffolding declared in view.html.
// Looking these up once at module load is cheaper than repeatedly
// querying — and keeps every consumer module's import list short.
import { html, render as litRender } from 'lit'

export const dropZone = document.querySelector('#drop-zone')
export const report = document.querySelector('#report')
export const sidebar = document.querySelector('#sidebar')
export const fileList = document.querySelector('#file-list')

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
