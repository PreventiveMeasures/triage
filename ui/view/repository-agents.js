// The code viewer's Agents tab (render-bundle.js): the Claude and Codex
// sessions the repository shows, reconstructed (common/managed/agent-tasks.ts)
// from its pull requests, the commits merging them and those pushed to its
// default branch, its branches and its issues, as the server reads them
// (GET /api/admin/repositories/agents), a page at a time as the end of the
// scroll nears. A session is a compact tile in a grid, as an issue is: its
// title, opening it where it ran, its agent, author and age, its tasks (the
// pull requests it opened and the commits it pushed) and the issues it
// worked on, each opening on GitHub, and its branch. What was read is kept a
// while, for the session that read it.
import { LitElement, html, nothing, svg } from 'lit'
import { state } from '#client/index.js'
import { agentSessions } from '../../common/managed/agent-tasks.ts'
import { fetchRepositoryAgents } from './client-managed.js'
import { unwatchNearViewport, watchNearViewport } from './lazy-render.js'
import { providerIcon } from './provider-icons.js'
import { compactTime } from './repository-history.js'

const KEEP_MS = 5 * 60_000
const RETRY_MS = 30_000
const MAX_CHIPS = 12

const lists = new Map()
const shownElements = new Set()
let keptFor = null
// Every agent's sessions, or one's, as the reader last picked.
let shownAgent = 'all'

function sessionLists() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    lists.clear()
    keptFor = session
  }
  return lists
}

const repaint = () => { for (const element of shownElements) element.requestUpdate() }

// A server's answer, its artifacts those it names by number, id or name.
function checked(answer) {
  if (!Array.isArray(answer?.pulls) || !Array.isArray(answer.commits)) throw new Error('The server answered with no pull requests or commits.')
  const signed = item => Array.isArray(item?.signals?.sessions) && Array.isArray(item.signals.tasks)
  return {
    pulls: answer.pulls.filter(pull => Number.isSafeInteger(pull?.number) && typeof pull.title === 'string' && Array.isArray(pull.closes) && signed(pull)),
    commits: answer.commits.filter(commit => typeof commit?.oid === 'string' && /^[a-f\d]{40}$/u.test(commit.oid) && signed(commit)),
    issues: Array.isArray(answer.issues) ? answer.issues.filter(issue => Number.isSafeInteger(issue?.number)) : [],
    branches: Array.isArray(answer.branches) ? answer.branches.filter(branch => typeof branch?.name === 'string' && signed(branch)) : [],
    more: answer.more === true,
    after: answer.more === true ? { pulls: answer.after?.pulls ?? null, commits: answer.after?.commits ?? null } : null,
  }
}

// The sessions what an entry read makes, kept with it: where pull requests
// are left to read, those of branches alone older than the oldest read wait.
const reconstructed = entry => Object.assign(entry, { sessions: agentSessions(entry, {
  branchesSince: entry.after?.pulls ? Math.min(...entry.pulls.map(pull => pull.updatedAt ?? Number.POSITIVE_INFINITY)) : null,
}) })

// What the repository `key` names showed, as held, else read: `{ status }`,
// 'loading', then 'ready' with the artifacts read, the `sessions` they make,
// and where more follow, the cursors reading them (`after`), or 'error' with
// its `error`; read again once old, or an error's retry is due.
function listRead(key, ask) {
  const data = sessionLists()
  const held = data.get(key)
  if (held && Date.now() < held.until) return held
  const loading = { status: 'loading', until: Number.POSITIVE_INFINITY }
  data.set(key, loading)
  ask(null).then(answer => {
    if (data.get(key) === loading) data.set(key, reconstructed({ status: 'ready', until: Date.now() + KEEP_MS, ...answer, loadingMore: false, moreError: null }))
    return null
  }, err => {
    if (data.get(key) !== loading) return null
    if (err?.name === 'AbortError') data.delete(key)
    else data.set(key, { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'The agents\' work could not be read.' })
    return null
  }).finally(repaint)
  return loading
}

