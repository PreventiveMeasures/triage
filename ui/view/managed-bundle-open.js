import { isManagedUiMode, state } from '#client/index.js'
import { fetchBundleMetadata } from './client-managed.js'
import { parseBundleMetadata } from './bundle-metadata.js'
import { selectBundle } from './bundle-load.js'
import { cleanupGraph2 } from './graph/state.js'
import { render } from './render.js'
import { showToast } from './toast.js'
import { currentViewGeneration, currentViewSignal } from './view-navigation.js'

export async function openManagedBundle({ bundleId: id, teamId, bundleTab: tab, file }, entries, isCurrent, renderSidebar) {
  const generation = currentViewGeneration()
  let metadata
  try { metadata = await fetchBundleMetadata(id, { signal: currentViewSignal() }) } catch { return false } // The managed state reports request errors.
  try {
    if (!isCurrent() || generation !== currentViewGeneration() || !isManagedUiMode()) return false
    const details = parseBundleMetadata(metadata, metadata.integrity)
    details.managedId = id
    const entry = entries.find(bundle => bundle.managedId === id)
    if (!entry || entry.integrity !== metadata.integrity) return false
    state.bundles = entries
    cleanupGraph2()
    selectBundle(entry.integrity, tab)
    if (tab === 'code' && file != null) state.bundleCodeFileRequest = { bundle: entry.integrity, file }
    state.bundleDetails = details
    state.currentManagedTeam = teamId
    state.currentManagedReport = null
    state.reports = []
    document.body.classList.remove('report-fullscreen')
    render({ animate: false })
    renderSidebar()
    document.querySelector('#main-content')?.scrollTo({ top: 0 })
    return true
  } catch (err) {
    if (isCurrent() && err.name !== 'AbortError') showToast(`Couldn't open bundle: ${err.message}`, { kind: 'error' })
    return false
  }
}
