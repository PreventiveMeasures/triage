import { reportRepoGithub } from '@preventive/report'

// A git commit hash as a report writes one, short or full, either case:
// the rule @preventive/report's parsers read `auditedCommit` with.
// Empty for anything else, so a link falls back to HEAD.
export function asCommit(value) {
  const commit = typeof value === 'string' ? value.trim() : ''
  return /^[0-9a-f]{7,64}$/iu.test(commit) ? commit : ''
}

// The revision a `repo` declaration names beside its `github`, as a
// deepview report's header does: `"repo": { "github", "directory",
// "commit" }`. Older reports carry no `commit`, some no `repo` at all.
export function repoCommit(repo) {
  return asCommit(repo?.commit)
}

// GitHub repository names ignore case, and the slug a report writes need
// not match the case GitHub reports for the same repository.
export function sameRepoSlug(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase()
}

// The commit a report read its repository at, stamped on its findings
// as `_repoCommit`, but only while `github` (the repo its links resolve
// against) is the one the report names: it says nothing about a repo
// typed in later or assigned in its place.
export function reportCommit(data, github) {
  return sameRepoSlug(github, reportRepoGithub(data)) ? repoCommit(data?.repo) : ''
}
