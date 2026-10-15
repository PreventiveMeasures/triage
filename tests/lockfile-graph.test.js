// `<lockfile-graph>` shows a lockfile's packages in the bundle graph viewer,
// at its package altitude: lockfile-graph-inputs.js makes each installed copy
// a member of its package, as a bundle's files are, and `packagesOnly` keeps
// every layout at packages, counting dependents and versions, never files.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import './_polyfills.js'

const { lockfileGraphPrep } = await import('../ui/view/lockfile-graph-inputs.js')
const { LOCKFILE_LAYOUTS } = await import('../ui/view/lockfile-graph.js')
const { buildGraphFromPrep } = await import('../ui/graph.js')
const { packageVersions } = await import('../ui/view/graph/data.js')
const { dependencyFilesOn, packageNetwork } = await import('../ui/view/graph/package-network.js')
const { renderFocusOverlay, renderSelectionCard, renderStage, renderTopBar, renderTopPkgsBlock } = await import('../ui/view/graph/render.js')
const { buildDependencyMatrix } = await import('../ui/view/graph/matrix-model.js')
const { renderMatrixPanel } = await import('../ui/view/graph/matrix-panel.js')
const { graph2 } = await import('../ui/view/graph/state.js')

function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value?.strings) return value.strings.map((part, i) => part + text(value.values[i])).join('')
  return ['string', 'number'].includes(typeof value) ? String(value) : ''
}

// Each test leaves the shared viewer state as it found it.
function keep(t, ...keys) {
  const saved = keys.map(key => graph2[key])
  t.after(() => keys.forEach((key, i) => { graph2[key] = saved[i] }))
}

// As pnpm locks a workspace: packages by name and version, importers linked.
const pnpm = {
  id: 'pnpm-lock.yaml@1',
  importers: {
    '.': { dependencies: ['react@18.2.0', 'link:packages/ui'] },
    'packages/ui': { version: '1.0.0', dependencies: ['react@18.2.0', 'lodash@4.17.21', 'gone@1.0.0'] },
  },
  packages: {
    'react@18.2.0': { name: 'react', version: '18.2.0', dependencies: ['loose-envify@1.4.0'] },
    'loose-envify@1.4.0': { name: 'loose-envify', version: '1.4.0', dependencies: ['js-tokens@4.0.0', 'lodash@3.10.1'] },
    'js-tokens@4.0.0': { name: 'js-tokens', version: '4.0.0', dependencies: [] },
    'lodash@4.17.21': { name: 'lodash', version: '4.17.21', dependencies: [] },
    'lodash@3.10.1': { name: 'lodash', version: '3.10.1', dependencies: [] },
  },
}
const graphOf = lockfile => buildGraphFromPrep(lockfileGraphPrep(lockfile))

