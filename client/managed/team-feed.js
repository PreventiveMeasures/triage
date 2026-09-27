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
// URL. Reconnection always starts with an invalidation, so no replay cursor or
// instance affinity is needed. The caller owns the subscription's lifetime.
export async function watchTeamFeed(teamId, { signal, onUpdate, onTeams, onClose }) {
  if (getPreviewRole()) return
  let backoff = 1_000
  const eventReceived = async event => {
    if (event === 'close') { await onClose(); return false }
    if (event === 'triage' || event === 'teams') {
      if (await (event === 'teams' ? onTeams?.() : onUpdate()) === false) throw new Error('Team refresh failed')
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
      const response = await managedFetch(teamId ? `/api/teams/${encodeURIComponent(teamId)}/feed` : '/api/teams/feed', {
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
      const complete = await consume(reader, signal, alive, eventReceived)
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
      if (signal.aborted || await eventReceived(event) === false) return true
    }
  }
  return true
}
