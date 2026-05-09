import { html, render as litRender } from 'lit'
import { buildWorkspaceExportGzip } from '../../client/workspace-export.js'

// Thin DOM wrapper around the pure export pipeline in
// `client/workspace-export.js`. Triggers a programmatic anchor
// click to download the gzipped JSON blob — the only DOM-touching
// concern on the export side.
//
// The anchor is rendered via Lit into a throwaway host so href /
// download flow through the same auto-escaped attribute path the
// rest of the UI uses. The host gets attached to the body just
// long enough for `.click()` to fire, then removed.

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const host = document.createElement('span')
  host.style.display = 'none'
  litRender(html`<a href=${url} download=${filename}></a>`, host)
  document.body.appendChild(host)
  host.firstElementChild.click()
  host.remove()
  URL.revokeObjectURL(url)
}

export async function exportWorkspace(workspace) {
  const { blob, filename } = await buildWorkspaceExportGzip(workspace)
  downloadBlob(blob, filename)
}
