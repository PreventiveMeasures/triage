// How views keep what they ask the server: copies and diffs worked out for
// a comparison (pretty-source.js, rename-diff.js, type-only.js,
// bundle-comparison.js), the last few kept, a failure that may pass asked
// again a while after; and a session's answers (heldAnswers).

// Whether asking again for what failed with `status` may succeed.
export const retryable = status => !(status >= 400 && status < 500 && status !== 429)

// How long a failure that may pass waits to be asked again, `tries` the
// failures in a row before it: twice as long each time.
export const retryWait = tries => Math.min(5_000 * 2 ** tries, 5 * 60_000)

// `fn` called after `ms`, holding no Node process open.
export const later = (ms, fn) => setTimeout(fn, ms)?.unref?.()

// A failure as kept: what it says, and whether asking again may succeed.
export const failureOf = err => ({ status: 'error', message: err?.message ?? String(err), retry: retryable(err?.status) })

// A request a session that changed aborted: what it was for is asked again
// under the new one, on its view's render.
export const aborted = err => err?.name === 'AbortError'

// `map`'s entries past `kept`, the least recent `done` ones dropped.
export function evict(map, kept, done) {
  for (const [key, value] of map) {
    if (map.size <= kept) break
    if (done(value)) map.delete(key)
  }
}

// `map`'s entry for `key` made its most recent, made anew (`make(was)`)
// where `stale(was)`, as one not kept is; then evicted past `kept`.
export function touch(map, key, kept, done, make, stale = was => !was) {
  let entry = map.get(key)
  map.delete(key)
  if (stale(entry)) entry = make(entry)
  map.set(key, entry)
  evict(map, kept, done)
  return entry
}

// Runs `work` with at most `max` running at once, the rest waiting their
// turn in the order asked.
export function limiter(max) {
  let running = 0
  const turns = []
  return async work => {
    if (running < max) running++
    else await new Promise(resolve => { turns.push(resolve) })
    try { return await work() }
    finally {
      const next = turns.shift()
      if (next) next()
      else running--
    }
  }
}

// Tells views of what came, each once, `ms` after the first of a burst.
export function teller(ms) {
  const told = new Set()
  return notify => {
    if (!notify) return
    if (told.size === 0) {
      setTimeout(() => {
        const views = [...told]
        told.clear()
        for (const view of views) view()
      }, ms)
    }
    told.add(notify)
  }
}

// Failures in a row by what failed: one that may pass (`retry`) is
// `drop`ped once due, where it is still what is kept, its view (`notify()`)
// told then to ask again; one that came, or failed for good, forgets them.
export function retrier() {
  const failures = new Map()
  return (key, retry, drop, notify) => {
    if (!retry) {
      failures.delete(key)
      return
    }
    const tries = failures.get(key) ?? 0
    failures.set(key, tries + 1)
    later(retryWait(tries), () => { if (drop()) notify()?.() })
  }
}

export const KEEP_MS = 2 * 60_000
const RETRY_MS = 30_000

// A session's answers, by key, as an Overview fact shows them, held for that
// session and role alone (`state.managedSession`), as are the facts whose
// details are `opened`.
// `ask(key, fetch, read)` gives what is held, asked of `fetch()` again once
// older than KEEP_MS, or RETRY_MS after a failure, shown as it was meanwhile
// (`refresh` added to it): 'loading', then 'ready' with `read(answer)`, or
// 'error' with its `error`. `changed` is told as one comes.
export function heldAnswers(state) {
  let keptFor = null
  const answers = {
    held: new Map(),
    opened: new Set(),
    changed: () => {},
    current() {
      const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
      if (session !== keptFor) {
        answers.held.clear()
        answers.opened.clear()
        keptFor = session
      }
      return answers.held
    },
    // `next` held for `key` in place of `was`, none for null, unless
    // something else has been since; told where it is.
    settle(key, was, next) {
      if (answers.held.get(key) !== was) return
      if (next) answers.held.set(key, next)
      else answers.held.delete(key)
      answers.changed()
    },
    ask(key, fetch, read, { fresh = entry => Date.now() < entry.until, refresh = {} } = {}) {
      const held = answers.current()
      const entry = held.get(key)
      if (entry && fresh(entry)) return entry
      const loading = entry?.status === 'ready' ? { ...entry, until: Number.POSITIVE_INFINITY, ...refresh } : { status: 'loading', until: Number.POSITIVE_INFINITY }
      held.set(key, loading)
      fetch().then(answer => ({ status: 'ready', until: Date.now() + KEEP_MS, ...read(answer) }))
        .catch(err => aborted(err) ? null : { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'It couldn’t be read.' })
        .then(next => answers.settle(key, loading, next))
      return loading
    },
    toggle(key) {
      if (answers.opened.has(key)) answers.opened.delete(key)
      else answers.opened.add(key)
    },
  }
  return answers
}