describe('lockfileGraphPrep', () => {
  it('groups copies by package and its importers by directory, the project as own source', () => {
    const graph = graphOf(pnpm)
    assert.equal(graph.packagesOnly, true)
    assert.equal(graph.viewId, 'pnpm-lock.yaml@1')
    assert.deepEqual(new Set(graph.packages), new Set(['__own__', 'packages/ui', 'react', 'loose-envify', 'js-tokens', 'lodash']))
    assert.deepEqual(graph.byPkg.get('lodash').map(n => n.file).toSorted(), ['lodash@3.10.1', 'lodash@4.17.21'])
    assert.deepEqual(packageVersions(graph, 'lodash'), ['3.10.1', '4.17.21'])
    assert.deepEqual(packageVersions(graph, 'packages/ui'), ['1.0.0'])
    assert.deepEqual(packageVersions(graph, '__own__'), [], 'the project records no version')
    assert.deepEqual(graph.layerRoots.roots, ['__own__', 'packages/ui'])
    assert.deepEqual(graph.ownSourcePackages, new Set(['__own__', 'packages/ui']))
  })

  it('links what depends on what, through links to importers, leaving out what leads nowhere', () => {
    const pg = packageNetwork(graphOf(pnpm))
    const links = id => pg.importsOf.get(id).toSorted()
    assert.deepEqual(links('__own__'), ['packages/ui', 'react'])
    assert.deepEqual(links('packages/ui'), ['lodash', 'react'], 'gone@1.0.0 is in no package')
    assert.deepEqual(links('loose-envify'), ['js-tokens', 'lodash'])
    assert.deepEqual(pg.importedBy.get('lodash').toSorted(), ['loose-envify', 'packages/ui'])
  })

  it('keeps npm\'s copies at their locations apart, and follows a link to one of them', () => {
    const graph = graphOf({
      importers: { '.': { dependencies: ['node_modules/a', 'node_modules/c'] } },
      packages: {
        'node_modules/a': { name: 'a', version: '1.0.0', dependencies: ['node_modules/a/node_modules/c', 'link:node_modules/d'] },
        'node_modules/a/node_modules/c': { name: 'c', version: '2.0.0', dependencies: [] },
        'node_modules/c': { name: 'c', version: '1.0.0', dependencies: [] },
        'node_modules/d': { name: 'd', version: '1.0.0', dependencies: [] },
      },
    })
    assert.deepEqual(graph.importsOf.get('node_modules/a'), ['node_modules/a/node_modules/c', 'node_modules/d'])
    assert.deepEqual(packageVersions(graph, 'c'), ['1.0.0', '2.0.0'])
    assert.equal(graph.viewId, null)
  })

  it('takes any key a lockfile has as a package of it', () => {
    const graph = graphOf({ importers: { '.': { dependencies: ['__proto__', 'constructor'] } }, packages: {
      __proto__: null, ['__proto__']: { name: 'p', version: '1.0.0', dependencies: ['constructor'] },
      constructor: { name: 'c', version: '1.0.0', dependencies: [] },
    } })
    assert.deepEqual(graph.files, ['link:.', '__proto__', 'constructor'])
    assert.deepEqual(packageNetwork(graph).importsOf.get('p'), ['c'])
  })

  it('has no graph for a lockfile of nothing', () => {
    assert.equal(lockfileGraphPrep({ importers: {}, packages: {} }), null)
    assert.equal(lockfileGraphPrep(null), null)
  })
})

