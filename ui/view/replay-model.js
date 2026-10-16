// The code viewer's Replay (repository-replay.js), as Gource draws a
// repository's history: its directories a tree grown from its root, each
// directory's files clustered about it, a dot each in its kind's color, and
// those who made each commit flying to the files it changes, a beam to each,
// each file added, modified or removed as its beam reaches it. Pure but for
// the time it is given: the commits played and when each plays, the scene
// they make, and where everything in it sits and moves to.

import { historyOrder } from './history-graph.js'

const DAY_MS = 86_400_000

// How many of the latest commits Replay plays, as the reader picks.
export const REPLAY_COUNTS = [100, 300, 1000]

// The commits played of those listed: the latest `count` with a time but
// merges (whose files their other parents' commits change), oldest first,
// as Commits orders them (history-graph.js historyOrder): by their times,
// but never a commit before its parent, whatever a clock off dates them.
export function playedCommits(commits, count) {
  return historyOrder(commits).filter(commit => commit.parents.length <= 1 && Number.isFinite(commit.committedAt)).slice(0, count).toReversed()
}

// When each commit plays, in seconds of replay at 1×: the first at once,
// each after the one before by their times apart, a day DAY_SECONDS, but no
// sooner than MIN_GAP, nor later than MAX_GAP, quiet spells skipped as
// Gource's --auto-skip-seconds skips them.
export const DAY_SECONDS = 1
export const MIN_GAP = 0.08
export const MAX_GAP = 0.6
export function playTimes(commits) {
  const times = []
  for (const [at, commit] of commits.entries()) {
    const days = at === 0 ? 0 : (commit.committedAt - commits[at - 1].committedAt) / DAY_MS
    times.push(at === 0 ? 0 : times[at - 1] + Math.min(MAX_GAP, Math.max(MIN_GAP, days * DAY_SECONDS)))
  }
  return times
}

// A file's kind, as its color tells it: its extension, lowercased; none
// ('') for a name with no dot past its first character.
export function extensionOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

// The colors of kinds of files, `slots` of them, each kind's its own once
// it has one, never another's: the kinds counted most (`counts`, by
// extension) not yet colored take those left, the most first; the rest,
// and files of no extension, are Other's.
export function assignColors(assigned, counts, slots) {
  const taken = new Set(assigned.values())
  const free = Array.from({ length: slots }, (_, slot) => slot).filter(slot => !taken.has(slot))
  const next = [...counts].filter(([extension]) => extension !== '' && !assigned.has(extension))
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  for (const [extension] of next.slice(0, free.length)) assigned.set(extension, free.shift())
  return assigned
}

// Seconds of replay a beam shows for, a file touched glows for, a file
// removed shrinks away over, one who made a commit stays after it, then
// fades over, and the most the changes of a commit's files are spread over,
// each after the one before.
export const BEAM_S = 0.9
export const GLOW_S = 2
export const REMOVE_S = 1
export const IDLE_S = 5
export const FADE_S = 1
const STAGGER_S = 0.06

// A scene: the tree of directories from its root, each directory and file
// by its path, the files going (removed, not yet gone), those who made
// commits by who they are, the beams shown, the changes due (made as their
// time comes) and whether the tree changed since it was laid out
// (`layout`).
export function createScene() {
  const root = directory('', null)
  return { root, dirs: new Map([['', root]]), files: new Map(), going: new Set(), users: new Map(), beams: [], due: [], layout: true }
}

// A directory, grown out of its parent's place, and there till laid out.
function directory(path, parent) {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), parent, dirs: [], files: [], depth: parent ? parent.depth + 1 : 0,
    x: parent?.x ?? 0, y: parent?.y ?? 0, tx: parent?.tx ?? 0, ty: parent?.ty ?? 0, cluster: 0, radius: 0, node: [0, 0], at: [0, 0], lx: undefined, ly: undefined,
    packed: false, dirty: true, touched: Number.NEGATIVE_INFINITY }
}