// The next page, after those held: its pull requests and commits, each once.
function readMore(key, entry, ask) {
  if (entry.loadingMore || !entry.more) return
  entry.loadingMore = true
  entry.moreError = null
  // Kept while the next page reads, however long it was held already.
  entry.until = Date.now() + KEEP_MS
  repaint()
  ask(entry.after).then(answer => {
    if (sessionLists().get(key) !== entry) return null
    const pulls = new Set(entry.pulls.map(pull => pull.number))
    const commits = new Set(entry.commits.map(commit => commit.oid))
    entry.pulls = [...entry.pulls, ...answer.pulls.filter(pull => !pulls.has(pull.number))]
    entry.commits = [...entry.commits, ...answer.commits.filter(commit => !commits.has(commit.oid))]
    entry.more = answer.more
    entry.after = answer.after
    entry.until = Date.now() + KEEP_MS
    // A page adding no session leaves the next to a click: most pull
    // requests and commits may be no agent's, and its button, still near,
    // would read the whole history on its own.
    const shown = entry.sessions.length
    reconstructed(entry)
    entry.stalled = entry.sessions.length <= shown
    return null
  }, err => {
    if (err?.name !== 'AbortError') entry.moreError = err?.message || 'More could not be read.'
    return null
  }).finally(() => {
    entry.loadingMore = false
    repaint()
  })
}

// Those of `sessions` of `agent` ('all' for every one's), and matching every
// word of `filter`: in a title, author, branch, pull request, commit, issue
// or session id.
export function filterSessions(sessions, agent, filter) {
  const words = filter.trim().toLowerCase().split(/\s+/u).filter(Boolean)
  return sessions.filter(session => {
    if (agent !== 'all' && !session.agents.includes(agent)) return false
    if (words.length === 0) return true
    const text = [session.title, ...session.authors, ...session.branches, ...session.sessions, ...session.tasks,
      ...session.pulls.flatMap(pull => [`#${pull.number}`, pull.title]), ...session.commits.flatMap(commit => [commit.oid.slice(0, 7), commit.title]),
      ...session.issues.flatMap(issue => [`#${issue.number}`, issue.title])].join('\n').toLowerCase()
    return words.every(word => text.includes(word))
  })
}

// Where a session opens: where it ran, a Claude Code session or a Codex
// task, else its latest pull request or commit, else its branch, on GitHub.
export function sessionLink(session, repo) {
  if (session.sessions[0]) return `https://claude.ai/code/${session.sessions[0]}`
  if (session.tasks[0]) return `https://chatgpt.com/codex/tasks/${session.tasks[0]}`
  if (!repo) return null
  if (session.pulls[0]) return `https://github.com/${repo}/pull/${session.pulls[0].number}`
  if (session.commits[0]) return `https://github.com/${repo}/commit/${session.commits[0].oid}`
  return session.branches[0] ? `https://github.com/${repo}/tree/${session.branches[0].split('/').map(encodeURIComponent).join('/')}` : null
}

const icon = body => html`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${body}</svg>`
// Claude a burst in its orange, Codex OpenAI's mark.
const AGENT_ICONS = {
  claude: icon(svg`<path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/>`),
  codex: html`<span class="agent-logo" aria-hidden="true">${providerIcon('openai')}</span>`,
}
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' }
const TILE_STATES = { open: 'open', merged: 'merged', closed: 'closed', branch: 'draft' }
// What an agent did, by icon: the pull requests it opened, the branches it
// pushed, and its commits to the default branch no pull request merged.
const STATS = [
  ['pulls', icon(svg`<circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M4 5v6M12 11V6a2 2 0 0 0-2-2H7m1.5-1.5L7 4l1.5 1.5"/>`),
    'pull request', 'pull requests'],
  ['branches', icon(svg`<circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="3" r="1.5"/><path d="M4 4.5v7m0-3h3a5 5 0 0 0 5-4"/>`),
    'branch', 'branches'],
  ['commits', icon(svg`<circle cx="8" cy="8" r="3"/><path d="M1 8h4m6 0h4"/>`), 'commit to the default branch without a pull request',
    'commits to the default branch without a pull request'],
]

// How many pull requests, branches and commits to the default branch
// without one `agent`'s `sessions` hold.
export function agentStats(sessions, agent) {
  const its = sessions.filter(session => session.agents.includes(agent))
  return { pulls: its.reduce((sum, session) => sum + session.pulls.length, 0), branches: new Set(its.flatMap(session => session.branches)).size,
    commits: its.reduce((sum, session) => sum + session.commits.length, 0) }
}

