// The code viewer's Replay (render-bundle.js), Activity's play button: the
// latest commits of the revision shown (below the repository's root, the
// directory's) played as Gource plays a repository's history
// (replay-model.js), on a canvas: its directories a tree, its files dots
// about them in their kinds' colors, those who made each commit flying to
// the files it changes, a beam to each, green where added, amber modified
// and red removed. It starts from the files as they were before the first
// commit it plays (GET /api/admin/repositories/tree, its parent's), from
// none where that commit is the repository's first. The commits are read
// as Commits reads them (repository-history.js), what each changes of the
// server (GET /api/admin/repositories/changes), the oldest first, ahead of
// where it plays, as a video buffers, and it waits where they aren't read
// yet.
// Over it, the day played, the commit last played, the kinds of files by
// their colors, and what lies under the pointer; under it, a play button,
// the commits to seek through, and how fast it plays. It starts playing as
// it opens, unless the reader asks for less motion. What was read, and where
// each replay is, is kept for the session that read it.
import { LitElement, html, nothing, svg } from 'lit'
import { state } from '#client/index.js'
import { fetchRepositoryChanges, fetchRepositoryTree } from './client-managed.js'
import { activityPicker } from './repository-activity.js'
import { rereadHistory, revisionHistory, subjectLinks, unwatchHistories, watchHistories } from './repository-history.js'
import { appUser, commitAgent, commitAuthors } from './github-users.js'
import { CLAUDE_MARK_PATH, COPILOT_MARK_PATH, OPENAI_MARK_PATH } from './icons.js'
import { GITHUB_AGENTS } from '../../common/managed/github-agents.ts'
import { styleMap } from './style-map.js'
import { BEAM_S, FADE_S, FILE_DOT, GLOW_S, IDLE_S, MAX_GAP, REMOVE_S, REPLAY_COUNTS, SPACE, advanceScene, assignColors, clusterRadius, createScene,
  extensionOf, fileChanges, layoutScene, moveScene, playCommit, playTimes, playedCommits, sceneBounds, settleCommit, snapScene, treeChanges } from './replay-model.js'

// How fast it plays, as the reader picks; the commits read of the server
// first, so that it starts soon, and then at a time, as many as it answers.
const SPEEDS = [0.5, 1, 2, 4, 8]
const FIRST_READ = 20
const READ = 50
// Kinds of files colored, as many as the lanes Commits draws in, in their
// order; the rest Other's.
const KINDS = 8
// How near the canvas's edges the tree comes (clear of the day over it and
// the commit under it), how far it zooms in at most, how many files' names
// show at once at most, those who made a commit drawn how wide and how far
// apart, how often the tree is laid out again at most as it changes (a large
// one takes tens of milliseconds), and how long after the last commit it
// stops.
const MARGIN = { side: 40, top: 64, bottom: 40 }
const MAX_ZOOM = 3
const NAMES = 10
const FACE = 11
const SPREAD = 72
const LAYOUT_MS = 250
const END_S = 2
const STATUS = new Set(['A', 'M', 'D', 'R'])
const AGENT_AVATAR = /^(?:app|user)-[1-9]\d{0,11}$/u

const replays = new Map()
const changesRead = new Map()
const cutCommits = new Set()
const treesRead = new Map()
const shownElements = new Set()
const images = new Map()
let keptFor = null
// How many commits and how fast, as the reader last picked.
let shownCount = 300
let shownSpeed = 1

function sessionReplays() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    replays.clear()
    changesRead.clear()
    cutCommits.clear()
    treesRead.clear()
    keptFor = session
  }
  return replays
}

const repaint = () => { for (const element of shownElements) element.requestUpdate() }
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

// The replay of the latest `count` commits of the directory `repository`
// shows, as held, else new: the commits it plays and when (none till its
// history is read), the kinds of files counted (of how many commits) and
// colored, its scene, where it is (`clock`, `next` the commit to play
// next), and whether it plays, waits for what the next commit changes, or
// ended; how many made its commits, once counted.
function replayOf(repository, count) {
  const { repoId, commit, path } = repository
  const key = `${repoId}\0${commit}\0${path}\0${count}`
  const held = sessionReplays().get(key)
  if (held) return held
  const replay = { key, repoId, path, count, commits: null, times: [], reading: false, treeReading: false, error: null, counted: '', counts: new Map(),
    colors: new Map(), people: null, scene: createScene(), clock: 0, next: 0, playing: false, waiting: false, ended: false, started: false }
  replays.set(key, replay)
  return replay
}

// The commit a replay starts from: its first commit's parent, the files it
// holds (their paths from the directory shown) drawn at first, as read
// (startOf); none for the repository's first commit, which starts from no
// files; undefined till they are read.
const NO_FILES = { files: [], cut: false }
const startCommit = replay => replay.commits[0]?.parents[0] ?? null
const startKey = replay => `${replay.repoId}\0${replay.path}\0${startCommit(replay)}`
const startOf = replay => startCommit(replay) ? treesRead.get(startKey(replay)) : NO_FILES

