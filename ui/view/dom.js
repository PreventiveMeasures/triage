// The static DOM scaffolding of index.html, looked up once.
import { html, render as litRender, nothing } from 'lit'

export const dropZone = document.querySelector('#drop-zone')
export const report = document.querySelector('#report')
// `<app-sidebar>`, whose host stays in light DOM for the collapse class.
export const sidebar = document.querySelector('app-sidebar')

// The slots Lit renders #report's views into: its children, or those of a
// wrapper among them (render.js).
const slots = new WeakSet()
export function reportSlot(id) {
  const slot = Object.assign(document.createElement('div'), { id })
  slots.add(slot)
  return slot
}
// #report's content replaced by `nodes`, the views in its slots cleared
// through Lit first, as Lit clears what it removes itself, which disconnects
// their directives. Removed without, a ref keeps the element it was last
// given for good (Lit holds it by its callback, under the global object where
// no host is given), and with it the whole view it was in.
export function replaceReport(...nodes) {
  for (const slot of report.querySelectorAll(':scope > div, :scope > div > div')) if (slots.has(slot)) litRender(nothing, slot)
  report.replaceChildren(...nodes)
}

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
