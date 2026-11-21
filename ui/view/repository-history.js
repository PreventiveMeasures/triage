// The code viewer's Commits (render-bundle.js): a repository's commits as
// `git log --oneline --decorate --graph [--all]` lists them, every branch's
// or those not merged (the revision's alone where every branch needs the
// reader's GitHub sign-in), or a directory's, in a line. One line a commit:
// its short id, refs, subject, author and time, beside its graph
// (history-graph.js). Read with the reader's own GitHub access
// (GET /api/admin/repositories/history).
import { LitElement, html, nothing, svg } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { styleMap } from './style-map.js'
import { appMarkup } from './markup.js'
import { fetchRepositoryHistory } from './client-managed.js'
import { firstParentLine, historyLayout, historyOrder } from './history-graph.js'
import { PULL_ICON_SVG, TAG_ICON_SVG } from './icons.js'
import { navigateToRepositoryCode, shownRevision } from './repository-code.js'
import { activityPicker } from './repository-activity.js'
import { commitAuthors } from './github-users.js'
import { heldRead } from './held-read.js'
import { KEEP_MS, RETRY_MS, failedRead, moreButton, readMore, readingBody, sessionKept, shownElements } from './activity-reads.js'

// The graph's geometry, in pixels: a lane's width, a line's height, and the
// margin before the first lane and after the last.
const LANE = 12
const ROW = 24
const EDGE = 9
const LANE_COLORS = 8
const MAX_REFS = 3
// What keys reach in a line: its links on GitHub, then its button.
const LINE_KEYS = 'a[href], .history-commit'
// The longest a read again of every branch, answered as the server kept them, waits to ask once more.
const RETRY_FRESH_MS = 15_000
// How long after an answer whose squashed pull requests GitHub is still
// looking up to ask for them again, and how many times (askPulls).
const PULLS_MS = 3000
const PULLS_TRIES = 10
// Where every branch's next page reads on from, as many as the server reads
// branches at first (repository-history.ts ALL_BRANCHES).
const ALL_STARTS = 25

// What the reader asked for, every branch ('all') or those not merged
// ('unmerged'); and the repositories every branch was refused for want of a
// sign-in, which show the revision's own ('revision').
let preferred = 'all'
const allRefused = new Set()
const sessionHistories = sessionKept(new Map(), allRefused)
const { Shown, shown: shownHistories, repaint } = shownElements(LitElement)

// A history's first page as read, `sought` the commits shown it was read
// again, afresh, for (refreshHistory).
function readEntry(answer, settle, sought = new Set()) {
  const entry = { status: 'ready', until: Date.now() + KEEP_MS, page: 1, commits: answer.commits, more: answer.more === true,
    branches: answer.branches ?? [], tags: answer.tags ?? [], defaultBranch: answer.defaultBranch ?? null, unread: answer.unread, cut: answer.cut === true,
    pulls: answer.pulls, pullsPending: answer.pullsPending === true, openPulls: answer.openPulls, loadingMore: false, moreError: null, sought }
  settle?.(entry)
  return entry
}

// The pull requests squashed into `pulls`' commits added to those `entry`
// holds, each once.
function addPulls(entry, pulls) {
  const merges = new Set(entry.pulls.map(pull => pull.merge))
  const added = pulls.filter(pull => !merges.has(pull.merge))
  if (added.length > 0) entry.pulls = [...entry.pulls, ...added]
}

// A page whose squashed pull requests GitHub was still looking up
// (`pullsPending`): asked again PULLS_MS later, those found added, as long
// as GitHub still looks, PULLS_TRIES times at most.
function askPulls(key, entry, ask, page, held, tries = 1) {
  setTimeout(() => {
    if (sessionHistories().get(key) !== entry) return
    ask(page, held).then(answer => {
      if (sessionHistories().get(key) !== entry) return null
      addPulls(entry, answer.pulls)
      if (answer.pullsPending && tries < PULLS_TRIES) askPulls(key, entry, ask, page, held, tries + 1)
      return null
    }, () => null).finally(repaint)
  }, PULLS_MS)
}

// The history `key` names, as held, else read (held-read.js): 'loading',
// then 'ready' (readEntry), or 'error' with its `error` and `code`.
function historyRead(key, ask, settle) {
  return heldRead(sessionHistories(), key, () => ask(1), {
    ready: answer => readEntry(answer, settle),
    settled: entry => { if (entry.pullsPending) askPulls(key, entry, ask, 1, null) },
    failed: err => {
      const failed = failedRead(err, 'The history could not be read.')
      return failed && { ...failed, code: err?.code ?? null }
    },
    retryMs: RETRY_MS, repaint,
  })
}

// Every branch's history read again afresh for the commit shown, its
// branches read now rather than as the server kept them: the one held shown
// meanwhile (`refreshing`), and kept where that read fails; once per commit
// shown, and once more where the server answered as it kept them, when it
// may read them again (`retryIn`, `retryAt`).
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
    if (entry.pullsPending) askPulls(key, entry, ask, 1, null)
    return null
  }, () => null).finally(() => {
    held.refreshing = false
    repaint()
  })
}

