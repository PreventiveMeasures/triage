// The commits that release a repository, for its Pulse (repository-pulse.ts
// commitStats): one a tag names that changes no code, only package.json
// files (at least one, in any directory), the lockfiles beside them
// (RELEASE_LOCKFILES) and changelogs written in Markdown (RELEASE_CHANGELOG,
// a changeset's file among them), as `npm version` and a release's tooling
// leave one. What each commit changes is read as Replay reads it, kept by
// the commit (repository-changes.ts repositoryChanges).
import { type ChangesStore, type CommitChanges, repositoryChanges } from './repository-changes.ts'
import { githubGraphql } from './repository-history.ts'

// The tags read, a page a query, the latest commits' first, as many pages as
// TAG_PAGES; of the commits they name, as many as RELEASES_READ have their
// files read.
const TAG_PAGE = 100
const TAG_PAGES = 5
const RELEASES_READ = 200
// An annotated tag's target, its own target in turn, through as many as
// TAG_DEPTH annotated tags.
const TAG_DEPTH = 3
const SHA = /^[a-f\d]{40}$/u
const RELEASE_LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'])
const RELEASE_CHANGELOG = /^(?:changelog|changes|history|news|releases?)(?:[._-][^/]*)?\.(?:md|markdown)$/iu
const CHANGESET = /(?:^|\/)\.changeset\/[^/]+\.md$/iu

const tagTarget = (depth: number): string => `target { __typename oid ... on Commit { committedDate }${depth > 0 ? ` ... on Tag { ${tagTarget(depth - 1)} }` : ''} }`
const TAGS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/tags/", first: ${TAG_PAGE}, after: $after, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${tagTarget(TAG_DEPTH)} }
    }
  }
}`
type TagTarget = { __typename?: unknown; oid?: unknown; committedDate?: unknown; target?: TagTarget | null } | null | undefined
type TagsPage = { repository?: { refs?: { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: ({ target?: TagTarget } | null)[] } | null } | null }

// The commit a tag names, through its annotated tags, and when it was
// committed; null for one naming no commit (a tree, a blob).
function taggedCommit(target: TagTarget, depth = TAG_DEPTH): { oid: string; at: number } | null {
  if (target?.__typename === 'Tag' && depth > 0) return taggedCommit(target.target, depth - 1)
  const at = typeof target?.committedDate === 'string' ? Date.parse(target.committedDate) : Number.NaN
  return target?.__typename === 'Commit' && typeof target.oid === 'string' && SHA.test(target.oid) && Number.isSafeInteger(at) ? { oid: target.oid, at } : null
}

// The commits the repository's tags name committed since `since`, the
// latest first, as many pages of them as TAG_PAGES.
export async function taggedCommits(fullName: string, token: string, since: number, fetchImpl: typeof fetch = globalThis.fetch): Promise<Set<string>> {
  const [owner, name] = fullName.split('/') as [string, string]
  const tagged = new Set<string>()
  let after: string | null = null
  for (let pages = 0; pages < TAG_PAGES; pages++) {
    const page = await githubGraphql(TAGS_QUERY, { owner, name, after }, token, fetchImpl) as TagsPage | null
    const refs = page?.repository?.refs
    const commits = (refs?.nodes ?? []).flatMap(node => taggedCommit(node?.target) ?? [])
    for (const commit of commits) if (commit.at >= since) tagged.add(commit.oid)
    if (refs?.pageInfo?.hasNextPage !== true || typeof refs.pageInfo.endCursor !== 'string' || commits.some(commit => commit.at < since)) break
    after = refs.pageInfo.endCursor
  }
  return tagged
}

// Whether a path is one a release changes: a package.json, a lockfile beside
// one, or a changelog in Markdown.
const releaseFile = (path: string) => {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base === 'package.json' || RELEASE_LOCKFILES.has(base) || RELEASE_CHANGELOG.test(base) || CHANGESET.test(path)
}

// Whether what a commit changes is a release's: a package.json at least, and
// nothing a release changes none of, a rename's both paths alike; one
// GitHub listed only some files of, not.
export function releaseChanges({ files, more }: CommitChanges): boolean {
  const paths = files.flatMap(([path, status, from]) => status === 'R' ? [path, from] : [path])
  return !more && paths.some(path => path.slice(path.lastIndexOf('/') + 1) === 'package.json') && paths.every(releaseFile)
}

// The commits since `since` that release the repository: those its tags
// name whose changes are a release's, each read as Replay reads it (`kept`),
// as many as RELEASES_READ, sorted.
export async function releaseCommits(fullName: string, token: string, since: number, kept: ChangesStore, fetchImpl: typeof fetch = globalThis.fetch): Promise<string[]> {
  const tagged = [...await taggedCommits(fullName, token, since, fetchImpl)].slice(0, RELEASES_READ)
  const changes = await repositoryChanges(fullName, token, tagged, kept, fetchImpl)
  return tagged.filter(sha => { const read = changes.get(sha); return read ? releaseChanges(read) : false }).toSorted()
}