describe('a graph of packages alone in the bundle graph viewer', () => {
  const options = { showBundleLayouts: true, layouts: LOCKFILE_LAYOUTS, hideAllFiles: true }

  it('offers only the layouts a lockfile can fill, and no altitude switch or Issues', t => {
    keep(t, 'bundleLayout')
    const graph = graphOf(pnpm)
    for (const layout of LOCKFILE_LAYOUTS) {
      graph2.bundleLayout = layout
      const bar = text(renderTopBar(graph, options))
      assert.deepEqual([...bar.matchAll(/data-g2-layout=(\w+)/gu)].map(m => m[1]), LOCKFILE_LAYOUTS)
      assert.match(bar, new RegExp(`data-g2-layout=${layout} aria-label=\\w+ aria-pressed=true`, 'u'))
      assert.doesNotMatch(bar, /data-g2-packages-view|data-g2-bundle-issues/u)
    }
    graph2.bundleLayout = 'graph'
    assert.deepEqual([...text(renderTopBar(graph, { showBundleLayouts: true })).matchAll(/data-g2-layout=(\w+)/gu)].map(m => m[1]),
      ['graph', 'layers', 'matrix', 'dependencies', 'flow'], 'a bundle offers them all')
  })

  it('stays at package altitude, with no file level to draw', () => {
    const graph = graphOf(pnpm)
    assert.ok(graph.nodes.length <= 100)
    assert.equal(dependencyFilesOn(graph, false), false)
  })

  it('counts packages and their dependencies, never files, in every canvas layout', t => {
    keep(t, 'bundleLayout')
    const graph = graphOf(pnpm)
    for (const layout of ['graph', 'dependencies']) {
      graph2.bundleLayout = layout
      const stats = text(renderStage(graph))
      assert.doesNotMatch(stats, / files/u)
      assert.match(stats, /<b>6<\/b> packages/u)
      assert.match(stats, /<b>7<\/b> dependencies/u)
    }
  })

  it('inspects a package by its versions, dependents and dependencies, and offers no file focus', t => {
    keep(t, 'bundleLayout', 'solo', 'selected')
    const graph = graphOf(pnpm)
    graph2.bundleLayout = 'graph'
    graph2.selected = null
    graph2.solo = 'lodash'
    const card = text(renderSelectionCard(graph))
    assert.match(card, /Versions \(2\)<\/div>\s*<div class="g2-sel-versions">3\.10\.1, 4\.17\.21</u)
    assert.match(card, /Dependents \(2\)/u)
    assert.doesNotMatch(card, /Imported by|data-g2-select|Files/u)
    assert.equal(renderFocusOverlay(graph), null)
    graph2.solo = 'react'
    assert.match(text(renderSelectionCard(graph)), /Version<\/div>\s*<div class="g2-sel-versions">18\.2\.0</u)
    assert.match(text(renderTopPkgsBlock(graph)), /Packages · dependents/u)
  })

  it('keeps a bundle\'s Dependencies card as it was', t => {
    keep(t, 'bundleLayout', 'solo', 'dependencyPackagesView')
    const graph = graphOf(pnpm)
    graph.packagesOnly = false
    graph2.bundleLayout = 'dependencies'
    graph2.dependencyPackagesView = true
    graph2.solo = 'lodash'
    const card = text(renderSelectionCard(graph))
    assert.match(card, /Imported by \(2\)/u)
    assert.doesNotMatch(card, /Version/u)
  })

  it('shows the matrix at packages, with no copies to expand or sources to view', () => {
    const graph = graphOf(pnpm)
    const model = buildDependencyMatrix(graph)
    const controls = { select() {}, expand() {}, expanded: new Set(), focus() {}, clear() {} }
    const empty = text(renderMatrixPanel(model, graph, null, controls))
    assert.doesNotMatch(empty, /files/u)
    assert.match(empty, /<b>6<\/b>packages<\/span><span><b>7<\/b>dependencies/u)
    assert.match(empty, /Most depended on/u)
    const row = text(renderMatrixPanel(model, graph, { from: 'p:lodash', to: null }, controls))
    assert.match(row, /<b>2<\/b>versions/u)
    assert.doesNotMatch(row, /source size|View source|Expand files|data-bundle-view-source/u)
    assert.match(row, /Dependents <b>2<\/b>/u)
    const cell = text(renderMatrixPanel(model, graph, { from: 'p:loose-envify', to: 'p:lodash' }, controls))
    assert.match(cell, /depends on →/u)
    assert.match(cell, /<span class="matrix-import-copy matrix-import-target"[^>]*>lodash@3\.10\.1<\/span>/u)
    assert.match(cell, /<span class="matrix-import-copy"><span aria-hidden="true">←<\/span><span[^>]*>loose-envify@1\.4\.0<\/span><\/span>/u)
    assert.doesNotMatch(cell, /data-bundle-view-source|file imports/u)
  })

  it('does not expand a package in the matrix', () => {
    const matrix = new (customElements.get('dependency-matrix'))()
    matrix.graph = graphOf(pnpm)
    matrix.expand('lodash')
    assert.equal(matrix.expanded.size, 0)
  })
})

