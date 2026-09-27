// Per-instance request tracking and graceful disposal. Process shutdown belongs
// to the standalone launcher; embedded hosts retain their signals and errors.
import type { Server } from 'node:http'
import type { WebSocketServer } from 'ws'
import type { SseSession } from './sse-session.ts'

export type ShutdownDeps = {
  httpServer: Server
  wss: WebSocketServer
  heartbeatTimer: ReturnType<typeof setInterval>
  sseKeepaliveTimer: ReturnType<typeof setInterval>
  stopReaper: () => Promise<void>
  sseSessions: () => Iterable<SseSession>
  closeDb: () => Promise<void>
}

export type Lifecycle = {
  track: (promise: Promise<unknown>) => void
  isShuttingDown: () => boolean
  install: (deps: ShutdownDeps) => void
}

function closePeers({ wss, sseSessions }: ShutdownDeps): void {
  for (const peer of [...wss.clients, ...sseSessions()]) {
    try { peer.close(1001, 'Server shutting down') } catch {}
  }
}

function terminatePeers({ httpServer, wss, sseSessions }: ShutdownDeps): void {
  for (const peer of [...wss.clients, ...sseSessions()]) {
    if (peer.readyState === peer.OPEN || peer.readyState === peer.CLOSING) {
      try { peer.terminate() } catch {}
    }
  }
  httpServer.closeAllConnections()
}

async function drain(deps: ShutdownDeps, inFlight: Set<Promise<unknown>>): Promise<void> {
  const { httpServer, wss, stopReaper, closeDb } = deps
  // Bound unresponsive WS/SSE peers and HTTP keep-alives to a one-second
  // grace period. Also works when the listeners are mounted on another host.
  const terminateTimer = setTimeout(() => terminatePeers(deps), 1000)
  terminateTimer.unref()
  try {
    await stopReaper()
    httpServer.closeIdleConnections()
    if (httpServer.listening) {
      await new Promise<void>(resolve => { httpServer.close(() => resolve()) })
    }
    await new Promise<void>(resolve => { wss.close(() => resolve()) })
    if (inFlight.size > 0) await Promise.allSettled([...inFlight])
  } finally {
    clearTimeout(terminateTimer)
    await closeDb()
  }
}

export function createLifecycle(): Lifecycle {
  const inFlight = new Set<Promise<unknown>>()
  function track(promise: Promise<unknown>): void {
    inFlight.add(promise)
    promise.finally(() => inFlight.delete(promise)).catch(() => {})
  }
  let shuttingDown = false

  function install(deps: ShutdownDeps): void {
    const { httpServer, wss, heartbeatTimer, sseKeepaliveTimer } = deps
    let disposal: Promise<void> | undefined
    function dispose(): Promise<void> {
      if (!disposal) {
        shuttingDown = true
        clearInterval(heartbeatTimer)
        clearInterval(sseKeepaliveTimer)
        // Store the promise before any close/error callback can re-enter.
        disposal = Promise.resolve().then(() => drain(deps, inFlight)).finally(() => {
          httpServer.off('close', onClose)
          httpServer.off('error', onClose)
          wss.off('error', onWsError)
        })
        closePeers(deps)
      }
      return disposal
    }
    function onClose(): void {
      void dispose().catch(err => { console.error('Server cleanup failed:', err) })
    }
    function onWsError(err: Error): void { httpServer.emit('error', err) }
    httpServer[Symbol.asyncDispose] = dispose
    httpServer.once('close', onClose)
    httpServer.on('error', onClose)
    wss.on('error', onWsError)
  }

  return { track, isShuttingDown: () => shuttingDown, install }
}
