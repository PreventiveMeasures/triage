import { MAX_REPORTS_PER_EXPORT } from './workspace-import.js'
import { gunzipToText } from '../common/gzip.js'
import { isEncryptedBundle } from './workspace-bundle-crypto.js'

// What a RAW REPORTS export is, and how a dropped `.gz` is told apart
// from a workspace one.
//
// The export dialog writes two files and they arrive through the same
// door — a `.gz` the user drags back in. One is the portable workspace
// (`workspace-import.js`: reports + triage + repo URLs + bundle
// pointers + the private key). The other is
// `workspace-export.js` buildRawReportsExportPayload: the report
// DOCUMENTS on their own, `{ reports: [{ name, content }] }` and
// nothing else.
//
// The second is not an import of its own. It is a drop of the reports
// that were in it, and lands the way dragging those files in lands —
// which is why nothing here saves anything: this module only says
// which file the user dropped, and `ui/view/ingest.js` runs the
// reports through the ordinary report-drop path from there.

// A raw reports export, told apart from a workspace export by what it
// LACKS. A `version` or a `workspace` key means the file is claiming
// to BE a workspace export, and belongs to `validateExportShape` —
// which will reject it properly if it is malformed — rather than being
// read here as a bag of reports with a workspace record quietly
// ignored. So neither shape can be mistaken for the other, in either
// direction.
//
// Entry shape is not checked: a bad entry doesn't condemn the file,
// and the importer skips what it can't use, the same way
// `applyWorkspaceImport` skips a report entry that isn't two strings.
// The count cap IS the workspace export's, and for its reason — a
// crafted file must not be able to open fifty thousand dialogs.
function validateRawReportsShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'payload is not an object'
  if (data.version !== undefined || data.workspace !== undefined) return 'payload claims to be a workspace export'
  if (!Array.isArray(data.reports)) return 'reports field must be an array'
  if (data.reports.length > MAX_REPORTS_PER_EXPORT) {
    return `reports count (${data.reports.length}) exceeds cap (${MAX_REPORTS_PER_EXPORT})`
  }
  return null
}

export function isRawReportsExport(data) {
  return validateRawReportsShape(data) === null
}

// Which export a dropped `.gz` / `.enc` holds, decided once so the
// caller decompresses once — a workspace export carrying bundle bytes
// is not a file to gunzip twice.
//
//   { kind: 'reports', reports }  the raw reports export
//   { kind: 'encrypted' }         an encrypted workspace bundle; the
//                                 caller owns the unlock prompt
//   { kind: 'workspace', text }   anything else, for parseWorkspaceJson
//
// Only a POSITIVE match on the reports shape takes the reports path.
// Everything else — a workspace export, a truncated file, JSON that is
// neither — goes back as `workspace` with the decompressed text, so
// the failure the user reads is the one `parseWorkspaceJson` already
// words rather than a second vocabulary for the same file. The gzip
// failure is the one raised here, in the words the bytes path has
// always used for it.
export async function classifyGzipExport(bytes) {
  if (isEncryptedBundle(bytes)) return { kind: 'encrypted' }
  let text
  try {
    text = await gunzipToText(bytes)
  } catch (err) {
    throw new Error(`gzip decompression failed: ${err.message}`, { cause: err })
  }
  let data
  try { data = JSON.parse(text) } catch { return { kind: 'workspace', text } }
  if (isRawReportsExport(data)) return { kind: 'reports', reports: data.reports }
  return { kind: 'workspace', text }
}
