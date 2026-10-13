import { HttpError } from '@preventive/upstream/github.js'

// A failure carrying the HTTP status the router should surface. 401 passes
// through so the user-token path can map it to "log in again".
export class GithubApiError extends Error {
  status: number
  retryAfter: number | null
  // What failed, where GitHub wasn't reached (githubUnreachable).
  detail: string | null
  constructor(status: number, message: string, retryAfter: number | null = null, detail: string | null = null) {
    super(message)
    this.name = 'GithubApiError'
    this.status = status
    this.retryAfter = retryAfter
    this.detail = detail
  }
}

// GitHub not reached, or its answer not read whole, `started` ms since the
// epoch: as `github-unreachable`, with what failed as the error and its causes
// tell it (a timeout, a connection closed, an answer too large) and after how
// long, for an admin's page to show (repository-risk.ts). Only the errors'
// names, codes and messages, never GitHub's text nor a request's headers.
export function githubUnreachable(error: unknown, started: number): GithubApiError {
  const told: string[] = []
  for (let at = error, depth = 0; at instanceof Error && depth < 4; at = at.cause, depth++) {
    const code = 'code' in at && typeof at.code === 'string' && at.code !== at.name ? ` ${at.code}` : ''
    told.push(`${at.name}${code}${at.message ? `: ${at.message.slice(0, 200)}` : ''}`)
  }
  const failed = told.length > 0 ? told.join('; ') : String(error).slice(0, 200)
  return new GithubApiError(502, 'github-unreachable', null, `${failed}, after ${((Date.now() - started) / 1000).toFixed(1)}s`)
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
  const started = Date.now()
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
    throw githubUnreachable(error, started)
  }
}
