// What the code viewer's Activity tabs read (repository-history.js,
// repository-issues.js, repository-agents.js, repository-pulse.js), held a
// while for the session that read it.

// What `key` names in `data` (entries `{ status, until }`), as held while
// fresh (`until`), else read with `ask`: 'loading' till it answers, then
// `ready`'s entry of its answer (`settled` told once held), or `failed`'s of
// its error (null to hold none). One 'ready' gone old is shown while read
// again (`rereading`), never blanked: a failure keeps it, read again
// `retryMs` after; an abort reads it again when next shown. One made fresh
// meanwhile (as reading its next page does) keeps what it holds.
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
