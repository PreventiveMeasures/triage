// The code viewer's Agents tab (render-bundle.js): the sessions of Claude, of
// Codex and of the agents the server knows by their GitHub Apps that the
// repository shows, reconstructed (common/managed/agent-tasks.ts)
// from its pull requests, the commits merging them and those pushed to its
// default branch, its branches and its issues, as the server reads them
// (GET /api/admin/repositories/agents), a page at a time as the end of the
// scroll nears. A session is a compact tile in a grid, as an issue is: its
// title, opening it where it ran, its agent, author and age, its tasks (the
// pull requests it opened and the commits it pushed) and the issues it
// worked on, each opening on GitHub, and its branch. What was read is kept a
// while, for the session that read it.
import { LitElement, html, nothing } from 'lit'
import { state } from '#client/index.js'
import { agentSessions } from '../../common/managed/agent-tasks.ts'
import { fetchRepositoryAgents } from './client-managed.js'
import { unwatchNearViewport, watchNearViewport } from './lazy-render.js'
import { compactTime } from './repository-history.js'
import { openRepositoryItemDialog } from './lazy-dialogs.js'
import { BRANCH_ICON, COMMIT_ICON, PULL_ICON, agentIcon, agentName, knowAgents, plainClick, sessionLink } from './repository-tiles.js'
import { activityPicker } from './repository-activity.js'
import { githubUser, githubUserName } from './github-users.js'

export { sessionLink }

const KEEP_MS = 5 * 60_000
const APP_AGENT = /^[a-z][a-z\d-]{0,31}$/u
// An app agent's avatar, as the server serves it: a GitHub App's or account's.
const AGENT_AVATAR = /^(?:app|user)-[1-9]\d{0,11}$/u
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

