// Per-key async mutex. Used to serialise commit / delete / abort
// operations against the same (workspaceTag, resourceTag) so that
// the runtime FS work between two sync DB phases (precondition
// check, then write) can't be interleaved with a competing
// operation's identical pair — `await stat(…)` / `await rename(…)`
// would otherwise let a second handler land its precondition check
// against the same prev_version, both rename, both upsert, race.
//
// Lock entries garbage-collect when no holder / waiter remains, so
// the Map size is bounded by concurrent in-flight operations rather
// than total resources ever seen. No browser Web Locks here — Node-
// only.

type Entry = {
  tail: Promise<unknown>
  refs: number
}

export class KeyedAsyncLock<K> {
  #locks = new Map<K, Entry>()

  async run<T>(key: K, fn: () => Promise<T>): Promise<T> {
    let entry = this.#locks.get(key)
    if (!entry) { entry = { tail: Promise.resolve(), refs: 0 }; this.#locks.set(key, entry) }
    entry.refs += 1
    const prev = entry.tail
    let release!: () => void
    const next = new Promise<void>((r) => { release = r })
    entry.tail = prev.then(() => next)
    try {
      await prev
      return await fn()
    } finally {
      release()
      entry.refs -= 1
      if (entry.refs === 0) this.#locks.delete(key)
    }
  }

  // Live entry count — exposed for the GC-after-refcount-drop test
  // (and any future operability probe). The `#` field is genuinely
  // private; this getter is the contract for outside inspection.
  get size(): number { return this.#locks.size }
}
