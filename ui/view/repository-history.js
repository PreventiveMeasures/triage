// The code viewer's History tab (render-bundle.js): a repository's commits as
// `git log --oneline --decorate --graph` lists them, from the revision shown,
// or, at its root, across its branches as `--all` does. One compact line a
// commit: its short id, the branches and tags naming it, its subject, author
// and time, beside the graph of the lines its parents make (history-graph.js),
// the commit shown marked. A directory's history lists the commits touching
// it, in a line. Opening a commit shows its code. The server reads it with
// the reader's own GitHub access (GET /api/admin/repositories/history); what
// it answered is kept a while, for the session that read it.
import { LitElement, html, nothing, svg } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { styleMap } from 'lit/directives/style-map.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { state } from '#client/index.js'
import { fetchRepositoryHistory } from './client-managed.js'
import { firstParentLine, historyLayout, historyOrder } from './history-graph.js'
import { TAG_ICON_SVG } from './icons.js'
import { unwatchNearViewport, watchNearViewport } from './lazy-render.js'
import { navigateToRepositoryCode, shownRevision } from './repository-code.js'
import { activityPicker } from './repository-activity.js'

// The graph's geometry, in pixels: a lane's width, a line's height, and the
// margin before the first lane and after the last.
const LANE = 12
const ROW = 24
const EDGE = 9
const LANE_COLORS = 8
const MAX_REFS = 3
const KEEP_MS = 5 * 60_000
const RETRY_MS = 30_000
// Where every branch's next page reads on from, as many as the server reads
// branches at first (repository-history.ts ALL_BRANCHES).
const ALL_STARTS = 25

const histories = new Map()
const shownElements = new Set()
let keptFor = null
// `--all` unless the reader asked for the revision's own history, and for
// the repositories reading every branch was refused for want of a sign-in.
let preferAll = true
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
function historyRead(key, ask, settle) {
  const data = sessionHistories()
  const held = data.get(key)
  if (held && Date.now() < held.until) return held
  const loading = { status: 'loading', until: Number.POSITIVE_INFINITY }
  data.set(key, loading)
  ask(1).then(answer => {
    if (data.get(key) === loading) {
      const entry = { status: 'ready', until: Date.now() + KEEP_MS, page: 1, commits: answer.commits, more: answer.more === true,
        branches: answer.branches ?? [], tags: answer.tags ?? [], defaultBranch: answer.defaultBranch ?? null, unread: answer.unread, cut: answer.cut === true,
        loadingMore: false, moreError: null }
      settle?.(entry)
      data.set(key, entry)
    }
    return null
  }, err => {
    if (data.get(key) !== loading) return null
    if (err?.name === 'AbortError') data.delete(key)
    else data.set(key, { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'The history could not be read.', code: err?.code ?? null })
    return null
  }).finally(repaint)
  return loading
}

