// Per-membership visibility permissions for a team's users — shared by the
// managed server (which stores + validates them) and the admin client (the
// team-member checkboxes). Each is an independent opt-in, BOTH DEFAULT OFF:
//   dependencies — scan findings in dependencies' own code; App impact stays visible
//   security     — security findings and published bundle advisories
// The managed server filters report responses and authorizes advisory lookups
// using these independent permissions.
export type VisibilityPermission = 'dependencies' | 'security'

export const VISIBILITY_PERMISSIONS: readonly VisibilityPermission[] = ['dependencies', 'security']

// Human labels for the admin checkboxes (keyed by permission).
export const VISIBILITY_PERMISSION_LABELS: Record<VisibilityPermission, string> = {
  dependencies: 'Dependencies',
  security: 'Security',
}

// A membership's resolved permission set; every key present (false = off).
export type TeamUserPermissions = Record<VisibilityPermission, boolean>

// All-off — the default for a fresh membership.
export const DEFAULT_TEAM_USER_PERMISSIONS: TeamUserPermissions = { dependencies: false, security: false }

export function isVisibilityPermission(x: unknown): x is VisibilityPermission {
  return typeof x === 'string' && (VISIBILITY_PERMISSIONS as readonly string[]).includes(x)
}

// Coerce arbitrary input (a request body) into a full permission set: a key is
// granted only when explicitly `true`; anything else (absent, non-bool) is off.
export function parseTeamUserPermissions(x: unknown): TeamUserPermissions {
  const o = (x == null || typeof x !== 'object') ? {} : x as Record<string, unknown>
  const out = { ...DEFAULT_TEAM_USER_PERMISSIONS }
  for (const p of VISIBILITY_PERMISSIONS) out[p] = o[p] === true
  return out
}
