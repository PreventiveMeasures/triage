// The code viewer's Agents tab (render-bundle.js): the sessions of Claude,
// Codex and the agents the server knows by their GitHub Apps, reconstructed
// (common/managed/agent-tasks.ts) from the repository's pull requests, the
// commits merging them and those pushed to its default branch, its branches
// and issues (GET /api/admin/repositories/agents), a page at a time as the
// end of the scroll nears. A session is a tile, as an issue is: its title,
// opening where it ran, its agent, author and age, its tasks and issues,
// each opening on GitHub, and its branch.
import { LitElement, html, nothing, svg } from 'lit'
import { agentSessions } from '../../common/managed/agent-tasks.ts'
import { fetchRepositoryAgents } from './client-managed.js'
import { compactTime } from './repository-history.js'
import { BRANCH_ICON, COMMIT_ICON, PULL_ICON, agentIcon, agentName, knowAgents, sessionLink } from './repository-tiles.js'
import { activityPicker, activitySubtab, pickActivitySubtab, watchActivitySubtabs } from './repository-activity.js'
import { commitAgent, githubUser, githubUserName } from './github-users.js'
import { filtered, modeButtons, moreButton, number, pagedRead, readingBody, sessionKept, shownElements, withNew } from './activity-reads.js'

export { sessionLink }

const APP_AGENT = /^[a-z][a-z\d-]{0,31}$/u
// An app agent's avatar, as the server serves it: a GitHub App's or account's.
const AGENT_AVATAR = /^(?:app|user)-[1-9]\d{0,11}$/u
const MAX_CHIPS = 12

const sessionLists = sessionKept(new Map())
const { Shown, repaint } = shownElements(LitElement)
watchActivitySubtabs(tab => { if (tab === 'agents') repaint() })

