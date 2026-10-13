// Values by key, the least recently used going first once their weights
// (`weight`, 1 each unless given) are past `limit`.
export interface Lru<V> { get(key: string): V | undefined; set(key: string, value: V): void }
export function lru<V>(limit: number, weight: (value: V) => number = () => 1): Lru<V> {
  const kept = new Map<string, V>()
  let total = 0
  const forget = (key: string) => {
    const value = kept.get(key)
    if (value === undefined) return
    kept.delete(key)
    total -= weight(value)
  }
  return {
    get(key) {
      const value = kept.get(key)
      if (value !== undefined) { kept.delete(key); kept.set(key, value) }
      return value
    },
    set(key, value) {
      forget(key)
      if (weight(value) > limit) return
      kept.set(key, value)
      total += weight(value)
      for (const first of kept.keys()) {
        if (total <= limit) break
        forget(first)
      }
    },
  }
}
