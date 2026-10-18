// What the code viewer's Activity tabs read (repository-history.js,
// repository-issues.js, repository-agents.js, repository-pulse.js), held a
// while for the session that read it.

// What `key` names in `data` (entries `{ status, until }`), as held while
// fresh (`until`), else read with `ask`: 'loading' till it answers, then the
// entry `ready` makes of its answer (`settled` told once it is held), or
// `failed` of its error (null to hold none, as for a read aborted). One held
// 'ready' and gone old is still shown while it is read again (`rereading`),
// replaced only by what that read answers, never blanked: where it fails,
// kept, read again `retryMs` after; aborted, read again when next shown.
// One made fresh again meanwhile, as reading its next page does, keeps what
// it holds, the answer dropped.
export function heldRead(data, key, ask, { ready, failed, settled = () => {}, retryMs, repaint }) {
  const held = data.get(key)
  if (held && Date.now() < held.until) return held
  const shown = held?.status === 'ready' ? held : null
  if (shown?.rereading) return shown
  const pending = shown ?? { status: 'loading', until: Number.POSITIVE_INFINITY }
  if (shown) shown.rereading = true
  else data.set(key, pending)
  ask().then(answer => {
    if (data.get(key) !== pending || (shown && Date.now() < shown.until)) return null
    const entry = ready(answer)
    data.set(key, entry)
    settled(entry)
    return null
  }, err => {
    if (data.get(key) !== pending) return null
    if (shown) {
      if (err?.name !== 'AbortError') shown.until = Date.now() + retryMs
      return null
    }
    const entry = failed(err)
    if (entry) data.set(key, entry)
    else data.delete(key)
    return null
  }).finally(() => {
    if (shown) shown.rereading = false
    repaint()
  })
  return pending
}
