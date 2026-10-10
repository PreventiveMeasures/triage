import { type Advisory, type CacheStore, type Package, advisories } from '@preventive/upstream/advisories.js'
import { type Client, HttpError, createClient } from '@preventive/upstream/github.js'

export const ADVISORIES_TIMEOUT_MS = 30_000

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const PATCHED_VERSION = /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u

// A maintainer may give a vulnerable range only its lower bound, and the
// version that fixed it apart, as GitHub's page shows them side by side
// (`>= 5.0.0-beta.1`, patched in `5.0.0-rc.2`): upstream reads the range
// alone, so such a range is ended below that version, where it is one.
export function boundRepoAdvisories(list: unknown): unknown {
  if (!Array.isArray(list)) return list
  return list.map(advisory => record(advisory) && Array.isArray(advisory['vulnerabilities']) ? {
    ...advisory,
    vulnerabilities: advisory['vulnerabilities'].map((vulnerability: unknown) => {
      if (!record(vulnerability)) return vulnerability
      const patched = vulnerability['patched_versions'], range = vulnerability['vulnerable_version_range']
      if (typeof patched !== 'string' || !PATCHED_VERSION.test(patched.trim()) || (typeof range === 'string' && range.includes('<'))) return vulnerability
      const bound = `< ${patched.trim()}`
      return { ...vulnerability, vulnerable_version_range: typeof range === 'string' && range.trim() !== '' ? `${range.trim()}, ${bound}` : bound }
    }),
  } : advisory)
}

function advisoryGithubClient(token: string | null, signal: AbortSignal): Client {
  const authenticated = createClient({ token, userAgent: 'deepview-triage' })
  let client = authenticated
  return {
    ...authenticated,
    async listRepoAdvisories(options) {
      const current = client
      try { return boundRepoAdvisories(await current.listRepoAdvisories(options)) as unknown[] } catch (error) {
        if (token === null || current !== authenticated || !(error instanceof HttpError) || error.status !== 401) throw error
        signal.throwIfAborted()
        // Published advisories remain readable after a token is revoked. Reuse
        // anonymous access for subsequent repositories in this audit as well.
        if (client === authenticated) client = createClient({ token: null, userAgent: 'deepview-triage' })
        return boundRepoAdvisories(await client.listRepoAdvisories(options)) as unknown[]
      }
    },
  }
}

// The managed caller supplies its user's token when available; public shares
// remain anonymous. Upstream sends this credential only to GitHub and returns
// published advisories, matching versions across npm, OSV and repository rows.
// `cache` keeps each repository's listing (upstream-cache.ts) across audits.
export async function fetchBundleAdvisories(packages: Package[], signal: AbortSignal,
  { debug = false, repoAdvisories = false, details = false, githubToken = null, cache }: {
    debug?: boolean; repoAdvisories?: boolean; details?: boolean; githubToken?: string | null; cache?: CacheStore | undefined
  } = {}): Promise<
  { status: 200; body: Advisory[] } | { status: 502; body: { error: string } }
> {
  let onAbort: (() => void) | undefined
  try {
    signal.throwIfAborted()
    if (packages.length === 0) return { status: 200, body: [] }
    // Upstream owns each transport's timeout and exposes no cancellation
    // option. Bound the caller's wait for the multi-request audit as well.
    const deadline = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    // Kept in the caller's store, or without one in upstream's disk cache,
    // where the server set one (auditCache).
    const result = await Promise.race([
      advisories(packages, { github: advisoryGithubClient(githubToken, signal), repoAdvisories, details, ...(cache && { cache }) }), deadline,
    ])
    return { status: 200, body: result }
  } catch (error) {
    if (debug) console.warn('managed: advisories failed:', error)
    return { status: 502, body: { error: 'upstream-unavailable' } }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
