import {
  applyWorkspaceImport,
  isEncryptedBundle,
  parseWorkspaceBundleBytes,
  readBundleBytes,
  state,
} from '../../client/index.js'
import { render } from './render.js'
import { resolveTriageConflicts } from './triage-conflict-dialog.js'
import { openWorkspaceUnlockBundleDialog } from './workspace-unlock-bundle-dialog.js'

// Thin DOM wrapper around the pure import pipeline. Drives the
// conflict-resolution and unlock dialogs; the pure layer handles state
// mutation, persistence, and mutex enforcement. Encrypted bundles
// trigger the unlock prompt before the merge runs.

export async function importWorkspaceFromGzip(file) {
  // Read once so the magic-byte sniff and the parse share one buffer.
  const bytes = await readBundleBytes(file)
  let data
  if (isEncryptedBundle(bytes)) {
    data = await openWorkspaceUnlockBundleDialog({
      tryPassword: (password) => parseWorkspaceBundleBytes(bytes, password),
    })
    if (!data) return null
  } else {
    data = await parseWorkspaceBundleBytes(bytes)
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
  return ws
}
