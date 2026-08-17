// Shared test utilities — currently only the server-spawn boilerplate
// that every server-driven test repeats. Co-locates the contract so a
// fix (e.g. pinning CONFIG_PATH to dodge a developer's local
// `server-e2e/config.json`) lands in one place instead of 13.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Boot a fresh `server-e2e/index.ts` against a per-test temp dir and
// resolve when the listening banner appears on stdout. Returns the
// spawned process, the temp dir, the resolved port, the derived URLs,
// and a teardown that kills the proc and removes the dir.
//
// Defaults: PORT=0 (OS-assigned), HOST=127.0.0.1, DB_PATH +
// OBJSTORE_DIR rooted at the temp dir, and CONFIG_PATH pointing at
// `<dir>/config.json` — which may or may not exist. The server's
// `loadConfig` treats ENOENT as `{}` (no password gate); tests that
// want a real config just pre-write the file before calling.
// Pinning CONFIG_PATH inside the temp dir matters because the
// server's default resolves `server-e2e/config.json` next to the source,
// which is git-ignored and can hold a password on a developer's
// checkout — leaking that file into spawned-server tests turns every
// "first action" (workspace create / save) into an unauthorized
// failure.
//
// Options:
//   `dir`  — reuse an existing serverDir (e.g. restart-style tests
//            that need the DB to persist across spawns). Helper-
//            created dirs are removed on teardown; caller-supplied
//            dirs are left alone.
//   `env`  — merge over the defaults. Use to override PORT (e.g.
//            preferredPort for restart-style tests), HOST, or extra
//            knobs like `MAX_INFLIGHT_PER_SOCKET`.
export async function bootServer({ dir = null, env = {} } = {}) {
  const ownsDir = dir == null
  const serverDir = dir ?? mkdtempSync(path.join(tmpdir(), 'deepview-test-'))
  const proc = spawn(process.execPath, ['server-e2e/index.ts'], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DB_PATH: path.join(serverDir, 'data.db'),
      OBJSTORE_DIR: path.join(serverDir, 'objstore'),
      CONFIG_PATH: path.join(serverDir, 'config.json'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let port
  try {
    port = await awaitListeningPort(proc)
  } catch (err) {
    if (proc.exitCode == null) proc.kill('SIGKILL')
    if (ownsDir) rmSync(serverDir, { recursive: true, force: true })
    throw err
  }
  return {
    proc,
    serverDir,
    port,
    serverUrl: `ws://127.0.0.1:${port}/api/sync`,
    httpOrigin: `http://127.0.0.1:${port}`,
    // Idempotent: safe to call after the test has already killed the
    // proc (e.g. graceful-shutdown tests that send SIGTERM as part of
    // the assertion). `exitCode == null` means the proc is still
    // running; once it's exited, `'exit'` won't fire again, so we
    // only await when there's still something to await. Falls back to
    // SIGKILL if SIGTERM doesn't take within 3 s — a wedged server
    // should not turn into an orphan process holding the tmp dir
    // open. Tests that intentionally probe shutdown can pre-kill the
    // proc; teardown then just cleans up.
    async teardown() {
      if (proc.exitCode == null && proc.signalCode == null) {
        proc.kill('SIGTERM')
        const sigkillTimer = setTimeout(() => proc.kill('SIGKILL'), 3_000)
        try {
          await new Promise((resolve) => { proc.once('exit', resolve) })
        } finally { clearTimeout(sigkillTimer) }
      }
      if (ownsDir) rmSync(serverDir, { recursive: true, force: true })
    },
  }
}

// Resolve when the server prints its listening banner on stdout.
// Surfaces stderr if the server exits before the banner appears so
// boot failures show the real reason instead of timing out.
// Exported for callers that spawn the server themselves (e.g. tests
// that need to inspect raw stdout/stderr for additional assertions,
// or that drive a custom kill schedule the standard teardown can't
// express).
export function awaitListeningPort(proc, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let stderrBuf = ''
    let settled = false
    function onData(d) {
      buf += String(d)
      const m = /ws:\/\/[^:]+:(\d+)\//u.exec(buf)
      if (m) finish(null, Number(m[1]))
    }
    function onErrData(d) { stderrBuf += String(d) }
    function onExit(code, signal) {
      const detail = stderrBuf.slice(0, 400).trim() || `exit ${code}, signal ${signal}`
      finish(new Error(`server exited during boot: ${detail}`))
    }
    function onError(err) { finish(err) }
    function finish(err, port) {
      if (settled) return
      settled = true
      clearTimeout(t)
      proc.stdout.removeListener('data', onData)
      proc.stderr.removeListener('data', onErrData)
      proc.removeListener('exit', onExit)
      proc.removeListener('error', onError)
      if (err) reject(err); else resolve(port)
    }
    const t = setTimeout(() => finish(new Error('server boot timeout')), timeoutMs)
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onErrData)
    proc.once('exit', onExit)
    proc.once('error', onError)
  })
}

// Shut down an in-process `ws` WebSocketServer without hanging.
//
// `wss.close(cb)` closes the underlying HTTP server, and node fires
// that callback only once every connection has ended — so a still-open
// client socket holds it OPEN INDEFINITELY (verified: no callback after
// seconds, because a healthy peer has no reason to disconnect). A test
// that awaited a bare `wss.close(resolve)` therefore deadlocked whenever
// the client it was driving hadn't finished tearing its socket down
// yet — a load-dependent race, invisible on an idle machine and fatal
// under `--test-isolation=process` (the child never exits, the runner
// waits on it forever, and `--test-timeout=0` means nothing intervenes).
//
// Terminating live sockets first is the same fallback the production
// server uses for this exact hazard — see the round-11 F4 note in
// sync-server.test.js about `ws`'s ~30 s `closeTimeout` when a peer
// doesn't ack the close frame. `terminate()` is an immediate socket
// destroy, not a close handshake, so it can't wait on the peer. The
// timed fallback is pure belt-and-braces: teardown must never be the
// reason a suite hangs.
// `.unref()` on the fallback timer so the guard itself can never be
// what keeps the process alive; a race of two single-resolve promises
// also keeps the linter's no-multiple-resolved rule satisfied.
export function closeWebSocketServer(wss, timeoutMs = 5_000) {
  for (const sock of wss.clients) sock.terminate()
  const closed = new Promise((resolve) => { wss.close(resolve) })
  const timed = new Promise((resolve) => { setTimeout(resolve, timeoutMs).unref() })
  return Promise.race([closed, timed])
}

// Await a WebSocketServer's `listening` event with an error path.
//
// A bare `once('listening', resolve)` has no failure branch: if the
// listen fails (EADDRINUSE, or EMFILE when a loaded runner has many
// suites holding sockets at once) the event never fires, `'error'` goes
// unhandled, and the await hangs forever — the same shape as the
// close-side deadlock above. Rejecting on `'error'` turns that into a
// readable failure.
export function awaitListening(wss, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => finish(new Error('WebSocketServer listen timeout')), timeoutMs)
    function finish(err) {
      clearTimeout(t)
      wss.removeListener('listening', onListening)
      wss.removeListener('error', finish)
      if (err) reject(err); else resolve(wss)
    }
    function onListening() { finish(null) }
    wss.once('listening', onListening)
    wss.once('error', finish)
  })
}
