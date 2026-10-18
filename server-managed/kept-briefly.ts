// What was lately worked out, kept a little while in memory for whoever asks
// for it next, by key: each for `keptMs` from when it was kept, the least
// lately read going first past `maxEntries` of them or `maxBytes` between
// them, and one that alone takes more than `maxBytes` not kept at all.
// Whoever reads one is the caller's to check, as they would one worked out.
export function keptBriefly<T>({ keptMs, maxBytes, maxEntries = Infinity }: { keptMs: number; maxBytes: number; maxEntries?: number }) {
  const held = new Map<string, { value: T; bytes: number; timer: ReturnType<typeof setTimeout> }>()
  let heldBytes = 0
  const forget = (key: string) => {
    const entry = held.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    held.delete(key)
    heldBytes -= entry.bytes
  }
  return {
    get(key: string): T | undefined {
      const entry = held.get(key)
      if (!entry) return undefined
      held.delete(key)
      held.set(key, entry)
      return entry.value
    },
    keep(key: string, value: T, bytes: number) {
      if (bytes > maxBytes) return
      forget(key)
      for (const old of held.keys()) {
        if (held.size < maxEntries && heldBytes + bytes <= maxBytes) break
        forget(old)
      }
      const timer = setTimeout(() => { forget(key) }, keptMs)
      timer.unref()
      held.set(key, { value, bytes, timer })
      heldBytes += bytes
    },
  }
}
