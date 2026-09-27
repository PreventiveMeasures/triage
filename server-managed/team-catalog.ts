import { createHash } from 'node:crypto'

// Version only this user's visible catalog, including access and content keys.
// REST and the live feed must describe exactly the same snapshot.
export function teamCatalogRevision(teams: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(teams)).digest('base64url')
}
