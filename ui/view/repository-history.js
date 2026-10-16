// The code viewer's Commits (render-bundle.js): a repository's commits as
// `git log --oneline --decorate --graph` lists them, across its branches as
// `--all` does, or those not merged; from the revision shown where reading
// every branch needs the reader's GitHub sign-in. One compact line a
// commit: its short id, the branches and tags naming it, its subject, author
// and time, beside the graph of the lines its parents make (history-graph.js),
// the commit shown marked. A directory's history lists the commits touching
// it, in a line. Opening a commit shows its code. The server reads it with
// the reader's own GitHub access (GET /api/admin/repositories/history); what
// it answered is kept a while, for the session that read it.
import { LitElement, html, nothing, svg } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { styleMap } from './style-map.js'
import { appMarkup } from './markup.js'
import { state } from '#client/index.js'
import { fetchRepositoryHistory } from './client-managed.js'
import { firstParentLine, historyLayout, historyOrder } from './history-graph.js'
import { PULL_ICON_SVG, TAG_ICON_SVG } from './icons.js'
import { unwatchNearViewport, watchNearViewport } from './lazy-render.js'
import { navigateToRepositoryCode, shownRevision } from './repository-code.js'
import { activityPicker } from './repository-activity.js'
import { commitAuthors } from './github-users.js'

// The graph's geometry, in pixels: a lane's width, a line's height, and the
// margin before the first lane and after the last.
const LANE = 12
const ROW = 24
const EDGE = 9
const LANE_COLORS = 8
const MAX_REFS = 3
// What keys reach in a line: its links on GitHub, then its button.
const LINE_KEYS = 'a[href], .history-commit'
const KEEP_MS = 5 * 60_000
// The longest a read again of every branch, answered as the server kept them, waits to ask once more.
const RETRY_FRESH_MS = 15_000
const RETRY_MS = 30_000
// Where every branch's next page reads on from, as many as the server reads
// branches at first (repository-history.ts ALL_BRANCHES).
const ALL_STARTS = 25

const histories = new Map()
const shownElements = new Set()
let keptFor = null
// What the reader asked for, `--all` at first: every branch ('all') or the
// branches not merged ('unmerged'); and the repositories reading every
// branch was refused for want of a sign-in, which show the revision's own
// history ('revision').
let preferred = 'all'
const allRefused = new Set()

function sessionHistories() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    histories.clear()
    allRefused.clear()
    keptFor = session
  }
  return histories
}

const repaint = () => { for (const element of shownElements) element.requestUpdate() }

// The history `key` names, as held, else read: `{ status }`, 'loading', then
// 'ready' with its `commits`, `more` and the `branches` and `tags` naming
// them, or 'error' with its `error`; read again once old, or an error's retry
// is due.
// A history's first page as read, `sought` the commits shown it was read
// again, afresh, for (refreshHistory).
function readEntry(answer, settle, sought = new Set()) {
  const entry = { status: 'ready', until: Date.now() + KEEP_MS, page: 1, commits: answer.commits, more: answer.more === true,
    branches: answer.branches ?? [], tags: answer.tags ?? [], defaultBranch: answer.defaultBranch ?? null, unread: answer.unread, cut: answer.cut === true,
    pulls: answer.pulls, openPulls: answer.openPulls, loadingMore: false, moreError: null, sought }
  settle?.(entry)
  return entry
}

function historyRead(key, ask, settle) {
  const data = sessionHistories()
  const held = data.get(key)
  if (held && Date.now() < held.until) return held
  const loading = { status: 'loading', until: Number.POSITIVE_INFINITY }
  data.set(key, loading)
  ask(1).then(answer => {
    if (data.get(key) === loading) data.set(key, readEntry(answer, settle))
    return null
  }, err => {
    if (data.get(key) !== loading) return null
    if (err?.name === 'AbortError') data.delete(key)
    else data.set(key, { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'The history could not be read.', code: err?.code ?? null })
    return null
  }).finally(repaint)
  return loading
}

