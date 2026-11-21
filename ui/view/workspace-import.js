import {
  applyWorkspaceImport,
  classifyGzipExport,
  parseWorkspaceBundleBytes,
  parseWorkspaceJson,
  readBundleBytes,
  state,
} from '#client/index.js'
import { render } from './render.js'
import { openWorkspaceUnlockBundleDialog } from './lazy-dialogs.js'
// Up front, not in the dialogs' bundle (lazy-dialogs.js says why).
import { resolveTriageConflicts } from './dialogs/triage-conflict-dialog.js'

// The dialogs around the pure import pipeline (client/), which does the
// state, persistence and mutex work. A dropped `.gz` / `.enc` is one of the
// export dialog's two kinds (`classifyGzipExport`, off one decompression):
//
//   { kind: 'workspace', workspace }  a bundle, merged in here (an
//                                     encrypted one unlocked first)
//   { kind: 'reports', reports }      a raw reports export, handed BACK:
//                                     it lands as dragging those files in
//                                     would (ingest.js importReportContent)
//   null                              the unlock prompt was closed
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
    conflictResolver: async (conflicts, lookup) => {
      try {
        return await resolveTriageConflicts(conflicts, lookup, {
          title: 'Triage conflicts on import',
          intro: 'disagree with your local triage on',
          trailingNote: 'Reports and non-conflicting triage were already merged; pick which side to keep for these disagreements.',
          importedSideLabel: 'Apply imported',
        })
      } catch {
        // A stacked modal: the user can't pick. The reports and the
        // non-conflicting triage are already in, so say the disagreements
        // kept the local side, and how to pick again (no re-prompt short
        // of a fresh import).
        const n = conflicts.length
        alert(`Imported ${file.name}. Kept your local triage on ${n} conflicting entr${n === 1 ? 'y' : 'ies'} because another dialog is open — re-drop the file to pick again.`)
        return null
      }
    },
  })
  // Mutations outside a render don't repaint by themselves.
  if (state.currentFile || state.currentWorkspace) render()
  return { kind: 'workspace', workspace: ws }
}
