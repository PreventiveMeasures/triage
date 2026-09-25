// Lazy managed-client entry: authenticated API calls and Manage custom elements.
// The runtime import in view/client-managed.js keeps this entire surface out of
// view.js. It loads when a managed session or page is first requested.
import './managed/pages.js'
export * from '../client/managed/session.js'
export { getPreviewRole, setPreviewRole } from '../client/managed/request.js'
export { resetManagedAppState, setManagedAppSession } from './managed/state.js'
