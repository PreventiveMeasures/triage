// GitHub as an actions scan resolves references with (risk ActionsSource), of
// `repos`, each `{ info, tags, branches, complete, history, missing, files }`:
// `history` by a commit or a branch, the commits in it; `files` by
// `path@commit`. Each call asked noted (`asked`, `[method, ...args]`).
export function actionsSourceOf(repos) {
  const asked = [], repo = name => repos[name.toLowerCase()]
  const answer = (method, value) => (...args) => { asked.push([method, ...args]); return Promise.resolve(value(...args)) }
  return {
    asked,
    repo: answer('repo', name => repo(name)?.info ?? null),
    tags: answer('tags', name => repo(name)?.tags ?? []),
    tag: answer('tag', (name, tag) => repo(name)?.tags?.find(each => each.tag === tag)?.oid ?? null),
    branch: answer('branch', (name, branch) => repo(name)?.branches?.find(each => each.branch === branch)?.oid ?? null),
    branches: answer('branches', name => ({ branches: repo(name)?.branches ?? [], complete: repo(name)?.complete ?? true })),
    contains: answer('contains', (name, base, sha) => {
      const { history = {}, missing = [] } = repo(name) ?? {}
      return missing.includes(sha) ? null : (history[base] ?? [base]).includes(sha)
    }),
    file: answer('file', (name, path, commit) => repo(name)?.files?.[`${path}@${commit}`] ?? null),
  }
}