// A whole repository's history read on (`settle`, as each page is read):
// the unread branches now naming a listed commit join the branches, and the
// next page reads on from the parents not listed and the branches not read,
// the newest first (a parent by its child's time), ALL_STARTS at most, none
// twice (repository-history.ts historyFrom).
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

// The next page of a history; where it read on from, for its pull requests
// asked again.
function readOn(key, entry, ask, settle) {
  const from = { next: entry.next }
  readMore(entry, {
    held: () => sessionHistories().get(key) === entry,
    ask: () => ask(entry.page + 1, from),
    merge: answer => {
      const held = new Set(entry.commits.map(commit => commit.sha))
      entry.commits = [...entry.commits, ...answer.commits.filter(commit => !held.has(commit.sha))]
      addPulls(entry, answer.pulls)
      entry.page += 1
      entry.more = answer.more === true
      settle?.(entry)
      if (answer.pullsPending) askPulls(key, entry, ask, entry.page, from)
    },
    error: 'More commits could not be read.', repaint,
  })
}

// A server's answer, its commits and unread branches those naming an id.
const SHA = /^[a-f\d]{40}$/u
const isCommit = commit => typeof commit?.sha === 'string' && SHA.test(commit.sha) && Array.isArray(commit.parents)
function checked(answer) {
  if (!Array.isArray(answer?.commits)) throw new TypeError('The server answered with no history.')
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

// The branches not merged of those read: the commits the default branch's
// `tip` doesn't reach, a squash merge reaching its pull request's
// (plantedCommits), as `git log --all --not <tip>` lists them. Only those
// newer than the oldest of the tip's own line read: one older may be merged
// where the default branch isn't read yet.
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

// The commits drawn of those listed: each a pull request was squashed into
// as the merge it was, its pull request's head its other parent, and that
// one's own commits, each once, marked by the pull request (`pull`).
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

// The refs naming each commit, by its id, as `--decorate` lists them: the
// default branch first, then branches, then the pull requests whose heads
// they are (squashed or open), then tags.
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

// The repository's page on GitHub, once its full name is known.
export const githubOf = repo => repo ? `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}` : null

// A subject, each `#12` in it (as GitHub links them: alone or after a space
// or bracket) linking to it on GitHub (`github`, githubOf's), in a new tab,
// by its issue's address, which GitHub sends on to a pull request's.
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

// A commit's refs as chips in its line's `color`: the first few, then how
// many more, named in its tooltip. A pull request's opens it on GitHub.
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

// The history of the directory `repository` shows in `mode`
// (RepositoryHistory.mode): its `entry` (historyRead), the `key` it is held
// by, and `more`, reading its next page. Unmerged reads every branch's;
// every branch's refused for want of a sign-in, the revision's.
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
  // Every branch's, as the server kept them, missing the commit shown (the
  // squashed pull requests' planted too): read again, afresh.
  if (every && entry.status === 'ready' && !entry.refreshing && !entry.sought.has(commit) && !(entry.retryAt > Date.now())
    && !plantedCommits(entry.commits, entry.pulls ?? []).some(item => item.sha === commit)) {
    refreshHistory(key, entry, ask, settle, commit)
  }
  if (every && entry.status === 'error' && entry.code === 'github-token-required') {
    allRefused.add(repoId)
    return readHistory(repository, 'revision')
  }
  return { mode, key, entry, more: () => readOn(key, entry, ask, settle) }
}

// What Replay plays (repository-replay.js): the history of the revision a
// directory shows (a directory's below the root), as Commits keeps it;
// `element` drawn again as it is read while it watches.
export const revisionHistory = repository => readHistory(repository, repository.path ? 'path' : 'revision')
export const watchHistories = element => { shownHistories.add(element) }
export const unwatchHistories = element => { shownHistories.delete(element) }
export function rereadHistory(key) {
  sessionHistories().delete(key)
  repaint()
}

// The tab's body, for the directory shown (`repository`, an entry's), its
// repository's full name (`repo`, repository-code.js repositoryFullName,
// once known) and branches and tags (`refs`, repositoryRefs).
class RepositoryHistory extends Shown {
  static properties = { repository: { attribute: false }, repo: { attribute: false }, refs: { attribute: false } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repository = null
    this.repo = null
    this.refs = null
    this._drawn = null
    this._mode = null
  }

  // Older commits read as their button nears; not for Unmerged, a page of
  // which may add no line, and would read the whole history on its own.
  updated() {
    this.watchMore(() => this._mode !== 'unmerged')
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

  // The graph of what it holds, the squashed pull requests planted as the
  // branches they were, or of its branches not merged, laid out again only
  // as that changes.
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
      ${ready ? this.renderCommits(mode, entry, more, layout, defaultBranch) : readingBody(entry, 'Reading the history…', () => rereadHistory(key))}`
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
    // A line's links on GitHub reached by keys along it (keydown); the rest
    // of it, its button, named by its subject, opening its code.
    const github = githubOf(this.repo ?? this.repository.repo)
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
      ${moreButton(entry, more, 'Older commits')}
    </div>`
  }
}
if (!customElements.get('repository-history')) customElements.define('repository-history', RepositoryHistory)
