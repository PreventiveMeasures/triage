// Lazy proxy for the managed admin UI bundle. Mirrors view/client-managed.js:
// the chunk is dynamically imported via a variable path so esbuild keeps it out
// of the main view bundle, and it's only ever loaded when an admin invokes it
// (the sidebar "Manage users" row, shown only when state.managedSession.isAdmin).
let loadPromise = null

function loadAdminOnce() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const path = './client-admin.js'
    try {
      return await import(path)
    } catch (err) {
      loadPromise = null
      throw err
    }
  })()
  return loadPromise
}

export async function openAdminUsers() {
  return (await loadAdminOnce()).openAdminUsers()
}
