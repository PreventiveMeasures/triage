// Manage data survives custom-element teardown, but never leaves memory. The
// session boundary is owned by the host, including while no Manage page is open.
export class ManagedAppState {
  constructor(notify = () => {}) {
    this.resources = new Map()
    this.session = null
    this.teamCatalog = null
    this.reportCatalog = null
    this.bundleCatalog = null
    this.generation = 0
    this.sessionController = new AbortController()
    this.notify = notify
  }

  setSession(session) {
    if (this.session?.id !== session?.id || this.session?.role !== session?.role) this.reset()
    this.session = session
  }

  reset() {
    this.generation++
    this.sessionController.abort()
    this.sessionController = new AbortController()
    this.invalidate()
    this.session = null
    this.teamCatalog = null
    this.reportCatalog = null
    this.bundleCatalog = null
  }

  // Each team owns one filtered workspace response. Any report/link or grant
  // change invalidates that response, plus affected privileged report previews.
  // Bundle assignments also change which sources its reports can expose.
  setReportCatalog(teams) {
    const changedTeams = new Set()
    const teamCatalog = new Map(teams.map(team => [team.id, JSON.stringify([
      team.cacheKey ?? null,
      team.reports.map(report => [report.id, report.cacheKey ?? null, report.visible !== false]).toSorted(),
      (team.bundles ?? []).map(bundle => [bundle.id, bundle.filename, bundle.repoFullName, bundle.repoDirectory ?? '']).toSorted(),
    ])]))
    for (const id of new Set([...this.teamCatalog?.keys() ?? [], ...teamCatalog.keys()])) {
      if (this.teamCatalog?.get(id) !== teamCatalog.get(id)) changedTeams.add(`team:${id}`)
    }
    for (const key of this.resources.keys()) {
      const prefix = 'reports:content:team:'
      if (key.startsWith(prefix)) {
        const [teamId] = key.slice(prefix.length).split(':')
        if (!teamCatalog.has(teamId) || this.teamCatalog?.get(teamId) !== teamCatalog.get(teamId)) this.invalidate([key])
      }
    }
    this.teamCatalog = teamCatalog
    const grouped = new Map()
    for (const team of teams) {
      for (const report of team.reports) {
        const keys = grouped.get(report.id) ?? []
        keys.push(JSON.stringify([team.id, report.cacheKey ?? null]))
        grouped.set(report.id, keys)
      }
    }
    const next = new Map([...grouped].map(([id, keys]) => [id, JSON.stringify(keys.toSorted())]))
    const previous = this.reportCatalog
    this.reportCatalog = next
    const changed = new Set(changedTeams)
    for (const id of new Set([...previous?.keys() ?? [], ...next.keys()])) {
      if (previous?.get(id) !== next.get(id)) changed.add(id)
    }
    for (const key of this.resources.keys()) {
      if (!key.startsWith('reports:content:') || key.startsWith('reports:content:team:')) continue
      const id = key.slice('reports:content:'.length)
      if (!next.has(id) || changed.has(id)) {
        this.invalidate([key])
        changed.add(id)
      }
    }
    const bundles = new Map()
    for (const team of teams) {
      for (const bundle of team.bundles ?? []) {
        const keys = bundles.get(bundle.id) ?? []
        keys.push(JSON.stringify([team.id, team.cacheKey ?? null, bundle.filename, bundle.repoFullName, bundle.repoDirectory ?? '']))
        bundles.set(bundle.id, keys)
      }
    }
    let bundlesChanged = false
    const bundleCatalog = new Map([...bundles].map(([id, keys]) => [id, JSON.stringify(keys.toSorted())]))
    for (const id of new Set([...this.bundleCatalog?.keys() ?? [], ...bundleCatalog.keys()])) {
      if (this.bundleCatalog?.get(id) === bundleCatalog.get(id)) continue
      bundlesChanged = true
      changed.add(`bundle:${id}`)
      this.invalidate([`bundle-metadata:${id}`])
    }
    this.bundleCatalog = bundleCatalog
    for (const key of this.resources.keys()) {
      if (!key.startsWith('report-sources:') && !key.startsWith('finding-history:')) continue
      const [, teamId, reportId] = key.split(':')
      // Includes cached 204/404s and errors as well as successful source reads.
      // A privileged preview has no team scope, so any bundle change can
      // affect its sources. Team views need only their own catalog changes.
      if (teamId ? changedTeams.has(`team:${teamId}`) : bundlesChanged || changed.has(reportId)) this.invalidate([key])
    }
    return changed
  }

  read(key) { return this.resources.get(key)?.data }

  // Writes invalidate related collections and cancel their older reads before
  // the page reloads them. Unrelated cached pages remain ready to render.
  invalidate(families) {
    for (const [key, entry] of this.resources) {
      if (families && !families.some(family => key === family || key.startsWith(`${family}:`))) continue
      entry.controller?.abort()
      this.resources.delete(key)
    }
  }

  async mutate(work, families) {
    const generation = this.generation
    let result
    try { result = await work() } catch (err) {
      if (generation === this.generation && err?.name !== 'AbortError') this.notify(`Couldn't save changes: ${err?.message ?? err}`)
      throw err
    }
    if (generation !== this.generation) throw new DOMException('Managed session changed', 'AbortError')
    this.invalidate(families)
    return result
  }

  // An element's cancellation only stops its own updates. Shared requests can
  // finish after navigation and populate the cache for the next visit.
  async load(key, label, fetchData, { signal, apply = () => {}, retryInvalidated = false } = {}) {
    const generation = this.generation
    while (true) {
      signal?.throwIfAborted()
      let entry = this.resources.get(key)
      if (!entry) {
        entry = {}
        this.resources.set(key, entry)
      }
      if (entry.data !== undefined) apply(entry.data)
      if (!entry.pending) {
        const controller = entry.controller = new AbortController()
        entry.pending = (async () => {
          try {
            const data = await fetchData(controller.signal)
            controller.signal.throwIfAborted()
            entry.data = data
            return data
          } catch (err) {
            if (!controller.signal.aborted && err?.name !== 'AbortError') {
              this.notify(`Couldn't refresh ${label}: ${err?.message ?? err}`)
            }
            throw err
          }
        })().finally(() => { entry.pending = null })
      }
      try {
        const data = await entry.pending
        signal?.throwIfAborted()
        if (this.resources.get(key) !== entry) throw new DOMException('Managed data changed', 'AbortError')
        apply(data)
        return data
      } catch (err) {
        // Immutable bundle metadata can restart against current authorization
        // when a catalogue update cancels its cache entry during navigation.
        if (!retryInvalidated || err?.name !== 'AbortError' || signal?.aborted
          || generation !== this.generation || this.resources.get(key) === entry) throw err
      }
    }
  }
}

export const managedAppState = new ManagedAppState(message => {
  document.dispatchEvent(new CustomEvent('managed-notice', { detail: { message } }))
})

export function setManagedAppSession(session) { managedAppState.setSession(session) }
export function setManagedReportCatalog(teams) { return managedAppState.setReportCatalog(teams) }
export function resetManagedAppState() { managedAppState.reset() }
