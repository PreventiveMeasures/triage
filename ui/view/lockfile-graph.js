// `<lockfile-graph>` — a lockfile's packages in the bundle graph viewer, at
// its package altitude: the `<graph-layout>` the bundle Graph tab mounts
// (view/graph-attach.js), fed lockfile-graph-inputs.js's graph of packages
// alone. Set `.lockfile` to the shape that module takes.
//
// The bundle Graph tab's interactions are routed by the page-wide delegate
// in events.js, which re-renders the bundle view. This element answers its
// graph's own instead and keeps them from that delegate: picking a layout
// or a package, the path filter and fullscreen. The viewer's state is the
// one shared `graph2` (graph/state.js), as only one graph is on screen.
import { LitElement, css, html } from 'lit'
import { attachGraphLayout, loadGraph, loadedGraphMod } from './graph-attach.js'
import { cleanupGraph2, graph2 } from './graph/state.js'
import { lockfileGraphPrep } from './lockfile-graph-inputs.js'

// The bundle layouts a lockfile offers: Layers and Size flow weigh packages
// by their bytes, which a lockfile doesn't record.
export const LOCKFILE_LAYOUTS = ['graph', 'matrix', 'dependencies']

class LockfileGraph extends LitElement {
  static properties = { lockfile: { attribute: false } }

  // The page frames the element, as the bundle Graph tab frames its graph.
  static styles = css`
    :host { display: flex; flex-direction: column; min-height: 0; }
    .slot { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    graph-layout { flex: 1; min-height: 0; border: none; border-radius: 0; }
    .empty { color: var(--muted); }
  `

  constructor() {
    super()
    this.lockfile = null
    this._prep = null
    this._graphState = null
    this._attachment = 0
    this.addEventListener('click', (e) => this._click(e))
    this.addEventListener('input', (e) => this._input(e))
  }

  connectedCallback() {
    super.connectedCallback()
    // Back on the page: draw again what leaving it stopped.
    if (this.hasUpdated && this._prep) void this._attach()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._detach()
  }

  willUpdate(changed) {
    if (!changed.has('lockfile')) return
    this._prep = lockfileGraphPrep(this.lockfile)
    if (!this._prep) this._detach()
    // What was picked in another graph names nothing here, and a file or
    // a focused package has no place in a graph of packages alone.
    graph2.selected = null
    graph2.solo = null
    graph2.focusedPkg = null
  }

  render() {
    if (!this.lockfile) return null
    return this._prep ? html`<div class="slot"></div>` : html`<p class="empty">No packages.</p>`
  }

  updated(changed) {
    if (changed.has('lockfile') && this._prep) void this._attach()
  }

  // The canvas listens on the window: stop it with the graph it drew, and
  // any attachment still waiting to mount.
  _detach() {
    this._attachment++
    if (this._graphState && graph2.graphState === this._graphState) cleanupGraph2()
    this._graphState = null
  }

  // (Re)mount the graph for the current layout. Called on a new lockfile
  // and on every view switch, after any teardown (cleanupGraph2).
  async _attach() {
    if (!LOCKFILE_LAYOUTS.includes(graph2.bundleLayout)) graph2.bundleLayout = 'graph'
    const slot = this.renderRoot.querySelector('.slot')
    if (!slot) return
    // Only the latest attachment of an element still on the page mounts. One
    // left waiting on the graph module would tear down whatever graph is on
    // screen once the module came (attachGraph2Interaction cleans up first).
    // A load that fails fails again below, and says so in the slot.
    const attachment = ++this._attachment
    await loadGraph().catch(() => {})
    if (attachment !== this._attachment || !this.isConnected) return
    // The module loaded, the mount completes in this task: nothing else
    // mounts meanwhile, so the graph state it leaves is this graph's.
    const options = { showBundleLayouts: true, layouts: LOCKFILE_LAYOUTS, hideAllFiles: true }
    await attachGraphLayout(slot, this._prep, options, () => this._refreshSidebar(), () => this._refreshTopPkgs())
    this._graphState = graph2.graphState
  }

  get _host() { return this.renderRoot.querySelector('graph-layout') }

  _refreshSidebar() { loadedGraphMod()?.refreshSidebar(this._prep, {}, this._host) }

  _refreshTopPkgs() { loadedGraphMod()?.refreshTopPkgs(this._prep, this._host) }

  // As events.js answers the bundle graph's, for what a graph of packages
  // alone offers.
  _click(e) {
    const at = selector => e.composedPath().find(el => el.matches?.(selector))
    const layout = at('[data-g2-layout]')?.dataset.g2Layout
    const pkg = at('[data-g2-pkg]')?.dataset.g2Pkg
    if (layout !== undefined) {
      if (LOCKFILE_LAYOUTS.includes(layout) && layout !== graph2.bundleLayout) {
        graph2.bundleLayout = layout
        graph2.selected = null
        graph2.solo = null
        graph2.layoutCache = null
        cleanupGraph2()
        void this._attach()
      }
    } else if (pkg !== undefined) {
      graph2.solo = graph2.solo === pkg ? null : pkg
      this._refreshSidebar()
      this._refreshTopPkgs()
      graph2.graphState?.requestDraw?.()
    } else if (at('#g2-path-filter-clear')) {
      graph2.pathFilter = ''
      const input = this._host?.shadowRoot?.querySelector('#g2-path-filter')
      if (input) input.value = ''
      graph2.graphState?.requestDraw?.()
    } else if (at('#g2-fullscreen')) {
      document.body.classList.toggle('report-fullscreen')
    } else {
      return
    }
    e.stopPropagation()
  }

  _input(e) {
    const input = e.composedPath()[0]
    if (input?.id !== 'g2-path-filter') return
    graph2.pathFilter = input.value
    graph2.graphState?.requestDraw?.()
    e.stopPropagation()
  }
}

customElements.define('lockfile-graph', LockfileGraph)