// Every branch's history read again, afresh (`ask`'s third argument), for
// the commit shown, its branches read now rather than as the server kept
// them: the one held shown meanwhile, `refreshing`, and kept where that read
// fails; once for each commit shown, and once more where the server, having
// read them just before, answered as it kept them, when it may read them
// again (`retryIn`, `retryAt`).
function refreshHistory(key, held, ask, settle, commit) {
  const sought = held.sought
  held.sought = new Set(sought).add(commit)
  held.refreshing = true
  ask(1, null, true).then(answer => {
    if (sessionHistories().get(key) !== held) return null
    const retryIn = held.retried === commit ? 0 : Math.min(Number(answer.retryIn) || 0, RETRY_FRESH_MS)
    const entry = readEntry(answer, settle, retryIn > 0 ? sought : held.sought)
    if (retryIn > 0) {
      Object.assign(entry, { retried: commit, retryAt: Date.now() + retryIn })
      setTimeout(repaint, retryIn)
    }
    sessionHistories().set(key, entry)
    return null
  }, () => null).finally(() => {
    held.refreshing = false
    repaint()
  })
}

// A whole repository's history read on (`settle`, as a page is read), every
// branch's or a revision's: the branches not read that now name a commit
// listed join those naming one, and the next page reads on from the commits
// where those listed stop, the parents not listed, and from the branches not
// read, the newest first (a parent by its child's time), as many as every
// branch's first page reads branches, none twice. The server glues on what it
// keeps of the history from each (repository-history.ts historyFrom).
function settleFrontier(entry) {
  const listed = new Set(entry.commits.map(commit => commit.sha))
  entry.branches = [...entry.branches, ...entry.unread.flatMap(({ name, sha }) => listed.has(sha) ? [{ name, sha }] : [])]
  entry.unread = entry.unread.filter(head => !listed.has(head.sha))
  entry.asked ??= new Set()
  const starts = new Map()
  const start = (sha, at) => { if (!entry.asked.has(sha)) starts.set(sha, Math.max(starts.get(sha) ?? Number.NEGATIVE_INFINITY, at ?? 0)) }
  for (const commit of entry.commits) for (const parent of commit.parents) if (!listed.has(parent)) start(parent, commit.committedAt)
  for (const head of entry.unread) start(head.sha, head.at)
  entry.next = [...starts].toSorted((a, b) => b[1] - a[1]).slice(0, ALL_STARTS).map(([sha]) => sha)
  for (const sha of entry.next) entry.asked.add(sha)
  entry.more &&= entry.next.length > 0
  return entry
}

// The next page of a history read a page at a time, after those it holds.
function readMore(key, entry, ask, settle) {
  if (entry.loadingMore || !entry.more) return
  entry.loadingMore = true
  entry.moreError = null
  // Kept while the next page reads, however long it was held already.
  entry.until = Date.now() + KEEP_MS
  repaint()
  ask(entry.page + 1, entry).then(answer => {
    if (sessionHistories().get(key) !== entry) return null
    const held = new Set(entry.commits.map(commit => commit.sha))
    entry.commits = [...entry.commits, ...answer.commits.filter(commit => !held.has(commit.sha))]
    const merges = new Set(entry.pulls.map(pull => pull.merge))
    entry.pulls = [...entry.pulls, ...answer.pulls.filter(pull => !merges.has(pull.merge))]
    entry.page += 1
    entry.more = answer.more === true
    settle?.(entry)
    entry.until = Date.now() + KEEP_MS
    return null
  }, err => {
    if (err?.name !== 'AbortError') entry.moreError = err?.message || 'More commits could not be read.'
    return null
  }).finally(() => {
    entry.loadingMore = false
    repaint()
  })
}

// A server's answer, its commits and the branches it didn't read those it
// names by id.
const SHA = /^[a-f\d]{40}$/u
const isCommit = commit => typeof commit?.sha === 'string' && SHA.test(commit.sha) && Array.isArray(commit.parents)
function checked(answer) {
  if (!Array.isArray(answer?.commits)) throw new Error('The server answered with no history.')
  const commits = answer.commits.filter(isCommit)
  const unread = Array.isArray(answer.unread) ? answer.unread.filter(head => typeof head?.name === 'string' && typeof head.sha === 'string' && SHA.test(head.sha)) : []
  // The pull requests squashed into its commits, each with its own commits,
  // and the open ones' heads.
  const pulls = Array.isArray(answer.pulls) ? answer.pulls.filter(pull => typeof pull?.merge === 'string' && SHA.test(pull.merge) && Number.isSafeInteger(pull.number)
    && typeof pull.head === 'string' && SHA.test(pull.head) && Array.isArray(pull.commits)).map(pull => ({ ...pull, commits: pull.commits.filter(isCommit) })) : []
  const openPulls = Array.isArray(answer.openPulls)
    ? answer.openPulls.filter(pull => Number.isSafeInteger(pull?.number) && typeof pull.sha === 'string' && SHA.test(pull.sha)) : []
  return { ...answer, commits, unread, pulls, openPulls }
}

