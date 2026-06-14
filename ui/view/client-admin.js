// Lazy proxy for the managed admin UI bundle. Mirrors view/client-managed.js:
// the chunk is dynamically imported via a variable path so esbuild keeps it out
// of the main view bundle, and it's only ever loaded when a privileged user
// invokes one of its pages from the sidebar account menu. Importing the chunk
// defines the <managed-admin-users> (admin) and <managed-admin-repos>
// (admin|manage) custom elements that render.js paints for the 'admin-users' /
// 'manage-repos' views. Both entry points share one chunk load.
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
export function loadAdminReposBundle() { return loadAdminOnce() }
