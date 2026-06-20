// Lazy proxy for the managed-mode client (auth now; managed features later).
// Mirrors view/client-sync.js: the heavy module is dynamically imported via a
// variable path so esbuild keeps it — and any future managed payload — out of
// the main view bundle. The browser resolves the path against the page URL.
let loadPromise = null

function loadManagedOnce() {
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
  return (await loadManagedOnce()).probeSession()
}

export async function probeTeams() {
  return (await loadManagedOnce()).probeTeams()
}

export async function login(loginPath) {
  return (await loadManagedOnce()).login(loginPath)
}

export async function logout(csrfToken) {
  return (await loadManagedOnce()).logout(csrfToken)
}
