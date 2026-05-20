// Composite-key helpers for `state.ignoredIds` — a Set of
// `${reportName}\0${id}` strings (per-report "ignore this finding"
// markers). NUL separates the two halves because report names and
// finding ids are arbitrary UTF-8 but never contain NUL (`storage.js`
// rejects report names that do). Centralised so the dozen-plus split
// sites and the join sites can't drift on the separator or the slice
// arithmetic.

const SEP = '\0'

export function makeIgnoredKey(reportName, id) {
  return `${reportName}${SEP}${id}`
}

// `{ reportName, id }` or `null` when the key carries no separator
// (malformed / legacy) — every caller skips those.
export function splitIgnoredKey(key) {
  const sep = key.indexOf(SEP)
  if (sep < 0) return null
  return { reportName: key.slice(0, sep), id: key.slice(sep + 1) }
}
