import { HttpError } from '@preventive/upstream/github.js'

// A failure carrying the HTTP status the router should surface. 401 passes
// through so the user-token path can map it to "log in again".
export class GithubApiError extends Error {
  status: number
  retryAfter: number | null
  constructor(status: number, message: string, retryAfter: number | null = null) {
    super(message)
    this.name = 'GithubApiError'
    this.status = status
    this.retryAfter = retryAfter
  }
}

export async function throwGithubResponseError(res: Response): Promise<never> {
  if (res.status === 403 || res.status === 429) {
    const body = await res.json().catch(() => null) as { message?: unknown } | null
    if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')
      || (typeof body?.message === 'string' && /rate limit|abuse detection/iu.test(body.message))) {
      const retry = Number(res.headers.get('retry-after'))
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000
      const wait = Math.max(Number.isFinite(retry) ? retry : 0, Number.isFinite(reset) ? (reset - Date.now()) / 1000 : 0)
      throw new GithubApiError(429, 'github-rate-limited', Math.max(60, Math.ceil(wait)))
    }
  }
  if (res.status === 401) throw new GithubApiError(401, 'github-unauthorized')
  if (res.status === 404) throw new GithubApiError(404, 'github-not-found')
  throw new GithubApiError(502, `github-status-${res.status}`)
}

export async function upstreamGithub<T>(request: () => Promise<T>): Promise<T> {
  try { return await request() } catch (error) {
    if (error instanceof HttpError) {
      // The upstream error includes GitHub's response text. Retain managed
      // status handling, including rate limits, without exposing that text.
      if (error.status === 401) throw new GithubApiError(401, 'github-unauthorized')
      if (error.status === 404) throw new GithubApiError(404, 'github-not-found')
      if (error.status === 429 || (error.status === 403 && /rate limit|abuse detection/iu.test(error.message))) {
        throw new GithubApiError(429, 'github-rate-limited', 60)
      }
      throw new GithubApiError(502, `github-status-${error.status}`)
    }
    if (error instanceof Error && (error.name === 'AssertionError' || error.cause instanceof SyntaxError)) {
      throw new GithubApiError(502, 'github-malformed')
    }
    throw new GithubApiError(502, 'github-unreachable')
  }
}