// The directory `path` names, made with those above it where it isn't,
// among its parent's in the order of their names.
function directoryOf(scene, path) {
  const held = scene.dirs.get(path)
  if (held) return held
  const slash = path.lastIndexOf('/')
  const parent = directoryOf(scene, slash === -1 ? '' : path.slice(0, slash))
  const made = directory(path, parent)
  let [low, high] = [0, parent.dirs.length]
  while (low < high) {
    const middle = (low + high) >> 1
    if (parent.dirs[middle].name < made.name) low = middle + 1
    else high = middle
  }
  parent.dirs.splice(low, 0, made)
  scene.dirs.set(path, made)
  unsettle(parent)
  scene.layout = true
  return made
}

// A file changed at `at` (`kind`: A, M or D): one added or modified made
// where it isn't, back where it was going; one removed going, gone
// REMOVE_S later (removeGone). The file, or null for one removed that
// isn't there.
export function changeFile(scene, path, kind, at) {
  let file = scene.files.get(path)
  if (kind === 'D' && !file) return null
  if (!file) {
    const slash = path.lastIndexOf('/')
    const dir = directoryOf(scene, slash === -1 ? '' : path.slice(0, slash))
    file = { path, name: path.slice(slash + 1), extension: extensionOf(path), dir, ox: 0, oy: 0, touched: at, kind, removed: null }
    dir.files.push(file)
    scene.files.set(path, file)
    unsettle(dir)
    scene.layout = true
  }
  file.touched = at
  file.kind = kind
  file.removed = kind === 'D' ? file.removed ?? at : null
  if (kind === 'D') scene.going.add(file)
  else scene.going.delete(file)
  for (let dir = file.dir; dir; dir = dir.parent) dir.touched = at
  return file
}

// A file gone from the tree, and the directories it leaves empty.
function removeFile(scene, file) {
  const { dir } = file
  dir.files.splice(dir.files.indexOf(file), 1)
  scene.files.delete(file.path)
  scene.going.delete(file)
  let left = dir
  for (; left.parent && left.files.length === 0 && left.dirs.length === 0; left = left.parent) {
    left.parent.dirs.splice(left.parent.dirs.indexOf(left), 1)
    scene.dirs.delete(left.path)
  }
  unsettle(left)
  scene.layout = true
}

// A commit's files' changes, as the server answers them (`[path, status,
// from]`, repository-changes.ts), as files changed: a rename the file it
// was removed and the file it is added.
export const fileChanges = files => files.flatMap(([path, status, from]) => status === 'R' ? [[from, 'D'], [path, 'A']] : [[path, status]])

// A commit played at `at`: those who made it (`makers`, each its `key`)
// to its files, each file's change due a little after the one before, all
// within `span`.
export function playCommit(scene, makers, files, at, span) {
  const users = makers.map(maker => {
    const user = scene.users.get(maker.key) ?? { ...maker, x: Number.NaN, y: Number.NaN, active: at }
    scene.users.set(maker.key, user)
    user.active = at
    return user
  })
  const changes = fileChanges(files)
  const step = changes.length > 1 ? Math.min(STAGGER_S, span / changes.length) : 0
  for (const [index, [path, kind]] of changes.entries()) scene.due.push({ at: at + index * step, path, kind, users })
  scene.due.sort((a, b) => a.at - b.at)
}

// A commit's files' changes made at once, as a replay sought past it has
// them made: none beamed to, none glowing, those removed gone.
export function settleCommit(scene, files) {
  for (const [path, kind] of fileChanges(files)) {
    const file = changeFile(scene, path, kind, Number.NEGATIVE_INFINITY)
    if (file && kind === 'D') removeFile(scene, file)
  }
}

// What makes the scene's files a tree's (`files`, as many as were read,
// `cut` where more were not), once the changes due and `changes` (a
// commit's, as fileChanges gives them) are made: each file of the tree it
// wouldn't hold, added; each it would hold the tree doesn't, removed, but
// where the tree was cut. As a commit whose files were more than were read
// is made whole by the files it leaves.
export function treeChanges(scene, files, cut, changes = []) {
  const held = new Set([...scene.files.values()].filter(file => file.removed === null).map(file => file.path))
  for (const [path, kind] of [...scene.due.map(due => [due.path, due.kind]), ...changes]) {
    if (kind === 'D') held.delete(path)
    else held.add(path)
  }
  const tree = new Set(files)
  return [...files.filter(path => !held.has(path)).map(path => [path, 'A']), ...cut ? [] : [...held].filter(path => !tree.has(path)).map(path => [path, 'D'])]
}

