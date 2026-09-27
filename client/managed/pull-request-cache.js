import { parseGithubPrUrl, pullRequestKey } from '../../common/github-pr.ts'

// One in-memory response per active workspace/session. A rendered URL is only
// a local lookup key; it never becomes input to the server or GitHub request.
export class PullRequestCache {
  constructor({ context, fetchWorkspace, changed = () => {}, now = Date.now }) {
    this.getContext = context
    this.fetchWorkspace = fetchWorkspace
    this.changed = changed
    this.now = now
    this.entries = new Map()
    this.expires = 0
    this.context = null
    this.timer = null
    this.run = null
  }

  reset() {
    this.run?.abort()
    this.run = null
    clearTimeout(this.timer)
    this.timer = null
    this.entries.clear()
    this.expires = 0
    this.context = null
  }

  syncContext() {
    const next = this.getContext()
    if (next?.key !== this.context?.key || next?.teamId !== this.context?.teamId || next?.teams !== this.context?.teams) {
      this.reset()
      this.context = next
    }
    return this.context
  }

  read(url) {
    const context = this.syncContext()
    const ref = context?.teamId && parseGithubPrUrl(url)
    if (!ref) return null
    if (this.expires > this.now()) return this.entries.get(pullRequestKey(ref)) ?? null
    if (!this.timer && !this.run) this.timer = setTimeout(() => { this.timer = null; void this.flush() }, 0)
    return null
  }

  async flush() {
    const context = this.syncContext()
    if (!context?.teamId || this.run || this.expires > this.now()) return
    const controller = this.run = new AbortController()
    let results
    try { results = await this.fetchWorkspace(context.teamId, controller.signal) }
    catch { results = null }
    this.syncContext()
    if (this.run !== controller || controller.signal.aborted) return
    this.entries.clear()
    for (const result of Array.isArray(results) ? results : []) {
      const ref = parseGithubPrUrl(result?.url)
      if (ref && typeof result.title === 'string' && ['open', 'draft', 'closed', 'merged'].includes(result.status)) {
        this.entries.set(pullRequestKey(ref), { title: result.title, status: result.status })
      }
    }
    this.expires = this.now() + 60_000
    this.run = null
    this.changed()
  }
}
