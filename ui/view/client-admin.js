// Lazy proxy for the managed admin UI bundle. Mirrors view/client-managed.js:
// the chunk is dynamically imported via a variable path so esbuild keeps it out
// of the main view bundle, and it's only ever loaded when an admin invokes it
// (the sidebar "Manage users" row, shown only when state.managedSession.isAdmin).
// Importing the chunk defines the <managed-admin-users> custom element that
// render.js paints for the 'admin-users' view.
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

export function loadAdminUsersBundle() { return loadAdminOnce() }