// The scene at `now`: the changes due by then made, a beam to each file from
// each who made its commit; the beams past, the files removed, and those
// idle past fading, gone.
export function advanceScene(scene, now) {
  let made = 0
  for (; made < scene.due.length && scene.due[made].at <= now; made++) {
    const { at, path, kind, users } = scene.due[made]
    const file = changeFile(scene, path, kind, at)
    if (file) for (const user of users) scene.beams.push({ user, file, kind, at })
  }
  if (made > 0) scene.due.splice(0, made)
  scene.beams = scene.beams.filter(beam => now - beam.at < BEAM_S)
  for (const file of [...scene.going]) if (now - file.removed >= REMOVE_S) removeFile(scene, file)
  for (const [key, user] of scene.users) if (now - user.active > IDLE_S + FADE_S) scene.users.delete(key)
}

// Geometry, in the scene's own units: files a step apart about their
// directory, each a dot of FILE_DOT, the directories' clusters GAP apart.
export const FILE_STEP = 6
export const FILE_DOT = 2.2
const GAP = 12
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
// Those who made a commit, how far from the files they change they stop,
// and from each other.
const STANDOFF = 46
export const SPACE = 34

// How far a directory's files reach from it, as many as `count`.
export const clusterRadius = count => count === 0 ? 0 : FILE_STEP * 0.62 * Math.sqrt(count) + FILE_DOT

// Where the `index`th of a directory's files sits from it: on a sunflower's
// spiral, the first at its middle, each after a turn of the golden angle
// further out.
export function fileOffset(index) {
  const radius = FILE_STEP * 0.62 * Math.sqrt(index + 0.5)
  return [radius * Math.cos(index * GOLDEN_ANGLE), radius * Math.sin(index * GOLDEN_ANGLE)]
}

// Where each directory sits, its tree packed about it: a directory's files
// a disc about it (`cluster`, half a gap past them), and each tree under it
// a disc (`radius`) about its own, beside its files and each other's as
// near as they go without one on another, the tree turned to face away from
// the directory it is under. Packed first all at once, the largest trees
// nearest (packSiblings), the tree as small as it goes; then, as it
// changes, only the directories it changes under laid out again, and those
// no more than they must be (relax): a tree new set in the nearest room for
// it, one grown pushing those it reaches aside, the smaller the further;
// so a replay's trees move a little as it plays, not all at once.
export function layoutScene(scene) {
  measure(scene.root)
  place(scene.root, -scene.root.node[0], -scene.root.node[1], 0)
  scene.layout = false
}

// A directory, and those above it, to be laid out again.
function unsettle(dir) {
  for (let at = dir; at && !at.dirty; at = at.parent) at.dirty = true
}

// How far a directory's files reach from it, half a gap past (`cluster`),
// where the trees under it are, each its disc's middle from its files
// (`lx`, `ly`), and the disc its tree fills (`radius`): where its files are
// in it (`node`), and where each tree under it is (`at`), from its middle.
function measure(dir) {
  if (!dir.dirty) return
  for (const child of dir.dirs) measure(child)
  dir.cluster = Math.max(clusterRadius(dir.files.length), FILE_DOT) + GAP / 2
  const own = { x: 0, y: 0, r: dir.cluster }
  const trees = dir.dirs.map(child => ({ child, x: child.lx, y: child.ly, r: child.radius }))
  if (dir.packed) relax(own, trees)
  else {
    // The largest beside its files first, then each the nearest it goes.
    const packed = [own, ...trees.toSorted((a, b) => b.r - a.r || (a.child.name < b.child.name ? -1 : 1))]
    packSiblings(packed)
    for (const tree of trees) [tree.x, tree.y] = [tree.x - own.x, tree.y - own.y]
    ;[own.x, own.y] = [0, 0]
  }
  const disc = enclose([own, ...trees])
  dir.radius = disc.r
  dir.node = [-disc.x, -disc.y]
  for (const tree of trees) {
    ;[tree.child.lx, tree.child.ly] = [tree.x, tree.y]
    tree.child.at = [tree.x - disc.x, tree.y - disc.y]
  }
  dir.packed = true
  dir.dirty = false
}

