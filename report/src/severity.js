import { fingerprintOf } from './finding-id.js'

// Informative is an input spelling of the existing Informational tier.
export function canonicalSeverity(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'informative' ? 'informational' : value
}

// Normalize presentation without re-keying stored triage. Markdown parsers
// can supply the severity their previous fallback used for the fingerprint.
export function normalizeFindingSeverity(finding, identitySeverity = finding.severity) {
  const severity = canonicalSeverity(finding.severity)
  if (severity !== finding.severity) {
    if (!finding.id && !finding._idBasis) finding._idBasis = fingerprintOf({ ...finding, severity: identitySeverity })
    finding.severity = severity
  }
  if (finding.correctedSeverity !== undefined) finding.correctedSeverity = canonicalSeverity(finding.correctedSeverity)
  return finding
}
