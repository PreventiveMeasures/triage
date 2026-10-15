// A tile of the code viewer's Issues, Pull requests or Agents tab
// (repository-issues.js, repository-agents.js), opened in a popup over it, as
// a kanban card opens: an issue or pull request with what its tile shows and
// more, read as it opens (GET /api/admin/repositories/item), its description,
// what it closes or what closed it, a pull request's commits, files and who
// merged it; or an agent's session, its pull requests, commits, issues and
// branches. An issue or pull request it names opens in its place, Back
// returning; each, and a commit or branch, is a link to GitHub, and a session
// to where it ran.
import { html, nothing, unsafeCSS } from 'lit'
import { styleMap } from 'lit/directives/style-map.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { fetchRepositoryItem } from '../client-managed.js'
import { flowText } from '../format.js'
import { renderHighlighted } from '../render-finding.js'
import { AGENT_ICONS, AGENT_NAMES, CHECKS, COMMENT_ICON, REVIEWS, STATE_ICONS, branchOnGithub, issueState, sessionOnGithub, sessionRan } from '../repository-tiles.js'
import proseCSS from '../../styles/prose.css'
import codeTokensCSS from '../../styles/code-tokens.css'
import styles from './dialog-repository-item.css'

const SESSION_STATES = { open: ['open', 'Open'], merged: ['merged', 'Merged'], closed: ['closed', 'Closed'], branch: ['draft', 'A branch alone'] }
const date = at => at == null ? '' : new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const plural = (count, noun) => `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`
const external = (href, label, primary = false) => href
  ? html`<a class=${primary ? 'primary' : ''} href=${href} target="_blank" rel="noopener noreferrer">${label}</a>` : nothing

class RepositoryItemDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(proseCSS), unsafeCSS(codeTokensCSS), unsafeCSS(styles)]
  static properties = { repository: { attribute: false }, target: { attribute: false }, _trail: { state: true }, _items: { state: true } }

  constructor() {
    super()
    this._trail = []
    this._items = new Map()
    this._controller = new AbortController()
  }

  // The target the helper set, shown from the first render, which the
  // dialog opens on (AppDialog.firstUpdated).
  connectedCallback() {
    super.connectedCallback()
    if (this._trail.length === 0 && this.target) this.open(this.target)
  }
  disconnectedCallback() { this._controller.abort(); super.disconnectedCallback() }
  focusInitial() { this.renderRoot.querySelector('.repo-item-body')?.focus() }

  // Shows `target`, an issue or pull request (`{ number, preview }`, the
  // preview what its tile knew) or a session (`{ session }`), over the one
  // shown, reading an issue or pull request not read yet.
  open(target) {
    this._trail = [...this._trail, target]
    if (target.number == null || this._items.has(target.number)) return
    const number = target.number
    this._items = new Map(this._items).set(number, { status: 'loading' })
    fetchRepositoryItem(this.repository.repoId, number, { signal: this._controller.signal }).then(
      item => ({ status: 'ready', item }),
      err => err?.name === 'AbortError' ? null : { status: 'error', error: err?.message || 'It could not be read.' },
    ).then(held => {
      if (held) this._items = new Map(this._items).set(number, held)
      return null
    })
  }

  back() { this._trail = this._trail.slice(0, -1) }

  render() {
    const target = this._trail.at(-1)
    if (!target) return nothing
    const [heading, body, links] = target.session ? this.renderSession(target.session) : this.renderItem(target)
    return html`<dialog aria-labelledby="repo-item-title" @close=${this._onClose} @click=${this._onBackdrop}>
      <header>
        ${this._trail.length > 1 ? html`<button type="button" class="back" aria-label="Back" @click=${() => this.back()}>←</button>` : nothing}
        <h3 id="repo-item-title">${heading}</h3>
        <button type="button" aria-label="Close" @click=${this._onClose}>×</button>
      </header>
      <div class="repo-item-body" tabindex="-1">${body}</div>
      <div class="nwd-actions"><span class="nwd-spacer"></span>${links}</div>
    </dialog>`
  }

  // An issue or pull request: its state, title and number; who opened it
  // when, its labels, a pull request's branches, size, commits and files,
  // review and checks; what it closes or what closed it; its description.
  renderItem({ number, preview }) {
    const held = this._items.get(number)
    const item = held?.item ?? preview ?? null
    const kind = item?.kind ?? 'issues'
    const repo = this.repository.repo
    const href = repo ? `https://github.com/${repo}/${kind === 'pulls' ? 'pull' : 'issues'}/${number}` : null
    const [stateClass, stateName] = item ? issueState(kind, item) : ['open', '']
    const heading = html`${item ? html`<span class=${`repo-item-state is-${stateClass}`} role="img" aria-label=${stateName}>${STATE_ICONS[kind][stateClass]}</span>` : nothing}
      <span>${item?.title || '(no title)'} <span class="repo-item-number">#${number}</span></span>`
    const full = held?.status === 'ready' ? held.item : null
    const pulls = kind === 'pulls'
    const marked = ([name, glyph], mark) => html`<span class=${`repo-item-mark is-${mark}`}>${glyph}${name}</span>`
    const body = html`
      <p class="repo-item-meta">
        ${item ? html`<span class=${`repo-item-badge is-${stateClass}`}>${stateName}</span>` : nothing}
        ${item?.author ? html`<span><strong>${item.author}</strong> opened ${date(item.createdAt)}</span>` : item?.createdAt ? html`<span>Opened ${date(item.createdAt)}</span>` : nothing}
        ${full?.mergedBy ? html`<span>merged by <strong>${full.mergedBy}</strong> ${date(full.mergedAt)}</span>`
          : item?.closedAt && item.state !== 'open' ? html`<span>closed ${date(item.closedAt)}</span>` : nothing}
        ${item?.comments > 0 ? html`<span class="repo-item-mark">${COMMENT_ICON}${plural(item.comments, 'comment')}</span>` : nothing}
      </p>
      ${item?.labels?.length > 0 ? html`<p class="repo-item-labels">${item.labels.map(label => html`<span class="repo-item-label"
        style=${styleMap(label.color ? { '--label': `#${label.color}` } : {})}>${label.name}</span>`)}${item.moreLabels > 0 ? html`<span class="repo-item-label">+${item.moreLabels}</span>` : nothing}</p>` : nothing}
      ${pulls && item?.head ? html`<p class="repo-item-meta">
        <span><code>${item.head}</code>${item.base ? html` → <code>${item.base}</code>` : nothing}</span>
        <span><span class="is-added">+${item.additions.toLocaleString('en-US')}</span> <span class="is-deleted">−${item.deletions.toLocaleString('en-US')}</span></span>
        ${full ? html`<span>${plural(full.commits, 'commit')}</span><span>${plural(full.files, 'file')} changed</span>` : nothing}
        ${REVIEWS[item.review] && item.state === 'open' ? marked(REVIEWS[item.review], item.review) : nothing}
        ${CHECKS[item.checks] ? marked(CHECKS[item.checks], item.checks) : nothing}
      </p>` : nothing}
      ${full ? this.renderLinked(pulls ? 'Closes' : 'Closed by', pulls ? 'issues' : 'pulls', pulls ? full.closes : full.closedBy, full.moreLinked) : nothing}
      ${full ? html`<div class="repo-item-description">${full.body ? renderHighlighted(flowText(full.body)) : html`<p class="repo-item-quiet">No description.</p>`}</div>
        ${full.bodyShortened ? html`<p class="repo-item-quiet">Shortened here; the rest of it is on GitHub.</p>` : nothing}`
        : held?.status === 'error' ? html`<p class="repo-item-quiet" role="alert">${held.error}</p>`
        : html`<p class="repo-item-quiet" role="status">Reading it…</p>`}`
    return [heading, body, external(href, 'Open on GitHub', true)]
  }

  // The issues or pull requests (`kind`) an item or session names, each
  // opening in its place, and how many more GitHub has.
  renderLinked(title, kind, items, more = 0) {
    if (!items?.length && !more) return nothing
    return html`<section class="repo-item-section"><h4>${title}</h4>${items?.length ? html`<ul>${items.map(linked => {
      const preview = { ...linked, kind, labels: [], comments: 0 }
      const [stateClass, stateName] = issueState(kind, preview)
      return html`<li><button type="button" class="repo-item-row" @click=${() => this.open({ number: linked.number, preview })}>
        <span class=${`repo-item-state is-${stateClass}`} role="img" aria-label=${stateName}>${STATE_ICONS[kind][stateClass]}</span>
        <span class="repo-item-number">#${linked.number}</span><span class="repo-item-title">${linked.title || '(no title)'}</span>
      </button></li>`
    })}</ul>` : nothing}${more > 0 ? html`<p class="repo-item-quiet">${items?.length ? 'and ' : ''}${more.toLocaleString('en-US')} more, on GitHub</p>` : nothing}</section>`
  }

  // A session: its agents' marks and title; who, when, its state, tasks and
  // size; its pull requests and issues, opening in its place, its commits
  // and branches, on GitHub.
  renderSession(session) {
    const repo = this.repository.repo
    const [stateClass, stateName] = SESSION_STATES[session.state] ?? SESSION_STATES.branch
    const tasks = session.pulls.length + session.commits.length
    const heading = html`<span class="repo-item-agents">${session.agents.map(agent => html`<span class=${`agent-mark is-${agent}`} role="img"
      aria-label=${AGENT_NAMES[agent]}>${AGENT_ICONS[agent]}</span>`)}</span><span>${session.title || '(no title)'}</span>`
    const ran = sessionRan(session)
    const body = html`
      <p class="repo-item-meta">
        <span class=${`repo-item-badge is-${stateClass}`}>${stateName}</span>
        ${session.authors.length > 0 ? html`<span><strong>${session.authors.join(', ')}</strong></span>` : nothing}
        ${session.startedAt == null ? nothing : html`<span>${date(session.startedAt)}${session.updatedAt != null && date(session.updatedAt) !== date(session.startedAt)
          ? ` – ${date(session.updatedAt)}` : ''}</span>`}
        <span>${tasks > 0 ? plural(tasks, 'task') : 'no pull request'}</span>
        ${session.additions || session.deletions ? html`<span><span class="is-added">+${session.additions.toLocaleString('en-US')}</span>
          <span class="is-deleted">−${session.deletions.toLocaleString('en-US')}</span></span>` : nothing}
      </p>
      ${this.renderLinked('Pull requests', 'pulls', session.pulls)}
      ${session.commits.length > 0 ? html`<section class="repo-item-section"><h4>Commits to the default branch</h4><ul>${session.commits.map(commit => html`<li>
        <a class="repo-item-row" href=${repo ? `https://github.com/${repo}/commit/${commit.oid}` : nothing} target="_blank" rel="noopener noreferrer">
          <code>${commit.oid.slice(0, 7)}</code><span class="repo-item-title">${commit.title || '(no message)'}</span></a></li>`)}</ul></section>` : nothing}
      ${this.renderLinked('Issues', 'issues', session.issues.map(issue => ({ ...issue, reason: null })))}
      ${session.branches.length > 0 ? html`<section class="repo-item-section"><h4>${session.branches.length === 1 ? 'Branch' : 'Branches'}</h4><ul>${session.branches.map(branch => html`<li>
        <a class="repo-item-row" href=${repo ? branchOnGithub(repo, branch) : nothing} target="_blank" rel="noopener noreferrer"><code>${branch}</code></a></li>`)}</ul></section>` : nothing}`
    const links = html`${external(ran, session.sessions[0] ? 'Open in Claude Code' : 'Open the Codex task')}${external(sessionOnGithub(session, repo), 'Open on GitHub', true)}`
    return [heading, body, links]
  }
}
customElements.define('repository-item-dialog', RepositoryItemDialog)

// Opens `target` of `repository` (`{ repoId, repo }`): an issue or pull
// request (`{ number, preview }`) or an agent's session (`{ session }`).
export function openRepositoryItemDialog(props) {
  return openAppDialog('repository-item-dialog', props)
}
