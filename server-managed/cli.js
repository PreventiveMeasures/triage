#!/usr/bin/env node
// Executable entry for the managed-server bin. See server-e2e/cli.js for the
// full rationale: Node refuses to strip TypeScript types from files under
// node_modules, so once this package is installed as a dependency
// server-managed/index.ts can't be executed directly. Register the in-thread
// type-stripping hook FIRST, then load the server via a dynamic import (a
// static import would be fetched before the hook is active) and start it.
//
// Imported here rather than run as the process entry, so index.ts's
// `import.meta.main` auto-start gate stays off and we call `start()` ourselves.
import '../strip-types-loader.js'
const { start } = await import('./index.ts')
start()
