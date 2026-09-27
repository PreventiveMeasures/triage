// One memory-only catalog for the active account/mode. Navigation reuses it;
// feed versions confirm unchanged snapshots or trigger a fresh read. Requests
// still belong to their view/feed, so stopped reads cannot replace newer data.
function summaryExpiry(teams) {
  let expiresAt = Infinity
  const pendingExpiry = Date.now() + 5_000
  for (const team of teams) {
    for (const bundle of team.bundles ?? []) {
      if (['stasis', 'sourcemap'].includes(bundle.kind) && bundle.summary == null) {
        expiresAt = Math.min(expiresAt, Math.max(pendingExpiry, bundle.summaryRetryAt ?? 0))
      }
    }
  }
  return expiresAt
}

export function createManagedTeamsProbe(probeTeams) {
  let active = null, cached = null, context = null
  return async ({ generation, session, signal, reuse = false, revision = null }) => {
    if (signal.aborted) return null
    const key = JSON.stringify([generation, session?.id, session?.role, session?.csrfToken])
    if (context !== key) {
      active?.controller.abort()
      active = null
      cached = null
      context = key
    }
    if (cached && Date.now() < cached.expiresAt && (reuse || revision !== null && revision === cached.revision)) return cached.teams
    // An invalidation arriving after a read began must not adopt its older
    // snapshot and consume the notification. Start a read after that event.
    if (!active || active.signal.aborted || revision !== null && active.revision !== revision) {
      active?.controller.abort()
      cached = null
      const controller = new AbortController()
      const owned = AbortSignal.any([signal, controller.signal])
      const refresh = { controller, signal: owned, promise: null, revision }
      active = refresh
      let receivedRevision = null
      refresh.promise = probeTeams({ fallback: null, signal: owned, onRevision: value => { receivedRevision = value } })
        .then(teams => {
          if (owned.aborted || context !== key) return null
          if (teams !== null) {
            // Counts can finish backfilling without changing access/content.
            // Pick up pending counts on later navigation, but respect the
            // server's retry deadline for failed/unavailable bundles.
            cached = { teams, revision: receivedRevision, expiresAt: summaryExpiry(teams) }
          }
          return teams
        })
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