// The commits drawn of those listed: each a pull request was squashed into
// as the merge it was, its pull request's head its other parent, and that
// one's own commits, each once (a branch reused for another pull request
// shares those both had), marked by the pull request (`pull`).
// The branches not merged of those read: their commits the default
// branch's `tip` doesn't reach, a squash merge reaching its pull request's
// (plantedCommits), as `git log --all --not <tip>` lists them, each down to
// where it began. Only those newer than the oldest of the default branch's
// own line read: what merged one would be newer still, so read, and would
// reach it; one older may be merged where the default branch isn't read yet,
// told as more of it is.
export function unmergedCommits(commits, pulls, tip) {
  const planted = plantedCommits(commits, pulls)
  const bySha = new Map(planted.map(commit => [commit.sha, commit]))
  if (!bySha.has(tip)) return planted
  const merged = new Set()
  for (const queue = [tip]; queue.length > 0;) {
    const sha = queue.pop()
    if (merged.has(sha) || !bySha.has(sha)) continue
    merged.add(sha)
    queue.push(...bySha.get(sha).parents)
  }
  // The oldest of its own line read, unless it goes on to its root.
  let line = bySha.get(tip)
  for (const seen = new Set(); bySha.has(line.parents[0]) && !seen.has(line.sha); line = bySha.get(line.parents[0])) seen.add(line.sha)
  const since = line.parents.length > 0 ? line.committedAt ?? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  return planted.filter(commit => !merged.has(commit.sha) && (commit.committedAt ?? Number.NEGATIVE_INFINITY) > since)
}

