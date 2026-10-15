// The graph of a repository's history (repository-history.js), laid out as
// `git log --graph --date-order` draws it: commits newest first, but never a
// parent before a child of it, each in a lane its line runs down from its
// child to it, a merge's other parents on lanes of their own, lanes waiting on
// the same parent drawn apart until it comes. Pure, for the tab to draw.

const time = commit => commit.committedAt ?? Number.NEGATIVE_INFINITY

// The commits in date order: newest first, a commit only once every child of
// it among them is listed (a parent dated after its child, by a clock off,
// waits for it).
export function historyOrder(commits) {
  const index = new Map(commits.map((commit, at) => [commit.sha, at]))
  const children = new Map(commits.map(commit => [commit.sha, 0]))
  for (const commit of commits) {
    for (const parent of new Set(commit.parents)) if (index.has(parent)) children.set(parent, children.get(parent) + 1)
  }
  // Ready commits, the next to list last: latest, then as listed.
  const before = (a, b) => time(a) - time(b) || index.get(b.sha) - index.get(a.sha)
  const ready = commits.filter(commit => children.get(commit.sha) === 0).toSorted(before)
  const ordered = []
  while (ready.length > 0) {
    const commit = ready.pop()
    ordered.push(commit)
    for (const parent of new Set(commit.parents)) {
      if (!index.has(parent)) continue
      const left = children.get(parent) - 1
      children.set(parent, left)
      if (left > 0) continue
      const next = commits[index.get(parent)]
      let high = ready.length, low = 0
      while (low < high) {
        const middle = (low + high) >> 1
        if (before(ready[middle], next) < 0) low = middle + 1
        else high = middle
      }
      ready.splice(low, 0, next)
    }
  }
  return ordered
}

// The commits `tip`'s first parents reach among `commits`, `tip` too: the
// line a branch's own commits make, as `--first-parent` lists them.
export function firstParentLine(commits, tip) {
  const bySha = new Map(commits.map(commit => [commit.sha, commit]))
  const line = new Set()
  for (let commit = bySha.get(tip); commit && !line.has(commit.sha); commit = bySha.get(commit.parents[0])) line.add(commit.sha)
  return line
}

// The graph of `ordered` (historyOrder's): each row's commit, the lane its
// node is on (`col`) and its line's `color`; the line segments between rows,
// each from a lane at a row to a lane at the next (`row`, `from`, `to`,
// `color`); and the parents not among the commits, each a short line on from
// its child's node (`stubs`, `straight` down its lane, else aside), the
// history going on past them. `width` is how many lanes it takes. Each line,
// a branch's from its tip or a merge's other parent's, takes the next of
// `colors` in turn, unlike its neighbors' where it can, and keeps it down to
// where it ends. `trunk`, the commits of a line (firstParentLine) to keep on
// the first lane, in the first color, alone, as the default branch's.
// `linear` draws each commit's parent as the next listed, as for the commits
// touching a directory, whose parents GitHub doesn't rewrite to those listed.
export function historyLayout(ordered, { linear = false, trunk = null, colors: palette = 8 } = {}) {
  const known = new Set(ordered.map(commit => commit.sha))
  const reserved = trunk?.size > 0 ? 1 : 0
  const lanes = []
  const colors = []
  const rows = []
  const segments = []
  const stubs = []
  let width = 0
  let turn = 0
  const freeLane = () => {
    const free = lanes.indexOf(null, reserved)
    return free === -1 ? Math.max(lanes.length, reserved) : free
  }
  // The lane a commit's node takes: the trunk's, the first waiting for it,
  // else (null) a free one.
  const laneOf = sha => {
    if (trunk?.has(sha)) return 0
    const waiting = lanes.indexOf(sha)
    return waiting === -1 ? null : waiting
  }
  const newColor = lane => {
    const span = Math.max(1, palette - reserved)
    const neighbors = new Set([lane - 1, lane + 1].filter(side => lanes[side] != null).map(side => colors[side]))
    const skip = Array.from({ length: span }, (_, step) => step).find(step => !neighbors.has(reserved + (turn + step) % span)) ?? 0
    const color = reserved + (turn + skip) % span
    turn = (turn + skip + 1) % span
    return color
  }
  for (const [row, commit] of ordered.entries()) {
    const next = ordered[row + 1]
    const all = linear ? next ? [next.sha] : commit.parents.slice(0, 1) : [...new Set(commit.parents)]
    const parents = all.filter(parent => known.has(parent))
    const awaited = laneOf(commit.sha)
    const col = awaited ?? freeLane()
    const color = trunk?.has(commit.sha) ? 0 : awaited === null ? newColor(col) : colors[col]
    for (const [lane, sha] of lanes.entries()) if (sha === commit.sha) lanes[lane] = null
    rows.push({ commit, col, color })
    // Where each lane goes from this row: from its own place, but the lanes
    // this commit's parents take, from its node.
    const fromNode = new Set()
    lanes[col] = parents[0] ?? null
    colors[col] = color
    if (parents.length > 0) fromNode.add(col)
    const merges = []
    for (const parent of parents.slice(1)) {
      const waiting = trunk?.has(parent) ? 0 : lanes.indexOf(parent)
      if (waiting === -1 || lanes[waiting] !== parent) {
        const lane = freeLane()
        colors[lane] = newColor(lane)
        lanes[lane] = parent
        fromNode.add(lane)
      } else merges.push(waiting)
    }
    let straight = lanes[col] === null
    for (const _parent of all.filter(parent => !known.has(parent))) {
      stubs.push({ row, col, straight, color })
      straight = false
    }
    for (let lane = 0; lane < lanes.length; lane++) lanes[lane] ??= null
    width = Math.max(width, lanes.length)
    if (next) {
      const nextCol = laneOf(next.sha)
      for (const [lane, sha] of lanes.entries()) {
        if (sha === null) continue
        segments.push({ row, from: fromNode.has(lane) ? col : lane, to: sha === next.sha ? nextCol : lane, color: colors[lane] })
      }
      // A merge's parent another lane already waits for: a line from the
      // node into that lane, in its color.
      for (const lane of merges) segments.push({ row, from: col, to: lanes[lane] === next.sha ? nextCol : lane, color: colors[lane] })
    }
    while (lanes.length > 0 && lanes.at(-1) === null) lanes.pop()
  }
  return { rows, segments, stubs, width: Math.max(width, rows.length > 0 ? 1 : 0) }
}
