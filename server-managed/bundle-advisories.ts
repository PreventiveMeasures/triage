import { type Advisory, type Package, advisories } from '@preventive/upstream/advisories.js'
import { createClient } from '@preventive/upstream/github.js'

export const ADVISORIES_TIMEOUT_MS = 30_000

// Public advisories never use a viewer's credentials. The library validates
// inventories, matches versions, and normalizes npm, OSV and repository rows.
export async function fetchBundleAdvisories(packages: Package[], signal: AbortSignal,
  { debug = false, repoAdvisories = false }: { debug?: boolean; repoAdvisories?: boolean } = {}): Promise<
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
    const result = await Promise.race([
      advisories(packages, { github: createClient({ token: null, userAgent: 'deepview-triage' }), repoAdvisories }), deadline,
    ])
    return { status: 200, body: result }
  } catch (error) {
    if (debug) console.warn('managed: advisories failed:', error)
    return { status: 502, body: { error: 'upstream-unavailable' } }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
