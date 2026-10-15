// What the code viewer's Issues, Pull requests and Agents tabs
// (repository-issues.js, repository-agents.js) and the popup of one of their
// tiles (dialogs/repository-item-dialog.js) draw alike: an issue's or pull
// request's state, review and checks, by their icons, as GitHub draws them;
// the agents' marks; and where a session opens.
import { html, nothing, svg } from 'lit'
import { providerIcon } from './provider-icons.js'

export const icon = body => html`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${body}</svg>`
const ring = svg`<circle cx="8" cy="8" r="6.25"/>`
const pull = svg`<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><path d="M4.5 5.1v5.8"/><circle cx="11.5" cy="12.5" r="1.6"/>`
export const STATE_ICONS = {
  issues: {
    open: icon(svg`${ring}<circle class="fill" cx="8" cy="8" r="1.6"/>`),
    completed: icon(svg`${ring}<path d="M5.4 8.3l1.8 1.8 3.4-3.7"/>`),
    'not-planned': icon(svg`${ring}<path d="M3.9 12.1l8.2-8.2"/>`),
  },
  pulls: {
    open: icon(svg`${pull}<path d="M11.5 10.9V6.5a2 2 0 0 0-2-2H7.4M8.9 3 7.4 4.5 8.9 6"/>`),
    draft: icon(svg`${pull}<path class="dotted" d="M11.5 10.9V4"/>`),
    merged: icon(svg`<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><path d="M4.5 5.1v5.8M4.5 5.1c0 2.4 2.4 3.4 5.4 3.4"/><circle cx="11.5" cy="8.5" r="1.6"/>`),
    closed: icon(svg`${pull}<path d="M9.6 3.1l3.8 3.8M13.4 3.1 9.6 6.9"/>`),
  },
}
export const COMMENT_ICON = icon(svg`<path d="M2.6 3.2h10.8v7.3H8l-3.2 2.6v-2.6H2.6z"/>`)
export const CHECKS = {
  success: ['Checks passed', icon(svg`<path d="M3.5 8.4l2.9 2.9 6.1-6.6"/>`)],
  failure: ['Checks failed', icon(svg`<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>`)],
  pending: ['Checks running', icon(svg`<circle class="fill" cx="8" cy="8" r="3"/>`)],
}
// A review's state by its icon, each its own shape: approved a ringed check,
// changes requested a diff, required an eye, awaiting one.
export const REVIEWS = {
  approved: ['Approved', icon(svg`${ring}<path d="M5.4 8.3l1.8 1.8 3.4-3.7"/>`)],
  changes: ['Changes requested', icon(svg`<path d="M3.75 1.75h5.5l3 3v9.5h-8.5z"/><path d="M8 4.5v4M6 6.5h4M6 11h4"/>`)],
  required: ['Review required', icon(svg`<path d="M1.25 8S3.75 3.5 8 3.5 14.75 8 14.75 8 12.25 12.5 8 12.5 1.25 8 1.25 8z"/><circle cx="8" cy="8" r="2"/>`)],
}
export const PULL_ICON = icon(svg`<circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M4 5v6M12 11V6a2 2 0 0 0-2-2H7m1.5-1.5L7 4l1.5 1.5"/>`)
export const BRANCH_ICON = icon(svg`<circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="3" r="1.5"/><path d="M4 4.5v7m0-3h3a5 5 0 0 0 5-4"/>`)
export const COMMIT_ICON = icon(svg`<circle cx="8" cy="8" r="3"/><path d="M1 8h4m6 0h4"/>`)

// An issue's or pull request's state (`kind` 'issues' or 'pulls'), as its
// icon and stripe show it, and as its icon is named.
export function issueState(kind, item) {
  if (kind === 'pulls') {
    if (item.state === 'merged') return ['merged', 'Merged']
    if (item.state === 'closed') return ['closed', 'Closed']
    return item.draft ? ['draft', 'Draft'] : ['open', 'Open']
  }
  if (item.state === 'open') return ['open', 'Open']
  return item.reason === 'not-planned' || item.reason === 'duplicate' ? ['not-planned', item.reason === 'duplicate' ? 'Closed as duplicate' : 'Closed as not planned']
    : ['completed', 'Closed']
}

// Claude's mark in its orange, Codex OpenAI's, as the app draws them
// elsewhere (provider-icons.js).
const AGENT_ICONS = {
  claude: html`<span class="agent-logo" aria-hidden="true">${providerIcon('anthropic')}</span>`,
  codex: html`<span class="agent-logo" aria-hidden="true">${providerIcon('openai')}</span>`,
}
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' }
// The agents known by their GitHub Apps or accounts, as the server named
// them (its APP_AGENTS, repository-agents.ts), by id: each its name and
// avatar.
const appAgents = new Map()
export function knowAgents(agents) {
  for (const agent of agents) appAgents.set(agent.id, agent)
}
// An agent's name and mark: Claude's or Codex's, else an app agent's, its
// GitHub App's or account's avatar, served by the server
// (/api/avatar/<avatar>).
export const agentName = agent => AGENT_NAMES[agent] ?? appAgents.get(agent)?.name ?? agent
export function agentIcon(agent) {
  if (AGENT_ICONS[agent]) return AGENT_ICONS[agent]
  const avatar = appAgents.get(agent)?.avatar
  return avatar ? html`<img class="agent-avatar" src=${`/api/avatar/${avatar}`} alt="" width="14" height="14" loading="lazy" decoding="async">` : nothing
}

// A click to open a tile's popup: the main button's, none held with it, which
// would open its link in a new tab or window instead.
export const plainClick = event => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

// Where a session ran: its Claude Code session or Codex task; null for one
// that names neither.
export function sessionRan(session) {
  if (session.sessions[0]) return `https://claude.ai/code/${session.sessions[0]}`
  return session.tasks[0] ? `https://chatgpt.com/codex/tasks/${session.tasks[0]}` : null
}

// A session on GitHub, in `repo`: its latest pull request, else commit, else
// its branch; null where `repo` is yet unnamed.
export function sessionOnGithub(session, repo) {
  if (!repo) return null
  if (session.pulls[0]) return `https://github.com/${repo}/pull/${session.pulls[0].number}`
  if (session.commits[0]) return `https://github.com/${repo}/commit/${session.commits[0].oid}`
  return session.branches[0] ? branchOnGithub(repo, session.branches[0]) : null
}

// A branch on GitHub; a fork's (`owner:branch`) in that owner's fork.
export function branchOnGithub(repo, branch) {
  const [owner, name] = branch.includes(':') ? [branch.slice(0, branch.indexOf(':')), branch.slice(branch.indexOf(':') + 1)] : [null, branch]
  const path = name.split('/').map(encodeURIComponent).join('/')
  return owner ? `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo.split('/')[1] ?? '')}/tree/${path}` : `https://github.com/${repo}/tree/${path}`
}

// Where a session opens: where it ran, else on GitHub.
export const sessionLink = (session, repo) => sessionRan(session) ?? sessionOnGithub(session, repo)
