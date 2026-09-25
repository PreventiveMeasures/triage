import { MAX_PULL_REQUESTS, parseGithubPrUrl, pullRequestKey } from '../../common/github-pr.ts'

// In-memory, per-session metadata. Reads in the same render turn coalesce into
// batches; failed lookups also get a short TTL instead of retrying per card.
export class PullRequestCache {
  constructor({ context, fetchBatch, changed = () => {}, now = Date.now }) {
    this.getContext = context
    this.fetchBatch = fetchBatch
    this.changed = changed
    this.now = now
    this.entries = new Map()
    this.queue = new Map()
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
    this.queue.clear()
    this.context = null
  }

  syncContext() {
    const next = this.getContext()
    if (next?.key !== this.context?.key || next?.teams !== this.context?.teams) {
      this.reset()
      this.context = next
    }
    return this.context
  }

  read(url) {
    const context = this.syncContext()
    const ref = context && parseGithubPrUrl(url)
    if (!ref) return null
    const key = pullRequestKey(ref)
    const entry = this.entries.get(key)
    if (entry && entry.expires > this.now()) return entry.value
    this.entries.set(key, { value: null, expires: Infinity })
    this.queue.set(key, url)
    if (!this.timer && !this.run) this.timer = setTimeout(() => { this.timer = null; void this.flush() }, 0)
    return null
  }

  async flush() {
    const context = this.syncContext()
    if (!context || this.run || this.queue.size === 0) return
    const controller = this.run = new AbortController()
    while (this.queue.size > 0) {
      const batch = [...this.queue.entries()].slice(0, MAX_PULL_REQUESTS)
      for (const [key] of batch) this.queue.delete(key)
      let results
      try { results = await this.fetchBatch(batch.map(([, url]) => url), context.csrfToken, controller.signal) }
      catch { results = null }
      this.syncContext()
      if (this.run !== controller || controller.signal.aborted) return
      const byUrl = new Map((Array.isArray(results) ? results : []).map(result => [result?.url, result]))
      for (const [key, url] of batch) {
        const result = byUrl.get(url)
        const value = typeof result?.title === 'string' && ['open', 'draft', 'closed', 'merged'].includes(result.status)
          ? { title: result.title, status: result.status } : null
        this.entries.set(key, { value, expires: this.now() + 60_000 })
      }
      this.changed()
    }
    if (this.run === controller) this.run = null
  }
}
