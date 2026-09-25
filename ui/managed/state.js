// Manage data survives custom-element teardown, but never leaves memory. The
// session boundary is owned by the host, including while no Manage page is open.
export class ManagedAppState {
  constructor(notify = () => {}) {
    this.resources = new Map()
    this.session = null
    this.generation = 0
    this.notify = notify
  }

  setSession(session) {
    if (this.session?.id !== session?.id || this.session?.role !== session?.role) this.reset()
    this.session = session
  }

  reset() {
    this.generation++
    this.invalidate()
    this.session = null
  }

  read(key) { return this.resources.get(key)?.data }

  // Writes invalidate related collections and cancel their older reads before
  // the page reloads them. Unrelated cached pages remain ready to render.
  invalidate(families) {
    for (const [key, entry] of this.resources) {
      if (families && !families.some(family => key === family || key.startsWith(`${family}:`))) continue
      entry.controller?.abort()
      this.resources.delete(key)
    }
  }

  async mutate(work, families) {
    const generation = this.generation
    let result
    try { result = await work() } catch (err) {
      if (generation === this.generation && err?.name !== 'AbortError') this.notify(`Couldn't save changes: ${err?.message ?? err}`)
      throw err
    }
    if (generation !== this.generation) throw new DOMException('Managed session changed', 'AbortError')
    this.invalidate(families)
    return result
  }

  // An element's cancellation only stops its own updates. Shared requests can
  // finish after navigation and populate the cache for the next visit.
  async load(key, label, fetchData, { signal, apply = () => {} } = {}) {
    signal?.throwIfAborted()
    let entry = this.resources.get(key)
    if (!entry) {
      entry = {}
      this.resources.set(key, entry)
    }
    if (entry.data !== undefined) apply(entry.data)
    if (!entry.pending) {
      const controller = entry.controller = new AbortController()
      entry.pending = (async () => {
        try {
          const data = await fetchData(controller.signal)
          controller.signal.throwIfAborted()
          entry.data = data
          return data
        } catch (err) {
          if (!controller.signal.aborted && err?.name !== 'AbortError') {
            this.notify(`Couldn't refresh ${label}: ${err?.message ?? err}`)
          }
          throw err
        }
      })().finally(() => { entry.pending = null })
    }
    const data = await entry.pending
    signal?.throwIfAborted()
    if (this.resources.get(key) !== entry) throw new DOMException('Managed data changed', 'AbortError')
    apply(data)
    return data
  }
}

export const managedAppState = new ManagedAppState(message => {
  document.dispatchEvent(new CustomEvent('managed-notice', { detail: { message } }))
})

export function setManagedAppSession(session) { managedAppState.setSession(session) }
export function resetManagedAppState() { managedAppState.reset() }
