// Compatibility entry point for the published e2e server. Importing exposes
// one unbound instance; the combined launcher uses the factory directly.
import { startServer } from '../server-common/standalone.ts'
import { createE2eApp } from './app.ts'
import { HELP, loadConfig } from './config.ts'

if (import.meta.main && (process.argv.includes('--help') || process.argv.includes('-h'))) {
  console.log(HELP)
  process.exit(0)
}

const config = loadConfig()
export const { httpServer, wss, isShuttingDown, reap, handleRequest, onShutdown } = await createE2eApp(config)

export function start(): void { startServer(httpServer, config) }

if (import.meta.main) start()
