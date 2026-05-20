// Per-key async mutex. Serialises a multi-step commit (precondition
// check → MAX(seq) → INSERT) against the same key so two competing
// commits can't interleave their check/write phases across an `await`.
//
// Used by the triage-sync revision chain (server/db.ts's per-tag
// write-lock). The objstore plane no longer uses it: content-addressed
// blobs + the version compare-and-set made per-resource serialisation
// unnecessary there, so its only consumer is now the revision chain.
// (The module still lives under objstore/ for historical reasons.)
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
