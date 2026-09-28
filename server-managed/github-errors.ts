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
