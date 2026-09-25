export const MAX_PULL_REQUESTS = 50
export const MAX_PULL_REQUEST_URL = 2048

export interface PullRequestRef { repo: string; number: number }
export type PullRequestStatus = 'open' | 'draft' | 'closed' | 'merged'
export type PullRequestResult = { url: string } & (
  { title: string; status: PullRequestStatus } | { error: 'invalid-url' | 'forbidden' | 'unavailable' }
)

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

// Used only to identify issue links in the UI; these are not PR lookup inputs.
export function parseGithubIssueUrl(value: unknown): PullRequestRef | null {
  return parseGithubNumberedUrl(value, /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/u)
}

// Browser-only deduplication key; never used to construct a server API call.
export function pullRequestKey(ref: PullRequestRef): string {
  return `${ref.repo.toLowerCase()}#${ref.number}`
}
