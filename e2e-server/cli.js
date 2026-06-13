#!/usr/bin/env node
// Executable entry for the `triage-server` bin.
//
// Node refuses to strip TypeScript types from files under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so once this package is
// installed as a dependency, e2e-server/index.ts can't be executed directly.
// This launcher registers the built-in-type-stripping hook FIRST
// (synchronous, in-thread — see ../strip-types-loader.js), then loads the
// server with the hook active and starts it.
//
// The `await import()` is load-bearing: a static `import './index.ts'`
// would be fetched during this module's instantiation — before the body
// runs and before the hook is registered — and would hit the node_modules
// strip error. Deferring to a dynamic import runs it only after the static
// `../strip-types-loader.js` import has evaluated and registered the hook.
//
// Because the server is imported here (not the process entry), its
// `import.meta.main` auto-start gate stays off, so we call the exported
// `start()` ourselves.
import '../strip-types-loader.js'
const { start } = await import('./index.ts')
start()
