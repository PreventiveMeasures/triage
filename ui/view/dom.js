// The static DOM scaffolding of index.html, looked up once.
import { html, render as litRender } from 'lit'

export const dropZone = document.querySelector('#drop-zone')
export const report = document.querySelector('#report')
// `<app-sidebar>`, whose host stays in light DOM for the collapse class.
export const sidebar = document.querySelector('app-sidebar')

// Download a Blob through a transient hidden anchor, Lit-rendered so href
// and download take the UI's escaping path.
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

// The error for a dialog refusing to open over another modal (`AppDialog`'s
// `exclusive` check, as `showModal()` stacks rather than throws), one copy
// for every wrapper turning a `modal-conflict` into a rejection.
export function makeStackedModalError(cause) {
  return new Error('Another dialog is already open. Close it and try again.', { cause })
}
