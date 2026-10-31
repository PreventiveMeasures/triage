// Package flow: Size flow's chart weighed in packages, each counted once,
// however many files or installed copies it has. Counting runs on those
// members, so merging them into packages never invents a path.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import './_polyfills.js'

const { buildGraph } = await import('../ui/view/graph/data.js')
const { buildSizeFlow, layoutSizeFlow, sizeFlowLargeThreshold } = await import('../ui/view/graph/size-flow-model.js')
const { flowNodeTooltip } = await import('../ui/view/graph/size-flow-chart.js')
const { packageCounts } = await import('../ui/view/graph/count-flow.js')
await import('../ui/view/graph/size-flow.js')
const { lockfileGraphPrep } = await import('../ui/view/lockfile-graph-inputs.js')
const { LOCKFILE_LAYOUTS } = await import('../ui/view/lockfile-graph.js')
const { buildGraphFromPrep } = await import('../ui/graph.js')
const { renderTopBar } = await import('../ui/view/graph/render.js')
const { graph2 } = await import('../ui/view/graph/state.js')

function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value?.strings) return value.strings.map((part, i) => part + text(value.values[i])).join('')
  // A directive's (keyed's) template is among its values.
  if (value?.values) return value.values.filter(v => typeof v === 'object').map(text).join('')
  return ['string', 'number'].includes(typeof value) ? String(value) : ''
}

// A bundle's files, each in the package its first path segment names.
function bundle(tree, entries = ['entry.js']) {
  const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: f => f.includes('/') ? f.split('/')[0] : '__own__' })
  graph.flowEntries = entries.map(file => ({ file }))
  return graph
}

const counted = (model, id) => {
  const { own, size, removable, missing, removableMissing } = model.byId.get(id)
  return { own, size, removable, missing, removableMissing }
}

const diamond = {
  'entry.js': { size: 10, imports: ['a/index.js', 'b/index.js'] },
  'a/index.js': { size: 20, imports: ['large/index.js', 'a/helper.js'] },
  'a/helper.js': { size: 20, imports: [] },
  'b/index.js': { size: 30, imports: ['large/index.js'] },
  'large/index.js': { size: 1000, imports: ['large/more.js'] },
  'large/more.js': { size: 9000, imports: [] },
  'gone/index.js': { size: 5000, imports: [] },
}

// As pnpm locks a workspace whose `tools` workspace nothing depends on, with
// two copies of `a`: only the second, which `qux` brings, depends on `baz`.
const pnpm = {
  id: 'pnpm-lock.yaml@2',
  importers: {
    '.': { dependencies: ['a@1.0.0', 'qux@1.0.0', 'link:packages/ui'] },
    'packages/ui': { version: '1.0.0', dependencies: ['react@18.2.0'] },
    'tools': { dependencies: ['eslint@9.0.0'] },
  },
  packages: {
    'a@1.0.0': { name: 'a', version: '1.0.0', dependencies: [] },
    'a@2.0.0': { name: 'a', version: '2.0.0', dependencies: ['baz@1.0.0'] },
    'qux@1.0.0': { name: 'qux', version: '1.0.0', dependencies: ['a@2.0.0'] },
    'baz@1.0.0': { name: 'baz', version: '1.0.0', dependencies: ['qux@1.0.0'] },
    'react@18.2.0': { name: 'react', version: '18.2.0', dependencies: ['loose-envify@1.4.0'] },
    'loose-envify@1.4.0': { name: 'loose-envify', version: '1.4.0', dependencies: [] },
    'eslint@9.0.0': { name: 'eslint', version: '9.0.0', dependencies: [] },
    'orphan@1.0.0': { name: 'orphan', version: '1.0.0', dependencies: [] },
  },
}
const lockfileGraph = lockfile => buildGraphFromPrep(lockfileGraphPrep(lockfile))