// A directory, its disc's middle at (`x`, `y`) turned by `turn`, and the
// trees under it, each turned to face away from it.
function place(dir, x, y, turn) {
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)]
  const at = ([dx, dy]) => [x + dx * cos - dy * sin, y + dx * sin + dy * cos]
  ;[dir.tx, dir.ty] = at(dir.node)
  for (const child of dir.dirs) {
    const [cx, cy] = at(child.at)
    place(child, cx, cy, Math.atan2(cy - dir.ty, cx - dir.tx))
  }
}

// Discs (`circles`, each its `r`) packed as tight as they go, each beside
// those before it, as near their middle as it goes (Wang, Wang, Dai and
// Wang's front-chain packing, as d3-hierarchy packs siblings): each its
// `x` and `y`.
function packSiblings(circles) {
  const [a, b, c] = circles
  if (!a) return
  ;[a.x, a.y] = [0, 0]
  if (!b) return
  ;[a.x, b.x, b.y] = [-b.r, a.r, 0]
  if (!c) return
  besides(b, a, c)
  // The chain of discs on the packing's edge, from `head` on round to `tail`.
  let head = { c: a }, tail = { c: b }
  const third = { c }
  head.next = third.previous = tail
  tail.next = head.previous = third
  third.next = tail.previous = head
  pack: for (let i = 3; i < circles.length; i++) {
    const circle = circles[i]
    besides(head.c, tail.c, circle)
    // The nearest disc on the chain it is on, ahead or behind, if any.
    let ahead = tail.next, aheadBy = tail.c.r, behind = head.previous, behindBy = head.c.r
    do {
      if (aheadBy <= behindBy) {
        if (overlaps(ahead.c, circle)) {
          tail = ahead
          head.next = tail
          tail.previous = head
          i--
          continue pack
        }
        aheadBy += ahead.c.r
        ahead = ahead.next
      } else {
        if (overlaps(behind.c, circle)) {
          head = behind
          head.next = tail
          tail.previous = head
          i--
          continue pack
        }
        behindBy += behind.c.r
        behind = behind.previous
      }
    } while (ahead !== behind.next)
    // On none: between the two it is beside, and the pair nearest the middle
    // those the next goes beside.
    const placed = { c: circle, previous: head, next: tail }
    head.next = tail.previous = tail = placed
    let nearest = nearness(head)
    for (let link = placed.next; link !== tail; link = link.next) {
      const near = nearness(link)
      if (near < nearest) [head, nearest] = [link, near]
    }
    tail = head.next
  }
}

// `c` set beside `a` and `b`, touching both.
function besides(b, a, c) {
  const [dx, dy] = [b.x - a.x, b.y - a.y]
  const apart = dx * dx + dy * dy
  if (!apart) {
    ;[c.x, c.y] = [a.x + c.r, a.y]
    return
  }
  const toA = (a.r + c.r) ** 2, toB = (b.r + c.r) ** 2
  if (toA > toB) {
    const along = (apart + toB - toA) / (2 * apart)
    const across = Math.sqrt(Math.max(0, toB / apart - along * along))
    ;[c.x, c.y] = [b.x - along * dx - across * dy, b.y - along * dy + across * dx]
  } else {
    const along = (apart + toA - toB) / (2 * apart)
    const across = Math.sqrt(Math.max(0, toA / apart - along * along))
    ;[c.x, c.y] = [a.x + along * dx - across * dy, a.y + along * dy + across * dx]
  }
}

const overlaps = (a, b) => {
  const reach = a.r + b.r - 1e-6
  return reach > 0 && reach * reach > (b.x - a.x) ** 2 + (b.y - a.y) ** 2
}

// How near the middle a disc on the chain and the next are, between them.
function nearness(link) {
  const [a, b] = [link.c, link.next.c]
  const both = a.r + b.r
  return ((a.x * b.r + b.x * a.r) / both) ** 2 + ((a.y * b.r + b.y * a.r) / both) ** 2
}