// A server's answer, its artifacts those it names by number, id or name, and
// the agents it knows by their GitHub Apps or accounts (its first page's),
// each by id, name and avatar; an artifact's those of them it names.
function checked(answer) {
  if (!Array.isArray(answer?.pulls) || !Array.isArray(answer.commits)) throw new Error('The server answered with no pull requests or commits.')
  const agents = (Array.isArray(answer.agents) ? answer.agents : []).filter(agent => typeof agent?.id === 'string' && APP_AGENT.test(agent.id)
    && !['claude', 'codex', 'all'].includes(agent.id) && typeof agent.name === 'string' && agent.name.trim() && typeof agent.avatar === 'string'
    && AGENT_AVATAR.test(agent.avatar)).map(({ id, name, avatar }) => [id, { id, name: name.trim().slice(0, 64), avatar }])
  const signed = item => Array.isArray(item?.signals?.sessions) && Array.isArray(item.signals.tasks)
  // An artifact's app agents, by id.
  const marked = item => ({ ...item, signals: { ...item.signals, agents: Array.isArray(item.signals.agents)
    ? item.signals.agents.filter(agent => typeof agent === 'string' && APP_AGENT.test(agent) && !['claude', 'codex', 'all'].includes(agent)) : [] } })
  return {
    pulls: answer.pulls.filter(pull => Number.isSafeInteger(pull?.number) && typeof pull.title === 'string' && Array.isArray(pull.closes) && signed(pull)).map(marked),
    commits: answer.commits.filter(commit => typeof commit?.oid === 'string' && /^[a-f\d]{40}$/u.test(commit.oid) && signed(commit)).map(marked),
    issues: Array.isArray(answer.issues) ? answer.issues.filter(issue => Number.isSafeInteger(issue?.number)) : [],
    branches: Array.isArray(answer.branches) ? answer.branches.filter(branch => typeof branch?.name === 'string' && signed(branch)).map(marked) : [],
    agents: [...new Map(agents).values()],
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
    knowAgents(answer.agents)
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
// word of `filter`: in a title, author (a login, or its user's name),
// branch, pull request, commit, issue or session id.
export function filterSessions(sessions, agent, filter) {
  const words = filter.trim().toLowerCase().split(/\s+/u).filter(Boolean)
  return sessions.filter(session => {
    if (agent !== 'all' && !session.agents.includes(agent)) return false
    if (words.length === 0) return true
    const text = [session.title, ...session.authors, ...session.authors.map(githubUserName), ...session.branches, ...session.sessions, ...session.tasks,
      ...session.pulls.flatMap(pull => [`#${pull.number}`, pull.title]), ...session.commits.flatMap(commit => [commit.oid.slice(0, 7), commit.title]),
      ...session.issues.flatMap(issue => [`#${issue.number}`, issue.title])].join('\n').toLowerCase()
    return words.every(word => text.includes(word))
  })
}

const TILE_STATES = { open: 'open', merged: 'merged', closed: 'closed', branch: 'draft' }
// The agents an entry's sessions are picked among, Claude and Codex first,
// then those the server knows by their apps or accounts that have a session
// among those read; and counted by, at the bar's end, those first and Claude
// and Codex last: either way, Claude's and Codex's in their places whatever
// others there are.
const appAgentsOf = entry => (entry.agents ?? []).map(agent => agent.id).filter(agent => (entry.sessions ?? []).some(session => session.agents.includes(agent)))
const agentsOf = entry => ['claude', 'codex', ...appAgentsOf(entry)]
// What an agent did, by icon: the pull requests it opened, the branches it
// pushed, and its commits to the default branch no pull request merged.
const STATS = [
  ['pulls', PULL_ICON, 'pull request', 'pull requests'],
  ['branches', BRANCH_ICON, 'branch', 'branches'],
  ['commits', COMMIT_ICON, 'commit to the default branch without a pull request', 'commits to the default branch without a pull request'],
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
    // One picked whose sessions are none of those read now, all.
    const picked = agentsOf(entry).includes(shownAgent) ? shownAgent : 'all'
    const shown = filterSessions(sessions, picked, this._filter)
    return html`<div class="history-bar issues-bar">
        ${activityPicker('agents')}
        <div class="history-modes" role="group" aria-label="Agents">
          <button type="button" aria-pressed=${String(picked === 'all')} @click=${() => this.pick('all')}>All${counted('all')}</button>
          ${agentsOf(entry).map(agent => html`<button type="button" class=${`agent-pick is-${agent}`} aria-pressed=${String(picked === agent)}
            @click=${() => this.pick(agent)}>${agentIcon(agent)}${agentName(agent)}${counted(agent)}</button>`)}
        </div>
        <input class="issues-filter" type="search" placeholder="Filter" aria-label="Filter the sessions read" .value=${this._filter}
          @input=${event => { this._filter = event.target.value }}>
        ${ready ? this.renderStats(entry) : nothing}
        ${ready ? html`<span class="history-summary">${entry.pulls.length} pull request${entry.pulls.length === 1 ? '' : 's'} read</span>` : nothing}
      </div>
      ${ready ? this.renderSessions(entry, shown, more, picked)
        : entry.status === 'error' ? html`<div class="bundles-slide-placeholder is-error"><p role="alert">${entry.error}</p>
            <button type="button" @click=${() => { sessionLists().delete(key); repaint() }}>Retry</button></div>`
        : html`<div class="bundles-slide-placeholder" role="status">Reading what the agents did…</div>`}`
  }

  // Each agent's mark, and beside it what it did among the sessions read,
  // each by its icon and count, more to come where its pages are left to
  // read: pull requests', which a branch alone may wait for, or commits'.
  // An agent shows only with a session among those read, and with no commit
  // to the default branch without a pull request, no count of them.
  renderStats(entry) {
    const left = { pulls: Boolean(entry.after?.pulls), branches: Boolean(entry.after?.pulls), commits: Boolean(entry.after?.commits) }
    const shown = agent => entry.sessions.some(session => session.agents.includes(agent))
    return html`<span class="agent-totals">${[...appAgentsOf(entry), 'claude', 'codex'].filter(shown).map(agent => {
      const stats = agentStats(entry.sessions, agent)
      return html`<span class="agent-stats" role="group" aria-label=${agentName(agent)}>
        <span class=${`agent-mark is-${agent}`}>${agentIcon(agent)}</span>
        ${STATS.filter(([kind]) => kind !== 'commits' || stats.commits > 0).map(([kind, glyph, one, many]) => {
          const count = `${stats[kind].toLocaleString('en-US')}${left[kind] ? '+' : ''}`
          const name = `${count} ${stats[kind] === 1 && !left[kind] ? one : many}`
          return html`<span class="agent-stat" role="img" aria-label=${name} data-tooltip=${name}>${glyph}${count}</span>`
        })}
      </span>`
    })}</span>`
  }

  renderSessions(entry, shown, more, picked) {
    const what = picked === 'all' ? 'agents\' sessions' : `${agentName(picked)} sessions`
    return html`<div class="issues-scroll">
      ${shown.length > 0 ? html`<ol class="issues-grid" aria-label="Sessions">${shown.map(session => this.renderSession(session))}</ol>`
        : html`<p class="history-note">${entry.sessions.length > 0 && this._filter.trim() ? `None of the ${what} read match.` : `No ${what} among those read.`}</p>`}
      ${entry.more || entry.moreError ? html`<div class="history-more issues-more">
        ${entry.moreError ? html`<span role="alert">${entry.moreError}</span>` : nothing}
        <button type="button" ?disabled=${entry.loadingMore} @click=${() => { entry.stalled = false; more() }}>${entry.loadingMore ? 'Reading…' : 'More'}</button>
      </div>` : nothing}
    </div>`
  }

  // A session clicked, its card or title, opens its popup; a pull request
  // or issue of it, that one's (dialogs/repository-item-dialog.js). Held
  // with a key, or another button, a link opens as one does; a click on a
  // commit opens it on GitHub.
  openSession(event, session) {
    if (!plainClick(event) || event.target?.closest?.('.agent-chip.is-commit')) return
    event.preventDefault()
    openRepositoryItemDialog({ repository: this.repository, target: { session } })
  }

  openItem(event, number, preview) {
    if (!plainClick(event)) return
    event.preventDefault()
    event.stopPropagation()
    openRepositoryItemDialog({ repository: this.repository, target: { number, preview } })
  }

  // A tile: its agents' marks, a rail beside its lines, each one alone: its
  // title, of two at most, opening its popup (where it ran, as a link); its
  // author, age, how many tasks and lines; its pull requests, commits and
  // issues, those that fit, each with how many follow it, seen only past the
  // last of them shown (report.css); and its branch.
  renderSession(session) {
    const repo = this.repository.repo
    const link = sessionLink(session, repo)
    const time = session.updatedAt == null ? null : new Date(session.updatedAt)
    const tasks = session.pulls.length + session.commits.length
    const chips = [
      ...session.pulls.map(pull => [`is-${pull.draft && pull.state === 'open' ? 'draft' : pull.state}`, `pull/${pull.number}`, `#${pull.number}`,
        { kind: 'pulls', ...pull }]),
      ...session.commits.map(commit => ['is-commit', `commit/${commit.oid}`, html`<code>${commit.oid.slice(0, 7)}</code>`, null]),
      // An issue closed, purple, as GitHub's completed are.
      ...session.issues.map(issue => [`is-issue is-${issue.state === 'open' ? 'open' : 'merged'}`, `issues/${issue.number}`,
        html`<span class="sr-only">Issue </span>#${issue.number}`, { kind: 'issues', reason: null, ...issue }]),
    ]
    return html`<li class=${`issue-tile agent-tile is-${TILE_STATES[session.state]}`}><div class="issue-body" @click=${event => this.openSession(event, session)}>
      <span class="issue-rail">${session.agents.map(agent => html`<span class=${`agent-mark is-${agent}`} role="img" aria-label=${agentName(agent)}>${agentIcon(agent)}</span>`)}</span>
      <span class="issue-lines">
        ${link ? html`<a class="issue-name" href=${link} target="_blank" rel="noopener noreferrer">${session.title || '(no title)'}</a>`
          : html`<button type="button" class="issue-name">${session.title || '(no title)'}</button>`}
        <span class="issue-meta">
          ${session.authors[0] ? html`<span class="issue-author">${githubUser(session.authors[0])}</span>` : nothing}
          ${time ? html`<time datetime=${time.toISOString()}>${compactTime(session.updatedAt)}</time>` : nothing}
          <span>${tasks > 0 ? `${tasks} task${tasks === 1 ? '' : 's'}` : 'no pull request'}</span>
          ${session.additions || session.deletions ? html`<span class="issue-diff"><span class="is-added">+${session.additions.toLocaleString('en-US')}</span>
            <span class="is-deleted">−${session.deletions.toLocaleString('en-US')}</span></span>` : nothing}
        </span>
        ${chips.length > 0 ? html`<span class="agent-chips">${chips.slice(0, MAX_CHIPS).map(([kind, path, label, preview], index) => html`<a class=${`agent-chip ${kind}`}
          href=${repo ? `https://github.com/${repo}/${path}` : nothing} target="_blank" rel="noopener noreferrer"
          @click=${preview ? event => this.openItem(event, preview.number, preview) : nothing}
          data-rest=${index < chips.length - 1 ? chips.length - 1 - index : nothing}>${label}</a>`)}</span>` : nothing}
        ${session.branches[0] ? html`<span class="issue-branch"><code>${session.branches[0]}</code>${session.branches.length > 1
          ? html`<span>+${session.branches.length - 1}</span>` : nothing}</span>` : nothing}
      </span>
    </div></li>`
  }
}
if (!customElements.get('repository-agents')) customElements.define('repository-agents', RepositoryAgents)