describe('Package flow model', () => {
  test('counts each package once, its own included, however many files it has', () => {
    const model = buildSizeFlow(bundle(diamond), { metric: 'count' })
    assert.equal(model.metric, 'count')
    assert.equal(model.packages, true, 'counting implies package altitude')
    assert.deepEqual([...model.byId.keys()].toSorted(), ['p:__own__', 'p:a', 'p:b', 'p:large'])
    assert.deepEqual(counted(model, 'p:__own__'), { own: 1, size: 4, removable: 4, missing: 0, removableMissing: 0 })
    assert.deepEqual(counted(model, 'p:a'), { own: 1, size: 2, removable: 1, missing: 0, removableMissing: 0 }, 'b still brings large')
    assert.deepEqual(counted(model, 'p:large'), { own: 1, size: 1, removable: 1, missing: 0, removableMissing: 0 })
    assert.deepEqual(model.edges.filter(e => e.to === 'p:large').map(e => e.size), [1, 1])
    assert.equal(model.edges.find(e => e.from === 'p:__own__' && e.to === 'p:a').size, 2)
    assert.deepEqual(model.total, { size: 4, missing: 0 })
    assert.equal(model.omittedPackages, 1, 'gone is reachable from no entry point')
    assert.deepEqual(model.roots, ['p:__own__'])
  })

  test('leaves Size flow\'s byte totals as they were', () => {
    const model = buildSizeFlow(bundle(diamond), { packages: true })
    assert.equal(model.metric, 'size')
    assert.equal(model.byId.get('p:large').own, 10000)
    assert.equal(model.byId.get('p:a').removable, 40)
    assert.equal(model.byId.get('p:__own__').size, 10080)
  })

  test('follows a lockfile\'s copies, not dependencies merged per package', () => {
    const model = buildSizeFlow(lockfileGraph(pnpm), { metric: 'count' })
    // qux brings a@2.0.0 and, through it, baz; a@1.0.0 keeps `a` itself.
    assert.equal(model.byId.get('p:qux').removable, 2, 'deleting qux removes qux and baz, not a')
    assert.equal(model.byId.get('p:a').removable, 2, 'deleting a deletes both copies, and baz, which only a@2.0.0 brings')
    assert.equal(model.byId.get('p:a').size, 3, 'its copies reach baz, and through it qux')
    const edge = (from, to) => model.edges.find(e => e.from === `p:${from}` && e.to === `p:${to}`)
    assert.equal(edge('__own__', 'a').size, 1, 'the root\'s copy of a brings nothing')
    assert.equal(edge('qux', 'a').size, 3, 'qux\'s copy brings baz, which comes back to qux')
    assert.equal(edge('baz', 'qux').size, 3)
    assert.equal(model.byId.get('p:baz').size, 3, 'a cycle reaches each of its packages once')
  })

  test('flows from every workspace, depended on or not, and counts what none reaches', () => {
    const model = buildSizeFlow(lockfileGraph(pnpm), { metric: 'count' })
    assert.equal(model.inferred, false)
    assert.deepEqual(model.roots, ['p:__own__', 'p:packages/ui', 'p:tools'])
    assert.equal(model.byId.get('p:__own__').removable, 4, 'the ui workspace stays, a root itself')
    assert.equal(model.byId.get('p:packages/ui').removable, 3)
    assert.equal(model.byId.get('p:react').removable, 2)
    assert.equal(model.byId.get('p:tools').removable, 2)
    assert.equal(model.total.size, 9)
    assert.equal(model.omittedPackages, 1, 'orphan')
    assert.equal(model.weakEdges, 0)
    assert.deepEqual(model.byId.get('p:a').instances.map(i => [i.version, i.directory]),
      [['1.0.0', 'a@1.0.0'], ['2.0.0', 'a@2.0.0']], 'each copy at the key the lockfile names it by')
  })

  test('lays packages out by what they bring, as Size flow lays out bytes', () => {
    const layout = layoutSizeFlow(buildSizeFlow(lockfileGraph(pnpm), { metric: 'count' }))
    const width = id => layout.byId.get(id).width
    assert.deepEqual(layout.nodes.filter(n => n.level === 0).map(n => n.id), ['p:__own__', 'p:packages/ui', 'p:tools'])
    assert.ok(Math.abs(width('p:tools') - 2 * width('p:eslint')) < 1e-9, 'bar width is proportional to removed packages')
  })

  test('matches independent traversals across batches of 32, cycles and shared members', () => {
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    for (let round = 0; round < 6; round++) {
      const packages = 40 + Math.floor(random() * 40)
      const members = Array.from({ length: packages * 2 }, (_, i) => `m${i}`)
      const pkgOf = new Map(members.map((m, i) => [m, `p${i % packages}`]))
      const links = new Map(members.map(m => [m, new Set()]))
      for (const m of members) for (let k = 0; k < 2; k++) if (random() < .8) links.get(m).add(members[Math.floor(random() * members.length)])
      const roots = [members[0], members[1]]
      // Only what the roots reach is counted, as buildSizeFlow passes it.
      const reach = (starts, removed = new Set()) => {
        const seen = new Set(), stack = starts.filter(m => !removed.has(m))
        while (stack.length > 0) {
          const m = stack.pop()
          if (seen.has(m)) continue
          seen.add(m)
          for (const to of links.get(m)) if (!removed.has(to)) stack.push(to)
        }
        return seen
      }
      const active = reach(roots)
      const rows = new Map()
      for (const m of active) {
        const id = pkgOf.get(m)
        if (!rows.has(id)) rows.set(id, { files: [] })
        rows.get(id).files.push(m)
      }
      const edges = [...active].flatMap(m => [...links.get(m)].map(to => ({ targets: new Set([to]) })))
      packageCounts(links, roots, rows, edges)
      const packagesOf = set => new Set([...set].map(m => pkgOf.get(m))).size
      const all = packagesOf(reach(roots))
      for (const [id, row] of rows) {
        assert.equal(row.size, packagesOf(reach(row.files)), `${id} reachable`)
        assert.equal(row.removable, all - packagesOf(reach(roots, new Set(row.files))), `${id} removable`)
      }
      for (const edge of edges) assert.equal(edge.size, packagesOf(reach([...edge.targets])))
    }
  })

  test('Large steps by packages', () => {
    const threshold = (...groups) => sizeFlowLargeThreshold({ metric: 'count', byId: new Map(groups.flatMap(([count, filterSize]) =>
      Array.from({ length: count }, () => ({ filterSize }))).map((node, i) => [i, node])) })
    assert.equal(threshold([100, 1]), 0, '100 packages need no filtering')
    assert.equal(threshold([200, 1], [60, 2]), 2, 'leaves alone first')
    assert.equal(threshold([200, 1], [101, 4], [50, 5]), 5)
    assert.equal(threshold([200, 1], [49, 50]), 0, 'never fewer than 50')
    assert.equal(threshold([1000, 300]), 200, '200 packages is the final step')
  })

  test('tooltips count packages and list versions without sizes', () => {
    const model = buildSizeFlow(lockfileGraph(pnpm), { metric: 'count' })
    assert.equal(flowNodeTooltip(model.byId.get('p:a'), 0, 'count'), 'a\n2 packages unique · 3 reachable\nVersions: 1.0.0, 2.0.0')
    assert.equal(flowNodeTooltip(model.byId.get('p:tools'), 0, 'count'), 'tools\n2 packages unique · 2 reachable')
  })
})

