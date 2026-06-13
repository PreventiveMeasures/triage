// The access-decision core for the managed protocol — PURE functions, no
// IO. Given facts the caller has already fetched (the project, the
// repo-wide policy, the instance default, the user's GitHub membership,
// and the grants that apply to the user), decide the user's effective
// role. SCAFFOLD ONLY — see `server-managed/MANAGED.md`. Keeping this pure means
// the precedence rules are unit-testable without a DB or a GitHub round
// trip, and the (future) IO layer only has to gather inputs and call in.

import { ROLE_RANK } from './types.ts'
import type {
  GithubAccessFacts, Grant, Project, RepoPolicy, Role, VisibilityMode,
} from './types.ts'

// Effective visibility mode, lowest-to-highest precedence:
//   instance default  →  repo-wide policy  →  project pin
// i.e. a project's own `visibilityMode` wins; absent that, the repo-wide
// `RepoPolicy`; absent that, the instance default. This is the
// "hybrid by default, switchable to explicit ACL — at the instance
// default, repo-wide, or per-project" rule.
export function effectiveVisibilityMode(
  project: Pick<Project, 'visibilityMode'>,
  repoPolicy: RepoPolicy | null,
  instanceDefault: VisibilityMode,
): VisibilityMode {
  return project.visibilityMode ?? repoPolicy?.visibilityMode ?? instanceDefault
}

// Map GitHub's repo permission ladder onto our role ladder. admin → admin;
// the write tier (maintain/write) → editor; the read tier (triage/read) →
// viewer; no permission → no role. `triage` is GitHub's "manage issues/PRs
// without code write" — it maps to viewer here (it grants no code/content
// write in our model). null collapses to null.
export function roleFromRepoPermission(p: GithubAccessFacts['repoPermission']): Role | null {
  switch (p) {
    case 'admin': return 'admin'
    case 'maintain': return 'editor'
    case 'write': return 'editor'
    case 'triage': return 'viewer'
    case 'read': return 'viewer'
    case null: return null
  }
}

// The result of an access decision. `role: null` = no access (the project
// must not even be listed to this user).
export type AccessDecision = { role: Role | null }

// Higher of two roles (null = no role). The chain folds every applicable
// source through this so the user ends on their MAX entitlement.
function maxRole(a: Role | null, b: Role | null): Role | null {
  if (a == null) return b
  if (b == null) return a
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b
}

// Decide a user's effective role on one project. Inputs are already
// resolved by the caller:
//   • `mode`             — the EFFECTIVE visibility mode (run
//                          `effectiveVisibilityMode` first).
//   • `isOwner`          — project.ownerUserId === the user's id.
//   • `github`           — the user's membership facts, or null when
//                          unauthenticated-to-GitHub / facts unavailable.
//   • `applicableGrants` — grants whose principal matches THIS user
//                          (direct user grant, or a team/org the user is
//                          in). The principal→user matching is
//                          GitHub-fact-dependent and lives in the IO layer.
//
// Rules, by design (see MANAGED.md):
//   • Owner is always admin, in either mode.
//   • `hybrid` mode (the default) consults GitHub repo permission AND
//     honours explicit grants on top (grants only ever ADD access — share
//     with a collaborator who isn't on the repo).
//   • `explicit` mode IGNORES GitHub access entirely; only owner + grants
//     count. This is the crisp "switched to explicit ACL" semantics.
export function resolveProjectAccess(input: {
  mode: VisibilityMode
  isOwner: boolean
  github: GithubAccessFacts | null
  applicableGrants: readonly Grant[]
}): AccessDecision {
  const { mode, isOwner, github, applicableGrants } = input
  if (isOwner) return { role: 'admin' }

  let role: Role | null = null
  if (mode === 'hybrid' && github != null) {
    role = maxRole(role, roleFromRepoPermission(github.repoPermission))
  }
  // Explicit grants are additive in BOTH modes — in `explicit` mode they
  // are the ONLY source besides ownership; in `hybrid` mode they augment.
  for (const g of applicableGrants) role = maxRole(role, g.role)

  return { role }
}

// Convenience predicates over a decision — the endpoint guards read as
// `if (!canView(decision)) return 403`.
export function canView(d: AccessDecision): boolean {
  return d.role != null
}
export function canEdit(d: AccessDecision): boolean {
  return d.role === 'editor' || d.role === 'admin'
}
export function canAdmin(d: AccessDecision): boolean {
  return d.role === 'admin'
}
