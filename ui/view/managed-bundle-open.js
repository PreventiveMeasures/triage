import { isManagedUiMode, state } from '#client/index.js'
import { compareModeOf } from '../../common/managed/routes.js'
import { fetchBundleMetadata } from './client-managed.js'
import { parseBundleMetadata } from './bundle-metadata.js'
import { selectBundle, takeHandedOffBundle } from './bundle-load.js'
import { bundleComparisonCandidates } from './bundle-comparison-candidates.js'
import { cleanupGraph2 } from './graph/state.js'
import { render } from './render.js'
import { showToast } from './toast.js'
import { currentViewGeneration, currentViewSignal } from './view-navigation.js'

// The catalogue entry already names, places, sizes and dates a bundle, so
// it shows at once; its files follow with the metadata. That arrives for as
// long as the bundle stays shown, even after a tab change takes over the
// navigation; only the navigation still current commits the bundle's URL.
export async function openManagedBundle({ bundleId: id, teamId, bundleTab: tab, file, line, endLine, compareId, compareMode }, entries, isCurrent, renderSidebar) {
  const entry = entries.find(bundle => bundle.managedId === id)
  if (!entry || !isCurrent() || !isManagedUiMode()) return false
  const handed = takeHandedOffBundle(entry.integrity, details => details.managedId === id)
  // Reopening the bundle shown, as Back to another of its tabs, keeps its
  // details on screen until the metadata replaces them.
  const kept = state.bundleDetails?.managedId === id && state.bundleDetails.integrity === entry.integrity && !state.bundleDetails.error ? state.bundleDetails : null
  try {
    state.bundles = entries
    cleanupGraph2()
    selectBundle(entry.integrity, tab)
    if (tab === 'code' && file != null) {
      state.bundleCodeFileRequest = { bundle: entry.integrity, file, ...(line == null ? {} : { line }), ...(endLine == null ? {} : { endLine }) }
    }
    // A Compare link's bundle, when Compare would offer it.
    const compared = tab === 'compare' && compareId != null
      ? bundleComparisonCandidates(entries, entry.integrity).find(bundle => bundle.managedId === compareId) : null
    if (compared) state.bundleCompare = { bundle: entry.integrity, target: compared.integrity, mode: compareModeOf(compareMode) }
    state.bundleDetails = handed ?? kept
    state.currentManagedTeam = teamId
    state.currentManagedReport = null
    state.reports = []
    document.body.classList.remove('report-fullscreen')
    render({ animate: false })
    renderSidebar()
    document.querySelector('#main-content')?.scrollTo({ top: 0 })
  } catch (err) {
    if (isCurrent() && err.name !== 'AbortError') showToast(`Couldn't open bundle: ${err.message}`, { kind: 'error' })
    return false
  }
  const early = state.bundleDetails
  // A catalogue refresh replaces the entries, and can rehome the bundle.
  const shown = () => isManagedUiMode() && state.currentView === 'bundles' && state.selectedBundle === entry.integrity
    && state.bundles.some(bundle => bundle.managedId === id && bundle.integrity === entry.integrity) && state.bundleDetails === early
  // A failed open lands on the home page; a bundle shown by a later
  // navigation, as one of its tabs, says why it has no files instead.
  const failed = (err, toast) => {
    if (err?.name === 'AbortError') return false
    if (isCurrent()) {
      if (toast) showToast(`Couldn't open bundle: ${err.message}`, { kind: 'error' })
    } else if (shown()) {
      state.bundleDetails = { integrity: entry.integrity, kind: entry.kind, size: entry.size, managedId: id, error: err.message }
      render()
    }
    return false
  }
  const generation = currentViewGeneration()
  let metadata
  for (;;) {
    const signal = currentViewSignal()
    try { metadata = await fetchBundleMetadata(id, { signal }); break }
    catch (err) {
      // Leaving a source tab stops its downloads, this read among them.
      if (err?.name === 'AbortError' && signal.aborted && shown()) continue
      return failed(err, false) // The managed state reports request errors.
    }
  }
  try {
    if (metadata.integrity !== entry.integrity) throw new Error('the metadata is for another version of this bundle')
    if (shown()) {
      const indexed = parseBundleMetadata(metadata, metadata.integrity)
      // Compare's swap hands over the bundle it opens, already parsed in full;
      // the metadata lends it the hashes, sizes and sourcemap edges the server
      // indexed, as a metadata open's sources upgrade (ensureBundleSources) does.
      const details = handed?.integrity === indexed.integrity
        ? Object.assign(handed, { fileHashes: indexed.fileHashes, fileSizes: indexed.fileSizes, lineCounts: indexed.lineCounts, codeStats: indexed.codeStats },
          indexed.edges ? { edges: indexed.edges } : {})
        : indexed
      details.managedId = id
      state.bundleDetails = details
      render({ animate: false })
    }
    return isCurrent() && generation === currentViewGeneration() && state.bundleDetails?.managedId === id && state.selectedBundle === entry.integrity
  } catch (err) { return failed(err, true) }
}