// What a commit of a replay changes, its files' paths from the directory
// shown, as read; undefined where it isn't yet. One whose files were more
// than the server reads (`more`, repository-changes.ts MAX_FILES) is cut
// (isCut), and made whole by the files it leaves (treeOf), read too.
const changesKey = (replay, sha) => `${replay.repoId}\0${replay.path}\0${sha}`
const changesOf = (replay, sha) => changesRead.get(changesKey(replay, sha))
const isCut = (replay, sha) => cutCommits.has(changesKey(replay, sha))
const treeOf = (replay, sha) => treesRead.get(changesKey(replay, sha))
const readyOf = (replay, commit) => Boolean(changesOf(replay, commit.sha) && (!isCut(replay, commit.sha) || treeOf(replay, commit.sha)))

// How many of its commits, from its first, what each changes is read of.
function bufferedOf(replay) {
  let count = 0
  while (count < (replay.commits?.length ?? 0) && readyOf(replay, replay.commits[count])) count++
  return count
}

// A file as the server answers it (repository-changes.ts), its paths from
// the directory `path`; null for one malformed, or not within it.
function fileOf(file, path) {
  if (!Array.isArray(file) || !STATUS.has(file[1])) return null
  const within = name => typeof name === 'string' && (path === '' || name.startsWith(`${path}/`)) ? name.slice(path === '' ? 0 : path.length + 1) : null
  const [to, status, from] = [within(file[0]), file[1], within(file[2])]
  if (!to || (status === 'R' && !from)) return null
  return status === 'R' ? [to, status, from] : [to, status]
}

// The kinds of files a replay holds, of the files it starts from and those
// its commits add and modify, as far as they are read, counted again as more
// are, and the kinds counted most colored (replay-model.js assignColors).
function countKinds(replay) {
  const start = startOf(replay)
  const read = replay.commits.filter(commit => changesOf(replay, commit.sha))
  const counted = `${start ? start.files.length : '-'}\0${read.length}`
  if (counted === replay.counted) return
  replay.counted = counted
  replay.counts = new Map()
  const count = path => replay.counts.set(extensionOf(path), (replay.counts.get(extensionOf(path)) ?? 0) + 1)
  for (const path of start?.files ?? []) count(path)
  for (const commit of read) for (const [path, kind] of fileChanges(changesOf(replay, commit.sha))) if (kind !== 'D') count(path)
  assignColors(replay.colors, replay.counts, KINDS)
}

// The files commits hold that a replay needs, one commit's at a time, each
// once: those it starts from first, then those each cut commit leaves, from
// where it plays on; as many as the server answers (repository-changes.ts
// MAX_TREE_FILES), `cut` where there were more; a commit the server has
// none of, none.
function readTrees(replay) {
  if (replay.treeReading || replay.error) return
  const order = [...replay.commits.slice(replay.next), ...replay.commits.slice(0, replay.next)]
  const start = startCommit(replay) && !startOf(replay)
  const sha = start ? startCommit(replay) : order.find(commit => isCut(replay, commit.sha) && !treeOf(replay, commit.sha))?.sha
  if (!sha) return
  replay.treeReading = true
  const key = changesKey(replay, sha)
  fetchRepositoryTree(replay.repoId, replay.path, sha).then(answer => {
    if (sessionReplays().get(replay.key) !== replay) return null
    // A cut commit's the server has none of making nothing whole: as a tree
    // cut short of every file, removing none.
    const files = Array.isArray(answer?.files) ? answer.files.map(file => fileOf([file, 'A'], replay.path)?.[0]).filter(Boolean) : []
    treesRead.set(key, { files, cut: answer?.cut === true || (!start && !Array.isArray(answer?.files)) })
    return null
  }, err => {
    if (err?.name !== 'AbortError') replay.error = err?.message || (start ? 'The files the commits start from could not be read.' : 'The files a commit leaves could not be read.')
    return null
  }).finally(() => {
    replay.treeReading = false
    repaint()
  })
}

// What a commit makes of the files, made whole where it was cut: its files'
// changes, then those making the files the ones it leaves (treeChanges).
function commitChanges(replay, scene, commit) {
  const files = changesOf(replay, commit.sha)
  const tree = isCut(replay, commit.sha) ? treeOf(replay, commit.sha) : null
  return tree ? [...files, ...treeChanges(scene, tree.files, tree.cut, fileChanges(files))] : files
}

// A replay's scene at its `at`th commit: the files it starts from, and what
// the commits before it change, made at once, everything where it sits.
function sceneAt(replay, at) {
  const scene = createScene()
  scene.start = startOf(replay)
  settleCommit(scene, scene.start.files.map(path => [path, 'A']))
  for (const commit of replay.commits.slice(0, at)) settleCommit(scene, commitChanges(replay, scene, commit))
  snapScene(scene)
  return scene
}

