// Managed-mode user roles, shared by the managed server (which stores +
// validates them) and the admin client (the role picker). A linear privilege
// ladder, highest first:
//   admin  — full access incl. managing other users' roles
//   manage — (reserved) content/workspace management
//   triage — can triage findings
//   view   — read-only
//   none   — no access
// Only `admin` is enforced today (the admin endpoints + UI); the rest are
// stored + assignable, with their enforcement a later step.
export type Role = 'admin' | 'manage' | 'triage' | 'view' | 'none'

export const ROLES: readonly Role[] = ['admin', 'manage', 'triage', 'view', 'none']

export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x)
}
