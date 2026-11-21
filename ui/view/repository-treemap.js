// The Treemap of a directory too large to open (render-bundle.js
// renderRepositoryCodeOpening): its files as its commit's tree lists them,
// each by its bytes (GET /api/admin/repositories/tree), drawn as an opened
// directory's are (bundle-treemap.js) with none of their text read; where
// the listing leaves files out, it says so.
import { LitElement, html, nothing } from 'lit'
import { fetchRepositoryTree } from './client-managed.js'
import { number, readingBody, sessionKept, shownElements } from './activity-reads.js'
import './bundle-treemap.js'

const sessionTrees = sessionKept(new Map())
const { Shown, repaint } = shownElements(LitElement)

// The files of the directory `repository` shows, at its commit, as held,
// else read: 'loading', then 'ready' with the `details` the Treemap draws
// (`listedOnly`: their sizes alone) and whether the listing was `cut`, or
// 'error' with its `error`.
function treeRead({ repoId, commit, path }) {
  const key = `${repoId}\0${commit}\0${path}`
  const trees = sessionTrees()
  const held = trees.get(key)
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

class RepositoryTreemap extends Shown {
  static properties = { repository: { attribute: false } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repository = null
  }

  render() {
    if (!this.repository?.commit) return nothing
    const entry = treeRead(this.repository)
    if (entry.status !== 'ready') return readingBody(entry, 'Reading its files…', () => { sessionTrees().delete(entry.key); repaint() })
    return html`${entry.cut ? html`<p class="history-note">Only the ${number(entry.details.fileSizes.size)} files nearest its root are drawn.</p>` : nothing}
      <bundle-treemap .details=${entry.details}></bundle-treemap>`
  }
}

customElements.define('repository-treemap', RepositoryTreemap)