// The least disc about `circles`, each whole in it (Welzl's, as Matoušek,
// Sharir and Welzl move each circle it leaves out to the front, as
// d3-hierarchy encloses packed circles): its middle, `x` and `y`, and `r`;
// taken in an order of their own, the same each time, a disc tried from
// one circle, then two, then three, each it leaves out added and the rest
// tried again. Where rounding leaves none (a disc of three in a line), or
// one not settling in as many tries as ENCLOSE_TRIES a circle, the disc
// about their box's middle reaching them all.
const ENCLOSE_TRIES = 64
function enclose(circles) {
  const order = circles.toSorted((a, b) => keyAngle(`${a.x},${a.y}`) - keyAngle(`${b.x},${b.y}`))
  let basis = [], disc = null, tries = 0
  for (let at = 0; at < order.length; at++) {
    if (disc && within(disc, order[at])) continue
    basis = widened(basis, order[at])
    disc = discOf(basis)
    if (!Number.isFinite(disc.x + disc.y + disc.r) || ++tries > ENCLOSE_TRIES * order.length) return about(circles)
    at = -1
  }
  return disc
}

function about(circles) {
  const [x, y] = [0, 1].map(axis => {
    const ends = circles.flatMap(circle => axis === 0 ? [circle.x - circle.r, circle.x + circle.r] : [circle.y - circle.r, circle.y + circle.r])
    return (Math.min(...ends) + Math.max(...ends)) / 2
  })
  return { x, y, r: Math.max(...circles.map(circle => Math.hypot(circle.x - x, circle.y - y) + circle.r)) }
}

// The least basis of circles a disc about `basis` and `circle` is made of.
function widened(basis, circle) {
  if (basis.every(other => within(circle, other))) return [circle]
  for (const one of basis) if (!holds(circle, one) && basis.every(other => within(discOf([one, circle]), other))) return [one, circle]
  for (const [at, one] of basis.entries()) {
    for (const other of basis.slice(at + 1)) {
      if (!holds(discOf([one, other]), circle) && !holds(discOf([one, circle]), other) && !holds(discOf([other, circle]), one)
        && basis.every(held => within(discOf([one, other, circle]), held))) return [one, other, circle]
    }
  }
  return [...basis, circle].length <= 3 ? [...basis, circle] : [circle]
}

// Whether disc `a` holds `b` whole, short of its edge (`holds`), or as
// near as rounding tells (`within`).
const holds = (a, b) => a.r - b.r >= 0 && (a.r - b.r) ** 2 >= (b.x - a.x) ** 2 + (b.y - a.y) ** 2
function within(a, b) {
  const room = a.r - b.r + Math.max(a.r, b.r, 1) * 1e-9
  return room > 0 && room * room > (b.x - a.x) ** 2 + (b.y - a.y) ** 2
}

// The least disc touching each of one, two or three circles from without.
function discOf([a, b, c]) {
  if (!b) return { x: a.x, y: a.y, r: a.r }
  if (!c) {
    const [dx, dy, dr] = [b.x - a.x, b.y - a.y, b.r - a.r]
    const apart = Math.hypot(dx, dy) || 1e-12
    return { x: (a.x + b.x + dx / apart * dr) / 2, y: (a.y + b.y + dy / apart * dr) / 2, r: (apart + a.r + b.r) / 2 }
  }
  const [a2, a3, b2, b3, c2, c3] = [a.x - b.x, a.x - c.x, a.y - b.y, a.y - c.y, b.r - a.r, c.r - a.r]
  const d1 = a.x ** 2 + a.y ** 2 - a.r ** 2
  const [d2, d3] = [d1 - b.x ** 2 - b.y ** 2 + b.r ** 2, d1 - c.x ** 2 - c.y ** 2 + c.r ** 2]
  const ab = a3 * b2 - a2 * b3
  const [xa, xb, ya, yb] = [(b2 * d3 - b3 * d2) / (ab * 2) - a.x, (b3 * c2 - b2 * c3) / ab, (a3 * d2 - a2 * d3) / (ab * 2) - a.y, (a2 * c3 - a3 * c2) / ab]
  const [qa, qb, qc] = [xb ** 2 + yb ** 2 - 1, 2 * (a.r + xa * xb + ya * yb), xa ** 2 + ya ** 2 - a.r ** 2]
  const r = -(Math.abs(qa) > 1e-6 ? (qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa) : qc / qb)
  return { x: a.x + xa + xb * r, y: a.y + ya + yb * r, r }
}

