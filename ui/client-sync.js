// Esbuild entry point for the sync surface. Mirrors the prism /
// terminal / brotli-fallback pattern: this file becomes its own
// output bundle, dynamically imported by `view/client-sync.js` on
// first use so the websocket transport + crypto + persistence
// machinery stays out of the main `view.js` bundle.
//
// Re-exports everything `#client/sync.js` exports;
// `view/client-sync.js` wraps these in a UI-facing surface that
// defers to this module once loaded.

export * from '#client/sync.js'
