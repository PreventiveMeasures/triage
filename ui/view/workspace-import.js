import { state } from '../../client/state.js'
import {
  applyWorkspaceImport,
  buildImportedFindingLookup,
  parseWorkspaceGzip,
} from '../../client/workspace-import.js'
import { render } from './render.js'
import { resolveTriageConflicts } from './triage-conflict-dialog.js'

// Thin DOM wrapper around the pure import pipeline in
// `client/workspace-import.js`. Drives the conflict-resolution
// dialog (lit + native <dialog> for focus-trap + Esc-to-cancel)
// and triggers a re-render after merge; the pure layer does the
// state mutation + persistence + mutex enforcement.
//
// Detection happens upstream in `addFiles` (any `.gz` drop is routed
// here); the pure layer decides whether the payload is actually a
// workspace and throws if not.

export async function importWorkspaceFromGzip(file) {
  const data = await parseWorkspaceGzip(file)
  // Build the metadata lookup once up front so the dialog (if it
  // surfaces) can show severity / file:line / description per
  // conflicting finding. Skipped when there's no triage.
  const hasIncomingTriage = data.triage && Object.keys(data.triage).length > 0
  const lookup = hasIncomingTriage
    ? await buildImportedFindingLookup(data.reports)
    : new Map()
  const ws = await applyWorkspaceImport(data, {
    conflictResolver: (conflicts) => resolveTriageConflicts(conflicts, lookup, {
      title: 'Triage conflicts on import',
      intro: 'disagree with your local triage on',
      trailingNote: 'Pick which side to keep — trash status was already merged.',
      importedSideLabel: 'Apply imported',
    }),
  })
  // Mutating state.markers / state.triageState outside a render
  // context doesn't auto-trigger a repaint of the loaded report —
  // re-run render() so adopted colors and trash assignments show up
  // immediately. No-op when nothing's loaded (render bails on an
  // empty state.reports). Sidebar refresh is owned by addFiles.
  if (state.currentFile) render()
  return ws
}
