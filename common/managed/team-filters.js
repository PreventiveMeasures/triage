import { SEVERITIES } from '@preventive/report'

// A team's board can be linked filtered by repository and severity, the
// two filters a link names: `/team/<slug>?repo=owner/name&severity=critical,high`,
// as `filters: { repo, severities }`. The repository is the key the
// Repository filter matches (ui/view/filters.js repoOfFinding); the
// severities are SEVERITIES' names, in their order. Only on the team's own
// page: a report's or a finding's link is about that instead.
const isRepoFilter = repo => typeof repo === 'string' && repo.length > 0 && repo.length <= 256 && !/[\p{Cc}]/u.test(repo)

export function filtersOf(params) {
  const repo = params.get('repo')
  const named = new Set((params.get('severity') ?? '').split(','))
  const severities = SEVERITIES.filter(severity => named.has(severity))
  const filters = { ...(isRepoFilter(repo) ? { repo } : {}), ...(severities.length > 0 ? { severities } : {}) }
  return Object.keys(filters).length > 0 ? { filters } : {}
}

export function filtersQuery(filters) {
  const severities = SEVERITIES.filter(severity => filters?.severities?.includes(severity))
  const query = [
    ...(isRepoFilter(filters?.repo) ? [`repo=${encodeURIComponent(filters.repo).replaceAll('%2F', '/')}`] : []),
    ...(severities.length > 0 ? [`severity=${severities.join(',')}`] : []),
  ]
  return query.length > 0 ? `?${query.join('&')}` : ''
}
