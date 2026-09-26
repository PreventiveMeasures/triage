import { env } from 'node:process'

// One shared URL or per-mode URLs. Validate before opening either store so
// an ambiguous configuration cannot send application traffic and GC elsewhere.
export function databaseUrls({ combined = false } = {}) {
  const shared = env['DATABASE_URL'] || null
  const e2e = env['E2E_DATABASE_URL'] || null
  const managed = env['MANAGED_DATABASE_URL'] || null
  if (shared && (e2e || managed)) {
    throw new Error('DATABASE_URL cannot be combined with E2E_DATABASE_URL or MANAGED_DATABASE_URL. Use the shared URL alone, or only the per-mode URLs.')
  }
  if (combined && Boolean(e2e) !== Boolean(managed)) {
    throw new Error('Combined mode requires both E2E_DATABASE_URL and MANAGED_DATABASE_URL, DATABASE_URL alone, or no database URLs. Mixing Neon and SQLite is not supported.')
  }
  return { e2e: shared ?? e2e, managed: shared ?? managed }
}
