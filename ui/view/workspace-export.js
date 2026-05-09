import { buildWorkspaceExportGzip } from '../../client/workspace-export.js'
import { downloadBlob } from './dom.js'

// Thin DOM wrapper around the pure export pipeline in
// `client/workspace-export.js`. Hands the gzipped JSON blob and
// filename to the shared `downloadBlob` helper (in `dom.js`),
// which owns the Lit-rendered transient anchor — same flow the
// global triage backup dialog uses.

export async function exportWorkspace(workspace) {
  const { blob, filename } = await buildWorkspaceExportGzip(workspace)
  downloadBlob(blob, filename)
}
