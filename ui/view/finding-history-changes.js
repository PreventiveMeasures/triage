// Pure display formatting shared with the lazy managed history dialog.
const FIELDS = { triage: 'Status', color: 'Label', flagged: 'Flagged', fix: 'Fix', comment: 'Comment' }
const STATUSES = { inprogress: 'In progress', fixed: 'Fixed', invalid: 'Invalid', deleted: 'Deleted' }
function value(entry, field) {
  if (field === 'triage') return STATUSES[entry?.triage] ?? 'Untriaged'
  if (field === 'flagged') return entry?.flagged ? 'Yes' : 'No'
  return entry?.[field] || 'None'
}

// The oldest retained event is a snapshot, not proof of when triage began.
export function findingHistoryChanges(entry, older) {
  return Object.entries(FIELDS).flatMap(([field, label]) => {
    const after = value(entry, field)
    if (older === undefined) return entry?.[field] === undefined ? [] : [{ label, after }]
    const before = value(older, field)
    return before === after ? [] : [{ label, before, after }]
  })
}
