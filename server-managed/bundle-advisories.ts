import { type Advisory, type CacheStore, type Package, advisories } from '@preventive/upstream/advisories.js'
import { type Client, HttpError, createClient } from '@preventive/upstream/github.js'
import { USER_AGENT } from './github-requests.ts'

export const ADVISORIES_TIMEOUT_MS = 30_000

function advisoryGithubClient(token: string | null, signal: AbortSignal): Client {
  const authenticated = createClient({ token, userAgent: USER_AGENT })
  let client = authenticated
  // Published advisories, and whether a repository is public, remain
  // readable after a token is revoked. Reuse anonymous access for subsequent
  // repositories in this audit as well.
  async function retried<T>(ask: (current: Client) => Promise<T>): Promise<T> {
    const current = client
    try { return await ask(current) } catch (error) {
      if (token === null || current !== authenticated || !(error instanceof HttpError) || error.status !== 401) throw error
      signal.throwIfAborted()
      if (client === authenticated) client = createClient({ token: null, userAgent: USER_AGENT })
      return await ask(client)
    }
  }
  return {
    ...authenticated,
    listRepoAdvisories: options => retried(current => current.listRepoAdvisories(options)),
    getRepo: options => retried(current => current.getRepo(options)),
  }
}

// How many repositories GitHub is asked at once whether they are public, as
// upstream asks for their listings.
const REPOS_AT_ONCE = 4

// Whether GitHub says anyone may read `repo`: not one private, nor one it
// has none of for this client (gone, or not the caller's to read). Any other
// failure is thrown, as the audit then fails.
async function isPublicRepo(github: Client, repo: string): Promise<boolean> {
  try { return (await github.getRepo({ repo, followRedirect: true }) as { private?: unknown } | null)?.private === false } catch (error) {
    if (error instanceof HttpError && [404, 410, 451].includes(error.status)) return false
    throw error
  }
}

// The packages as upstream is asked of them. Upstream asks OSV of every
// `github` package by its name, as an Action, but of one `internal`: each is
// internal but where GitHub says its repository is public, so a private one,
// or one GitHub has none of, has its own published advisories read alone, as
// a private npm package's name never reaches OSV either. One that says
// (`internal`, as its caller knows) is taken as it says.
async function markInternal(packages: Package[], github: Client): Promise<Package[]> {
  const internal = new Set(packages.flatMap(pkg => pkg.ecosystem === 'github' && pkg.internal === undefined ? [pkg.name] : []))
  const repos = [...internal]
  for (let at = 0; at < repos.length; at += REPOS_AT_ONCE) {
    await Promise.all(repos.slice(at, at + REPOS_AT_ONCE).map(async repo => { if (await isPublicRepo(github, repo)) internal.delete(repo) }))
  }
  return packages.map(pkg => pkg.ecosystem === 'github' && internal.has(pkg.name) ? { ...pkg, internal: true } : pkg)
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
    // private one's never leaves for OSV, as it never does for Socket; nor an
    // internal `github` package's (markInternal). Kept
    // in the caller's store, or without one in upstream's disk cache, where
    // the server set one (auditCache).
    const client = github ?? advisoryGithubClient(githubToken, signal)
    const options = { github: client, repoAdvisories, details, osv: true, ...(cache && { cache }) }
    return { status: 200, body: await Promise.race([markInternal(packages, client).then(asked => advisories(asked, options)), deadline]) }
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
