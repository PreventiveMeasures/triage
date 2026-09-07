import {
  applyWorkspaceImport,
  classifyGzipExport,
  parseWorkspaceBundleBytes,
  parseWorkspaceJson,
  readBundleBytes,
  state,
} from '#client/index.js'
import { render } from './render.js'
import { resolveTriageConflicts } from './dialogs/triage-conflict-dialog.js'
import { openWorkspaceUnlockBundleDialog } from './dialogs/workspace-unlock-bundle-dialog.js'

// Thin DOM wrapper around the pure import pipeline. Drives the
// conflict-resolution and unlock dialogs; the pure layer handles state
// mutation, persistence, and mutex enforcement. Encrypted bundles
// trigger the unlock prompt before the merge runs.

// A dropped `.gz` / `.enc` is one of the two things the export dialog
// writes, and this is the door for both (`classifyGzipExport` decides
// which, off one decompression). What comes back says which happened:
//
//   { kind: 'workspace', workspace }  the bundle was merged in here
//   { kind: 'reports', reports }      the raw reports export — the
//                                     documents alone, handed BACK for
//                                     the caller to run through the
//                                     ordinary report-drop path
//   null                              the user closed the unlock prompt
//
// The reports are handed back rather than saved here because a raw
// export is not an import of its own: it is a drop of the reports that
// were in it, and has to land the way dragging those files in lands —
// the same recognition check, the same rename / replace prompt on a
// name that is already taken, the same navigation to the last one.
// That path is `ingest.js`'s (importReportContent), and it stays
// there; this function only says what the file turned out to be.
export async function importWorkspaceFromGzip(file) {
  // Read once so the magic-byte sniff and the parse share one buffer.
  const bytes = await readBundleBytes(file)
  const found = await classifyGzipExport(bytes)
  if (found.kind === 'reports') return { kind: 'reports', reports: found.reports }
  let data
  if (found.kind === 'encrypted') {
    data = await openWorkspaceUnlockBundleDialog({
      tryPassword: (password) => parseWorkspaceBundleBytes(bytes, password),
    })
    if (!data) return null
  } else {
    // Already decompressed by the classifier; the validation, and the
    // wording of every way it can fail, is still parseWorkspaceJson's.
    data = parseWorkspaceJson(found.text)
  }

  const ws = await applyWorkspaceImport(data, {
    // `lookup` is built and passed by the pure layer's mergeTriage —
    // no need to precompute on this side.
    conflictResolver: async (conflicts, lookup) => {
      try {
        return await resolveTriageConflicts(conflicts, lookup, {
          title: 'Triage conflicts on import',
          intro: 'disagree with your local triage on',
          trailingNote: 'Reports and non-conflicting triage were already merged; pick which side to keep for these disagreements.',
          importedSideLabel: 'Apply imported',
        })
      } catch {
        // Stacked-modal failure — the user can't pick. The reports
        // were saved and non-conflicting triage was merged in the
        // mergeTriage call above; surface that the disagreements
        // dropped to local so the user knows what's missing. The
        // generic "try again" copy from `makeStackedModalError`
        // doesn't apply here — there's no re-prompt without a fresh
        // import, so name the filename and the recovery instead.
        const n = conflicts.length
        alert(`Imported ${file.name}. Kept your local triage on ${n} conflicting entr${n === 1 ? 'y' : 'ies'} because another dialog is open — re-drop the file to pick again.`)
        return null
      }
    },
  })
  // Mutations outside a render context don't auto-repaint; cover both
  // file and workspace mode (render() bails on its own when neither).
  if (state.currentFile || state.currentWorkspace) render()
  return { kind: 'workspace', workspace: ws }
}