// A server's answer, its artifacts those naming a number, id or name, and
// the agents it knows by their GitHub Apps or accounts (its first page's),
// each by id, name and avatar; an artifact's those of them it names.
function checked(answer) {
  if (!Array.isArray(answer?.pulls) || !Array.isArray(answer.commits)) throw new TypeError('The server answered with no pull requests or commits.')
  const appAgent = id => typeof id === 'string' && APP_AGENT.test(id) && !['claude', 'codex', 'all'].includes(id)
  const agents = (Array.isArray(answer.agents) ? answer.agents : []).filter(agent => appAgent(agent?.id) && typeof agent.name === 'string' && agent.name.trim()
    && (agent.avatar === undefined || (typeof agent.avatar === 'string' && AGENT_AVATAR.test(agent.avatar))))
    .map(({ id, name, avatar }) => [id, { id, name: name.trim().slice(0, 64), avatar: avatar ?? null }])
  const signed = item => Array.isArray(item?.signals?.sessions) && Array.isArray(item.signals.tasks)
  // An artifact's app agents, by id.
  const marked = item => ({ ...item, signals: { ...item.signals, agents: Array.isArray(item.signals.agents) ? item.signals.agents.filter(appAgent) : [] } })
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

// Those of `sessions` of `agent` ('all' for every one's), and matching every
// word of `filter`: in a title, author (a login, or its user's name),
// branch, pull request, commit, issue or session id.
export const filterSessions = (sessions, agent, filter) => filtered(sessions.filter(session => agent === 'all' || session.agents.includes(agent)), filter, session => [
  session.title, ...session.authors, ...session.authors.map(githubUserName), ...session.branches, ...session.sessions, ...session.tasks,
  ...session.pulls.flatMap(pull => [`#${pull.number}`, pull.title]), ...session.commits.flatMap(commit => [commit.oid.slice(0, 7), commit.title]),
  ...session.issues.flatMap(issue => [`#${issue.number}`, issue.title])])

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

// How much of the repository's pull requests those an entry read are, in
// percent: all, where none are left to read; else as many as are read of the
// numbers up to the highest read, its issues' among them, each taken for a
// pull request, which may undercount it, short of all.
export function pullsReadShare(entry) {
  if (!entry.after?.pulls) return 100
  const highest = Math.max(entry.pulls.length, ...entry.pulls.map(pull => pull.number), ...(entry.issues ?? []).map(issue => issue.number))
  return highest > 0 ? Math.min(99, Math.floor(100 * entry.pulls.length / highest)) : 0
}

// A ring filling as `share` percent of them are read, the percent in it, a check
// once all are, what it counts (`label`) its tooltip; pulsing while a page
// reads (`reading`).
function readGauge(share, label, reading) {
  const length = 2 * Math.PI * 9
  return html`<span class=${`history-summary read-gauge${reading ? ' is-reading' : ''}`} role="progressbar" aria-valuemin="0" aria-valuemax="100"
    aria-valuenow=${share} aria-label=${label} data-tooltip=${label}>
    <svg class="read-gauge-ring" viewBox="0 0 22 22" aria-hidden="true"><circle class="read-gauge-track" cx="11" cy="11" r="9"/>${share > 0
      ? svg`<circle class="read-gauge-arc" cx="11" cy="11" r="9" transform="rotate(-90 11 11)" stroke-dasharray=${`${length * share / 100} ${length}`}/>` : nothing}</svg>
    ${share === 100 ? html`<svg class="read-gauge-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.25 8.5 2.5 2.5 5-5.5"/></svg>`
      : html`<span class="read-gauge-value" aria-hidden="true">${share}%</span>`}</span>`
}

// How many pull requests, branches and commits to the default branch
// without one `agent`'s `sessions` hold.
export function agentStats(sessions, agent) {
  const its = sessions.filter(session => session.agents.includes(agent))
  return { pulls: its.reduce((sum, session) => sum + session.pulls.length, 0), branches: new Set(its.flatMap(session => session.branches)).size,
    commits: its.reduce((sum, session) => sum + session.commits.length, 0) }
}

// The tab's body, for the repository a directory shown (`repository`, an
// entry's) is in, by its full name (`repo`, repository-code.js
// repositoryFullName, once known).
class RepositoryAgents extends Shown {
  static properties = { _filter: { state: true } }

  constructor() {
    super()
    this._filter = ''
  }

  // More read as their button nears, as the Issues tab's are: not while a
  // filter picks, nor after a page that added no session, till a click.
  updated() {
    this.watchMore(() => !this._filter.trim() && !this.list().entry.stalled)
  }

  // What the repository showed, as held, else read (pagedRead): 'loading',
  // then 'ready' with the artifacts read, the `sessions` they make and the
  // cursors reading on (`after`), or 'error'. Its next page's pull requests
  // and commits each once; one adding no session leaves the next to a click
  // (`stalled`): most may be no agent's, and its button, still near, would
  // read the whole history on its own.
  list() {
    const { repoId } = this.repository
    const ask = after => fetchRepositoryAgents(repoId, after ?? {}).then(checked)
    return pagedRead(sessionLists, `${repoId}`, { first: () => ask(null).then(answer => { knowAgents(answer.agents); return answer }), next: ask,
      message: 'The agents\' work could not be read.', repaint, ready: reconstructed,
      merge: (entry, answer) => {
        entry.pulls = withNew(entry.pulls, answer.pulls, pull => pull.number)
        entry.commits = withNew(entry.commits, answer.commits, commit => commit.oid)
        const shown = entry.sessions.length
        reconstructed(entry)
        entry.stalled = entry.sessions.length <= shown
      } })
  }

  pick(agent) {
    pickActivitySubtab(this.repository, 'agents', agent)
  }

  render() {
    if (!this.repository) return nothing
    const { key, entry, more } = this.list()
    const ready = entry.status === 'ready'
    const sessions = ready ? entry.sessions : []
    const counted = agent => ready ? html`<span class="n">${(agent === 'all' ? sessions : sessions.filter(session => session.agents.includes(agent))).length}${entry.more ? '+' : ''}</span>` : nothing
    // Every agent's sessions, or one's, as its route's sub-tab names it
    // (repository-activity.js); one whose sessions are none of those read
    // now, all.
    const named = activitySubtab('agents')
    const picked = agentsOf(entry).includes(named) ? named : 'all'
    const shown = filterSessions(sessions, picked, this._filter)
    return html`<div class="history-bar issues-bar">
        ${activityPicker('agents')}
        ${modeButtons('Agents', [['all', html`All${counted('all')}`], ...agentsOf(entry).map(agent => [agent, html`${agentIcon(agent)}${agentName(agent)}${counted(agent)}`])],
          picked, agent => () => this.pick(agent), agent => agent === 'all' ? nothing : `agent-pick is-${agent}`)}
        <input class="issues-filter" type="search" placeholder="Filter" aria-label="Filter the sessions read" .value=${this._filter}
          @input=${event => { this._filter = event.target.value }}>
        ${ready ? this.renderStats(entry) : nothing}
        ${ready ? readGauge(pullsReadShare(entry), `${entry.pulls.length} pull request${entry.pulls.length === 1 ? '' : 's'} read`, entry.loadingMore) : nothing}
      </div>
      ${ready ? this.renderSessions(entry, shown, more, picked)
        : readingBody(entry, 'Reading what the agents did…', () => { sessionLists().delete(key); repaint() })}`
  }

  // Each agent with a session among those read, its mark and what it did,
  // each by its icon and count, "+" where pages are left to read: pull
  // requests', which a branch alone may wait for, or commits'.
  renderStats(entry) {
    const left = { pulls: Boolean(entry.after?.pulls), branches: Boolean(entry.after?.pulls), commits: Boolean(entry.after?.commits) }
    const shown = agent => entry.sessions.some(session => session.agents.includes(agent))
    return html`<span class="agent-totals">${[...appAgentsOf(entry), 'claude', 'codex'].filter(shown).map(agent => {
      const stats = agentStats(entry.sessions, agent)
      return html`<span class="agent-stats" role="group" aria-label=${agentName(agent)}>
        <span class=${`agent-mark is-${agent}`}>${agentIcon(agent)}</span>
        ${STATS.filter(([kind]) => stats[kind] > 0).map(([kind, glyph, one, many]) => {
          const count = `${number(stats[kind])}${left[kind] ? '+' : ''}`
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
      ${moreButton(entry, () => { entry.stalled = false; more() }, 'More', 'history-more issues-more')}
    </div>`
  }

  // A session clicked, its card or title, opens its popup; a pull request or
  // issue of it, that one's; a commit opens on GitHub.
  openSession(event, session) {
    if (!event.target?.closest?.('.agent-chip.is-commit')) this.openPopup(event, { session })
  }

  openItem(event, itemNumber, preview) {
    if (this.openPopup(event, { number: itemNumber, preview })) event.stopPropagation()
  }

  // A tile: its agents' marks, a rail beside its lines: its title, opening
  // its popup (where it ran, as a link); its author, none for an agent's own
  // account; its age and lines, a single task's beside its chip; its pull
  // requests, commits and issues, those that fit, each with how many follow
  // it, seen only past the last shown (report.css); and its branch.
  renderSession(session) {
    const repo = this.repo ?? this.repository.repo
    const link = sessionLink(session, repo)
    const time = session.updatedAt == null ? null : new Date(session.updatedAt)
    const author = session.authors.find(login => !commitAgent(login))
    const tasks = session.pulls.length + session.commits.length
    const age = time ? html`<time datetime=${time.toISOString()}>${compactTime(session.updatedAt)}</time>` : nothing
    const size = session.additions || session.deletions ? html`<span class="issue-diff"><span class="is-added">+${number(session.additions)}</span>
      <span class="is-deleted">−${number(session.deletions)}</span></span>` : nothing
    const single = tasks === 1
    const meta = [
      author ? html`<span class="issue-author">${githubUser(author)}</span>` : nothing,
      single ? nothing : age,
      tasks === 0 ? html`<span>no pull request</span>` : nothing,
      single ? nothing : size,
    ].filter(part => part !== nothing)
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
        ${meta.length > 0 ? html`<span class="issue-meta">${meta}</span>` : nothing}
        ${chips.length > 0 ? html`<span class="agent-task-row"><span class="agent-chips">${chips.slice(0, MAX_CHIPS).map(([kind, path, label, preview], index) => html`<a class=${`agent-chip ${kind}`}
          href=${repo ? `https://github.com/${repo}/${path}` : nothing} target="_blank" rel="noopener noreferrer"
          @click=${preview ? event => this.openItem(event, preview.number, preview) : nothing}
          data-rest=${index < chips.length - 1 ? chips.length - 1 - index : nothing}>${label}</a>`)}</span>${single && (age !== nothing || size !== nothing)
          ? html`<span class="issue-meta">${age}${size}</span>` : nothing}</span>` : nothing}
        ${session.branches[0] ? html`<span class="issue-branch"><code>${session.branches[0]}</code>${session.branches.length > 1
          ? html`<span>+${session.branches.length - 1}</span>` : nothing}</span>` : nothing}
      </span>
    </div></li>`
  }
}
if (!customElements.get('repository-agents')) customElements.define('repository-agents', RepositoryAgents)
