import { type Advisory, type CacheStore, type Package, advisories } from '@preventive/upstream/advisories.js'
import { type Client, HttpError, createClient } from '@preventive/upstream/github.js'

export const ADVISORIES_TIMEOUT_MS = 30_000

function advisoryGithubClient(token: string | null, signal: AbortSignal): Client {
  const authenticated = createClient({ token, userAgent: 'deepview-triage' })
  let client = authenticated
  return {
    ...authenticated,
    async listRepoAdvisories(options) {
      const current = client
      try { return await current.listRepoAdvisories(options) } catch (error) {
        if (token === null || current !== authenticated || !(error instanceof HttpError) || error.status !== 401) throw error
        signal.throwIfAborted()
        // Published advisories remain readable after a token is revoked. Reuse
        // anonymous access for subsequent repositories in this audit as well.
        if (client === authenticated) client = createClient({ token: null, userAgent: 'deepview-triage' })
        return await client.listRepoAdvisories(options)
      }
    },
  }
}

// The managed caller supplies its user's token when available; public shares
// remain anonymous. Upstream sends this credential only to GitHub and returns
// published advisories, matching versions across npm, OSV and repository rows:
// OSV's for npm packages anyone may read too, the malicious packages' records
// among them, which npm's registry hasn't, each row of malware told so
// (`malware`). `cache` keeps each repository's listing, and the npm packages
// anyone may read (upstream-cache.ts), across audits; `github`, a client of
// the caller's, asks GitHub in place of one with `githubToken`.
export async function fetchBundleAdvisories(packages: Package[], signal: AbortSignal,
  { debug = false, repoAdvisories = false, details = false, githubToken = null, github, cache }: {
    debug?: boolean; repoAdvisories?: boolean; details?: boolean; githubToken?: string | null; github?: Client; cache?: CacheStore | undefined
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
    // npm packages anyone may read are asked of OSV too (upstream's `osv`),
    // for the malicious packages' records npm's registry hasn't: upstream
    // sends OSV only the names npm's registry serves without a token, so a
    // private one's never leaves for OSV, as it never does for Socket. Kept in
    // the caller's store, or without one in upstream's disk cache, where the
    // server set one (auditCache).
    const options = { github: github ?? advisoryGithubClient(githubToken, signal), repoAdvisories, details, osv: true, ...(cache && { cache }) }
    return { status: 200, body: await Promise.race([advisories(packages, options), deadline]) }
  } catch (error) {
    // Answered as upstream's failure alone: logged, its message, or with
    // `debug` the whole error, but for a request its client gave up on. One
    // past its deadline (aborted with a TimeoutError, as AbortSignal.timeout
    // and the bundle route's timer abort) is the server giving up: logged.
    const cancelled = signal.aborted && (signal.reason as { name?: unknown } | undefined)?.name !== 'TimeoutError'
    if (!cancelled) console.warn('managed: advisories failed:', debug || !(error instanceof Error) ? error : error.message)
    return { status: 502, body: { error: 'upstream-unavailable' } }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
