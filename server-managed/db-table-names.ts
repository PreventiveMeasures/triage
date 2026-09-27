// Table identifiers are code constants. Renames retain rows and foreign keys;
// an ambiguous old/new pair must be resolved before the server can start.
export const MANAGED_TABLE_RENAMES = [
  ['selected_repo', 'managed_selected_repo'],
  ['team_repo', 'managed_team_repo'],
  ['team_user', 'managed_team_user'],
  ['finding_triage', 'managed_finding_triage'],
  ['finding_triage_event', 'managed_finding_triage_event'],
  ['finding_comment', 'managed_finding_comment'],
  ['finding_comment_event', 'managed_finding_comment_event'],
] as const

export function managedTableRenames(tables: Set<string>) {
  // A fresh installation must not claim similarly named unrelated tables in
  // a shared database. managed_user anchors an existing managed installation.
  if (!tables.has('managed_user')) return []
  const renames = MANAGED_TABLE_RENAMES.filter(([from]) => tables.has(from))
  for (const [from, to] of renames) {
    if (tables.has(to)) throw new Error(`Cannot migrate managed tables: both ${from} and ${to} exist`)
  }
  return renames
}