// The next of a replay's commits what each changes is read of: those from
// where it plays on, the oldest first, else those before; as many as READ,
// or FIRST_READ before any is. One the server told nothing of changes none;
// one failing waits for the reader to ask again.
function readChanges(replay) {
  if (replay.reading || replay.error || !replay.commits) return
  const size = bufferedOf(replay) === 0 ? FIRST_READ : READ
  const order = [...replay.commits.slice(replay.next), ...replay.commits.slice(0, replay.next)]
  const asked = order.filter(commit => !changesOf(replay, commit.sha)).slice(0, size).map(commit => commit.sha)
  if (asked.length === 0) return
  replay.reading = true
  fetchRepositoryChanges(replay.repoId, replay.path, asked).then(answer => {
    if (sessionReplays().get(replay.key) !== replay) return null
    const told = new Map((Array.isArray(answer?.changes) ? answer.changes : []).filter(item => typeof item?.sha === 'string').map(item => [item.sha, item]))
    for (const sha of asked) {
      changesRead.set(changesKey(replay, sha), Array.isArray(told.get(sha)?.files) ? told.get(sha).files.map(file => fileOf(file, replay.path)).filter(Boolean) : [])
      if (told.get(sha)?.more === true) cutCommits.add(changesKey(replay, sha))
    }
    return null
  }, err => {
    if (err?.name !== 'AbortError') replay.error = err?.message || 'What the commits changed could not be read.'
    return null
  }).finally(() => {
    replay.reading = false
    repaint()
  })
}

// Who made a commit, as the app tells them apart: its author, and those who
// made it with them, each once; a user of the app by their account
// whichever of theirs, with their avatar; an agent whichever of its accounts
// or the name it gives, by its mark (`mark`, as Commits draws it), else its
// avatar where the app has one; anyone else by their login, else name. Each
// by the name the app shows them by, and the letter it draws them by where
// it has no mark or avatar.
export function makersOf(commit) {
  const makers = new Map()
  for (const { login = null, name = null, agent = null, avatar = null } of [{ login: commit.authorLogin, name: commit.authorName }, ...commit.coauthors ?? []]) {
    if (typeof login !== 'string' && typeof name !== 'string') continue
    const drawn = typeof agent === 'string' && Object.hasOwn(GITHUB_AGENTS, agent) ? agent : commitAgent(login, name)
    const user = drawn ? null : appUser(login)
    const key = drawn ? `agent:${drawn}` : user ? `user:${user.id}` : typeof login === 'string' ? `login:${login.toLowerCase()}` : `name:${name.toLowerCase()}`
    if (makers.has(key)) continue
    const label = drawn ? GITHUB_AGENTS[drawn].name : user ? user.name ?? user.login : name ?? login
    const mark = drawn ? GITHUB_AGENTS[drawn].mark ?? null : null
    const image = drawn ? !mark && GITHUB_AGENTS[drawn].avatar ? `/api/avatar/${GITHUB_AGENTS[drawn].avatar}` : null
      : user ? `/api/avatar/${encodeURIComponent(user.id)}` : typeof avatar === 'string' && AGENT_AVATAR.test(avatar) ? `/api/avatar/${avatar}` : null
    makers.set(key, { key, label, letter: label.trim()[0]?.toUpperCase() ?? '?', agent: drawn, mark, image })
  }
  return [...makers.values()]
}

// The agents' marks, as Commits draws them (provider-icons.js): each its
// path and the square of it drawn (its left, top and side), made once drawn.
const MARKS = { anthropic: [CLAUDE_MARK_PATH, 4, 5, 8], openai: [OPENAI_MARK_PATH, 4, 5, 8], 'github-copilot': [COPILOT_MARK_PATH, 0, 0, 24] }
// The agents' discs as their apps' icons are, whatever the theme: Claude's
// mark white on its orange, OpenAI's black on white, Copilot's white on
// GitHub's dark.
const BADGES = { claude: ['#d97757', '#fff'], codex: ['#fff', '#000'], copilot: ['#0d1117', '#fff'] }
const markPaths = new Map()
const markPath = mark => markPaths.get(mark) ?? markPaths.set(mark, new Path2D(MARKS[mark][0])).get(mark)

// An avatar to draw, once it has loaded; null till it has, or where it
// failed to.
function imageOf(src) {
  let image = images.get(src)
  if (!image) {
    image = new Image()
    image.decoding = 'async'
    image.src = src
    images.set(src, image)
  }
  return image.complete && image.naturalWidth > 0 ? image : null
}

const number = value => value.toLocaleString('en-US')
const day = at => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const speedName = speed => speed === 0.5 ? '½×' : `${speed}×`

const PLAY_ICON = svg`<path d="M5 3.25v9.5L12.75 8z" fill="currentColor"/>`
const PAUSE_ICON = svg`<path d="M5.25 3.5v9M10.75 3.5v9"/>`
const AGAIN_ICON = svg`<path d="M3.25 8a4.75 4.75 0 1 0 1.4-3.36M3.25 2.5v2.75H6"/>`

