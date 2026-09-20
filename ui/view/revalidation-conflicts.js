import { REVALIDATE_KINDS, revalidateKindOf } from '../../report/index.js'

// Keep only the pass's fields, before gap-filling changes the survivor.
// In particular, a verdict borrowed from report B must never be attributed
// to an unstamped copy from report A when report C later contradicts it.
function fieldsOf(finding) {
  return Object.fromEntries(Object.entries(finding).filter(([key, value]) =>
    key.startsWith('revalidate') && value != null))
}

export function recordRevalidationCopies(survivor, duplicate, reportName) {
  const fields = fieldsOf(duplicate)
  if (!survivor._revalidationCopies) {
    const own = fieldsOf(survivor)
    if (Object.keys(own).length === 0 && Object.keys(fields).length === 0) return []
    survivor._revalidationCopies = Object.keys(own).length > 0
      ? [{ reportName: survivor._reportName ?? '', fields: own }]
      : []
  }
  if (Object.keys(fields).length > 0) survivor._revalidationCopies.push({ reportName, fields })
  return survivor._revalidationCopies
}

// Same comparisons as mergeDuplicateFields: missing values are gaps, stamps
// are normalized, and prose ignores surrounding whitespace. Group agreeing
// reports together, retaining every distinct answer rather than just a pair.
export function revalidationDifferences(copies) {
  const byField = new Map()
  const knownKinds = new Set(REVALIDATE_KINDS)
  for (const { reportName, fields } of copies) {
    for (const [key, value] of Object.entries(fields)) {
      if (value == null) continue
      const normalized = key === 'revalidate'
        ? revalidateKindOf(fields) || String(value).trim().toLowerCase()
        : String(value).trim()
      if (key === 'revalidate' && !normalized) continue
      if (key === 'revalidate' && !knownKinds.has(normalized)) continue
      if (!byField.has(key)) byField.set(key, new Map())
      const variants = byField.get(key)
      if (!variants.has(normalized)) variants.set(normalized, new Set())
      variants.get(normalized).add(reportName)
    }
  }
  return [...byField].filter(([, variants]) => variants.size > 1).map(([field, variants]) => ({
    field,
    variants: [...variants].map(([value, reports]) => ({ value, reports: [...reports] })),
  }))
}
