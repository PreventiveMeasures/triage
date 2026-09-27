// Coalesce catalog reads only while their owning view/feed is alive. A new
// navigation must not inherit an aborted request, even before it settles.
export function createManagedTeamsProbe(probeTeams) {
  let active = null
  return async ({ generation, session, signal }) => {
    if (signal.aborted) return null
    const key = JSON.stringify([generation, session?.id, session?.role])
    if (!active || active.key !== key || active.signal.aborted) {
      active?.controller.abort()
      const controller = new AbortController()
      const owned = AbortSignal.any([signal, controller.signal])
      const refresh = { key, controller, signal: owned, promise: null }
      active = refresh
      refresh.promise = probeTeams({ fallback: null, signal: owned })
        .then(teams => owned.aborted ? null : teams)
        .finally(() => { if (active === refresh) active = null })
    }
    const refresh = active
    // A feed may join a view-owned read. Its watchdog must cancel the shared
    // request too, or awaiting that older promise would still block reconnects.
    const abort = () => refresh.controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      const teams = await refresh.promise
      return signal.aborted || refresh.signal.aborted ? null : teams
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}
