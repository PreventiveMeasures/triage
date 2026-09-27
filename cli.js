#!/usr/bin/env node
import './strip-types-loader.js'

// Load TypeScript only after the stripping hook is registered.
const { start } = await import('./server.ts')
await start()
