// Esbuild entry point for the sync surface. Mirrors the prism /
// terminal / brotli-fallback pattern: this file becomes its own
// output bundle, dynamically imported by `view/client-sync.js` on
// first use so the websocket transport + crypto + persistence
// machinery doesn't land in the main `view.js` bundle.
//
// The bundle exposes everything `#client/sync.js` exports —
// `view/client-sync.js` re-exports a UI-facing surface that defers
// to this module once it's loaded.

export * from '#client/sync.js'
