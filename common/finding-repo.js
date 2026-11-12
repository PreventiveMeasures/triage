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
