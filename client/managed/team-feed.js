import { getPreviewRole, managedFetch } from './request.js'

function wait(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

// Fetch preserves the public-share header and never puts a capability in a
// URL. Reconnection confirms the catalog version and invalidates annotations,
// so no replay cursor or instance affinity is needed. The caller owns the
// subscription's lifetime.
export async function watchTeamFeed(teamId, { signal, onUpdate, onTeams, onClose, reportId = null }) {
  if (getPreviewRole()) return
  let backoff = 1_000
  const eventReceived = async (event, data, requestSignal) => {
    requestSignal.throwIfAborted()
    if (event === 'close') { await onClose(); return false }
    if (event === 'triage' || event === 'teams') {
      // Refresh requests share this connection's watchdog, not just the view's
      // lifetime, so a stalled read cannot prevent the reconnect loop.
      let revision = null
      if (event === 'teams') {
        try { const parsed = JSON.parse(data); if (typeof parsed?.revision === 'string') revision = parsed.revision } catch {}
      }
      if (await (event === 'teams' ? onTeams?.(requestSignal, revision) : onUpdate(requestSignal)) === false) throw new Error('Team refresh failed')
      requestSignal.throwIfAborted()
      backoff = 1_000
    }
    return true
  }
  while (!signal.aborted) {
    const request = new AbortController()
    const abort = () => request.abort()
    signal.addEventListener('abort', abort, { once: true })
    let reader, watchdog
    const alive = () => {
      clearTimeout(watchdog)
      watchdog = setTimeout(abort, 45_000)
    }
    try {
      alive()
      const query = reportId === null ? '' : `?reportId=${encodeURIComponent(reportId)}`
      const response = await managedFetch(teamId ? `/api/teams/${encodeURIComponent(teamId)}/feed${query}` : '/api/teams/feed', {
        credentials: 'same-origin', headers: { accept: 'text/event-stream' }, signal: request.signal,
      })
      if ([401, 403, 404].includes(response.status)) {
        await response.body?.cancel()
        if (!signal.aborted) await onClose()
        return
      }
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
        await response.body?.cancel()
        throw new Error('Team feed unavailable')
      }
      reader = response.body.getReader()
      const complete = await consume(reader, signal, alive, (event, data) => eventReceived(event, data, request.signal))
      if (complete) return
    } catch {
      // Includes proxy timeouts, deployment rollovers and failed refreshes.
    } finally {
      clearTimeout(watchdog)
      abort()
      await reader?.cancel().catch(() => {})
      signal.removeEventListener('abort', abort)
    }
    await wait(backoff, signal)
    backoff = Math.min(backoff * 2, 30_000)
  }
}

// Bound incomplete frames even if a proxy serves a corrupt or stalled body.
async function consume(reader, signal, alive, eventReceived) {
  const decoder = new TextDecoder()
  let buffer = ''
  while (!signal.aborted) {
    const { done, value } = await reader.read()
    if (done) return false
    alive()
    buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n')
    if (buffer.length > 16_384) throw new Error('Team feed frame too large')
    let end
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const event = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim()
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (signal.aborted || await eventReceived(event, data) === false) return true
    }
  }
  return true
}
