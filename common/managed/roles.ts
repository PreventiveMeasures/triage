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

// True iff `role` sits at or above `min` in the privilege ladder. ROLES is
// ordered highest-first, so a lower index is more privileged; an unknown role
// (index -1) is never "at least" anything. e.g. roleAtLeast(role, 'view') is
// "has at least read access" (everything except 'none').
export function roleAtLeast(role: Role, min: Role): boolean {
  const r = ROLES.indexOf(role)
  return r !== -1 && r <= ROLES.indexOf(min)
}
