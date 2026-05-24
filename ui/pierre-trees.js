// Pierre file-tree renderer — separate esbuild entry point so the
// `@pierre/trees` runtime (preact + the tree's own shadow-DOM
// virtualized renderer, ~150KB after minify) doesn't land in the
// main view.js bundle. `ui/view/pierre-tree-attach.js`
// `await import('./pierre-trees.js')`s this file lazily the first
// time the bundle Code tab's Files panel renders; the dynamic
// import URL is a runtime string so esbuild leaves it alone and
// the browser resolves it against the page's URL.
//
// Exposes a `<pierre-tree>` custom element wrapping a single
// `FileTree` instance. Inputs flow in as plain JS setters
// (`paths`, `currentPath`, `query`, `decorations`); selection
// flows out as a bubbling, composed `pierre-tree-select`
// CustomEvent so the existing event delegate model in view.js
// can drive `state.bundleSourceFile` updates the same way the
// previous hand-rolled tree did.

import { FileTree } from '@pierre/trees'

class PierreTree extends HTMLElement {
  #tree = null
  #mount = null
  #paths = []
  #currentPath = null
  #query = ''
  // Map<path, { text, title }> — read by renderRowDecoration on
  // every visible-row paint so updating the map (and forcing a
  // resetPaths to bust the row cache) is the only thing needed
  // to refresh the chips.
  #decorations = null
  #connected = false

  connectedCallback() {
    if (this.#connected) return
    this.#connected = true
    this.#mount = document.createElement('div')
    // The tree virtualizes rows against the mount's measured
    // height; without an explicit height the container collapses
    // to 0 and nothing paints. Caller is expected to give the
    // host element a sized parent (.bundle-pierre-tree-slot).
    this.#mount.style.height = '100%'
    this.#mount.style.width = '100%'
    this.append(this.#mount)
    this.#build()
  }

  disconnectedCallback() {
    this.#connected = false
    try { this.#tree?.cleanUp?.() } catch {}
    this.#tree = null
    if (this.#mount) {
      this.#mount.remove()
      this.#mount = null
    }
  }

  get paths() { return this.#paths }
  set paths(v) {
    const next = Array.isArray(v) ? v : []
    this.#paths = next
    if (this.#tree) this.#tree.resetPaths(next)
  }

  get currentPath() { return this.#currentPath }
  set currentPath(v) {
    this.#currentPath = v ?? null
    this.#syncSelection()
  }

  get query() { return this.#query }
  set query(v) {
    this.#query = v ?? ''
    this.#syncSearch()
  }

  // Setting decorations after build only updates the source of
  // truth; the next resetPaths (or initial render) re-runs
  // renderRowDecoration. In practice, decoration counts and
  // paths change together (a fresh bundle), so callers should
  // set decorations first and paths second.
  get decorations() { return this.#decorations }
  set decorations(v) {
    this.#decorations = v instanceof Map ? v : null
  }

  #build() {
    this.#tree = new FileTree({
      paths: this.#paths,
      initialExpansion: 'open',
      flattenEmptyDirectories: true,
      // Enables the search session so setSearch / closeSearch
      // calls have somewhere to land. We don't show the built-in
      // search input — the bundle Code view has its own search
      // chrome that drives `query` via the setter.
      search: true,
      initialSelectedPaths: this.#currentPath ? [this.#currentPath] : [],
      renderRowDecoration: (ctx) => {
        if (!this.#decorations) return null
        const dec = this.#decorations.get(ctx.item.path)
        if (!dec) return null
        return { text: dec.text, title: dec.title ?? '' }
      },
      onSelectionChange: (selected) => {
        const path = selected[0] ?? null
        // The current file in `state.bundleSourceFile` lives on
        // the page-level state; bubbling + composed so the event
        // crosses our shadow boundary and reaches the
        // document-level handler in events.js.
        this.dispatchEvent(new CustomEvent('pierre-tree-select', {
          detail: { path },
          bubbles: true,
          composed: true,
        }))
      },
    })
    this.#tree.render({ containerWrapper: this.#mount })
    // Apply any deferred search query from a pre-build setter.
    this.#syncSearch()
  }

  #syncSelection() {
    if (!this.#tree || !this.#currentPath) return
    try {
      const item = this.#tree.getItem(this.#currentPath)
      if (item && !item.isSelected()) {
        item.select()
        this.#tree.scrollToPath(this.#currentPath, { offset: 'nearest' })
      }
    } catch {}
  }

  #syncSearch() {
    if (!this.#tree) return
    try {
      if (this.#query) {
        if (this.#tree.isSearchOpen()) this.#tree.setSearch(this.#query)
        else this.#tree.openSearch(this.#query)
      } else if (this.#tree.isSearchOpen()) {
        this.#tree.closeSearch()
      }
    } catch {}
  }
}

customElements.define('pierre-tree', PierreTree)

// Factory used by `pierre-tree-attach.js` to mount a fresh tree
// into a freshly-emitted slot. Returning a live element instead
// of a constructor keeps the lazy bundle's exports minimal.
export function createPierreTreeElement(opts = {}) {
  const el = document.createElement('pierre-tree')
  if (opts.decorations) el.decorations = opts.decorations
  el.paths = opts.paths ?? []
  if (opts.currentPath != null) el.currentPath = opts.currentPath
  if (opts.query != null) el.query = opts.query
  return el
}
