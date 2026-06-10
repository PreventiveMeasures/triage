// Graph v2 tab — mutable state. A single shared object the
// renderer + canvas + event handlers all read and mutate, plus a
// cleanup hook the canvas owns so re-attach can drop stale
// listeners and rAF callbacks.
//
// Most fields back UI controls in the topbar / right-panel: the
// "All files" toggle, severity / triage-color highlight sets,
// path-substring filter, package solo + focus drill-in, the
// per-render canvas handle (live `requestDraw` + `_cleanup`), and
// the layout cache. Defaults are tuned to read well on the small
// typical DeepView graph (10–80 files) so the empty state is
// informative even before any user input.
//
// Cross-bundle sharing: this module is bundled into BOTH `view.js`
// (main, statically reached via events.js / ingest.js / sidebar.js /
// render*.js) AND `graph.js` (lazy, via graph-layout.js / canvas.js
// / graph/render.js). Each bundle gets its own copy, so without
// coordination each side would hold a SEPARATE `graph2` and writes
// from the main bundle's click handlers (severity chip toggle, path
// filter, etc.) would never reach the lazy bundle's canvas. The
// exported `graph2` is therefore a `Proxy` forwarding every access
// through a swappable internal `_impl`; the graph-attach helper
// calls `_swapImpl(mainBundleImpl)` on the lazy module after load
// so both proxies drive the SAME object. Nested mutations
// (`graph2.selectedSeverities.add(...)`, `graph2.hidden.clear()`)
// hit the live Set/object directly — the proxy is top-level only,
// so they're observable across both bundles too.

function createImpl() {
  return {
    // Include clean files (no own / subtree findings) in the
    // canvas. Off by default so the layout focuses on
    // issue-bearing code. Toggled via the topbar's "All files"
    // button.
    showAll: false,
    // Split own (non-dependency) source into per-directory groups.
    // Off by default: every first-party file shares the single
    // `__own__` group (labeled "own source") so the canvas's color +
    // clustering axis is "which package", not "which top-level dir".
    // On: own source buckets by its top-level directory (`src/...`,
    // `lib/...` each become their own group/color). Bundle Graph tab
    // only — toggled via the topbar's "Split dirs" pill; flipping it
    // rebuilds the graph (different packages → different layout).
    splitOwnDirs: false,
    // Package-level view — one node per package (or per top-level
    // dir under Split dirs) instead of one per file, edges
    // aggregated from the cross-package imports. Bundle Graph tab
    // only, via the topbar's "Packages" pill; the pill (and the
    // mode) only engage when the bundle has 3+ packages — see
    // `canPackagesView` in buildBundleGraphData. Off by default.
    packagesView: false,
    selected: null,        // file path or null
    // Package focus mode — when set, the canvas drops the spiral
    // and renders ONLY this package's intra-imports in graph v1
    // style (single hue, arrowheads, file labels). null = full
    // graph; reset on report swap and on the back-button click.
    focusedPkg: null,
    // Right-panel "Top packages" sort axis. Issues-first by default
    // so the user lands on the actionable list; files for "what's
    // the codebase shape" exploration.
    topPkgsTab: 'issues',  // 'issues' | 'files'
    // Visual constants the canvas reads as fixed values (no longer
    // user-facing sliders). Tune the defaults here.
    edgeOpacity: 0.22,
    nodeSize: 1.0,
    showLabels: false,
    // Severity highlight filter — empty = no filter, every node at
    // full opacity (default). With 1+ selected, matching nodes stay
    // full opacity and the rest dim to 0.1. Selecting all severities
    // reproduces the old "Show only issues" behavior automatically.
    selectedSeverities: new Set(),
    // Mark-color highlight filter — same shape as the severity set.
    // Empty = no filter. When non-empty, a node stays full-opacity
    // only if at least one finding on that file carries one of the
    // selected colors (with severity filter AND-combined when both
    // are active). Mirrors the findings-tab triage filter so the
    // canvas highlight matches what the table would show.
    selectedColors: new Set(),
    // Path-substring filter. Empty = no filter. Non-empty =
    // case-insensitive substring match; non-matching nodes
    // dim to 0.1 (same soft-dim path as solo / severity).
    pathFilter: '',
    // Package solo — narrows the canvas highlight to a single
    // package via the Top-packages list click. `hidden` is a
    // legacy hide-set that nothing currently writes to, kept as
    // an empty Set so nodeVisible can still read it without an
    // undefined check.
    hidden: new Set(),
    solo: null,
    // Per-render canvas state — owned by canvas.js, re-built on
    // every attach. Cleanup tears down listeners + rAF +
    // ResizeObserver.
    graphState: null,
    // Layout result cache, keyed off (mode, files, w, h).
    // Recomputed when the user switches layouts or the underlying
    // file set changes (showAll on graph v1 invalidates v2's cache
    // too via cleanupGraph2 in events.js).
    layoutCache: null,
  }
}

let _impl = createImpl()

// Top-level Proxy. Property reads / writes / membership checks
// flow through `_impl` so swapping `_impl` (via `_swapImpl`)
// retargets the entire `graph2` object atomically.
export const graph2 = new Proxy(_impl, {
  get(_t, prop) { return _impl[prop] },
  set(_t, prop, value) { _impl[prop] = value; return true },
  has(_t, prop) { return prop in _impl },
  deleteProperty(_t, prop) { return delete _impl[prop] },
  ownKeys() { return Reflect.ownKeys(_impl) },
  getOwnPropertyDescriptor(_t, prop) { return Object.getOwnPropertyDescriptor(_impl, prop) },
})

export function cleanupGraph2() {
  if (graph2.graphState?._cleanup) graph2.graphState._cleanup()
  graph2.graphState = null
}

// Cross-bundle sharing seam. The graph-attach helper calls
// `_swapImpl(mainImpl)` on the lazy bundle's instance of this
// module so both bundles' `graph2` proxies forward to the same
// underlying object. No-op when `newImpl` is falsy (defensive — a
// caller passing null would silently leave the proxy pointing at
// a freed copy otherwise).
export function _swapImpl(newImpl) {
  if (newImpl) _impl = newImpl
}

// Read-side companion — exposes the live `_impl` so the
// graph-attach helper (running in the main bundle) can hand the
// main-bundle copy off to the lazy bundle's `_swapImpl`. The two
// functions are paired and only called by graph-attach during the
// `await import('./graph.js')` settle path.
export function _currentImpl() {
  return _impl
}
