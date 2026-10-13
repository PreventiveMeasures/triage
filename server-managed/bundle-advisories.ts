import { type Advisory, type CacheStore, type Package, advisories } from '@preventive/upstream/advisories.js'
import { type Client, HttpError, createClient } from '@preventive/upstream/github.js'
import { isNpmPackageName, npmPackageScope } from '../common/managed/npm-packages.js'
import { NPM_REGISTRY, askUpstream } from './npm-packages.ts'

export const ADVISORIES_TIMEOUT_MS = 30_000
const PUBLIC_AT_ONCE = 16
const order = (a: string, b: string) => Number(a > b) - Number(a < b)

// Whether anyone may read a package, so that its name may go to a service
// other than npm (OSV): an unscoped one always, npm's private packages
// always being scoped; a scoped one where npm answers it anonymously, asked
// by a HEAD, which reads nothing of it. One npm can't be asked of is taken
// as private, and not kept; the rest are, for PUBLIC_MS, PUBLIC_NAMES at
// most, as a package may be made private, or public. A name npm can't have
// is asked of no one, upstream refusing it.
const PUBLIC_MS = 60 * 60_000
const PUBLIC_NAMES = 10_000
const publicNames = new Map<string, { at: number; open: boolean }>()
async function isPublicNpmPackage(name: string, signal: AbortSignal): Promise<boolean> {
  if (!isNpmPackageName(name)) return false
  if (npmPackageScope(name) === null) return true
  const kept = publicNames.get(name)
  if (kept && Date.now() - kept.at < PUBLIC_MS) return kept.open
  let open
  try { open = await askUpstream(`${NPM_REGISTRY}/${name}`, { method: 'HEAD', limit: Number.MAX_SAFE_INTEGER, signal, absent: [401, 403, 404] }) !== null } catch { return false }
  publicNames.delete(name)
  publicNames.set(name, { at: Date.now(), open })
  while (publicNames.size > PUBLIC_NAMES) publicNames.delete(publicNames.keys().next().value!)
  return open
}

// The npm packages anyone may read (isPublicNpmPackage), a few asked at a
// time, within PUBLIC_BUDGET_MS, a third of the audit's: a scoped one npm
// hasn't told of by then is taken as private, asked of npm alone, for the
// audit to keep the rest of its time.
const PUBLIC_BUDGET_MS = 10_000
async function publicNpmNames(packages: Package[], signal: AbortSignal): Promise<Set<string>> {
  const names = [...new Set(packages.filter(pkg => pkg.ecosystem === 'npm').map(pkg => pkg.name))]
  const open = new Set<string>()
  const budget = new AbortController()
  const timer = setTimeout(() => { budget.abort(new Error('public-check-budget')) }, PUBLIC_BUDGET_MS)
  const asking = AbortSignal.any([signal, budget.signal])
  try {
    for (let at = 0; at < names.length; at += PUBLIC_AT_ONCE) {
      const chunk = names.slice(at, at + PUBLIC_AT_ONCE)
      const checked = await Promise.all(chunk.map(name => isPublicNpmPackage(name, asking)))
      for (const [i, name] of chunk.entries()) if (checked[i]) open.add(name)
    }
  } finally { clearTimeout(timer) }
  return open
}

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
// among them, which npm's registry hasn't.
// `cache` keeps each repository's listing (upstream-cache.ts) across audits;
// `github`, a client of the caller's, asks GitHub in place of one with
// `githubToken`.
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
    // for the malicious packages' records npm's registry hasn't; a private
    // one's name never leaves for OSV, as it never does for Socket. A package
    // is wholly in one ask or the other, so upstream's order holds.
    const open = await Promise.race([publicNpmNames(packages, signal), deadline])
    const toOsv = (pkg: Package) => pkg.ecosystem === 'npm' && open.has(pkg.name)
    // Kept in the caller's store, or without one in upstream's disk cache,
    // where the server set one (auditCache).
    const options = { github: github ?? advisoryGithubClient(githubToken, signal), repoAdvisories, details, ...(cache && { cache }) }
    const asked = [{ part: packages.filter(toOsv), osv: true }, { part: packages.filter(pkg => !toOsv(pkg)), osv: false }]
    const result = await Promise.race([Promise.all(asked.map(({ part, osv }) => part.length === 0 ? Promise.resolve([]) : advisories(part, { ...options, osv }))), deadline])
    return { status: 200, body: result.flat().toSorted((a, b) => order(a.ecosystem, b.ecosystem) || order(a.name, b.name)) }
  } catch (error) {
    if (debug) console.warn('managed: advisories failed:', error)
    return { status: 502, body: { error: 'upstream-unavailable' } }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
