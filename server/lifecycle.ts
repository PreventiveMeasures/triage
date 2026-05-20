// Process lifecycle: the in-flight request tracker, the `shuttingDown`
// gate, the graceful-shutdown choreography, and the signal / error /
// uncaught-exception handlers that drive it. Two-phase so the bits the
// HTTP + WS planes need (`track`, `isShuttingDown`) exist BEFORE those
// servers are built, while the teardown is `install()`ed afterward —
// once the server objects, heartbeat timer, and reaper exist.

import type { Server } from 'node:http'
import type { WebSocketServer } from 'ws'
import { errStack } from './util.ts'

export type ShutdownDeps = {
  httpServer: Server
  wss: WebSocketServer
  heartbeatTimer: ReturnType<typeof setInterval>
  // Stops the periodic reaper AND awaits any in-flight sweep.
  stopReaper: () => Promise<void>
  // App-specific teardown, run (in order) AFTER the in-flight drain:
  // release any commit-lock leases this process holds, then close the
  // DB. Each swallows its own errors (a failed release/close shouldn't
  // abort the exit).
  releaseLeases: () => Promise<void>
  closeDb: () => Promise<void>
}

export type Lifecycle = {
  // Collects in-flight async handlers so `shutdown` can drain them
  // before closing the DB. Passed to the HTTP + WS planes.
  track: (promise: Promise<unknown>) => void
  // Read by the REST shutdown gate + the WS message loop to drop new
  // work once teardown began.
  isShuttingDown: () => boolean
  // Wire the graceful shutdown + the error / signal / process-catchall
  // handlers. Call once, after the server objects exist.
  install: (deps: ShutdownDeps) => void
}