// The tab's body, for the directory shown (`repository`, an entry's) and its
// repository's full name (`repo`, repository-code.js repositoryFullName,
// once known), which its commit line links to GitHub by.
class RepositoryReplay extends LitElement {
  static properties = { repository: { attribute: false }, repo: { attribute: false } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repository = null
    this.repo = null
    this.replay = null
    this._frame = null
    this._last = 0
    this._camera = null
    this._colors = null
    this._themes = null
    this._resize = null
    this._restless = 0
    this._laidOut = Number.NEGATIVE_INFINITY
    this._pointer = null
    this._hovered = null
    this._shownNext = -1
  }

  connectedCallback() {
    super.connectedCallback()
    shownElements.add(this)
    watchHistories(this)
    // A theme picked, drawn in its colors at once, as the other graphs are.
    this._themes = new AbortController()
    globalThis.addEventListener('deepview-theme-changed', () => this.themeChanged(), { signal: this._themes.signal })
    // Resized, drawn again to its size on the next frame, however still it
    // is, the canvas never left stretched.
    this._resize = globalThis.ResizeObserver ? new ResizeObserver(() => { this.restless() }) : null
    this._resize?.observe(this)
    this._last = performance.now()
    this._frame = requestAnimationFrame(time => this.frame(time))
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    shownElements.delete(this)
    unwatchHistories(this)
    this._themes?.abort()
    this._resize?.disconnect()
    cancelAnimationFrame(this._frame)
    this._frame = null
    // Paused where it was, to play on from there when shown again.
    if (this.replay && ![...shownElements].some(element => element.replay === this.replay)) this.replay.playing = false
  }

  // Its commits, once its history is read as far as they go (a page of it
  // failing to read waits for the reader to read on: renderStatus), the
  // files they start from, drawn once read, and what they change, read ahead
  // of where it plays, while it shows; playing as soon as what its first
  // commit changes is read too, the first time it shows.
  updated() {
    const replay = this.replay
    if (!replay) return
    this.restless()
    if (!replay.commits) {
      const { entry, more } = revisionHistory(this.repository)
      if (entry.status !== 'ready') return
      const playable = entry.commits.filter(commit => commit.parents.length <= 1 && Number.isFinite(commit.committedAt)).length
      if (playable < replay.count && entry.more) {
        if (!entry.loadingMore && !entry.moreError) more()
        return
      }
      replay.commits = playedCommits(entry.commits, replay.count)
      replay.times = playTimes(replay.commits)
    }
    readTrees(replay)
    readChanges(replay)
    const start = startOf(replay)
    if (!start) return
    countKinds(replay)
    // The files it starts from drawn as soon as they are read.
    if (replay.scene.start !== start) this.seek(replay.next)
    if (!replay.started && bufferedOf(replay) > 0) {
      replay.started = true
      replay.playing = !reducedMotion()
      this.requestUpdate()
    }
  }

  pickCount(count) {
    shownCount = count
    repaint()
  }

  pickSpeed(speed) {
    shownSpeed = speed
    repaint()
  }

  // Playing, paused; ended, played again from its first commit.
  toggle() {
    const replay = this.replay
    if (!replay?.commits?.length) return
    if (replay.ended) {
      this.seek(0)
      replay.playing = true
    } else replay.playing = !replay.playing
    replay.started = true
    this.requestUpdate()
  }

  // Played to its `to`th commit, as far as what they change is read: the
  // scene of those before it made at once, as they stand after them.
  seek(to) {
    const replay = this.replay
    if (!replay?.commits || !startOf(replay)) return
    const at = Math.max(0, Math.min(to, bufferedOf(replay)))
    Object.assign(replay, { scene: sceneAt(replay, at), next: at, clock: at > 0 ? replay.times[at - 1] : -1e-3, ended: false, waiting: false })
    this._camera = null
    this.requestUpdate()
  }

  restless() {
    this._restless = performance.now() + 3000
  }

  // Another theme picked: its colors read, and the scene drawn in them now,
  // not on the next frame, however still it is.
  themeChanged() {
    this.readColors()
    this.restless()
    if (this.replay) this.draw(this.replay, 0)
  }

  // A frame: the replay played on as far as its clock goes, the scene moved
  // on and drawn, while it plays or moves; its overlay rendered again as a
  // commit plays.
  frame(time) {
    this._frame = requestAnimationFrame(next => this.frame(next))
    const dt = Math.min(0.1, Math.max(0, (time - this._last) / 1000))
    this._last = time
    const replay = this.replay
    if (!replay) return
    if (replay.playing && replay.commits) this.play(replay, dt)
    if (replay.next !== this._shownNext) {
      this._shownNext = replay.next
      this.requestUpdate()
    }
    if (!this._colors) this.readColors()
    if (replay.playing || time < this._restless) {
      advanceScene(replay.scene, replay.clock)
      // Laid out again as the tree changes, LAYOUT_MS apart at most.
      if (replay.scene.layout && time - this._laidOut >= LAYOUT_MS) {
        layoutScene(replay.scene)
        this._laidOut = time
      }
      // Those who made commits kept apart on the canvas as far as their names
      // need, however far it is zoomed out.
      moveScene(replay.scene, dt, Math.max(SPACE, SPREAD / (this._camera?.zoom ?? 1)))
      this.draw(replay, dt)
    }
  }

