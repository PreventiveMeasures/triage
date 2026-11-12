import { reportRepoGithub } from '@preventive/report'
import { sameRepoSlug } from './repo-commit.js'

// A finding on an advisory names, in older dependency scans, the advised
// package's repository as its own `repo` (`expressjs/body-parser` for an
// advisory on `body-parser`): no repository of ours, and a mistake. It is
// ignored everywhere, as if the finding named none, and the report's
// repository answers for it. Only that one, though: a `repo` whose name is
// not the advised package's (a scoped `@scope/name` by `name`) stays, and so
// does the report's own repository, which a merge may stamp there.
export function ignoresOwnRepo(finding, reportRepo) {
  const advised = finding?.advisory?.package
  const github = finding?.repo?.github
  if (typeof advised !== 'string' || advised === '' || typeof github !== 'string' || github === '') return false
  const slug = reportRepoGithub({ repo: { github } })
  const name = slug?.split('/')[1].toLowerCase()
  if (name !== advised.toLowerCase() && name !== advised.replace(/^@[^/]+\//u, '').toLowerCase()) return false
  const ours = typeof reportRepo === 'string' && reportRepo !== '' ? reportRepoGithub({ repo: { github: reportRepo } }) ?? reportRepo : ''
  return !sameRepoSlug(slug, ours)
}

// The finding as the app reads it: without that `repo`, marked
// `_repoIgnored` for what asks whose the finding is, and with nothing else
// changed (`parent` and the rest kept).
export function dropForeignRepo(finding, reportRepo) {
  if (!ignoresOwnRepo(finding, reportRepo)) return finding
  const { repo: _ignored, ...rest } = finding
  return { ...rest, _repoIgnored: true }
}

// Managed mode is stricter, as a finding's repository there decides what a
// viewer without dependency access may see (common/managed/report-filter.ts):
// a finding on an advisory on its own npm package (`package.npm.name` is
// `advisory.package`) keeps its `repo` only when that is one of `ours`, the
// lowercase slugs ourRepoSlugs gives. The server removes any other before a
// report leaves it, and the client never sees it.
export function isStrayRepo(finding, ours) {
  const name = finding?.package?.npm?.name
  const github = finding?.repo?.github
  if (typeof name !== 'string' || name === '' || finding?.advisory?.package !== name || typeof github !== 'string' || github === '') return false
  return !ours.has((reportRepoGithub({ repo: { github } }) ?? github).toLowerCase())
}

// The repositories that are ours, as isStrayRepo reads them.
export function ourRepoSlugs(repos) {
  const ours = new Set()
  for (const github of repos) {
    const slug = typeof github === 'string' && github !== '' ? reportRepoGithub({ repo: { github } }) : null
    if (slug) ours.add(slug.toLowerCase())
  }
  return ours
}

// A report's data without those `repo`s; the same object when it holds none.
export function withoutStrayRepos(data, ours) {
  const key = Array.isArray(data?.findings) ? 'findings' : Array.isArray(data?.groups) ? 'groups' : null
  if (!key) return data
  let changed = false
  const read = (finding) => {
    if (!isStrayRepo(finding, ours)) return finding
    changed = true
    const { repo: _stray, ...rest } = finding
    return rest
  }
  const entries = data[key].map((entry) => (Array.isArray(entry) ? entry.map(read) : read(entry)))
  return changed ? { ...data, [key]: entries } : data
}
