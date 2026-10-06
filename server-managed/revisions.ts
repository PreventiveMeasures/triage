// Internal invalidation counters. Never expose these global values to clients:
// feeds still publish only the existing user/visibility-scoped revisions.
const catalogTables = ['managed_link_report', 'managed_team', 'managed_team_user', 'managed_team_repo', 'managed_report', 'managed_bundle', 'managed_selected_repo']
const annotationTables = ['managed_finding_triage', 'managed_finding_triage_event', 'managed_finding_comment']
export function revisionSchema(postgres = false): string {
  let sql = `CREATE TABLE IF NOT EXISTS managed_maintenance_lease (
    id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS managed_change_revision (
    id INTEGER PRIMARY KEY, catalog INTEGER NOT NULL, annotations INTEGER NOT NULL
  ); INSERT INTO managed_change_revision VALUES (1, 0, 0) ON CONFLICT(id) DO NOTHING;`
  for (const [column, tables] of [['catalog', catalogTables], ['annotations', annotationTables]] as const) {
    const update = `UPDATE managed_change_revision SET ${column} = ${column} + 1 WHERE id = 1;`
    if (postgres) {
      sql += `CREATE OR REPLACE FUNCTION managed_${column}_changed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF EXISTS (SELECT 1 FROM managed_revision_rows) THEN ${update} END IF; RETURN NULL; END $$;`
    }
    for (const table of tables) {
      if (postgres) {
        sql += `DROP TRIGGER IF EXISTS ${table}_revision ON ${table};`
        for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
          sql += `DROP TRIGGER IF EXISTS ${table}_revision_${event} ON ${table};
            CREATE TRIGGER ${table}_revision_${event} AFTER ${event} ON ${table}
            REFERENCING ${event === 'DELETE' ? 'OLD' : 'NEW'} TABLE AS managed_revision_rows
            FOR EACH STATEMENT EXECUTE FUNCTION managed_${column}_changed();`
        }
      } else {
        for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
          sql += `CREATE TRIGGER IF NOT EXISTS ${table}_revision_${event}
            AFTER ${event} ON ${table} BEGIN ${update} END;`
        }
      }
    }
  }
  return sql
}
