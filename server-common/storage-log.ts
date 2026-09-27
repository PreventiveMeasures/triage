import { dirname, resolve } from 'node:path'

type DatabaseConfig = { dbPath: string; neonUrl?: string | null }

function databaseLocation({ dbPath, neonUrl }: DatabaseConfig): string {
  if (!neonUrl) return `SQLite ${dbPath === ':memory:' ? dbPath : resolve(dbPath)}`
  // Report the destination, never URL credentials or query-string secrets.
  try {
    const url = new URL(neonUrl)
    return `Neon Postgres ${url.host}${url.pathname}`
  } catch { return 'Neon Postgres' }
}

export function e2eStorageLines(config: DatabaseConfig & { objstoreDir: string }): string[] {
  return [
    `  E2E database: ${databaseLocation(config)}`,
    `  E2E objects: ${config.neonUrl ? 'Vercel Blob (private), {workspaceTag}/' : resolve(config.objstoreDir)}`,
    `  E2E staging: ${config.neonUrl ? 'Vercel Blob (private), {workspaceTag}/.staging/' : resolve(config.objstoreDir, '{workspaceTag}', '.staging')}`,
  ]
}

export function managedStorageLines(config: DatabaseConfig): string[] {
  const dir = dirname(config.dbPath)
  const location = (path: string) => config.neonUrl ? `Vercel Blob (private), .managed/${path}/` : resolve(dir, path)
  return [
    `  Managed database: ${databaseLocation(config)}`,
    `  Managed reports: ${location('reports')}`,
    `  Managed bundles: ${location('bundles')}`,
    `  Managed avatars: ${location('avatars')}`,
    `  Managed bundle cache: ${location('cache/bundles')}`,
    `  Managed report sources cache: ${location('cache/report-sources')}`,
    ...(config.neonUrl ? [`  Managed upload parts: ${location('uploads')}`] : []),
  ]
}
