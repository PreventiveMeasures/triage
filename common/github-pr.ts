export const MAX_PULL_REQUEST_URL = 2048

export interface PullRequestRef { repo: string; number: number }
export type GithubFixRef = PullRequestRef & { kind: 'pull' | 'issue' }
export type GithubFixStatus = 'open' | 'draft' | 'closed' | 'merged'
export type GithubIssueClosedReason = 'completed' | 'not_planned' | 'duplicate' | 'unknown'
export type GithubFixResult = { url: string } & (
  { title: string; description: string | null; status: GithubFixStatus; stateReason: GithubIssueClosedReason | null } | { error: 'unavailable' }
)

// Unknown closure reasons must never imply that an issue was completed.
export function githubIssueClosedReason(value: unknown): GithubIssueClosedReason {
  return value === 'completed' || value === 'not_planned' || value === 'duplicate' ? value : 'unknown'
}

export function isGithubRepoName(value: string): boolean {
  const [owner, repo, extra] = value.split('/')
  return extra === undefined && owner !== undefined && repo !== undefined
    && owner.length <= 39 && /^[a-zA-Z\d](?:-?[a-zA-Z\d])*$/u.test(owner)
    && repo.length <= 100 && repo !== '.' && repo !== '..' && /^[a-zA-Z\d._-]+$/u.test(repo)
}

// Only identify the repository and PR number. This never supplies an API URL:
// the server must match a team repository and use its stored full name.
function parseGithubNumberedUrl(value: unknown, path: RegExp): PullRequestRef | null {
  if (typeof value !== 'string' || value.length > MAX_PULL_REQUEST_URL) return null
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (url.href !== value || url.origin !== 'https://github.com' || url.username || url.password) return null
  const match = path.exec(url.pathname)
  if (!match) return null
  const repo = `${match[1]}/${match[2]}`
  const number = Number(match[3])
  if (!isGithubRepoName(repo) || !Number.isSafeInteger(number) || number <= 0) return null
  return { repo, number }
}

export function parseGithubPrUrl(value: unknown): PullRequestRef | null {
  return parseGithubNumberedUrl(value, /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(?:files|commits|checks))?\/?$/u)
}

export function parseGithubIssueUrl(value: unknown): PullRequestRef | null {
  return parseGithubNumberedUrl(value, /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/u)
}

export function parseGithubFixUrl(value: unknown): GithubFixRef | null {
  const pr = parseGithubPrUrl(value)
  if (pr) return { ...pr, kind: 'pull' }
  const issue = parseGithubIssueUrl(value)
  return issue ? { ...issue, kind: 'issue' } : null
}

// Browser-only deduplication key; never used to construct a server API call.
export function githubFixKey(ref: GithubFixRef): string {
  return `${ref.repo.toLowerCase()}#${ref.kind}:${ref.number}`
}