describe('<size-flow metric="count">', () => {
  const mount = (graph, metric = 'count') => {
    const flow = new (customElements.get('size-flow'))()
    flow.graph = graph; flow.packages = true; flow.metric = metric
    flow.willUpdate(new Map([['graph', null]]))
    return flow
  }

  test('describes packages, with no byte sizes, sources or files', () => {
    const flow = mount(lockfileGraph(pnpm))
    const overview = text(flow.renderPanel())
    assert.match(overview, /<h3>Package flow<\/h3><div class="flow-metrics"><b>9<\/b><span>packages reachable/u)
    assert.match(overview, /1 package is not reachable from these workspaces/u)
    assert.match(overview, /<h4>Workspaces<\/h4>/u)
    assert.doesNotMatch(overview, /KiB|bytes|files/u)
    flow.select('p:a')
    const card = text(flow.renderPanel())
    assert.match(card, /<b>2<\/b><span>unique packages · removed if deleted · bar width<\/span><b>3<\/b><span>packages reachable · itself and 2 dependencies/u)
    assert.match(card, /Versions: 2<\/summary><ul class="flow-versions"><li>\s*<div><span>1\.0\.0<\/span><\/div>\s*<small>a@1\.0\.0<\/small>/u, 'no own source size for copies')
    assert.match(card, /Follow dependencies/u)
    assert.match(card, /<h4>Dependencies · 1<\/h4>/u)
    assert.match(card, /<h4>Dependents · 2<\/h4>/u)
    assert.doesNotMatch(card, /View source|data-bundle-view-source|KiB/u)
    flow.select('p:a', JSON.stringify(['p:qux', 'p:a']))
    const ribbon = text(flow.renderPanel())
    assert.match(ribbon, /qux<br>↓ depends on<br>a/u)
    assert.match(ribbon, /<b>3<\/b><span>packages reachable through this dependency<\/span>/u, 'no file imports in a lockfile')
  })

  test('counts a bundle\'s packages, which import each other through files', () => {
    const flow = mount(bundle(diamond))
    assert.match(text(flow.renderPanel()), /<h4>Entry points<\/h4>/u)
    flow.select('p:large', JSON.stringify(['p:a', 'p:large']))
    assert.match(text(flow.renderPanel()), /<b>1<\/b><span>package reachable through this dependency · 1 file import<\/span>/u)
    assert.match(text(flow.render()), /4 packages/u)
  })

  test('labels Large in packages', () => {
    const tree = { 'entry.js': { size: 1, imports: [] } }
    for (let i = 0; i < 150; i++) {
      tree['entry.js'].imports.push(`p${i}/index.js`)
      tree[`p${i}/index.js`] = { size: 1, imports: i < 60 ? [`d${i}/index.js`] : [] }
      if (i < 60) tree[`d${i}/index.js`] = { size: 1, imports: [] }
    }
    const flow = mount(bundle(tree))
    assert.equal(flow.largeThreshold, 2)
    assert.equal(flow.renderControls().values.find(v => typeof v === 'string' && v.startsWith('Large')), 'Large · 2+ packages')
    assert.equal(flow.layout.nodes.length, 61, 'the entry and the packages that bring another')
  })

  test('rebuilds and refits when switched between Size flow and Package flow', () => {
    const flow = mount(bundle(diamond), 'size')
    assert.equal(flow.model.metric, 'size')
    flow.select('p:a'); flow.needsFit = false
    flow.metric = 'count'; flow.willUpdate(new Map([['metric', 'size']]))
    assert.equal(flow.model.metric, 'count')
    assert.equal(flow.needsFit, true)
    assert.equal(flow.selection.node, 'p:a', 'a package selected in one stays selected in the other')
    assert.equal(flow.model.byId.get('p:a').removable, 1)
  })
})

describe('Package flow in the layout selector', () => {
  test('a bundle offers it beside Size flow, with no altitude switch', t => {
    const saved = graph2.bundleLayout
    t.after(() => { graph2.bundleLayout = saved })
    const graph = bundle(diamond)
    graph2.bundleLayout = 'package-flow'
    const bar = text(renderTopBar(graph, { showBundleLayouts: true, showPackagesView: true }))
    assert.deepEqual([...bar.matchAll(/data-g2-layout=([\w-]+)/gu)].map(m => m[1]),
      ['graph', 'layers', 'matrix', 'dependencies', 'flow', 'package-flow'])
    assert.match(bar, /data-g2-layout=package-flow aria-label=Package flow aria-pressed=true/u)
    assert.doesNotMatch(bar, /data-g2-packages-view/u)
    graph2.bundleLayout = 'flow'
    assert.match(text(renderTopBar(graph, { showBundleLayouts: true })), /data-g2-packages-view/u)
  })

  test('a lockfile offers it, its only flow', () => {
    assert.ok(LOCKFILE_LAYOUTS.includes('package-flow'))
    assert.ok(!LOCKFILE_LAYOUTS.includes('flow'), 'a lockfile records no bytes')
  })
})
