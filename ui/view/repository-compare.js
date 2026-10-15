// A repository directory's Compare (render-bundle.js): the same directory at
// another revision, compared with the one shown as an npm version is with
// another (bundle-compare.js `source`): the files each adds, removes and
// changes, and Code's diff of them, without a package's risk, alerts or
// dependencies. Each side is picked as the header picks the revision shown
// (revision-select: a branch, a tag or a commit); a pick on the second opens
// the directory there, compared with the same first. What is compared with
// is read as the directory is (GET /api/admin/repositories/code), and then
// named by the commit read, as the route names it: `/compare/<commit>`.
import { LitElement, html } from 'lit'
import { fetchRepositoryCode } from './client-managed.js'
import { navigateToRepositoryCode, rememberRevision, repositoryCodeDetails, repositoryCodeEntry, repositoryRefs, revisionNamed, revisionPicked,
  revisionRef, shownRevision } from './repository-code.js'
import { fileIconFormat, isNotTextFormat, sourceFileIcon } from './source-file-icon.js'
import { installShadowTooltipListener } from './tooltip.js'
import { currentViewSignal } from './view-navigation.js'
import './revision-select.js'

const COMMIT = /^[a-f\d]{40}$/iu
// A directory's files are its own: it lists no packages, as a bundle does,
// nor dependencies in their place, as an npm version does.
const NO_DEPENDENCIES = { removed: [], added: [], changed: [] }

// What a revision is compared by: its commit, where it names one whole,
// else the ref the server reads (`heads/<branch>`, `tags/<tag>`, a commit's
// first digits).
const revisionId = revision => revision.kind === 'commit' && COMMIT.test(revision.name) ? revision.name.toLowerCase() : revisionRef(revision)

// The revision an id names: a commit by the name it was read by, where it
// was read by one; its default branch's name once its branches arrive.
function idRevision(repoId, id, refs) {
  const named = COMMIT.test(id) ? revisionNamed(repoId, id) ?? { kind: 'commit', name: id }
    : id.startsWith('heads/') ? { kind: 'branch', name: id.slice('heads/'.length) }
    : id.startsWith('tags/') ? { kind: 'tag', name: id.slice('tags/'.length) } : { kind: 'commit', name: id }
  return shownRevision({ revision: named, commit: id }, refs)
}

// A revision's name in Compare's titles: a branch's or tag's, a commit's
// first seven digits.
const revisionLabel = (revision, id) => revision.kind === 'commit' || !revision.name ? (revision.name || id).slice(0, 7) : revision.name

// The comparison source of a repository's directory (`entry`, repository-code.js
// repositoryCodeEntry), the commit it is open at its `base`.
export function repositoryCompareSource(entry) {
  const { repoId, repo, commit, path } = entry.repository
  const refs = repositoryRefs(repoId)
  const shown = shownRevision(entry.repository, refs)
  return {
    noun: 'revision',
    base: commit,
    // Each side picks its own (`select`), as no list offers them all.
    options: [],
    choices: [],
    name: id => id === entry.integrity || id === commit ? revisionLabel(shown, commit) : revisionLabel(idRevision(repoId, id, refs), id),
    // The directory there, named by the commit read (`compareId`), and that
    // commit by the name it was picked by.
    async load(id) {
      const data = await fetchRepositoryCode(repoId, id, path, { signal: currentViewSignal() })
      if (data?.repoId !== repoId || data.path !== path || !COMMIT.test(data.commit ?? '') || (COMMIT.test(id) && data.commit.toLowerCase() !== id.toLowerCase())) {
        throw new Error('The server answered with another directory.')
      }
      const at = data.commit.toLowerCase()
      if (!COMMIT.test(id)) rememberRevision(repoId, at, idRevision(repoId, id, null))
      const other = repositoryCodeEntry({ ...data, commit: at }, revisionNamed(repoId, at))
      return { ...repositoryCodeDetails(other, data), compareId: at }
    },
    // A swap or a pick on the second side opens `base`, compared with `target`.
    open: (base, target, mode) => navigateToRepositoryCode({ repoId, repo, path, bundleTab: 'compare', compare: { target, mode },
      ...COMMIT.test(base) ? { commit: base.toLowerCase() } : { ref: base, revision: idRevision(repoId, base, null) } }),
    dependencies: () => NO_DEPENDENCIES,
    // Each file's type, as Code shows it.
    files: { icon: (file, sides) => sourceFileIcon(file, sides.map(([details, at]) => fileIconFormat(details, at)).find(isNotTextFormat)) },
    select: (side, label) => html`<repository-revision-pick .refs=${refs.status === 'ready' ? refs.value : null} label=${label} ?empty=${!side.value}
      .revision=${side.value ? side.value === commit ? shown : idRevision(repoId, side.value, refs) : null}
      @revision-pick=${event => side.pick(revisionId(event.detail))}></repository-revision-pick>`,
  }
}

// One side of a repository's Compare: its revision as the header picks one,
// what is typed kept until a revision is picked (`revision-pick`, its
// `detail` the revision) or another shown.
class RepositoryRevisionPick extends LitElement {
  static properties = { refs: { attribute: false }, revision: { attribute: false }, label: {}, _edit: { state: true } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.refs = null
    this.revision = null
    this.label = ''
    this._edit = null
    this._shownKey = null
  }

  willUpdate() {
    const key = JSON.stringify(this.revision)
    if (key !== this._shownKey) {
      this._shownKey = key
      this._edit = null
    }
  }

  changed({ detail }) {
    const picked = revisionPicked(detail)
    this._edit = picked ?? { kind: detail.kind, name: detail.name }
    if (picked) this.dispatchEvent(new CustomEvent('revision-pick', { detail: picked }))
  }

  render() {
    const revision = this._edit ?? this.revision ?? { kind: 'branch', name: '' }
    return html`<revision-select role="group" aria-label=${this.label} .refs=${this.refs} .kind=${revision.kind} .name=${revision.name}
      .installTooltips=${root => installShadowTooltipListener(root)} @revision-change=${this.changed}></revision-select>`
  }
}
if (!customElements.get('repository-revision-pick')) customElements.define('repository-revision-pick', RepositoryRevisionPick)