  // Its clock on by `dt` at the speed picked, each commit due by then
  // played, waiting at one what it changes isn't read of yet; past its last
  // a while, ended.
  play(replay, dt) {
    let clock = replay.clock + dt * shownSpeed
    const waiting = replay.waiting
    replay.waiting = false
    while (replay.next < replay.commits.length && replay.times[replay.next] <= clock) {
      const commit = replay.commits[replay.next]
      if (!readyOf(replay, commit)) {
        clock = replay.times[replay.next]
        replay.waiting = true
        break
      }
      const at = replay.times[replay.next]
      const span = (replay.times[replay.next + 1] ?? at + MAX_GAP) - at
      playCommit(replay.scene, makersOf(commit), commitChanges(replay, replay.scene, commit), at, span * 0.8)
      replay.next++
    }
    replay.clock = clock
    if (replay.next >= replay.commits.length && clock > (replay.times.at(-1) ?? 0) + END_S) {
      replay.playing = false
      replay.ended = true
    }
    if (waiting !== replay.waiting || replay.ended) this.requestUpdate()
  }

  // The colors it draws in, as the page's theme gives them (its swatches'):
  // read once it shows, and again as another theme is picked.
  readColors() {
    const swatches = this.querySelector('.replay-swatches')
    if (!swatches) return
    const color = name => getComputedStyle(swatches.querySelector(`.is-${name}`)).color
    const colors = { background: color('background'), text: color('text'), muted: color('muted'), surface: color('surface'), added: color('added'), modified: color('modified'),
      removed: color('removed'), kinds: Array.from({ length: KINDS }, (_, kind) => color(`kind-${kind}`)), font: getComputedStyle(this).fontFamily }
    this._colors = colors
  }

  // The scene on the canvas, the camera easing toward the box it fills,
  // zoomed in no further than MAX_ZOOM: the directories' branches, the files
  // in their kinds' colors (Other's muted), those touched a while bright and
  // larger, those removed shrinking away; the beams, those who made commits
  // and their names, and the names of directories near the root and of
  // files and directories touched lately, as many as room allows. What
  // lies under the pointer told over it.
  draw(replay, dt) {
    const canvas = this.querySelector('canvas')
    const colors = this._colors
    if (!canvas || !colors) return
    const { clientHeight: height, clientWidth: width } = canvas
    if (width === 0 || height === 0) return
    const ratio = globalThis.devicePixelRatio || 1
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
    }
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    const { scene, clock } = replay
    const camera = this.aim(scene, width, height, dt)
    const sx = x => (x - camera.x) * camera.zoom + width / 2
    const sy = y => (y - camera.y) * camera.zoom + height / 2
    const fileX = file => sx(file.dir.x + file.ox), fileY = file => sy(file.dir.y + file.oy)

    context.lineCap = 'round'
    context.strokeStyle = colors.muted
    context.globalAlpha = 0.35
    context.lineWidth = Math.max(1, Math.min(2.5, 1.5 * camera.zoom))
    context.beginPath()
    for (const dir of scene.dirs.values()) {
      if (!dir.parent) continue
      context.moveTo(sx(dir.parent.x), sy(dir.parent.y))
      context.lineTo(sx(dir.x), sy(dir.y))
    }
    context.stroke()

    // Files, a path a color; those glowing or going after, each its own.
    const dot = Math.max(1.2, FILE_DOT * camera.zoom)
    const kindOf = file => replay.colors.has(file.extension) ? colors.kinds[replay.colors.get(file.extension)] : colors.muted
    const lit = []
    const byColor = new Map()
    for (const file of scene.files.values()) {
      if (file.removed !== null || clock - file.touched < GLOW_S) { lit.push(file); continue }
      const color = kindOf(file)
      const path = byColor.get(color) ?? byColor.set(color, new Path2D()).get(color)
      path.moveTo(fileX(file) + dot, fileY(file))
      path.arc(fileX(file), fileY(file), dot, 0, 2 * Math.PI)
    }
    context.globalAlpha = 0.85
    for (const [color, path] of byColor) {
      context.fillStyle = color
      context.fill(path)
    }
    for (const file of lit) {
      const glow = Math.max(0, 1 - (clock - file.touched) / GLOW_S)
      const going = file.removed === null ? 1 : Math.max(0, 1 - (clock - file.removed) / REMOVE_S)
      context.globalAlpha = 0.85 * going + 0.15 * glow
      context.fillStyle = kindOf(file)
      context.beginPath()
      context.arc(fileX(file), fileY(file), dot * (1 + glow) * going, 0, 2 * Math.PI)
      context.fill()
    }