describe('<lockfile-graph>', () => {
  // A click as it reaches the element, on what `selector` matches.
  function click(el, selector, dataset = {}) {
    let stopped = false
    el._click({ composedPath: () => [{ dataset, matches: s => s === selector }, el], stopPropagation: () => { stopped = true } })
    return stopped
  }

  it('switches between the layouts it offers, and keeps its graph\'s clicks from the page', t => {
    keep(t, 'bundleLayout', 'lockfileLayout', 'solo', 'selected', 'graphState')
    const el = new (customElements.get('lockfile-graph'))()
    let attached = 0
    el._attach = () => { attached++ }
    graph2.bundleLayout = 'graph'
    graph2.solo = 'react'
    assert.equal(click(el, '[data-g2-layout]', { g2Layout: 'matrix' }), true)
    assert.equal(graph2.bundleLayout, 'matrix')
    assert.equal(graph2.lockfileLayout, 'matrix', 'the next lockfile opens on it')
    assert.equal(graph2.solo, null)
    assert.equal(attached, 1)
    assert.equal(click(el, '[data-g2-layout]', { g2Layout: 'flow' }), true, 'a layout it does not offer is still not the page\'s')
    assert.equal(graph2.bundleLayout, 'matrix')
    assert.equal(attached, 1)
    assert.equal(click(el, '[data-g2-pkg]', { g2Pkg: 'lodash' }), true)
    assert.equal(graph2.solo, 'lodash')
    assert.equal(click(el, '[data-g2-pkg]', { g2Pkg: 'lodash' }), true)
    assert.equal(graph2.solo, null, 'a second click lets the package go')
    assert.equal(click(el, '.somewhere-else'), false)
  })

  it('opens on Dependencies, or the layout picked last, gives the bundle graph its own back, and drops what was picked in another', async t => {
    keep(t, 'bundleLayout', 'lockfileLayout', 'solo', 'selected', 'focusedPkg')
    const opened = () => {
      const el = new (customElements.get('lockfile-graph'))()
      el.lockfile = pnpm
      el.willUpdate(new Map([['lockfile', undefined]]))
      // No graph module to load here: the slot says so, as on a failed load.
      const slot = {}
      el.renderRoot = { querySelector: selector => selector === '.slot' ? slot : null }
      Object.defineProperty(el, 'isConnected', { value: true })
      return { el, slot }
    }
    graph2.bundleLayout = 'flow'
    graph2.solo = 'react'
    graph2.selected = 'src/index.js'
    graph2.focusedPkg = 'react'
    const { el, slot } = opened()
    assert.deepEqual([graph2.solo, graph2.selected, graph2.focusedPkg], [null, null, null])
    await el._attach()
    assert.match(slot.textContent, /^Graph failed to load/u)
    assert.equal(graph2.bundleLayout, 'dependencies', 'Dependencies first, the third of its layouts')
    await el._attach()
    el._detach()
    assert.equal(graph2.bundleLayout, 'flow', 'the bundle graph\'s own, however often it mounted')
    graph2.lockfileLayout = 'matrix'
    const { el: next } = opened()
    await next._attach()
    assert.equal(graph2.bundleLayout, 'matrix')
    next._detach()
    assert.equal(graph2.bundleLayout, 'flow')
  })

  it('mounts only its latest attachment, and none once off the page, so a late one leaves the graph on screen alone', async t => {
    keep(t, 'bundleLayout')
    const el = new (customElements.get('lockfile-graph'))()
    el.lockfile = pnpm
    el.willUpdate(new Map([['lockfile', undefined]]))
    // Each mount, here a failed one (no graph module to load), writes the slot.
    const mounts = []
    const slot = { get textContent() { return mounts.at(-1) }, set textContent(message) { mounts.push(message) } }
    el.renderRoot = { querySelector: selector => selector === '.slot' ? slot : null }
    let connected = true
    Object.defineProperty(el, 'isConnected', { get: () => connected })
    await Promise.all([el._attach(), el._attach()])
    assert.equal(mounts.length, 1, 'the earlier attachment, superseded while it waited, mounts nothing')
    const leaving = el._attach()
    connected = false
    el._detach()
    await leaving
    assert.equal(mounts.length, 1, 'nor one whose element left the page while it waited')
  })
})
