import { revalidateKindOf } from '../../report/index.js'
import { recordRevalidationCopies } from './revalidation-conflicts.js'
import { effectiveSeverity } from './format.js'

// Gap-fill a derived finding only within a mergeable row. Raw report copies
// remain intact so App and code modes can use different row partitions.
// Provenance stays with the first copy; corrected severity keeps per-report
// variants. Missing/null fields are gaps, never disagreements.
const KEEPS_ITS_OWN = new Set(['correctedSeverity', 'correctedSeverityReason', 'isApp', 'isUpstream', 'source'])

// Contradictory revalidate* answers disable App mode for this loaded set.
// Retain the first answer on the derived copy; the conflict dialog exposes all
// answers instead of presenting that arbitrary choice as the pass's verdict.
export function mergeDuplicateFields(survivor, dup) {
  if (!survivor || !dup || survivor === dup) return false
  let conflicted = false
  for (const [key, value] of Object.entries(dup)) {
    if (key.startsWith('_') || KEEPS_ITS_OWN.has(key)) continue
    if (value === undefined || value === null) continue
    // The stamp is compared as the app READS it, not as the file
    // wrote it: the reader trims and case-folds, and answers "no
    // stamp" for anything it doesn't recognise (report/src/finding.js
    // revalidateKindOf). So `confirmed` and ` Confirmed ` agree, and
    // a value the app can't read is no answer at all — it neither
    // blocks the other copy's real stamp from landing nor takes the
    // layer off a whole workspace for a typo.
    if (key === 'revalidate') {
      const theirs = revalidateKindOf(dup)
      if (!theirs) continue
      const mine = revalidateKindOf(survivor)
      if (!mine) survivor[key] = value
      else if (mine !== theirs) conflicted = true
      continue
    }
    const own = survivor[key]
    if (own === undefined || own === null) { survivor[key] = value; continue }
    // The pass's prose either side of the stamp, compared past the
    // whitespace two writers can differ on for the same words.
    if (key.startsWith('revalidate') && String(own).trim() !== String(value).trim()) conflicted = true
  }
  return conflicted
}

// The row merger also retains the evidence behind a conflict. This must
// run for every duplicate, including agreeing copies and missing-field fills,
// so the eventual dialog can name the reports that actually supplied a value.
export function mergeReportDuplicateFields(survivor, dup, reportName, conflicts) {
  if (!survivor || !dup || survivor === dup) return
  if (survivor.correctedSeverity || dup.correctedSeverity) {
    survivor._correctedByReport ??= {
      [survivor._reportName ?? '']: { severity: effectiveSeverity(survivor), reason: survivor.correctedSeverityReason },
    }
    survivor._correctedByReport[reportName] = { severity: effectiveSeverity(dup), reason: dup.correctedSeverityReason }
  }
  const copies = recordRevalidationCopies(survivor, dup, reportName)
  if (mergeDuplicateFields(survivor, dup) || conflicts.has(survivor.id)) {
    conflicts.set(survivor.id, { finding: survivor, copies })
  }
}