    // Beams, from each who made a commit to each file it changes, fading.
    context.lineWidth = 1.5
    for (const beam of scene.beams) {
      if (Number.isNaN(beam.user.x)) continue
      context.globalAlpha = Math.max(0, 1 - (clock - beam.at) / BEAM_S) * 0.85
      context.strokeStyle = beam.kind === 'A' ? colors.added : beam.kind === 'D' ? colors.removed : colors.modified
      context.beginPath()
      context.moveTo(sx(beam.user.x), sy(beam.user.y))
      context.lineTo(fileX(beam.file), fileY(beam.file))
      context.stroke()
    }

    // Names, each on a halo of the background: directories near the root, or
    // touched lately; files touched lately, while few are.
    const label = (text, x, y) => {
      context.strokeText(text, x, y)
      context.fillText(text, x, y)
    }
    context.lineJoin = 'round'
    context.globalAlpha = 1
    context.textBaseline = 'middle'
    context.font = `11px ${colors.font}`
    context.fillStyle = colors.muted
    context.strokeStyle = colors.background
    context.lineWidth = 3
    for (const dir of scene.dirs.values()) {
      if (!dir.parent || (dir.depth > 1 && clock - dir.touched > GLOW_S)) continue
      label(dir.name, sx(dir.x) + Math.max(6, (clusterRadius(dir.files.length) + 3) * camera.zoom), sy(dir.y))
    }
    const touched = lit.filter(file => file.removed === null)
    if (touched.length <= NAMES) {
      context.fillStyle = colors.text
      for (const file of touched) {
        context.globalAlpha = Math.max(0, 1 - (clock - file.touched) / GLOW_S)
        label(file.name, fileX(file) + dot * 2 + 3, fileY(file))
      }
    }

