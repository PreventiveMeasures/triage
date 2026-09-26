import { isSecurityFinding } from './finding.js'

function securityGraph() {
  const ids = [], nodes = new Map()
  const nodeFor = (key) => {
    if (!nodes.has(key)) {
      const node = { security: false }
      node.parent = node
      nodes.set(key, node)
      if (typeof key === 'string') ids.push(key)
    }
    return nodes.get(key)
  }
  const root = (node) => {
    let current = node
    while (current.parent !== current) current = current.parent
    while (node.parent !== node) { const next = node.parent; node.parent = current; node = next }
    return current
  }
  const join = (a, b) => {
    a = root(a); b = root(b)
    if (a !== b) { b.parent = a; a.security ||= b.security }
  }
  return { nodeFor, root, join, ids }
}

// Stamp the complete row/link component, before any display lens hides tabs.
// The callbacks are synchronous lookups of already-known links and index rows;
// this never loads reports. Only the supplied findings are mutated. Recompute
// from intrinsic evidence so removing a sibling/link does not latch a true flag.
export function stampSecurityGroups(groups, { source, linkedIds = () => [], knownRows = () => [] } = {}) {
  const { nodeFor, root, join, ids } = securityGraph()
  const findings = []
  const addRow = (group, known = false) => {
    let first
    for (const f of group) {
      if (!f || typeof f !== 'object') continue
      const node = nodeFor(f.id || f)
      root(node).security ||= known ? f.isSecurity === true : isSecurityFinding(f, f._source ?? f.source ?? source)
      if (first) join(first, node)
      else first = node
      if (!known) findings.push([f, node])
    }
  }
  for (const group of groups) addRow(group)
  const seenRows = new Set()
  // Growing queue: a known linked row can have siblings with links of their own.
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i], node = nodeFor(id)
    for (const other of linkedIds(id)) join(node, nodeFor(other))
    for (const row of knownRows([id])) {
      if (seenRows.has(row)) continue
      seenRows.add(row)
      addRow(row.members, true)
    }
  }
  let changed = false
  for (const [f, node] of findings) {
    const security = root(node).security
    if (f.isSecurity !== security) { f.isSecurity = security; changed = true }
  }
  return changed
}
