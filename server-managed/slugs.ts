import type { DatabaseSync } from 'node:sqlite'

// Legacy non-UUID IDs stay intact. Production IDs are UUIDs; only their final
// component is proposed as a slug, never an arbitrary prefix or abbreviation.
export function preferredSlug(id: string): string {
  return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-([a-f\d]{12})$/iu.exec(id)?.[1] ?? id
}

// Allocate once, across the entire namespace rather than a viewer's teams.
// Keep existing slugs stable when names, memberships, or collisions change.
export function migrateSlugs(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const table of ['managed_team', 'managed_report']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      if (!columns.some(column => column.name === 'slug')) db.exec(`ALTER TABLE ${table} ADD COLUMN slug TEXT`)
      const rows = db.prepare(`SELECT id, slug FROM ${table} ORDER BY id`).all() as { id: string; slug: string | null }[]
      // Reserve every ID up front: a legacy non-UUID row may sort after a
      // UUID whose suffix matches it, and its full-ID fallback must stay free.
      const used = new Set(rows.flatMap(row => row.slug == null ? [row.id] : [row.id, row.slug]))
      const update = db.prepare(`UPDATE ${table} SET slug = ? WHERE id = ?`)
      for (const row of rows) {
        if (row.slug != null) continue
        const candidate = preferredSlug(row.id)
        const slug = used.has(candidate) ? row.id : candidate
        update.run(slug, row.id)
        used.add(slug)
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_slug_idx ON ${table}(slug)`)
    }
    db.exec('COMMIT')
  } catch (err) { db.exec('ROLLBACK'); throw err }
}
