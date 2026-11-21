// A cache's entries kept for the next view to read: the least recently read
// let go once there are more than a few, as each can hold a large read (a
// version's or a commit's files, their colored lines), those still wanted
// (`held`, one still coming, or one a view shows) kept whatever their count.

// `key`'s entry, moved last as the one read most recently; undefined where none.
export function readKept(map, key) {
  if (!map.has(key)) return undefined
  const value = map.get(key)
  map.delete(key)
  map.set(key, value)
  return value
}

// Those past `max`, the least recently read first, let go (`drop`, deleting
// each by default), but those `held` names.
export function trimKept(map, max, held = () => false, drop = key => { map.delete(key) }) {
  if (map.size <= max) return
  for (const [key, value] of [...map]) {
    if (map.size <= max) break
    if (!held(value, key)) drop(key, value)
  }
}