// The trees under a directory (`trees`, each where it was, `x` and `y` from
// its files, `own`, and its `r`) moved no more than they must: one new (no
// `x`) set in the nearest room for it (roomFor); then, round after round,
// any two on one another pushed
// apart along the line between them, the smaller the further, and any on
// its files pushed out from them, till none are, or as many rounds as
// SEPARATE_ROUNDS; an overlap of less than SLACK, the pushes' own rounding,
// none. Room left where one shrank, or went, is left.
const SEPARATE_ROUNDS = 60
const SLACK = 0.5
function relax(own, trees) {
  const set = trees.filter(tree => tree.x !== undefined)
  for (const tree of trees) {
    if (tree.x !== undefined) continue
    roomFor(tree, own, set)
    set.push(tree)
  }
  for (let round = 0; round < SEPARATE_ROUNDS; round++) {
    let moved = false
    for (const tree of trees) {
      const apart = Math.hypot(tree.x, tree.y), need = own.r + tree.r
      if (apart >= need - SLACK) continue
      const angle = apart > 1e-6 ? Math.atan2(tree.y, tree.x) : keyAngle(tree.child.name)
      ;[tree.x, tree.y] = [Math.cos(angle) * need, Math.sin(angle) * need]
      moved = true
    }
    const swept = trees.toSorted((a, b) => a.x - a.r - (b.x - b.r))
    for (const [at, one] of swept.entries()) {
      for (let next = at + 1; next < swept.length && swept[next].x - swept[next].r < one.x + one.r; next++) {
        const other = swept[next]
        const need = one.r + other.r
        const [dx, dy] = [other.x - one.x, other.y - one.y]
        if (Math.abs(dy) >= need - SLACK) continue
        const apart = Math.hypot(dx, dy)
        if (apart >= need - SLACK) continue
        const angle = apart > 1e-6 ? Math.atan2(dy, dx) : keyAngle(other.child.name)
        // Each pushed by the other's share of their two discs' room.
        const [oneShare, otherShare] = [other.r ** 2, one.r ** 2].map(share => share / (one.r ** 2 + other.r ** 2) * (need - apart))
        ;[one.x, one.y] = [one.x - Math.cos(angle) * oneShare, one.y - Math.sin(angle) * oneShare]
        ;[other.x, other.y] = [other.x + Math.cos(angle) * otherShare, other.y + Math.sin(angle) * otherShare]
        moved = true
      }
    }
    if (!moved) return
  }
}

// Where a tree new to a directory goes: the spot nearest its files where it
// touches none of the trees `set` nor its files, of those where it touches
// two of them (its files and one of the trees, or two trees); with none,
// beside its files at its own angle, or past every tree out along it.
function roomFor(tree, own, set) {
  const free = spot => Math.hypot(spot.x, spot.y) >= own.r + tree.r - SLACK
    && set.every(other => Math.hypot(other.x - spot.x, other.y - spot.y) >= other.r + tree.r - SLACK)
  const spots = []
  const touching = (one, other) => {
    for (const [a, b] of [[one, other], [other, one]]) {
      const spot = { r: tree.r }
      besides(a, b, spot)
      spots.push(spot)
    }
  }
  for (const other of set) touching(own, other)
  const swept = set.toSorted((a, b) => a.x - a.r - (b.x - b.r))
  for (const [at, one] of swept.entries()) {
    for (let next = at + 1; next < swept.length && swept[next].x - swept[next].r < one.x + one.r + 2 * tree.r; next++) {
      const other = swept[next]
      if (Math.hypot(other.x - one.x, other.y - one.y) < one.r + other.r + 2 * tree.r) touching(one, other)
    }
  }
  const angle = keyAngle(tree.child.name)
  if (set.length === 0) spots.push({ x: Math.cos(angle) * (own.r + tree.r), y: Math.sin(angle) * (own.r + tree.r) })
  let best = null
  for (const spot of spots) if (free(spot) && (!best || Math.hypot(spot.x, spot.y) < Math.hypot(best.x, best.y))) best = spot
  const beyond = Math.max(own.r, ...set.map(other => Math.hypot(other.x, other.y) + other.r)) + tree.r
  ;[tree.x, tree.y] = best ? [best.x, best.y] : [Math.cos(angle) * beyond, Math.sin(angle) * beyond]
}

