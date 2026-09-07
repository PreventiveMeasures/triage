// Lazy proxy for the managed admin UI bundle. Mirrors view/client-managed.js:
// the chunk is dynamically imported via a variable path so esbuild keeps it out
// of the main view bundle, and it's only ever loaded when a privileged user
// invokes one of its pages from the sidebar account menu. Importing the chunk
// defines the <managed-admin-users> (admin), <managed-admin-repos>,
// <managed-admin-reports>, <managed-admin-bundles> and <managed-admin-teams>
// (all admin|manage) custom elements that render.js paints for the
// 'admin-users' / 'manage-repos' / 'manage-reports' / 'manage-bundles' /
// 'manage-teams' views. All entry points share one chunk load.
let loadPromise = null

export function loadAdminBundle() {
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