// The tab's body, for the repository a directory shown (`repository`, an
// entry's) is in.
class RepositoryAgents extends LitElement {
  static properties = { repository: { attribute: false }, _filter: { state: true } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repository = null
    this._filter = ''
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

  // More read as their button nears the end of the scroll, as the Issues
  // tab's are (repository-issues.js): not after one failed, nor while a
  // filter picks among those read, nor after a page that added no session,
  // till a click reads on. Watched again after every update.
  updated() {
    const button = this.querySelector('.issues-more > button')
    if (this._moreButton && this._moreButton !== button) unwatchNearViewport(this._moreButton)
    this._moreButton = button
    if (button) watchNearViewport(button, near => { if (near) this.readNear(button) })
  }

  readNear(button) {
    if (button === this._moreButton && button.isConnected && !button.disabled && !this._filter.trim() && !button.parentElement.querySelector('[role=alert]')
      && !this.list().entry.stalled) button.click()
  }

  list() {
    const { repoId } = this.repository
    const key = `${repoId}`
    const ask = after => fetchRepositoryAgents(repoId, after ?? {}).then(checked)
    const entry = listRead(key, ask)
    return { key, entry, more: () => readMore(key, entry, ask) }
  }

  pick(agent) {
    shownAgent = agent
    repaint()
  }

  render() {
    if (!this.repository) return nothing
    const { key, entry, more } = this.list()
    const ready = entry.status === 'ready'
    const sessions = ready ? entry.sessions : []
    const counted = agent => ready ? html` <span class="issues-count">${(agent === 'all' ? sessions : sessions.filter(session => session.agents.includes(agent))).length}${entry.more ? '+' : ''}</span>` : nothing
    const shown = filterSessions(sessions, shownAgent, this._filter)
    return html`<div class="history-bar issues-bar">
        <div class="history-modes" role="group" aria-label="Agents">
          <button type="button" aria-pressed=${String(shownAgent === 'all')} @click=${() => this.pick('all')}>All${counted('all')}</button>
          ${['claude', 'codex'].map(agent => html`<button type="button" class=${`agent-pick is-${agent}`} aria-pressed=${String(shownAgent === agent)}
            @click=${() => this.pick(agent)}>${AGENT_ICONS[agent]}${AGENT_NAMES[agent]}${counted(agent)}</button>`)}
        </div>
        <input class="issues-filter" type="search" placeholder="Filter" aria-label="Filter the sessions read" .value=${this._filter}
          @input=${event => { this._filter = event.target.value }}>
        ${ready ? this.renderStats(entry) : nothing}
        ${ready ? html`<span class="history-summary">${entry.pulls.length} pull request${entry.pulls.length === 1 ? '' : 's'} read</span>` : nothing}
      </div>
      ${ready ? this.renderSessions(entry, shown, more)
        : entry.status === 'error' ? html`<div class="bundles-slide-placeholder is-error"><p role="alert">${entry.error}</p>
            <button type="button" @click=${() => { sessionLists().delete(key); repaint() }}>Retry</button></div>`
        : html`<div class="bundles-slide-placeholder" role="status">Reading what Claude and Codex did…</div>`}`
  }

  // Each agent's mark, and beside it what it did among the sessions read,
  // each by its icon and count, more to come where its pages are left to
  // read: pull requests', which a branch alone may wait for, or commits'.
  renderStats(entry) {
    const left = { pulls: Boolean(entry.after?.pulls), branches: Boolean(entry.after?.pulls), commits: Boolean(entry.after?.commits) }
    return html`<span class="agent-totals">${['claude', 'codex'].map(agent => {
      const stats = agentStats(entry.sessions, agent)
      return html`<span class="agent-stats" role="group" aria-label=${AGENT_NAMES[agent]}>
        <span class=${`agent-mark is-${agent}`}>${AGENT_ICONS[agent]}</span>
        ${STATS.map(([kind, glyph, one, many]) => {
          const count = `${stats[kind].toLocaleString('en-US')}${left[kind] ? '+' : ''}`
          const name = `${count} ${stats[kind] === 1 && !left[kind] ? one : many}`
          return html`<span class="agent-stat" role="img" aria-label=${name} title=${name}>${glyph}${count}</span>`
        })}
      </span>`
    })}</span>`
  }

  renderSessions(entry, shown, more) {
    const what = shownAgent === 'all' ? 'Claude or Codex sessions' : `${AGENT_NAMES[shownAgent]} sessions`
    return html`<div class="issues-scroll">
      ${shown.length > 0 ? html`<ol class="issues-grid" aria-label="Sessions">${shown.map(session => this.renderSession(session))}</ol>`
        : html`<p class="history-note">${entry.sessions.length > 0 && this._filter.trim() ? `None of the ${what} read match.` : `No ${what} among those read.`}</p>`}
      ${entry.more || entry.moreError ? html`<div class="history-more issues-more">
        ${entry.moreError ? html`<span role="alert">${entry.moreError}</span>` : nothing}
        <button type="button" ?disabled=${entry.loadingMore} @click=${() => { entry.stalled = false; more() }}>${entry.loadingMore ? 'Reading…' : 'More'}</button>
      </div>` : nothing}
    </div>`
  }

  // A tile: its agents' marks, a rail beside its lines, each one alone: its
  // title, of two at most, opening where it ran; its author, age, how many
  // tasks and lines; its pull requests, commits and issues, those that fit,
  // each with how many follow it, seen only past the last of them shown
  // (report.css); and its branch.
  renderSession(session) {
    const repo = this.repository.repo
    const link = sessionLink(session, repo)
    const time = session.updatedAt == null ? null : new Date(session.updatedAt)
    const tasks = session.pulls.length + session.commits.length
    const chips = [
      ...session.pulls.map(pull => [`is-${pull.draft && pull.state === 'open' ? 'draft' : pull.state}`, `pull/${pull.number}`, `#${pull.number}`]),
      ...session.commits.map(commit => ['is-commit', `commit/${commit.oid}`, html`<code>${commit.oid.slice(0, 7)}</code>`]),
      // An issue closed, purple, as GitHub's completed are.
      ...session.issues.map(issue => [`is-issue is-${issue.state === 'open' ? 'open' : 'merged'}`, `issues/${issue.number}`,
        html`<span class="sr-only">Issue </span>#${issue.number}`]),
    ]
    return html`<li class=${`issue-tile agent-tile is-${TILE_STATES[session.state]}`}><div class="issue-body">
      <span class="issue-rail">${session.agents.map(agent => html`<span class=${`agent-mark is-${agent}`} role="img" aria-label=${AGENT_NAMES[agent]}>${AGENT_ICONS[agent]}</span>`)}</span>
      <span class="issue-lines">
        ${link ? html`<a class="issue-name" href=${link} target="_blank" rel="noopener noreferrer">${session.title || '(no title)'}</a>`
          : html`<span class="issue-name">${session.title || '(no title)'}</span>`}
        <span class="issue-meta">
          ${session.authors[0] ? html`<span class="issue-author">${session.authors[0]}</span>` : nothing}
          ${time ? html`<time datetime=${time.toISOString()}>${compactTime(session.updatedAt)}</time>` : nothing}
          <span>${tasks > 0 ? `${tasks} task${tasks === 1 ? '' : 's'}` : 'no pull request'}</span>
          ${session.additions || session.deletions ? html`<span class="issue-diff"><span class="is-added">+${session.additions.toLocaleString('en-US')}</span>
            <span class="is-deleted">−${session.deletions.toLocaleString('en-US')}</span></span>` : nothing}
        </span>
        ${chips.length > 0 ? html`<span class="agent-chips">${chips.slice(0, MAX_CHIPS).map(([kind, path, label], index) => html`<a class=${`agent-chip ${kind}`}
          href=${repo ? `https://github.com/${repo}/${path}` : nothing} target="_blank" rel="noopener noreferrer"
          data-rest=${index < chips.length - 1 ? chips.length - 1 - index : nothing}>${label}</a>`)}</span>` : nothing}
        ${session.branches[0] ? html`<span class="issue-branch"><code>${session.branches[0]}</code>${session.branches.length > 1
          ? html`<span>+${session.branches.length - 1}</span>` : nothing}</span>` : nothing}
      </span>
    </div></li>`
  }
}
if (!customElements.get('repository-agents')) customElements.define('repository-agents', RepositoryAgents)