    // Those who made commits, each on a disc, solid as an avatar is: an
    // agent with a mark as its app's icon is (BADGES), else their avatar or
    // letter; their name under it; fading once idle.
    context.textAlign = 'center'
    for (const user of scene.users.values()) {
      if (Number.isNaN(user.x)) continue
      const [x, y] = [sx(user.x), sy(user.y)]
      context.globalAlpha = Math.max(0, Math.min(1, 1 - (clock - user.active - IDLE_S) / FADE_S))
      const [face, ink] = Object.hasOwn(BADGES, user.agent) ? BADGES[user.agent] : [colors.surface, colors.text]
      context.fillStyle = face
      context.beginPath()
      context.arc(x, y, FACE, 0, 2 * Math.PI)
      context.fill()
      const image = user.image ? imageOf(user.image) : null
      if (user.mark && Object.hasOwn(MARKS, user.mark)) {
        const [, left, top, side] = MARKS[user.mark]
        const size = FACE * 2 * 0.62
        context.save()
        context.translate(x - size / 2, y - size / 2)
        context.scale(size / side, size / side)
        context.translate(-left, -top)
        context.fillStyle = ink
        context.fill(markPath(user.mark))
        context.restore()
        context.beginPath()
        context.arc(x, y, FACE, 0, 2 * Math.PI)
      } else if (image) {
        context.save()
        context.clip()
        context.drawImage(image, x - FACE, y - FACE, FACE * 2, FACE * 2)
        context.restore()
      } else {
        context.fillStyle = colors.text
        context.font = `600 11px ${colors.font}`
        context.fillText(user.letter, x, y + 0.5)
      }
      context.strokeStyle = colors.muted
      context.lineWidth = 1
      context.stroke()
      context.fillStyle = colors.text
      context.strokeStyle = colors.background
      context.lineWidth = 3
      context.font = `11px ${colors.font}`
      label(user.label, x, y + FACE + 9)
    }
    context.textAlign = 'start'
    context.globalAlpha = 1
    this.hover(scene, sx, sy, fileX, fileY, dot)
  }

  // Where the camera looks, and how near: easing toward the middle of the
  // box the scene fills and the zoom that fits it, at once where it hasn't
  // yet (as a replay sought is drawn).
  aim(scene, width, height, dt) {
    const box = sceneBounds(scene)
    const fits = Number.isFinite(box.minX)
    const zoom = fits ? Math.max(0.02, Math.min(MAX_ZOOM, (width - 2 * MARGIN.side) / Math.max(1, box.maxX - box.minX),
      (height - MARGIN.top - MARGIN.bottom) / Math.max(1, box.maxY - box.minY))) : 1
    // The box's middle at the room's, the room lower by what the day takes over the commit.
    const x = fits ? (box.minX + box.maxX) / 2 : 0, y = fits ? (box.minY + box.maxY) / 2 - (MARGIN.top - MARGIN.bottom) / 2 / zoom : 0
    const target = { x, y, zoom }
    if (this._camera) {
      const ease = 1 - Math.exp(-dt * 1.8)
      this._camera.x += (target.x - this._camera.x) * ease
      this._camera.y += (target.y - this._camera.y) * ease
      this._camera.zoom = Math.exp(Math.log(this._camera.zoom) + (Math.log(target.zoom) - Math.log(this._camera.zoom)) * ease)
    } else this._camera = target
    return this._camera
  }

  // What lies under the pointer: one who made commits, else the file
  // nearest, else a directory; told over the canvas as it changes.
  hover(scene, sx, sy, fileX, fileY, dot) {
    const pointer = this._pointer
    let found = null
    if (pointer) {
      const distance = (x, y) => Math.hypot(x - pointer.x, y - pointer.y)
      const user = [...scene.users.values()].find(item => !Number.isNaN(item.x) && distance(sx(item.x), sy(item.y)) <= FACE + 2)
      let best = dot + 4, nearest = null
      if (!user) {
        for (const file of scene.files.values()) {
          const away = distance(fileX(file), fileY(file))
          if (away <= best) [best, nearest] = [away, file]
        }
      }
      const dir = user || nearest ? null : [...scene.dirs.values()].find(item => item.parent && distance(sx(item.x), sy(item.y)) <= 6)
      found = user ? user.label : nearest ? this.pathName(nearest.path) : dir ? `${this.pathName(dir.path)}/` : null
    }
    const hovered = found ? { text: found, x: pointer.x, y: pointer.y } : null
    if (hovered?.text !== this._hovered?.text || hovered?.x !== this._hovered?.x || hovered?.y !== this._hovered?.y) {
      this._hovered = hovered
      this.requestUpdate()
    }
  }

  // A path from the directory shown, as the repository names it.
  pathName(path) {
    return this.repository.path ? `${this.repository.path}/${path}` : path
  }

  pointer(event) {
    const box = event.currentTarget.getBoundingClientRect()
    this._pointer = event.type === 'pointerleave' ? null : { x: event.clientX - box.left, y: event.clientY - box.top }
    this.restless()
  }

  render() {
    if (!this.repository) return nothing
    const replay = replayOf(this.repository, shownCount)
    // Another picked, the one shown paused where it was.
    if (this.replay && this.replay !== replay) this.replay.playing = false
    this.replay = replay
    const history = replay.commits ? null : revisionHistory(this.repository)
    const total = replay.commits?.length ?? 0
    const buffered = bufferedOf(replay)
    const last = replay.next > 0 ? replay.commits[replay.next - 1] : null
    const people = replay.commits ? replay.people ??= new Set(replay.commits.flatMap(commit => makersOf(commit).map(maker => maker.key))).size : 0
    // Drawn in part where the files it starts from, or those a cut commit
    // leaves, are more than are read: files past them neither drawn nor, of
    // those a cut commit removes past its own read, removed.
    const start = replay.commits ? startOf(replay) : null
    const inPart = start?.cut || replay.commits?.some(commit => isCut(replay, commit.sha) && treeOf(replay, commit.sha)?.cut)
    const summary = replay.commits && total > 0
      ? `${number(total)} commit${total === 1 ? '' : 's'} by ${number(people)}, ${day(replay.commits[0].committedAt)} – ${day(replay.commits.at(-1).committedAt)}${
        inPart ? ', drawn in part: more files than are read' : ''}` : ''
    return html`<div class="history-bar">
        ${activityPicker('replay')}
        <div class="history-modes" role="group" aria-label="Commits played">
          ${REPLAY_COUNTS.map(count => html`<button type="button" aria-pressed=${String(shownCount === count)} @click=${() => this.pickCount(count)}>Last ${number(count)}</button>`)}
        </div>
        ${summary ? html`<span class="history-summary">${summary}</span>` : nothing}
      </div>
      <div class="replay-stage">
        <canvas class="replay-canvas" role="img" aria-label=${last ? `The repository’s files as of ${day(last.committedAt)}, ${number(replay.next)} of ${number(total)} commits played`
          : 'The repository’s files, as its commits change them'}
          @pointermove=${this.pointer} @pointerleave=${this.pointer}></canvas>
        ${last ? html`<div class="replay-day"><time datetime=${new Date(last.committedAt).toISOString()}>${day(last.committedAt)}</time>
          <span>${number(replay.next)} of ${number(total)}</span></div>
          ${this.renderCommit(last)}` : nothing}
        ${this.renderKey(replay)}
        ${this.renderStatus(replay, history, buffered)}
        ${this._hovered ? html`<div class="replay-tip" style=${styleMap({ left: `${this._hovered.x}px`, top: `${this._hovered.y}px` })}>${this._hovered.text}</div>` : nothing}
        <div class="replay-swatches" aria-hidden="true">
          ${['background', 'text', 'muted', 'surface', 'added', 'modified', 'removed', ...Array.from({ length: KINDS }, (_, kind) => `kind-${kind}`)].map(name => html`<span class=${`is-${name}`}></span>`)}
        </div>
      </div>
      ${this.renderControls(replay, total, buffered)}`
  }

  // The commit last played, as Commits lists it: its short id and the pull
  // requests its subject names opening them on GitHub, in a new tab, where
  // the repository's name is known; who made it, their avatars and marks
  // stacked, all of them named on hover.
  renderCommit(commit) {
    const repo = this.repo ?? this.repository.repo
    const github = repo ? `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}` : null
    const short = commit.sha.slice(0, 7)
    return html`<p class="replay-commit">${github ? html`<a class="replay-sha" href=${`${github}/commit/${commit.sha}`} target="_blank" rel="noopener noreferrer"
        aria-label=${`Commit ${short} on GitHub`}>${short}</a>` : html`<code class="replay-sha">${short}</code>`}
      <span class="replay-commit-subject">${subjectLinks(commit.subject || '(no message)', github)}</span>
      <span class="replay-commit-author">${commitAuthors(commit.authorLogin, commit.authorName, commit.coauthors)}</span></p>`
  }

  // The kinds of files colored, the most counted first, then Other; and
  // what the beams' colors tell.
  renderKey(replay) {
    if (replay.colors.size === 0) return nothing
    const kinds = [...replay.colors].toSorted((a, b) => (replay.counts.get(b[0]) ?? 0) - (replay.counts.get(a[0]) ?? 0))
    return html`<ul class="replay-key" aria-label="Kinds of files">
      ${kinds.map(([extension, kind]) => html`<li><span class=${`replay-dot is-kind-${kind}`}></span>.${extension}</li>`)}
      <li><span class="replay-dot is-muted"></span>Other</li>
      <li class="replay-beams"><span class="replay-beam is-added"></span>Added</li>
      <li><span class="replay-beam is-modified"></span>Modified</li>
      <li><span class="replay-beam is-removed"></span>Removed</li>
    </ul>`
  }

  // What it waits for, over the canvas: its history read, how many commits
  // so far, what they change read, the next commit's; or why it can't play,
  // and a button to read again.
  renderStatus(replay, history, buffered) {
    if (history?.entry.status === 'error') {
      return html`<div class="replay-status is-error"><p role="alert">${history.entry.error}</p>
        <button type="button" @click=${() => rereadHistory(history.key)}>Retry</button></div>`
    }
    if (replay.error) {
      return html`<div class="replay-status is-error"><p role="alert">${replay.error}</p>
        <button type="button" @click=${() => { replay.error = null; repaint() }}>Retry</button></div>`
    }
    if (history?.entry.status === 'ready' && history.entry.moreError) {
      return html`<div class="replay-status is-error"><p role="alert">${history.entry.moreError}</p>
        <button type="button" @click=${() => history.more()}>Retry</button></div>`
    }
    if (history) {
      const read = history.entry.status === 'ready' ? history.entry.commits.length : 0
      return html`<div class="replay-status" role="status">${read > 0 ? `Reading commits… ${number(read)} so far` : 'Reading the history…'}</div>`
    }
    if (replay.commits.length === 0) return html`<div class="replay-status">No commits to play.</div>`
    if (!startOf(replay)) return html`<div class="replay-status" role="status">Reading the files as they were before ${day(replay.commits[0].committedAt)}…</div>`
    if (buffered === 0) return html`<div class="replay-status" role="status">Reading what the commits changed…</div>`
    if (replay.waiting) return html`<div class="replay-status is-waiting" role="status">Reading what the next commits changed…</div>`
    return nothing
  }

  // Play and pause, played again once ended; the commits to seek through,
  // as far as what they change is read, which shows behind them; how fast.
  renderControls(replay, total, buffered) {
    const name = replay.ended ? 'Play again' : replay.playing ? 'Pause' : 'Play'
    const ready = buffered > 0 && Boolean(replay.commits && startOf(replay))
    const share = count => `${total > 0 ? count / total * 100 : 0}%`
    return html`<div class="replay-controls">
      <button type="button" class="replay-play" aria-label=${name} ?disabled=${!ready} @click=${() => this.toggle()}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
          aria-hidden="true">${replay.ended ? AGAIN_ICON : replay.playing ? PAUSE_ICON : PLAY_ICON}</svg>
      </button>
      <div class="replay-track" style=${styleMap({ '--buffered': share(buffered), '--played': share(replay.next) })}>
        <input type="range" min="0" max=${total} step="1" .value=${String(replay.next)} aria-label="Commits played" ?disabled=${!ready}
          aria-valuetext=${`${number(replay.next)} of ${number(total)} commits`} @input=${event => this.seek(Number(event.target.value))}>
      </div>
      <div class="history-modes" role="group" aria-label="Speed">
        ${SPEEDS.map(speed => html`<button type="button" aria-pressed=${String(shownSpeed === speed)} @click=${() => this.pickSpeed(speed)}>${speedName(speed)}</button>`)}
      </div>
    </div>`
  }
}
if (!customElements.get('repository-replay')) customElements.define('repository-replay', RepositoryReplay)
