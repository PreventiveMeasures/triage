import { buildWorkspaceExportGzip } from '../../client/workspace-export.js'

// Thin DOM wrapper around the pure export pipeline in
// `client/workspace-export.js`. Triggers a programmatic anchor
// click to download the gzipped JSON blob — the only DOM-touching
// concern on the export side.

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export async function exportWorkspace(workspace) {
  const { blob, filename } = await buildWorkspaceExportGzip(workspace)
  downloadBlob(blob, filename)
}
