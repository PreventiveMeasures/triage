import { githubFixKey, githubIssueClosedReason, parseGithubFixUrl } from '../../common/github-pr.ts'

function workspaceScope(context) {
  const team = context?.teams?.find(candidate => candidate.id === context.teamId)
  if (!team) return null
  // These server versions cover grants, reports, links and repository scope.
  // A catalog refresh or rename alone must not discard authorized metadata.
  // Older/unversioned catalogs conservatively revalidate on every refresh.
  if (!team.cacheKey || !Array.isArray(team.reports) || team.reports.some(report => !report.cacheKey)) return context.teams
  return JSON.stringify([team.cacheKey, team.reports.map(report => [report.id, report.cacheKey, report.visible !== false]).toSorted()])
}

// One in-memory response per active workspace/session. A rendered URL is only
// a local lookup key; it never becomes input to the server or GitHub request.
export class FixCache {
  constructor({ context, fetchWorkspace, changed = () => {}, now = Date.now }) {
    this.getContext = context
    this.fetchWorkspace = fetchWorkspace
    this.changed = changed
    this.now = now
    this.entries = new Map()
    this.required = new Set()
    this.expires = 0
    this.context = null
    this.scope = null
    this.timer = null
    this.run = null
  }

  reset() {
    this.run?.abort()
    this.run = null
    clearTimeout(this.timer)
    this.timer = null
    this.entries.clear()
    this.required.clear()
    this.expires = 0
    this.context = null
    this.scope = null
  }

  syncContext() {
    const next = this.getContext()
    if (next?.key !== this.context?.key || next?.teamId !== this.context?.teamId || next?.reportId !== this.context?.reportId || next?.teams !== this.context?.teams) {
      const scope = workspaceScope(next)
      if (next?.key !== this.context?.key || next?.teamId !== this.context?.teamId || next?.reportId !== this.context?.reportId || scope !== this.scope) this.reset()
      this.context = next
      this.scope = scope
    }
    return this.scope === null ? null : this.context
  }

  schedule() {
    if (!this.timer && !this.run) this.timer = setTimeout(() => { this.timer = null; void this.flush() }, 0)
  }

  read(url, { refreshIfMissing = false } = {}) {
    const context = this.syncContext()
    const ref = context?.teamId && parseGithubFixUrl(url)
    if (!ref) return null
    const key = githubFixKey(ref), result = this.entries.get(key) ?? null
    // A new annotation can introduce a URL after the cached batch was read.
    // Ordinary renders keep the TTL for unavailable links; only a changed
    // annotation asks for missing metadata. Let an in-flight batch try first.
    if (refreshIfMissing && !result) {
      if (this.run) this.required.add(key)
      else this.expires = 0
    }
    if (this.expires <= this.now()) this.schedule()
    return result
  }

  async flush() {
    const context = this.syncContext()
    if (!context?.teamId || this.run || this.expires > this.now()) return
    const controller = this.run = new AbortController()
    let results
    try { results = await this.fetchWorkspace(context.teamId, controller.signal, context.reportId) }
    catch { results = null }
    this.syncContext()
    if (this.run !== controller || controller.signal.aborted) return
    this.entries.clear()
    for (const result of Array.isArray(results) ? results : []) {
      const ref = parseGithubFixUrl(result?.url)
      if (ref && typeof result.title === 'string' && ['open', 'draft', 'closed', 'merged'].includes(result.status)) {
        const stateReason = ref.kind === 'issue' && result.status === 'closed' ? githubIssueClosedReason(result.stateReason) : null
        this.entries.set(githubFixKey(ref), { title: result.title, description: typeof result.description === 'string' ? result.description : null, status: result.status, stateReason })
      }
    }
    this.expires = this.now() + 60_000
    this.run = null
    const missing = [...this.required].some(key => !this.entries.has(key))
    this.required.clear()
    if (missing) { this.expires = 0; this.schedule() }
    this.changed()
  }
}
