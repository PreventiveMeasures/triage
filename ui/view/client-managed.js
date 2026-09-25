// Lazy proxy for managed API calls and Manage custom elements.
// Mirrors view/client-sync.js: the heavy module is dynamically imported via a
// variable path so esbuild keeps it — and any future managed payload — out of
// the main view bundle. The browser resolves the path against the page URL.
import { managedHistory } from './managed-history.js'

let loadPromise = null
let managedModule = null

// Synchronous reads/reset never load the chunk on an E2E or standalone visit.
export function getPreviewRole() { return managedModule?.getPreviewRole() ?? null }
export function clearPreviewRole() { managedModule?.setPreviewRole(null) }
export function resetManagedAppState() { managedModule?.resetManagedAppState() }
export function setManagedAppSession(session) { managedModule?.setManagedAppSession(session) }
export function readReportSources(id) { return managedModule?.readReportSources(id) }
export function clearReportSources() { managedModule?.clearReportSources() }
export async function fetchReportSources(id) { return (await loadManagedBundle()).fetchReportSources(id) }

export function loadManagedBundle() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const path = './client-managed.js'
    try {
      managedModule = await import(path)
      return managedModule
    } catch (err) {
      // Don't pin a rejected promise — a transient failure would replay
      // forever; reset so the next call retries from scratch.
      loadPromise = null
      throw err
    }
  })()
  return loadPromise
}

export async function probeSession(options) {
  return (await loadManagedBundle()).probeSession(options)
}

export async function probeTeams(options) {
  return (await loadManagedBundle()).probeTeams(options)
}

export async function fetchReport(id) {
  return (await loadManagedBundle()).fetchReport(id)
}

export async function fetchReportTriage(id) {
  return (await loadManagedBundle()).fetchReportTriage(id)
}

export async function fetchPullRequests(urls, csrfToken, signal) {
  return (await loadManagedBundle()).fetchPullRequests(urls, csrfToken, signal)
}

export async function fetchReportComments(id) {
  return (await loadManagedBundle()).fetchReportComments(id)
}

export async function saveReportComment(reportId, entry, csrfToken) {
  return (await loadManagedBundle()).saveReportComment(reportId, entry, csrfToken)
}

export async function deleteReportComment(reportId, commentId, version, csrfToken) {
  return (await loadManagedBundle()).deleteReportComment(reportId, commentId, version, csrfToken)
}

export async function pushReportTriage(id, entries, csrfToken) {
  return (await loadManagedBundle()).pushReportTriage(id, entries, csrfToken)
}

export async function login(loginPath) {
  if (loginPath) managedHistory?.rememberFinding()
  return (await loadManagedBundle()).login(loginPath)
}

export async function logout(csrfToken) {
  return (await loadManagedBundle()).logout(csrfToken)
}

export async function fetchBundleMetadata(id) {
  return (await loadManagedBundle()).fetchBundleMetadata(id)
}

export async function fetchBundleContents(id, options) {
  return (await loadManagedBundle()).fetchBundleContents(id, options)
}
