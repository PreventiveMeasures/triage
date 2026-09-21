// Explicit links combine already-resolved workspace App rows. This is a view
// grouping, not report deduplication: each report's revalidation answer has
// already been checked in its own row, and links never create report conflicts.
export function mergeLinkedWorkspaceGroups(groups, duplicatesOf, visibleTabs) {
  const parent = groups.map((_, i) => i)
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  const tabs = groups.map(visibleTabs)
  const byId = new Map()
  for (let i = 0; i < tabs.length; i++) {
    for (const f of tabs[i]) {
      if (!f.id) continue
      if (!byId.has(f.id)) byId.set(f.id, [])
      byId.get(f.id).push(i)
    }
  }
  for (const [id, rows] of byId) {
    for (const other of duplicatesOf(id)) {
      if (other === id) continue
      for (const a of rows) {
        for (const b of byId.get(other) ?? []) {
          const left = find(a), right = find(b)
          if (left !== right) parent[right] = left
        }
      }
    }
  }
  const components = new Map()
  for (let i = 0; i < groups.length; i++) {
    const root = find(i)
    if (!components.has(root)) components.set(root, [])
    components.get(root).push(i)
  }
  if (components.size === groups.length) return groups
  const key = (f) => f.id ?? String(f._id)
  const merged = [...components.values()].map((indices) => {
    if (indices.length === 1) return groups[indices[0]]
    // Retain the tabs visible in each original row. An imported App finding
    // or an unjudged source row must not disappear when linked to a pass row.
    const visible = new Map()
    for (const i of indices) for (const f of tabs[i]) if (!visible.has(key(f))) visible.set(key(f), f)
    const members = new Map()
    for (const i of indices) {
      for (const f of groups[i]) {
        if (!members.has(key(f))) members.set(key(f), visible.get(key(f)) ?? f)
      }
    }
    const group = [...members.values()]
    const first = groups[indices[0]]
    group.workspaceKey = first.workspaceKey ?? key(first[0])
    group.linkedTabs = [...visible.values()]
    return group
  })
  Object.defineProperty(merged, 'ruledOutIds', { value: groups.ruledOutIds, configurable: true })
  return merged
}
