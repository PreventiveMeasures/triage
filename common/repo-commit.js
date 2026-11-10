// The revision a report's `repo` names beside its `github`, as a deepview
// report's header does (`"repo": { "github", "directory", "commit" }`):
// the commit the report read that repository at. A finding's own `repo`
// can carry one too. Empty when it names none, or something that isn't a
// commit hash: older reports carry no `commit`, some no `repo` at all,
// and their links stay on HEAD.
const COMMIT_RE = /^[0-9a-f]{7,40}$/iu

// GitHub repository names ignore case, and the slug a report writes need
// not match the case GitHub reports for the same repository.
export function sameRepoSlug(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase()
}

export function repoCommit(repo) {
  const commit = typeof repo?.commit === 'string' ? repo.commit.trim() : ''
  return COMMIT_RE.test(commit) ? commit : ''
}