// This revision's history from every branch's, where that holds the commit
// shown, read again of none: the commits it reaches among them, its history
// going on where one has a parent not among them, its older commits read on
// from there (settleFrontier).
export function revisionFromAll(all, commit) {
  const bySha = new Map(all.commits.map(item => [item.sha, item]))
  if (!bySha.has(commit)) return null
  const reached = new Set()
  for (const queue = [commit]; queue.length > 0;) {
    const sha = queue.pop()
    if (reached.has(sha) || !bySha.has(sha)) continue
    reached.add(sha)
    queue.push(...bySha.get(sha).parents)
  }
  const commits = all.commits.filter(item => reached.has(item.sha))
  return settleFrontier({ status: 'ready', until: all.until, page: 1, commits, more: commits.some(item => item.parents.some(parent => !bySha.has(parent))),
    branches: all.branches, tags: all.tags, defaultBranch: all.defaultBranch, unread: [], loadingMore: false, moreError: null })
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
function checked(answer) {
  if (!Array.isArray(answer?.commits)) throw new Error('The server answered with no history.')
  const commits = answer.commits.filter(commit => typeof commit?.sha === 'string' && SHA.test(commit.sha) && Array.isArray(commit.parents))
  const unread = Array.isArray(answer.unread) ? answer.unread.filter(head => typeof head?.name === 'string' && typeof head.sha === 'string' && SHA.test(head.sha)) : []
  return { ...answer, commits, unread }
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

// The branches and tags naming each commit, by its id: the default branch's
// first, then branches, then tags, as `--decorate` lists them.
export function historyRefs({ branches = [], tags = [] }, defaultBranch) {
  const named = new Map()
  const add = (sha, ref) => named.set(sha, [...named.get(sha) ?? [], ref])
  for (const branch of branches.toSorted((a, b) => Number(b.name === defaultBranch) - Number(a.name === defaultBranch))) {
    add(branch.sha, { kind: 'branch', name: branch.name, main: branch.name === defaultBranch })
  }
  for (const tag of tags) add(tag.sha, { kind: 'tag', name: tag.name })
  return named
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

// A commit's branches and tags, as chips, a branch's marked in its line's
// `color`: the first few, then how many more, those named in its tooltip.
function refChips(refs, color, revision) {
  if (!refs?.length) return nothing
  const chip = ref => html`<span class=${classMap({ 'history-ref': true, [`is-${ref.kind}`]: true, 'is-default': ref.main === true,
    'is-shown': ref.kind === revision.kind && ref.name === revision.name })}>${ref.kind === 'tag' ? unsafeHTML(TAG_ICON_SVG) : nothing}<span>${ref.name}</span></span>`
  const rest = refs.slice(MAX_REFS)
  return html`<span class="history-refs" style=${styleMap({ '--ref': `var(--lane-${color})` })}>${refs.slice(0, MAX_REFS).map(chip)}${rest.length > 0
    ? html`<span class="history-ref is-more" data-tooltip=${rest.map(ref => ref.name).join(', ')}>+${rest.length}</span>` : nothing}</span>`
}

// The tab's body, for the directory shown (`repository`, an entry's) and
// the repository's branches and tags (`refs`, repository-code.js
// repositoryRefs), naming its revision.
class RepositoryHistory extends LitElement {
  static properties = { repository: { attribute: false }, refs: { attribute: false } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repository = null
    this.refs = null
    this._drawn = null
    this._moreButton = null
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
  // while it stays near; not after one failed, which waits for a click.
  // Watched again after every update, so that whether it is near is where
  // it is now, below the lines that update added, never where it was.
  updated() {
    const button = this.querySelector('.history-more > button')
    if (this._moreButton && this._moreButton !== button) unwatchNearViewport(this._moreButton)
    this._moreButton = button
    if (button) watchNearViewport(button, near => { if (near) this.readNear(button) })
  }

  readNear(button) {
    if (button === this._moreButton && button.isConnected && !button.disabled && !button.parentElement.querySelector('[role=alert]')) button.click()
  }

  // What it lists: a directory's commits ('path'), every branch's ('all'),
  // or the revision's ('revision').
  mode() {
    const { repoId, path } = this.repository
    if (path) return 'path'
    sessionHistories()
    return preferAll && !allRefused.has(repoId) ? 'all' : 'revision'
  }

  history(mode) {
    const { repoId, commit, path } = this.repository
    const key = mode === 'all' ? `all\0${repoId}` : `${repoId}\0${commit}\0${path}`
    const ask = (page, held) => fetchRepositoryHistory(repoId, mode === 'all' ? '' : commit, path,
      { page, all: mode === 'all', ...mode !== 'path' && page > 1 ? { from: held.next } : {} }).then(answer => {
      if (mode !== 'all' && answer?.commit !== commit) throw new Error('The server answered with another revision\'s history.')
      return checked(answer)
    })
    // This revision's history, where All branches' holds its commit, comes
    // from that, unread again; All branches' own is read all the same.
    const held = sessionHistories()
    const fresh = entry => entry && Date.now() < entry.until
    const all = mode === 'revision' && !fresh(held.get(key)) ? held.get(`all\0${repoId}`) : null
    const derived = all?.status === 'ready' && fresh(all) ? revisionFromAll(all, commit) : null
    if (derived) held.set(key, derived)
    const settle = mode === 'path' ? null : settleFrontier
    const entry = historyRead(key, ask, settle)
    if (mode === 'all' && entry.status === 'error' && entry.code === 'github-token-required') {
      allRefused.add(repoId)
      return { mode: 'revision', ...this.history('revision') }
    }
    return { mode, key, entry, more: () => readMore(key, entry, ask, settle) }
  }

  // The graph of what it holds, laid out again only as that changes.
  layout(mode, entry, defaultBranch) {
    const drawn = this._drawn
    if (drawn?.commits === entry.commits && drawn.mode === mode && drawn.defaultBranch === defaultBranch) return drawn.layout
    const linear = mode === 'path'
    const ordered = linear ? entry.commits : historyOrder(entry.commits)
    const tip = mode === 'all' ? entry.branches.find(branch => branch.name === defaultBranch)?.sha : ordered[0]?.sha
    const layout = historyLayout(ordered, { linear, trunk: tip && !linear ? firstParentLine(ordered, tip) : null, colors: LANE_COLORS })
    this._drawn = { commits: entry.commits, mode, defaultBranch, layout }
    return layout
  }

  pick(mode) {
    preferAll = mode === 'all'
    repaint()
  }

  // A commit's code, named by the branch, else the tag, naming it.
  open(commit, refs) {
    const { repoId, repo, path } = this.repository
    const ref = refs?.find(item => item.kind === 'branch') ?? refs?.find(item => item.kind === 'tag')
    navigateToRepositoryCode({ repoId, repo, path, commit: commit.sha, bundleTab: 'code', ...ref ? { revision: { kind: ref.kind, name: ref.name } } : {} })
  }

  // Up and down move between lines, Home and End to the first and last.
  keydown(event) {
    const rows = [...this.querySelectorAll('.history-commit')]
    const at = rows.indexOf(event.target)
    if (at === -1) return
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[event.key]
    if (to == null || !rows[to]) return
    event.preventDefault()
    for (const row of rows) row.tabIndex = row === rows[to] ? 0 : -1
    rows[to].focus()
  }

  render() {
    if (!this.repository) return nothing
    const { mode, key, entry, more } = this.history(this.mode())
    const ready = entry.status === 'ready'
    const branches = ready && mode === 'all' ? entry.branches.length : 0
    const count = ready ? `${entry.commits.length}${entry.more || entry.cut ? '+' : ''} commit${entry.commits.length === 1 ? '' : 's'}` : ''
    return html`<div class="history-bar">
        ${activityPicker('history')}
        ${mode === 'path' ? html`<span class="history-scope">Commits touching <code>${this.repository.path}</code></span>`
          : html`<div class="history-modes" role="group" aria-label="History">
            <button type="button" aria-pressed=${String(mode === 'revision')} @click=${() => this.pick('revision')}>This revision</button>
            <button type="button" aria-pressed=${String(mode === 'all')} ?disabled=${allRefused.has(this.repository.repoId)} @click=${() => this.pick('all')}>All branches</button>
          </div>
          ${allRefused.has(this.repository.repoId) ? html`<span class="history-scope">Every branch needs your GitHub sign-in.</span>` : nothing}`}
        ${ready ? html`<span class="history-summary">${count}${branches > 0 ? ` on ${branches} branch${branches === 1 ? '' : 'es'}` : ''}</span>` : nothing}
      </div>
      ${ready ? this.renderCommits(mode, entry, more)
        : entry.status === 'error' ? html`<div class="bundles-slide-placeholder is-error"><p role="alert">${entry.error}</p>
            <button type="button" @click=${() => { sessionHistories().delete(key); repaint() }}>Retry</button></div>`
        : html`<div class="bundles-slide-placeholder" role="status">Reading the history…</div>`}`
  }

  renderCommits(mode, entry, more) {
    if (entry.commits.length === 0) return html`<div class="bundles-slide-placeholder">No commits.</div>`
    const shown = this.repository.commit
    const revision = shownRevision(this.repository, this.refs)
    const defaultBranch = mode === 'all' ? entry.defaultBranch : this.refs?.status === 'ready' ? this.refs.value.defaultBranch ?? null : null
    const layout = this.layout(mode, entry, defaultBranch)
    const named = historyRefs(entry, defaultBranch)
    const focused = Math.max(0, layout.rows.findIndex(row => row.commit.sha === shown))
    const graphWidth = EDGE * 2 + (layout.width - 1) * LANE
    return html`<div class="history-scroll">
      ${mode === 'all' && !layout.rows.some(row => row.commit.sha === shown) ? html`<p class="history-note">
        <code>${shown.slice(0, 7)}</code> isn’t among these commits.
        <button type="button" class="history-link" @click=${() => this.pick('revision')}>Show its history</button></p>` : nothing}
      <div class="history-lines" style=${styleMap({ '--history-graph': `${graphWidth}px` })}>
        ${historyGraph(layout, shown)}
        <ol class="history-list" aria-label="Commits" @keydown=${this.keydown}>${layout.rows.map(({ commit, color }, row) => {
          const refs = named.get(commit.sha)
          const time = commit.committedAt == null ? null : new Date(commit.committedAt)
          return html`<li class=${classMap({ 'history-row': true, 'is-shown': commit.sha === shown })}>
            <button type="button" class="history-commit" tabindex=${row === focused ? 0 : -1} aria-current=${commit.sha === shown ? 'true' : nothing}
              @click=${() => this.open(commit, refs)}>
              <code class="history-sha">${commit.sha.slice(0, 7)}</code>
              ${refChips(refs, color, revision)}
              <span class="history-subject">${commit.subject || '(no message)'}</span>
              <span class="history-author">${commit.authorName ?? commit.authorLogin ?? ''}</span>
              ${time ? html`<time class="history-time" datetime=${time.toISOString()}>${compactTime(commit.committedAt)}</time>` : html`<span class="history-time"></span>`}
            </button>
          </li>`
        })}</ol>
      </div>
      ${entry.cut ? html`<p class="history-note">Only the first 1,000 branches by name are read.</p>` : nothing}
      ${entry.more || entry.moreError ? html`<div class="history-more">
        ${entry.moreError ? html`<span role="alert">${entry.moreError}</span>` : nothing}
        <button type="button" ?disabled=${entry.loadingMore} @click=${more}>${entry.loadingMore ? 'Reading…' : 'Older commits'}</button>
      </div>` : nothing}
    </div>`
  }
}
if (!customElements.get('repository-history')) customElements.define('repository-history', RepositoryHistory)
