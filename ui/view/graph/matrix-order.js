// Within a cyclic group, favor imports above the diagonal (importer first).
// Compare a two-ended greedy ordering with DFS dependency order, retaining
// whichever puts more imports above the diagonal. Both stay sparse; the heap
// bounds the greedy pass to O((nodes + imports) log nodes), even for file cycles.
// Ties keep the supplied alphabetical order stable.
class BalanceQueue {
  constructor(nodes) {
    this.nodes = [...nodes]
    for (const [i, node] of this.nodes.entries()) node.position = i
    for (let i = (this.nodes.length >> 1) - 1; i >= 0; i--) this.down(i)
  }

  before(a, b) {
    return Math.abs(a.balance) > Math.abs(b.balance)
      || (Math.abs(a.balance) === Math.abs(b.balance) && (a.balance > b.balance
        || (a.balance === b.balance && a.tie < b.tie)))
  }

  swap(a, b) {
    const nodes = this.nodes
    const first = nodes[a]
    nodes[a] = nodes[b]; nodes[b] = first
    nodes[a].position = a; nodes[b].position = b
  }

  down(i) {
    const nodes = this.nodes
    while (2 * i + 1 < nodes.length) {
      let child = 2 * i + 1
      if (child + 1 < nodes.length && this.before(nodes[child + 1], nodes[child])) child++
      if (!this.before(nodes[child], nodes[i])) break
      this.swap(i, child); i = child
    }
  }

  update(node) {
    if (node.position < 0) return
    let i = node.position
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.before(node, this.nodes[parent])) break
      this.swap(i, parent); i = parent
    }
    this.down(i)
  }

  take() {
    const first = this.nodes[0], last = this.nodes.pop()
    first.position = -1
    if (this.nodes.length > 0) {
      this.nodes[0] = last; last.position = 0; this.down(0)
    }
    return first
  }
}

function improveAdjacent(order, cells) {
  // Resolve greedy ties with a few bounded sweeps. Swapping neighbors changes
  // only their mutual edges, so every swap strictly reduces backward imports.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (let step = 0; step < order.length - 1; step++) {
      const i = pass % 2 ? order.length - 2 - step : step
      const a = order[i], b = order[i + 1]
      if ((cells.get(b)?.get(a)?.count ?? 0) <= (cells.get(a)?.get(b)?.count ?? 0)) continue
      order[i] = b; order[i + 1] = a; changed = true
    }
    if (!changed) break
  }
  return order
}

function dependencyOrder(nodes) {
  const finish = [], seen = new Set()
  for (const node of nodes.values()) node.outgoing.sort((a, b) => b[1] - a[1] || a[0].tie - b[0].tie)
  for (const node of nodes.values()) {
    if (seen.has(node)) continue
    const stack = [{ node, next: 0 }]
    seen.add(node)
    while (stack.length > 0) {
      const frame = stack.at(-1)
      if (frame.next === frame.node.outgoing.length) { finish.push(frame.node.id); stack.pop(); continue }
      const target = frame.node.outgoing[frame.next++][0]
      if (!seen.has(target)) { seen.add(target); stack.push({ node: target, next: 0 }) }
    }
  }
  return finish.toReversed()
}

function forwardImports(order, nodes) {
  const index = new Map(order.map((id, i) => [id, i]))
  let count = 0
  for (const node of nodes.values()) {
    for (const [target, weight] of node.outgoing) if (index.get(node.id) < index.get(target.id)) count += weight
  }
  return count
}

function rotateOrder(order, nodes) {
  // DFS may enter a cycle in its middle. Try every rotation in linear time:
  // moving the first node to the end flips only its incoming/outgoing edges.
  let count = forwardImports(order, nodes)
  let best = count, start = 0
  for (let i = 0; i < order.length - 1; i++) {
    count -= nodes.get(order[i]).originalBalance
    if (count > best) { best = count; start = i + 1 }
  }
  return [...order.slice(start), ...order.slice(0, start)]
}

export function orderCyclicGroup(ids, cells) {
  if (ids.length < 2) return ids
  const nodes = new Map(ids.map((id, tie) => [id, { id, tie, balance: 0, incoming: [], outgoing: [] }]))
  for (const node of nodes.values()) {
    for (const cell of cells.get(node.id)?.values() ?? []) {
      const target = nodes.get(cell.to)
      if (!target || target === node) continue // External imports and self-imports cannot affect this order.
      node.outgoing.push([target, cell.count]); target.incoming.push([node, cell.count])
      node.balance += cell.count; target.balance -= cell.count
    }
  }
  for (const node of nodes.values()) node.originalBalance = node.balance
  const left = [], queue = new BalanceQueue(nodes.values()), right = []
  while (queue.nodes.length > 0) {
    const node = queue.take()
    if (node.balance >= 0) left.push(node.id)
    else right.push(node.id)
    for (const [target, count] of node.outgoing) {
      if (target.position < 0) continue
      target.balance += count; queue.update(target)
    }
    for (const [source, count] of node.incoming) {
      if (source.position < 0) continue
      source.balance -= count; queue.update(source)
    }
  }
  let best = ids, count = forwardImports(ids, nodes)
  for (const candidate of [[...left, ...right.toReversed()], dependencyOrder(nodes), ids, ids.toReversed()]) {
    const improved = improveAdjacent(rotateOrder(candidate, nodes), cells)
    const next = forwardImports(improved, nodes)
    if (next > count) { best = improved; count = next }
  }
  // Never replace an existing alphabetical arrangement with a worse one.
  return best
}
