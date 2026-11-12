// A finding about an advisory on the npm package it names (its
// `package.npm.name` is the `advisory.package`) belongs to the project the
// report covers: its own `repo` names that package's repository, which is
// no repository of the project's. It is ignored for which repository the
// finding is filtered under and which one its issue is opened in, and the
// report's repository answers for both, as for a finding with no `repo`.
export function ignoresOwnRepo(finding) {
  const name = finding?.package?.npm?.name
  const advisory = finding?.advisory
  return typeof name === 'string' && name !== '' && advisory !== null && typeof advisory === 'object' && advisory.package === name
}
