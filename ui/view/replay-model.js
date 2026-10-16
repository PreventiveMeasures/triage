// The code viewer's Replay (repository-replay.js), as Gource draws a
// repository's history: its directories a tree grown from its root, each
// directory's files clustered about it, a dot each in its kind's color, and
// those who made each commit flying to the files it changes, a beam to each,
// each file added, modified or removed as its beam reaches it. Pure but for
// the time it is given: the commits played and when each plays, the scene
// they make, and where everything in it sits and moves to.

const DAY_MS = 86_400_000

// How many of the latest commits Replay plays, as the reader picks.
export const REPLAY_COUNTS = [100, 300, 1000]

// The commits played of those listed: the latest `count` with a time but
// merges (whose files their other parents' commits change), oldest first.
export function playedCommits(commits, count) {
  return commits.filter(commit => commit.parents.length <= 1 && Number.isFinite(commit.committedAt))
    .toSorted((a, b) => b.committedAt - a.committedAt).slice(0, count).toReversed()
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
    x: parent?.x ?? 0, y: parent?.y ?? 0, tx: parent?.tx ?? 0, ty: parent?.ty ?? 0, cluster: 0, ring: 0, extent: 0, touched: Number.NEGATIVE_INFINITY }
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
  for (let empty = dir; empty.parent && empty.files.length === 0 && empty.dirs.length === 0; empty = empty.parent) {
    empty.parent.dirs.splice(empty.parent.dirs.indexOf(empty), 1)
    scene.dirs.delete(empty.path)
  }
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

// Where each directory sits, as a balloon tree lays one out: the root's at
// the middle, its directories on a ring about it all the way round, each
// other's on a ring about it facing away from its parent, half a turn wide;
// each ring clear of its directory's files, and wide enough for the trees on
// it, each in a share of it about as wide as its tree is seen from there;
// then any directories' files the shares, being near, left on another's
// moved apart (separate).
export function layoutScene(scene) {
  measure(scene.root)
  place(scene.root, 0, 0, -Math.PI / 2, 2 * Math.PI)
  separate([...scene.dirs.values()])
  scene.layout = false
}

// Directories' files, `dirs` (each after its parent, as a scene holds them),
// moved off one another: round after round, any two whose files and the
// gap about them overlap pushed apart along the line between them, half
// each, or, one under the other, the one under alone, each tree moved with
// its directory and the root where it is, till none overlap, or as many
// rounds as SEPARATE_ROUNDS; an overlap of less than SLACK, the pushes'
// own rounding, none. Those that may overlap are found sweeping across
// them, by where each begins, left to right.
const SEPARATE_ROUNDS = 40
const SLACK = 0.5
function separate(dirs) {
  const under = (dir, above) => {
    for (let at = dir.parent; at && at.depth >= above.depth; at = at.parent) if (at === above) return true
    return false
  }
  for (let round = 0; round < SEPARATE_ROUNDS; round++) {
    const pushes = new Map()
    const push = (dir, x, y) => {
      const held = pushes.get(dir)
      if (held) {
        held[0] += x
        held[1] += y
      } else pushes.set(dir, [x, y])
    }
    const swept = dirs.toSorted((a, b) => a.tx - a.cluster - (b.tx - b.cluster))
    for (const [at, one] of swept.entries()) {
      for (let next = at + 1; next < swept.length && swept[next].tx - swept[next].cluster < one.tx + one.cluster; next++) {
        const other = swept[next]
        const need = one.cluster + other.cluster
        const [dx, dy] = [other.tx - one.tx, other.ty - one.ty]
        if (Math.abs(dy) >= need - SLACK) continue
        const apart = Math.hypot(dx, dy)
        if (apart >= need - SLACK) continue
        const angle = apart > 1e-6 ? Math.atan2(dy, dx) : keyAngle(other.path)
        const [ux, uy] = [Math.cos(angle) * (need - apart), Math.sin(angle) * (need - apart)]
        if (under(other, one)) push(other, ux, uy)
        else if (under(one, other)) push(one, -ux, -uy)
        else {
          push(one, -ux / 2, -uy / 2)
          push(other, ux / 2, uy / 2)
        }
      }
    }
    if (pushes.size === 0) return
    // Each directory by its own push and those of the directories above it.
    const moved = new Map()
    for (const dir of dirs) {
      const own = pushes.get(dir)
      const above = dir.parent ? moved.get(dir.parent) : null
      const by = own && above ? [own[0] + above[0], own[1] + above[1]] : own ?? above
      if (!by) continue
      moved.set(dir, by)
      dir.tx += by[0]
      dir.ty += by[1]
    }
  }
}

// How far a directory's files reach from it, half a gap past (`cluster`),
// the ring its directories sit on (`ring`), and how far its tree reaches
// from it (`extent`): a tree facing away from its parent comes no nearer it
// than its own files, and is seen from it no wider than the half disc of
// its extent.
function measure(dir) {
  for (const child of dir.dirs) measure(child)
  dir.cluster = Math.max(clusterRadius(dir.files.length), FILE_DOT) + GAP / 2
  if (dir.dirs.length === 0) {
    dir.ring = 0
    dir.extent = dir.cluster
    return
  }
  const wedge = dir.parent ? Math.PI : 2 * Math.PI
  let ring = dir.cluster + Math.max(...dir.dirs.map(child => child.cluster))
  for (let tries = 0; tries < 80 && shares(dir.dirs, ring) > wedge; tries++) ring *= 1.1
  dir.ring = ring
  dir.extent = Math.max(dir.cluster, ring + Math.max(...dir.dirs.map(child => child.extent)))
}

// The angle the tree of `dir` takes on a ring of `radius`, and the trees of
// `dirs` all together: a tree is seldom as wide as its extent's half disc,
// so a share is a little narrower (TIGHT), trees' empty edges overlapping
// where they are, and any files that do moved apart after (separate); never
// narrower than its own files.
const TIGHT = 0.8
const shareOf = (dir, radius) => 2 * Math.max(TIGHT * Math.atan(dir.extent / radius), Math.asin(Math.min(1, dir.cluster / radius)))
const shares = (dirs, radius) => dirs.reduce((sum, dir) => sum + shareOf(dir, radius), 0)

// A directory placed at (`x`, `y`), its directories in the `wedge` about
// `facing`, each in its share, the room left between them.
function place(dir, x, y, facing, wedge) {
  dir.tx = x
  dir.ty = y
  if (dir.dirs.length === 0) return
  const taken = shares(dir.dirs, dir.ring)
  const full = wedge >= 2 * Math.PI
  const room = Math.max(0, wedge - taken) / (full ? dir.dirs.length : dir.dirs.length + 1)
  let angle = facing - (full ? 0 : wedge / 2) + (full ? 0 : room)
  for (const child of dir.dirs) {
    const share = shareOf(child, dir.ring)
    const at = angle + share / 2
    place(child, x + dir.ring * Math.cos(at), y + dir.ring * Math.sin(at), at, Math.PI)
    angle += share + room
  }
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
