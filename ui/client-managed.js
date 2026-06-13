// Esbuild entry point for the managed-mode client surface. Mirrors
// client-sync.js: this file becomes its own output bundle, dynamically
// imported by view/client-managed.js on first use so the managed-only code
// stays out of the main view.js bundle.
export * from '../client/managed/session.js'
