// The localStorage half of objstore-presence's tag→name cache, kept apart
// so readers outside the lazy sync bundle (the managed import preview)
// don't pull the sync client in with it.
const PRESENCE_CACHE_PREFIX = 'deepview.objstore-presence.'
export function presenceCacheKey(workspaceId) { return PRESENCE_CACHE_PREFIX + workspaceId }
export function loadPresenceCache(workspaceId) {
  try {
    const raw = localStorage.getItem(presenceCacheKey(workspaceId))
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    return {
      names: obj.names && typeof obj.names === 'object' ? obj.names : {},
      bundles: obj.bundles && typeof obj.bundles === 'object' ? obj.bundles : {},
      bundleNames: obj.bundleNames && typeof obj.bundleNames === 'object' ? obj.bundleNames : {},
      // `tag → baseline` for the local copy of each report (see
      // `entry.baselines`). Drives the boot-time divergence check: a
      // cloud copy that moved past the baseline while we were offline
      // (a Replace, or a delete + re-upload) must be re-fetched on
      // reconnect.
      baselines: parseBaselines(obj.baselines, obj.localVersions),
    }
  } catch { return null }
}
// Cache rows written before incarnations were tracked carry
// `localVersions: { tag: version }` — a synced baseline with no
// incarnation. Keep those as version-only baselines so an upgrade
// doesn't drop every existing baseline; the next reconcile of the tag
// upgrades it to a full one.
function parseBaselines(raw, legacy) {
  const out = {}
  if (legacy && typeof legacy === 'object') {
    for (const [tag, version] of Object.entries(legacy)) {
      if (Number.isSafeInteger(version) && version >= 0) out[tag] = { version, incarnation: null, synced: true, hash: null }
    }
  }
  if (raw && typeof raw === 'object') {
    for (const [tag, b] of Object.entries(raw)) {
      if (!b || typeof b !== 'object' || !Number.isSafeInteger(b.version) || b.version < 0) continue
      if (b.incarnation != null && typeof b.incarnation !== 'string') continue
      out[tag] = {
        version: b.version, incarnation: b.incarnation ?? null, synced: b.synced === true,
        hash: typeof b.hash === 'string' ? b.hash : null,
      }
    }
  }
  return out
}

// Import previews run without a sync session (managed mode never starts
// one), so they read the last-known presence; report bytes must match its hash.
export function localContentSyncStatus(workspaceId, kind, value, hash) {
  const cached = loadPresenceCache(workspaceId)
  const known = Object.entries((kind === 'bundle' ? cached?.bundles : cached?.names) ?? {}).find(([, name]) => name === value)?.[0]
  const baseline = cached?.baselines?.[known]
  return { synced: known !== undefined && (kind === 'bundle' || baseline?.synced === true && baseline.hash === hash), cached: true }
}
