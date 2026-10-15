import { isManagedUiMode, state } from '#client/index.js'
import { currentViewGeneration, goHome } from './ingest.js'
import { ensureClientMode, navigateToAdminPage, renderSidebar } from './sidebar.js'
import { render } from './render.js'
import { SCAN_ICON_SVG } from './icons.js'
import { availableScanServer } from '../scan/availability.js'
import { loadScanPage } from './scan-load.js'
import { showToast } from './toast.js'

// Navigation and the configured service belong to the local/E2E host, not
// the reusable scan component (which also lives inside Manage).
export function currentScanServer() {
  return availableScanServer({
    hostname: window.location.hostname,
    devServer: document.querySelector('meta[name="deepview-scan-server"]')?.content,
    serverMode: state.serverMode, localMode: state.localMode, deepviewScanServer: state.deepviewScanServer,
  })
}

export function canScanBundle(entry) {
  return isManagedUiMode()
    ? Boolean(entry.managedId) && ['admin', 'manage'].includes(state.managedSession?.role)
    : !entry.managedId && Boolean(currentScanServer())
}

// `mode` preselects a bundle scan mode ('dependencies' from the Advisories
// tab); omitted, scan setup opens on its default Code mode.
export async function openScan(entry = null, { mode } = {}) {
  const workspaceId = state.selectedBundleWorkspace
  const initialGeneration = currentViewGeneration()
  await ensureClientMode()
  if (initialGeneration !== currentViewGeneration()) return
  if (entry && !canScanBundle(entry)) return
  if (isManagedUiMode()) {
    if (entry) await navigateToAdminPage('manage-scans', { bundleId: entry.managedId, ...(mode ? { scanMode: mode } : {}) })
    return
  }
  if (!currentScanServer()) return
  // `<local-scan-page>` comes with Scans' own bundle, loaded before leaving
  // the view, so one that doesn't load leaves the view as it was.
  const loaded = await loadScanPage().then(() => true, () => false)
  if (!currentScanServer() || initialGeneration !== currentViewGeneration()) return
  if (!loaded) { showToast('Couldn’t load Scans. Try again.', { kind: 'warning' }); return }
  const home = goHome()
  const generation = currentViewGeneration()
  await home
  if (!currentScanServer() || generation !== currentViewGeneration()) return
  state.scanSelection = entry ? { bundleId: entry.integrity, ...(workspaceId ? { repoId: workspaceId } : {}), ...(mode ? { mode } : {}) } : null
  state.currentView = 'scan'
  render()
  void renderSidebar()
}

export function refreshScanNavigation() {
  const landing = document.querySelector('#drop-zone')
  if (!landing) return
  let button = landing.querySelector('.local-scan-button')
  if (!button) {
    button = document.createElement('button')
    button.type = 'button'
    button.className = 'local-scan-button'
    button.innerHTML = `${SCAN_ICON_SVG}<span>Scan</span>`
    button.addEventListener('click', () => void openScan())
    landing.append(button)
  }
  const server = currentScanServer()
  button.hidden = !server
  document.querySelector('local-scan-page')?.setScanServer(server)
  const bundleButton = document.querySelector('.bundles-scan-button')
  const entry = state.bundles?.find(bundle => bundle.integrity === state.selectedBundle)
  if (bundleButton) bundleButton.hidden = !entry || !canScanBundle(entry)
}
