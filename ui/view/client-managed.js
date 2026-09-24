// Lazy proxy for managed API calls and Manage custom elements.
// Mirrors view/client-sync.js: the heavy module is dynamically imported via a
// variable path so esbuild keeps it — and any future managed payload — out of
// the main view bundle. The browser resolves the path against the page URL.
let loadPromise = null

export function loadManagedBundle() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const path = './client-managed.js'
    try {
      return await import(path)
    } catch (err) {
      // Don't pin a rejected promise — a transient failure would replay
      // forever; reset so the next call retries from scratch.
      loadPromise = null
      throw err
    }
  })()
  return loadPromise
}

export async function probeSession() {
  return (await loadManagedBundle()).probeSession()
}

export async function probeTeams() {
  return (await loadManagedBundle()).probeTeams()
}

export async function fetchReport(id) {
  return (await loadManagedBundle()).fetchReport(id)
}

export async function fetchReportTriage(id) {
  return (await loadManagedBundle()).fetchReportTriage(id)
}

export async function pushReportTriage(id, entries, csrfToken) {
  return (await loadManagedBundle()).pushReportTriage(id, entries, csrfToken)
}

export async function login(loginPath) {
  return (await loadManagedBundle()).login(loginPath)
}

export async function logout(csrfToken) {
  return (await loadManagedBundle()).logout(csrfToken)
}
