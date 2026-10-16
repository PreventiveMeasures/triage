// The Treemap of a directory too large to open (render-bundle.js
// renderRepositoryCodeOpening): its files as its commit's tree lists them,
// each by its bytes (GET /api/admin/repositories/tree, as Replay reads it),
// drawn as the Treemap of a directory opened draws its files
// (bundle-treemap.js), but with none of their text read: a file's cell opens
// nothing, and its packages are told by their paths alone. Where the listing
// leaves files out (those deepest, past as many as the server answers), it
// says so. What was read is kept for the session that read it.
import { LitElement, html, nothing } from 'lit'
import { state } from '#client/index.js'
import { fetchRepositoryTree } from './client-managed.js'
import './bundle-treemap.js'

const trees = new Map()
const shownElements = new Set()
let keptFor = null

function sessionTrees() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    trees.clear()
    keptFor = session
  }
  return trees
}

const repaint = () => { for (const element of shownElements) element.requestUpdate() }

// The files of the directory `repository` shows, at its commit, as held,
// else read: 'loading', then 'ready' with the `details` the Treemap draws
// (`listedOnly`: their sizes alone) and whether the listing was `cut`, or
// 'error' with its `error`.
function treeRead({ repoId, commit, path }) {
  const key = `${repoId}\0${commit}\0${path}`
  const held = sessionTrees().get(key)
  if (held) return held
  const loading = { key, status: 'loading' }
  trees.set(key, loading)
  fetchRepositoryTree(repoId, path, commit).then(answer => {
    if (answer?.files === null) throw new Error('GitHub has no files at this commit.')
    if (!Array.isArray(answer?.files) || !Array.isArray(answer.sizes) || answer.sizes.length !== answer.files.length) throw new Error('The server answered with no files.')
    const fileSizes = new Map(answer.files.map((file, at) => [file, Number.isSafeInteger(answer.sizes[at]) && answer.sizes[at] > 0 ? answer.sizes[at] : 0]))
    if (trees.get(key) === loading) {
      trees.set(key, { key, status: 'ready', cut: answer.cut === true,
        details: { integrity: `tree\0${key}`, kind: 'tree', metadataOnly: true, listedOnly: true, fileSizes } })
    }
    return null
  }).catch(err => {
    if (trees.get(key) !== loading) return
    if (err?.name === 'AbortError') trees.delete(key)
    else trees.set(key, { key, status: 'error', error: err?.message || 'Its files could not be read.' })
  }).finally(repaint)
  return loading
}

class RepositoryTreemap extends LitElement {
  static properties = { repository: { attribute: false } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repository = null
  }

  connectedCallback() {
    super.connectedCallback()
    shownElements.add(this)
  }

  disconnectedCallback() {
    shownElements.delete(this)
    super.disconnectedCallback()
  }

  render() {
    if (!this.repository?.commit) return nothing
    const entry = treeRead(this.repository)
    if (entry.status === 'error') {
      return html`<div class="bundles-slide-placeholder is-error"><p role="alert">${entry.error}</p>
        <button type="button" @click=${() => { trees.delete(entry.key); repaint() }}>Retry</button></div>`
    }
    if (entry.status !== 'ready') return html`<div class="bundles-slide-placeholder" role="status">Reading its files…</div>`
    return html`${entry.cut ? html`<p class="history-note">Only the ${entry.details.fileSizes.size.toLocaleString('en-US')} files nearest its root are drawn.</p>` : nothing}
      <bundle-treemap .details=${entry.details}></bundle-treemap>`
  }
}

customElements.define('repository-treemap', RepositoryTreemap)