export function plantedCommits(commits, pulls) {
  if (pulls.length === 0) return commits
  const squashed = new Map(pulls.map(pull => [pull.merge, pull]))
  const listed = new Set(commits.map(commit => commit.sha))
  const own = new Map()
  for (const pull of pulls) for (const commit of pull.commits) if (!listed.has(commit.sha) && !own.has(commit.sha)) own.set(commit.sha, { ...commit, pull: pull.number })
  return [...commits.map(commit => {
    const pull = squashed.get(commit.sha)
    return pull && commit.parents.length === 1 && pull.head !== commit.parents[0] ? { ...commit, parents: [commit.parents[0], pull.head] } : commit
  }), ...own.values()]
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// A commit's time as a line has room for: how long ago, within a week, else
// its day, and its year where not this one's.
export function compactTime(at, now = Date.now()) {
  if (at == null) return ''
  const ago = now - at
  if (ago >= -MINUTE && ago < MINUTE) return 'now'
  if (ago > 0 && ago < HOUR) return `${Math.floor(ago / MINUTE)}m`
  if (ago > 0 && ago < DAY) return `${Math.floor(ago / HOUR)}h`
  if (ago > 0 && ago < 7 * DAY) return `${Math.floor(ago / DAY)}d`
  const date = new Date(at)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' } })
}

// The branches, pull requests and tags naming each commit, by its id: the
// default branch's first, then branches, then the pull requests whose heads
// they are (those squashed in when merged, the open ones now), by number,
// then tags, as `--decorate` lists them.
export function historyRefs({ branches = [], tags = [], pulls = [], openPulls = [] }, defaultBranch) {
  const named = new Map()
  const add = (sha, ref) => named.set(sha, [...named.get(sha) ?? [], ref])
  for (const branch of branches.toSorted((a, b) => Number(b.name === defaultBranch) - Number(a.name === defaultBranch))) {
    add(branch.sha, { kind: 'branch', name: branch.name, main: branch.name === defaultBranch })
  }
  const numbered = new Set()
  for (const { number, sha } of [...pulls.map(pull => ({ number: pull.number, sha: pull.head })), ...openPulls]) {
    if (numbered.has(number)) continue
    numbered.add(number)
    add(sha, { kind: 'pull', name: `#${number}`, number })
  }
  for (const tag of tags) add(tag.sha, { kind: 'tag', name: tag.name })
  return named
}

// A subject, the pull requests it names by number (`#12`, as GitHub links
// them: on their own or after a space or bracket) opening them on GitHub
// (`github`, the repository's page there), in a new tab: by the issue's
// address, as an issue's number is one too, GitHub sending a pull
// request's on to it. Replay's commit line links its subject so too
// (repository-replay.js).
export function subjectLinks(subject, github) {
  if (!github) return subject
  const parts = []
  let at = 0
  for (const match of subject.matchAll(/(?<=^|[\s([])#(\d+)\b/gu)) {
    parts.push(subject.slice(at, match.index), html`<a href=${`${github}/issues/${match[1]}`} target="_blank" rel="noopener noreferrer"
      tabindex="-1">${match[0]}</a>`)
    at = match.index + match[0].length
  }
  return at === 0 ? subject : [...parts, subject.slice(at)]
}

const laneX = lane => EDGE + lane * LANE
const rowY = row => row * ROW + ROW / 2

// A line from a lane at a row to a lane at the next: straight down, or
// curving across between them.
function segmentPath({ row, from, to }) {
  const [x1, x2, y1, y2] = [laneX(from), laneX(to), rowY(row), rowY(row + 1)]
  if (x1 === x2) return `M${x1} ${y1}V${y2}`
  const middle = (y1 + y2) / 2
  return `M${x1} ${y1}C${x1} ${middle} ${x2} ${middle} ${x2} ${y2}`
}

// A parent not listed: a short dotted line on from its child, down its lane
// or aside.
const stubPath = ({ row, col, straight }) => straight
  ? `M${laneX(col)} ${rowY(row) + 6}v${ROW * .55}` : `M${laneX(col) + 4} ${rowY(row) + 5}l${LANE * .6} ${ROW * .5}`

// The graph of `layout` (history-graph.js historyLayout), `shown` the
// commit to mark: the lines of each color as one path, then the nodes over
// them.
function historyGraph(layout, shown) {
  const lines = Array.from({ length: LANE_COLORS }, () => [])
  for (const segment of layout.segments) lines[segment.color].push(segmentPath(segment))
  const stubs = Array.from({ length: LANE_COLORS }, () => [])
  for (const stub of layout.stubs) stubs[stub.color].push(stubPath(stub))
  const width = EDGE * 2 + (layout.width - 1) * LANE
  return html`<svg class="history-graph" width=${width} height=${layout.rows.length * ROW} aria-hidden="true">
    ${lines.map((parts, color) => parts.length > 0 ? svg`<path class=${`lane-${color}`} d=${parts.join('')}/>` : nothing)}
    ${stubs.map((parts, color) => parts.length > 0 ? svg`<path class=${`history-stub lane-${color}`} d=${parts.join('')}/>` : nothing)}
    ${layout.rows.map(({ commit, col, color }, row) => svg`<circle class=${`lane-${color}${commit.sha === shown ? ' is-shown' : ''}`} cx=${laneX(col)} cy=${rowY(row)}
      r=${commit.sha === shown ? 4.5 : commit.parents.length > 1 ? 3 : 3.5}/>`)}
  </svg>`
}

// A commit's branches, pull requests and tags, as chips, a branch's marked in
// its line's `color`: the first few, then how many more, those named in its
// tooltip. A pull request's opens it on GitHub (`github`, the repository's
// page there), in a new tab, as its line's id does.
function refChips(refs, color, revision, github) {
  if (!refs?.length) return nothing
  const chip = ref => {
    const classes = classMap({ 'history-ref': true, [`is-${ref.kind}`]: true, 'is-default': ref.main === true,
      'is-shown': ref.kind === revision.kind && ref.name === revision.name })
    const label = html`${ref.kind === 'tag' ? appMarkup(TAG_ICON_SVG) : ref.kind === 'pull' ? appMarkup(PULL_ICON_SVG) : nothing}<span>${ref.name}</span>`
    return ref.kind === 'pull' && github ? html`<a class=${classes} href=${`${github}/pull/${ref.number}`} target="_blank" rel="noopener noreferrer" tabindex="-1"
      aria-label=${`Pull request ${ref.name} on GitHub`}>${label}</a>` : html`<span class=${classes}>${label}</span>`
  }
  const rest = refs.slice(MAX_REFS)
  return html`<span class="history-refs" style=${styleMap({ '--ref': `var(--lane-${color})` })}>${refs.slice(0, MAX_REFS).map(chip)}${rest.length > 0
    ? html`<span class="history-ref is-more" data-tooltip=${rest.map(ref => ref.name).join(', ')}>+${rest.length}</span>` : nothing}</span>`
}

// The history of the directory `repository` shows in `mode` (as
// RepositoryHistory.mode names them), as held, else read: its `entry`
// (historyRead), the `key` it is held by, and `more`, reading its next page.
// The branches not merged are every branch's, read as those are; every
// branch's refused for want of a sign-in, the revision's.
function readHistory(repository, mode) {
  const { repoId, commit, path } = repository
  const every = mode === 'all' || mode === 'unmerged'
  const key = every ? `all\0${repoId}` : `${repoId}\0${commit}\0${path}`
  const ask = (page, held, fresh = false) => fetchRepositoryHistory(repoId, every ? '' : commit, path,
    { page, all: every, ...fresh ? { fresh: true } : {}, ...mode !== 'path' && page > 1 ? { from: held.next } : {} }).then(answer => {
    if (!every && answer?.commit !== commit) throw new Error('The server answered with another revision\'s history.')
    return checked(answer)
  })
  const settle = mode === 'path' ? null : settleFrontier
  const entry = historyRead(key, ask, settle)
  // Every branch's, as the server kept them, missing the commit shown, those
  // of the pull requests squashed into them planted among them too, as they
  // do once a branch reaches it since: read again, afresh.
  if (every && entry.status === 'ready' && !entry.refreshing && !entry.sought.has(commit) && !(entry.retryAt > Date.now())
    && !plantedCommits(entry.commits, entry.pulls ?? []).some(item => item.sha === commit)) {
    refreshHistory(key, entry, ask, settle, commit)
  }
  if (every && entry.status === 'error' && entry.code === 'github-token-required') {
    allRefused.add(repoId)
    return readHistory(repository, 'revision')
  }
  return { mode, key, entry, more: () => readMore(key, entry, ask, settle) }
}

// What Replay plays (repository-replay.js): the history of the revision a
// directory shows, below the repository's root the directory's, as Commits
// reads and keeps it; `element` updated as it is read, from when it
// watches till it unwatches; read again where it failed (rereadHistory).
export const revisionHistory = repository => readHistory(repository, repository.path ? 'path' : 'revision')
export const watchHistories = element => { shownElements.add(element) }
export const unwatchHistories = element => { shownElements.delete(element) }
export function rereadHistory(key) {
  sessionHistories().delete(key)
  repaint()
}

// The tab's body, for the directory shown (`repository`, an entry's), its
// repository's full name (`repo`, repository-code.js repositoryFullName,
// once known) and the repository's branches and tags (`refs`,
// repositoryRefs), naming its revision.
class RepositoryHistory extends LitElement {
  static properties = { repository: { attribute: false }, repo: { attribute: false }, refs: { attribute: false } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repository = null
    this.repo = null
    this.refs = null
    this._drawn = null
    this._moreButton = null
    this._mode = null
  }

  connectedCallback() {
    super.connectedCallback()
    shownElements.add(this)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    shownElements.delete(this)
    if (this._moreButton) unwatchNearViewport(this._moreButton)
    this._moreButton = null
  }

  // Older commits read as their button nears the end of the scroll, a
  // screen before it shows, as though clicked, and again after each page
  // while it stays near; not after one failed, which waits for a click, nor
  // for Unmerged, whose lines a page may add none of, which would read the
  // whole history on its own. Watched again after every update, so that
  // whether it is near is where it is now, below the lines that update
  // added, never where it was.
  updated() {
    const button = this.querySelector('.history-more > button')
    if (this._moreButton && this._moreButton !== button) unwatchNearViewport(this._moreButton)
    this._moreButton = button
    if (button) watchNearViewport(button, near => { if (near) this.readNear(button) })
  }

  readNear(button) {
    if (button === this._moreButton && button.isConnected && !button.disabled && !button.parentElement.querySelector('[role=alert]')
      && this._mode !== 'unmerged') button.click()
  }

  // What it lists: a directory's commits ('path'), every branch's ('all'),
  // every branch's not merged ('unmerged'), or, where every branch's needs a
  // sign-in, the revision's ('revision').
  mode() {
    const { repoId, path } = this.repository
    if (path) return 'path'
    sessionHistories()
    return allRefused.has(repoId) ? 'revision' : preferred
  }

  history(mode) {
    return readHistory(this.repository, mode)
  }

  // The graph of what it holds, the pull requests squashed into it planted
  // as the branches they were, or of its branches not merged, laid out again
  // only as that changes.
  layout(mode, entry, defaultBranch) {
    const drawn = this._drawn
    if (drawn?.commits === entry.commits && drawn.pulls === entry.pulls && drawn.mode === mode && drawn.defaultBranch === defaultBranch) return drawn.layout
    const linear = mode === 'path'
    const defaultTip = entry.branches.find(branch => branch.name === defaultBranch)?.sha
    const ordered = linear ? entry.commits : historyOrder(mode === 'unmerged' ? unmergedCommits(entry.commits, entry.pulls ?? [], defaultTip)
      : plantedCommits(entry.commits, entry.pulls ?? []))
    const tip = mode === 'all' ? defaultTip : mode === 'revision' ? ordered[0]?.sha : null
    const layout = historyLayout(ordered, { linear, trunk: tip && !linear ? firstParentLine(ordered, tip) : null, colors: LANE_COLORS })
    this._drawn = { commits: entry.commits, pulls: entry.pulls, mode, defaultBranch, layout }
    return layout
  }

  pick(mode) {
    preferred = mode
    repaint()
  }

  // A commit shown in its place, the view staying on Commits, named by the
  // branch, the default first, else the tag, naming it.
  open(commit, refs) {
    const { repoId, repo, path } = this.repository
    const ref = refs?.find(item => item.kind === 'branch') ?? refs?.find(item => item.kind === 'tag')
    navigateToRepositoryCode({ repoId, repo, path, commit: commit.sha, bundleTab: 'commits', ...ref ? { revision: { kind: ref.kind, name: ref.name } } : {} })
  }

  // Up and down move between lines' buttons, Home and End to the first's and
  // the last's; left and right along a line, through its links on GitHub and
  // its button. Whichever is reached is the list's one stop for Tab.
  keydown(event) {
    const lines = [...this.querySelectorAll('.history-row')]
    const line = event.target.closest('.history-row')
    const own = line ? [...line.querySelectorAll(LINE_KEYS)] : []
    const at = own.indexOf(event.target)
    if (at === -1) return
    const along = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
    const across = { ArrowUp: -1, ArrowDown: 1 }[event.key]
    const to = along ? own[at + along]
      : (across ? lines[lines.indexOf(line) + across] : { Home: lines[0], End: lines.at(-1) }[event.key])?.querySelector('.history-commit')
    if (!to) return
    event.preventDefault()
    for (const item of this.querySelectorAll(`.history-row :is(${LINE_KEYS})`)) item.tabIndex = item === to ? 0 : -1
    to.focus()
  }

  render() {
    if (!this.repository) return nothing
    const { mode, key, entry, more } = this.history(this.mode())
    this._mode = mode
    const ready = entry.status === 'ready'
    const defaultBranch = mode === 'all' || mode === 'unmerged' ? entry.defaultBranch : this.refs?.status === 'ready' ? this.refs.value.defaultBranch ?? null : null
    const layout = ready ? this.layout(mode, entry, defaultBranch) : null
    // The commits listed (those not merged, the branches not merged's), and the branches naming them.
    const listed = mode === 'unmerged' ? layout?.rows.length ?? 0 : entry.commits?.length ?? 0
    const unmerged = mode === 'unmerged' && layout ? new Set(layout.rows.map(row => row.commit.sha)) : null
    const branches = ready && mode === 'all' ? entry.branches.length : unmerged ? entry.branches.filter(branch => unmerged.has(branch.sha)).length : 0
    const count = ready ? `${listed}${entry.more || entry.cut ? '+' : ''} commit${listed === 1 ? '' : 's'}` : ''
    const refused = allRefused.has(this.repository.repoId)
    return html`<div class="history-bar">
        ${activityPicker('commits')}
        ${mode === 'path' ? html`<span class="history-scope">Commits touching <code>${this.repository.path}</code></span>`
          : refused ? html`<span class="history-scope">Every branch needs your GitHub sign-in.</span>`
          : html`<div class="history-modes" role="group" aria-label="Branches">
            <button type="button" aria-pressed=${String(mode === 'all')} @click=${() => this.pick('all')}>All branches</button>
            <button type="button" aria-pressed=${String(mode === 'unmerged')} @click=${() => this.pick('unmerged')}>Unmerged</button>
          </div>`}
        ${ready ? html`<span class="history-summary">${count}${branches > 0 ? ` on ${branches} branch${branches === 1 ? '' : 'es'}` : ''}</span>` : nothing}
      </div>
      ${ready ? this.renderCommits(mode, entry, more, layout, defaultBranch)
        : entry.status === 'error' ? html`<div class="bundles-slide-placeholder is-error"><p role="alert">${entry.error}</p>
            <button type="button" @click=${() => { sessionHistories().delete(key); repaint() }}>Retry</button></div>`
        : html`<div class="bundles-slide-placeholder" role="status">Reading the history…</div>`}`
  }

  renderCommits(mode, entry, more, layout, defaultBranch) {
    if (layout.rows.length === 0 && !(mode === 'unmerged' && (entry.more || entry.moreError))) {
      return html`<div class="bundles-slide-placeholder">${mode === 'unmerged' ? 'Every branch read is merged.' : 'No commits.'}</div>`
    }
    const shown = this.repository.commit
    const revision = shownRevision(this.repository, this.refs)
    const named = historyRefs(entry, defaultBranch)
    const focused = Math.max(0, layout.rows.findIndex(row => row.commit.sha === shown))
    const graphWidth = EDGE * 2 + (layout.width - 1) * LANE
    // Each line's short id, pull requests and the pull requests its subject
    // names open them on GitHub, in a new tab, reached by keys along the line
    // (keydown); the rest of it, its code, its button named by its subject,
    // then its author and time.
    const repo = this.repo ?? this.repository.repo
    const github = repo ? `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}` : null
    return html`<div class="history-scroll">
      ${mode === 'all' && !entry.refreshing && !(entry.retryAt > Date.now()) && !layout.rows.some(row => row.commit.sha === shown) ? html`<p class="history-note">
        <code>${shown.slice(0, 7)}</code> isn’t among these commits.</p>` : nothing}
      <div class="history-lines" style=${styleMap({ '--history-graph': `${graphWidth}px` })}>
        ${historyGraph(layout, shown)}
        <ol class="history-list" aria-label="Commits" @keydown=${this.keydown}>${layout.rows.map(({ commit, color }, row) => {
          const refs = named.get(commit.sha)
          const time = commit.committedAt == null ? null : new Date(commit.committedAt)
          const short = commit.sha.slice(0, 7)
          return html`<li class=${classMap({ 'history-row': true, 'is-shown': commit.sha === shown })}>
            ${github ? html`<a class="history-sha" href=${`${github}/commit/${commit.sha}`} target="_blank" rel="noopener noreferrer" tabindex="-1"
              aria-label=${`Commit ${short} on GitHub`}>${short}</a>` : html`<code class="history-sha">${short}</code>`}
            ${refChips(refs, color, revision, github)}
            <span class="history-subject" id=${`history-subject-${commit.sha}`}>${subjectLinks(commit.subject || '(no message)', github)}</span>
            <button type="button" class="history-commit" id=${`history-commit-${commit.sha}`} tabindex=${row === focused ? 0 : -1}
              aria-labelledby=${`history-subject-${commit.sha} history-commit-${commit.sha}`} aria-current=${commit.sha === shown ? 'true' : nothing}
              @click=${() => this.open(commit, refs)}>
              <span class="history-author">${commitAuthors(commit.authorLogin, commit.authorName, commit.coauthors)}</span>
              ${time ? html`<time class="history-time" datetime=${time.toISOString()}>${compactTime(commit.committedAt)}</time>` : html`<span class="history-time"></span>`}
            </button>
          </li>`
        })}</ol>
      </div>
      ${entry.cut ? html`<p class="history-note">Only the first 5,000 branches by name are read.</p>` : nothing}
      ${entry.more || entry.moreError ? html`<div class="history-more">
        ${entry.moreError ? html`<span role="alert">${entry.moreError}</span>` : nothing}
        <button type="button" ?disabled=${entry.loadingMore} @click=${more}>${entry.loadingMore ? 'Reading…' : 'Older commits'}</button>
      </div>` : nothing}
    </div>`
  }
}
if (!customElements.get('repository-history')) customElements.define('repository-history', RepositoryHistory)