// Everything `dt` seconds nearer where it sits: directories toward their
// places, files about their directories, those who made commits toward the
// files their beams reach, stopping short of them, and apart from each other
// where they come closer than `space` (SPACE where not told, as near as the
// scene is drawn on); one new where its first beams' files are, further out.
export function moveScene(scene, dt, space = SPACE) {
  const ease = rate => 1 - Math.exp(-dt * rate)
  const dirs = ease(3), files = ease(6), users = ease(2.5)
  for (const dir of scene.dirs.values()) {
    dir.x += (dir.tx - dir.x) * dirs
    dir.y += (dir.ty - dir.y) * dirs
    for (const [index, file] of dir.files.entries()) {
      const [ox, oy] = fileOffset(index)
      file.ox += (ox - file.ox) * files
      file.oy += (oy - file.oy) * files
    }
  }
  const reached = new Map()
  for (const { user, file } of scene.beams) {
    const sum = reached.get(user) ?? reached.set(user, { x: 0, y: 0, count: 0 }).get(user)
    sum.x += file.dir.x + file.ox
    sum.y += file.dir.y + file.oy
    sum.count++
  }
  for (const [user, sum] of reached) {
    const [cx, cy] = [sum.x / sum.count, sum.y / sum.count]
    if (Number.isNaN(user.x)) {
      const angle = keyAngle(user.key)
      ;[user.x, user.y] = [cx + Math.cos(angle) * STANDOFF * 3, cy + Math.sin(angle) * STANDOFF * 3]
    }
    const away = Math.hypot(user.x - cx, user.y - cy) || 1
    const [tx, ty] = [cx + (user.x - cx) / away * STANDOFF, cy + (user.y - cy) / away * STANDOFF]
    user.x += (tx - user.x) * users
    user.y += (ty - user.y) * users
  }
  const placed = [...scene.users.values()].filter(user => !Number.isNaN(user.x))
  for (const [index, one] of placed.entries()) {
    for (const other of placed.slice(index + 1)) {
      const [dx, dy] = [other.x - one.x, other.y - one.y]
      const apart = Math.hypot(dx, dy)
      if (apart >= space) continue
      const [ux, uy] = apart > 0 ? [dx / apart, dy / apart] : [Math.cos(keyAngle(other.key)), Math.sin(keyAngle(other.key))]
      const push = (space - apart) / 2 * users
      ;[one.x, one.y, other.x, other.y] = [one.x - ux * push, one.y - uy * push, other.x + ux * push, other.y + uy * push]
    }
  }
}

// An angle of its own for each key, the same each time.
function keyAngle(key) {
  let hash = 0
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)) | 0
  return (hash >>> 0) / 2 ** 32 * 2 * Math.PI
}

// Everything moved to where it sits, as a replay sought shows it.
export function snapScene(scene) {
  if (scene.layout) layoutScene(scene)
  for (const dir of scene.dirs.values()) {
    dir.x = dir.tx
    dir.y = dir.ty
    for (const [index, file] of dir.files.entries()) [file.ox, file.oy] = fileOffset(index)
  }
}

// The box the scene's directories, files and those who made commits fill.
export function sceneBounds(scene) {
  const box = { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY }
  const add = (x, y, radius) => {
    box.minX = Math.min(box.minX, x - radius)
    box.minY = Math.min(box.minY, y - radius)
    box.maxX = Math.max(box.maxX, x + radius)
    box.maxY = Math.max(box.maxY, y + radius)
  }
  for (const dir of scene.dirs.values()) add(dir.x, dir.y, clusterRadius(dir.files.length) + FILE_DOT)
  for (const user of scene.users.values()) if (!Number.isNaN(user.x)) add(user.x, user.y, 14)
  return box
}
