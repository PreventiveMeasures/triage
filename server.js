#!/usr/bin/env node
import { parseArgs } from 'node:util'
import './strip-types-loader.js'

const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'e2e' },
  help: { type: 'boolean', short: 'h' },
} })
const modes = ['e2e', 'managed', 'managed-e2e', 'e2e-managed']
if (!modes.includes(values.mode)) throw new Error(`Unknown mode: ${values.mode}. Expected ${modes.join(', ')}.`)
if (values.help) {
  console.log(`Usage: node server.js --mode <${modes.join('|')}>
Defaults to e2e. Combined modes share HOST/PORT; the first mode is the client default.
Managed modes require GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and OAUTH_CALLBACK_URL.
Combined storage: DB_PATH for e2e, MANAGED_DB_PATH for managed.`)
} else if (values.mode === 'e2e') {
  const { start } = await import('./server-e2e/index.ts')
  start()
} else if (values.mode === 'managed') {
  const { start } = await import('./server-managed/index.ts')
  await start()
} else {
  const { start } = await import('./server-managed/combined.ts')
  await start(values.mode === 'managed-e2e' ? 'managed+e2e' : 'e2e+managed')
}