export function createLifecycle(): Lifecycle {
  // In-flight async message handlers. `shutdown` awaits this set before
  // closing the DB so a SIGINT mid-save can't resume against a closed
  // handle (which would throw inside `insertRevision` after the client
  // believed its save was committed).
  const inFlight = new Set<Promise<unknown>>()
  function track(promise: Promise<unknown>): void {
    inFlight.add(promise)
    promise.finally(() => inFlight.delete(promise))
  }
  let shuttingDown = false
  // Live exit code the in-progress shutdown will pass to `process.exit`.
  // Re-entry can ESCALATE it from 0 → 1 (e.g. a `wss.error` firing
  // during a SIGTERM-driven graceful shutdown shouldn't leave the
  // launcher seeing a clean exit code) but can never DE-escalate.
  // Audit round-13.
  let pendingExitCode = 0

  function install(deps: ShutdownDeps): void {
    const { httpServer, wss, heartbeatTimer, stopReaper, releaseLeases, closeDb } = deps

    async function shutdown(exitCode: number = 0): Promise<void> {
      // Re-entry: don't restart the teardown, but escalate the pending
      // exit code if the new caller is non-zero (e.g. a wss.error during
      // a SIGTERM-driven graceful shutdown). Without this, an error
      // arriving mid-shutdown would silently exit 0 and the launcher
      // would record a clean stop.
      if (shuttingDown) {
        if (exitCode !== 0 && pendingExitCode === 0) pendingExitCode = exitCode
        return
      }
      shuttingDown = true
      pendingExitCode = exitCode
      console.log('Shutting down…')
      // Stop the heartbeat so a tick can't fire mid-shutdown and ping a
      // socket the close-loop below already started tearing down.
      clearInterval(heartbeatTimer)
      // Send a 1001 (going away) close frame to every open socket BEFORE
      // shutting the listener. Lets clients distinguish a server-initiated
      // graceful shutdown from a network drop, so they can skip their
      // reconnect backoff. Fire-and-forget — `process.exit` below would
      // force-kill any in-progress flush anyway. `try/catch` shrugs at
      // sockets already in CLOSING / CLOSED.
      for (const socket of wss.clients) {
        try { socket.close(1001, 'Server shutting down') } catch {}
      }
      // Force-terminate any client that doesn't ack the close frame
      // within a short grace window. `wss.close()` waits for every client
      // to emit `'close'`, and `ws` only TCP-RSTs unresponsive peers
      // after its own ~30 s `closeTimeout`. A single dead/blackholed peer
      // would otherwise stretch SIGTERM/SIGINT response by that full
      // timeout. Audit round-11.
      const TERMINATE_GRACE_MS = 1_000
      const terminateTimer = setTimeout(() => {
        for (const socket of wss.clients) {
          const rs = socket.readyState
          if (rs === socket.OPEN || rs === socket.CLOSING) {
            try { socket.terminate() } catch {}
          }
        }
        // Same grace for HTTP keep-alive sockets that didn't respect the
        // `Connection: close` hint, which would otherwise hold
        // `httpServer.close()` until their TCP timeout.
        try { httpServer.closeAllConnections() } catch {}
      }, TERMINATE_GRACE_MS)
      // Don't keep the event loop alive solely for the grace timer.
      terminateTimer.unref?.()
      // Stop the periodic reaper AND wait for any in-flight sweep (incl.
      // the startup sweep) before the DB close — otherwise a
      // readdir / unlink would race a closed DB.
      await stopReaper()
      // Free idle HTTP keep-alive sockets up front so close() below
      // doesn't wait on them. Active in-flight requests still finish.
      try { httpServer.closeIdleConnections() } catch {}
      // Close http.Server first to stop accepting new upgrades + HTTP
      // requests. Guard with `.listening` because `close()` throws
      // ERR_SERVER_NOT_RUNNING when bind never succeeded (the http error
      // handler is the path that invoked shutdown in that case).
      if (httpServer.listening) {
        await new Promise<void>((resolve) => { httpServer.close(() => resolve()) })
      }
      await new Promise<void>((resolve) => { wss.close(() => resolve()) })
      clearTimeout(terminateTimer)
      // Drain in-flight handlers so a save that's mid-pipeline finishes
      // its insertRevision before the DB closes. `handleSave` splits its
      // canonical/id/dup-precheck/verify/commit work across awaits, so
      // the window spans several yield points. `Promise.allSettled` so a
      // single handler rejection doesn't abort the drain.
      if (inFlight.size > 0) await Promise.allSettled([...inFlight])
      // App teardown AFTER the drain: a PUT that was mid-commit has
      // already run its own finally-release, so we only mop up stragglers,
      // then close the DB.
      await releaseLeases()
      await closeDb()
      // Read `pendingExitCode` (not the parameter) so a re-entrant
      // `shutdown(1)` that landed during the drain wins over the original
      // `shutdown(0)`. See round-13 escalation note.
      process.exit(pendingExitCode)
    }

    // `.catch` defends against an unguarded `await` slipping into
    // `shutdown`: an unhandled rejection there would skip the non-zero
    // exit the launcher relies on.
    function fireShutdown(code: number): void {
      shutdown(code).catch((err) => {
        console.warn('shutdown error:', errStack(err))
        process.exit(code === 0 ? 1 : code)
      })
    }

    // Route bind / post-listen failures through `shutdown` so the
    // in-flight drain + DB close still run before exit. Without this,
    // `ws` re-emits the error as uncaughtException and the launcher sees
    // a confusing crash rather than the bind failure. Audit round-9 M2.
    httpServer.on('error', (err: Error) => {
      console.error('Server error:', errStack(err))
      fireShutdown(1)
    })
    // Symmetric with the http.Server error handler — route through
    // `fireShutdown(1)` so the launcher sees a non-zero exit, and the
    // re-entry escalation bumps `pendingExitCode` 0 → 1 for a `wss.error`
    // arriving mid-graceful-SIGTERM.
    wss.on('error', (err: Error) => {
      console.error('WS server error:', errStack(err))
      fireShutdown(1)
    })
    // Wrap signal handlers so the signal name (the listener's first arg)
    // doesn't bleed into shutdown's `exitCode`.
    process.on('SIGINT', () => fireShutdown(0))
    process.on('SIGTERM', () => fireShutdown(0))
    // Process-level catchalls so a stray rejection / uncaught exception
    // doesn't bypass `shutdown()` — Node 20+ exits on unhandled
    // rejection, which would skip the drain + DB close. Log forensically
    // and route through `fireShutdown(1)`. Audit round-11 observability.
    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled rejection:', errStack(reason))
      fireShutdown(1)
    })
    process.on('uncaughtException', (err) => {
      console.error('Uncaught exception:', errStack(err))
      fireShutdown(1)
    })
  }

  return { track, isShuttingDown: () => shuttingDown, install }
}
