// Risk's pages, each a scope it scans (ui/managed/repository-risk.js): every
// connected repository, `/manage/risk/all`; a team's, by its slug,
// `/manage/risk/team/<slug>`; or one repository, by its id,
// `/manage/risk/repository/<repo id>`; a team or a repository still to
// choose, without one. A route naming no scope (`riskScope`) is a team's
// still to choose, Risk's own page, `/manage/risk`, opening there, as links
// from before Risk left Repositories, `/manage/repositories/risk`, do.
const RISK_SCOPES = Object.freeze({ all: 'all', team: 'team', repo: 'repository' })
const isRiskTarget = (scope, target) => scope === 'team' ? typeof target === 'string' && /^[A-Za-z0-9_-]+$/u.test(target)
  : scope === 'repo' && Number.isSafeInteger(target) && target > 0

export function riskPath(route) {
  const scope = route.riskScope ?? 'team'
  const target = route.riskTarget ?? null
  if (!Object.hasOwn(RISK_SCOPES, scope) || target != null && !isRiskTarget(scope, target)) return null
  return `/manage/risk/${RISK_SCOPES[scope]}${target == null ? '' : `/${target}`}`
}

// Risk's route of `path` past its own page (MANAGED_PAGES); undefined where
// it is none of Risk's pages.
export function parseRiskRoute(path) {
  if (path === '/manage/risk/team' || path === '/manage/repositories/risk') return { view: 'manage-repo-risk' }
  if (!path.startsWith('/manage/risk/')) return undefined
  const match = /^\/manage\/risk\/(?:(all)|(team)\/([A-Za-z0-9_-]+)|repository(?:\/([1-9]\d*))?)$/u.exec(path)
  if (!match) return null
  if (match[1]) return { view: 'manage-repo-risk', riskScope: 'all' }
  const [scope, target] = match[2] ? ['team', match[3]] : ['repo', match[4] == null ? null : Number(match[4])]
  if (target != null && !isRiskTarget(scope, target)) return null
  return { view: 'manage-repo-risk', riskScope: scope, ...(target == null ? {} : { riskTarget: target }) }
}
