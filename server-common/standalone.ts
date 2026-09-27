import type { Server } from 'node:http'

// Only CLI entry points own process signals and termination. Embedded servers
// expose async disposal and error events to their host instead.
export function startServer(server: Server, config: { port: number; host: string }): void {
  let shuttingDown = false
  let exitCode = 0
  function shutdown(code: number): void {
    if (code !== 0) exitCode = code
    if (shuttingDown) return
    shuttingDown = true
    console.log('Shutting down…')
    void server[Symbol.asyncDispose]().catch(err => {
      console.error('Shutdown failed:', err)
      exitCode = 1
    }).finally(() => process.exit(exitCode))
  }
  function onSignal(): void { shutdown(0) }
  function onError(err: unknown): void {
    console.error('Server error:', err)
    shutdown(1)
  }
  server.on('error', onError)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  process.on('unhandledRejection', onError)
  process.on('uncaughtException', onError)
  server.listen(config.port, config.host)
}
