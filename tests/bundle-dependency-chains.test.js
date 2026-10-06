import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { createBundleMetadata, parseBundleMetadata } from '../common/bundle-metadata.js'
import { bundleDependencyChains, layoutDependencyChains, traceDependencyChains } from '../ui/view/bundle-dependency-chains.js'
import { DEPENDENCY_CARD_HEIGHT, DEPENDENCY_CARD_WIDTH, DEPENDENCY_DIALOG_GUTTER, layoutDependencyGroup } from '../ui/view/dependency-chain-layout.js'
import { placeDependencyCycle } from '../ui/view/dependency-chain-order.js'

const file = dir => dir === '.' ? 'index.js' : `${dir}/index.js`
function fixture({ modules, links = [], entries = [], reason = {} }) {
  const imports = new Map()
  for (const [from, to] of links) {
    const parent = file(from)
    if (!imports.has(parent)) imports.set(parent, new Map())
    imports.get(parent).set(to, file(to))
  }
  return { kind: 'stasis', integrity: 'test', size: 1, bundle: Bundle.parse(new Bundle({
    config: { scope: 'full' },
    modules: new Map(Object.entries(modules).map(([dir, info]) => [dir, { name: dir === '.' ? 'app' : dir, files: { 'index.js': 'source' }, ...info }])),
    imports: new Map([['node,import', imports]]), entries: new Set(entries.map(file)), reason,
  }).serialize()) }
}
const dep = (name, version = '1.0.0', ecosystem = 'npm') => ({ name, version, ecosystem })
const query = { packageKey: 'dep', version: '1.0.0' }

test('retains every diamond branch, direct import and exact installed copy without including other versions', () => {
  const details = fixture({ modules: {
    '.': { name: 'app' }, 'node_modules/a': dep('a'), 'node_modules/b': dep('b'),
    'node_modules/dep': dep('dep'), 'node_modules/b/node_modules/dep': dep('dep', '2.0.0'),
    'node_modules/c': dep('c'), 'node_modules/c/node_modules/dep': dep('dep'),
  }, links: [
    ['.', 'node_modules/a'], ['.', 'node_modules/b'], ['.', 'node_modules/dep'], ['.', 'node_modules/c'],
    ['node_modules/a', 'node_modules/dep'], ['node_modules/b', 'node_modules/dep'],
    ['node_modules/b', 'node_modules/b/node_modules/dep'], ['node_modules/c', 'node_modules/c/node_modules/dep'],
  ] })
  const graph = bundleDependencyChains(details, query)
  assert.equal(graph.targets.length, 2)
  assert.equal(graph.nodes.has('node_modules/b/node_modules/dep'), false)
  assert.deepEqual(graph.importedBy.get('node_modules/dep'), new Set(['.', 'node_modules/a', 'node_modules/b']))
  assert.deepEqual(graph.importedBy.get('node_modules/c/node_modules/dep'), new Set(['node_modules/c']))
  assert.equal(graph.nodes.get('.').root, true)
  assert.equal(graph.imports.get('node_modules/c').has('node_modules/dep'), false, 'no invented path between copies')
  const layout = layoutDependencyChains(graph)
  assert.equal(layout.boxes.length, 6)
  assert.equal(layout.edges.length, 7)
  const from = layout.boxes.find(box => box.members.includes('.')).id
  const to = layout.boxes.find(box => box.members.includes('node_modules/dep')).id
  const shortcut = layout.edges.find(edge => edge.from === from && edge.to === to)
  const right = Math.max(...layout.boxes.map(box => box.x + box.width))
  assert.ok([...shortcut.path.matchAll(/(-?\d+(?:\.\d+)?),/gu)].some(([, x]) => Number(x) > right), 'shortcut routes outside intervening cards')
})

test('metadata-only bundles retain the same chains and entry points without source bodies', async () => {
  const details = fixture({ modules: { 'app': { name: 'workspace' }, 'vendor/dep': dep('dep', '1.0.0', 'composer') },
    links: [['app', 'vendor/dep']], entries: ['app'] })
  const metadata = parseBundleMetadata(await createBundleMetadata(details), details.integrity)
  assert.equal(metadata.metadataOnly, true)
  const options = { packageKey: 'composer:dep', version: '1.0.0' }
  assert.deepEqual(bundleDependencyChains(metadata, options), bundleDependencyChains(details, options))
  assert.equal(bundleDependencyChains(metadata, options).nodes.get('app').root, true)
})

test('keeps ecosystems separate and matches normalized GitHub unknown versions and case', () => {
  const details = fixture({ modules: {
    '.': {}, 'node_modules/dep': dep('dep'), 'vendor/dep': dep('dep', '1.0.0', 'cargo'),
    'dependencies/lib': dep('Owner/Library', '.', 'github'),
  }, links: [['.', 'node_modules/dep'], ['.', 'vendor/dep'], ['.', 'dependencies/lib']] })
  assert.deepEqual(bundleDependencyChains(details, query).targets, ['node_modules/dep'])
  assert.deepEqual(bundleDependencyChains(details, { packageKey: 'cargo:dep', version: '1.0.0' }).targets, ['vendor/dep'])
  const graph = bundleDependencyChains(details, { packageKey: 'github:owner/library', version: '0.0.0' })
  assert.deepEqual(graph.targets, ['dependencies/lib'])
  assert.equal(graph.nodes.get('dependencies/lib').version, '.')
})

test('follows all platform resolutions and ignores internal package imports', () => {
  const details = fixture({ modules: { '.': {}, 'node_modules/dep': dep('dep'), 'node_modules/platform/node_modules/dep': dep('dep') } })
  details.bundle.imports.set('metro', new Map([['index.js', new Map([['dep', new Map([
    ['ios', 'node_modules/dep/index.js'], ['android', 'node_modules/platform/node_modules/dep/index.js'],
  ])]])], ['node_modules/dep/index.js', new Map([['self', 'node_modules/dep/index.js']])]]))
  const graph = bundleDependencyChains(details, query)
  assert.deepEqual(graph.imports.get('.'), new Set(graph.targets))
  assert.equal(graph.imports.get('node_modules/dep').size, 0)
})

test('scope filtering never restores an excluded bundled importer as virtual App', () => {
  const details = fixture({ modules: { '.': {}, 'node_modules/a': dep('a'), 'node_modules/dep': dep('dep') },
    links: [['.', 'node_modules/dep'], ['node_modules/a', 'node_modules/dep']],
    reason: { run: ['node_modules/a/index.js', 'node_modules/dep/index.js'], add: ['index.js'] } })
  const graph = bundleDependencyChains(details, { ...query, reason: 'run' })
  assert.equal(graph.nodes.has('.'), false)
  assert.deepEqual(graph.importedBy.get('node_modules/dep'), new Set(['node_modules/a']))
  assert.equal([...graph.nodes.values()].some(node => node.root), false)
  assert.equal(bundleDependencyChains(details, { ...query, reason: 'add' }).targets.length, 0)
  assert.deepEqual(bundleDependencyChains(details, { ...query, reason: 'stale' }), bundleDependencyChains(details, query))
})

test('retains imports from omitted app source and distinguishes direct entry packages from unexplained inclusion', () => {
  const details = fixture({ modules: { 'node_modules/dep': dep('dep') }, links: [['.', 'node_modules/dep']] })
  assert.equal(bundleDependencyChains(details, query).nodes.get('.').root, true)
  const entry = fixture({ modules: { 'node_modules/dep': dep('dep') }, entries: ['node_modules/dep'] })
  assert.equal(bundleDependencyChains(entry, query).nodes.get('node_modules/dep').root, true)
  const unknown = fixture({ modules: { 'node_modules/dep': dep('dep') } })
  const graph = bundleDependencyChains(unknown, query)
  assert.equal(graph.nodes.size, 1)
  assert.equal(graph.nodes.get('node_modules/dep').root, false)
  assert.equal(graph.importedBy.get('node_modules/dep').size, 0)
})

test('cycles remain visible in finite groups with their incoming and outgoing chains', () => {
  const details = fixture({ modules: { '.': {}, 'node_modules/a': dep('a'), 'node_modules/b': dep('b'), 'node_modules/dep': dep('dep') },
    links: [['.', 'node_modules/a'], ['node_modules/a', 'node_modules/b'], ['node_modules/b', 'node_modules/a'], ['node_modules/b', 'node_modules/dep']] })
  const graph = bundleDependencyChains(details, query), layout = layoutDependencyChains(graph)
  assert.equal(graph.imports.get('node_modules/b').has('node_modules/a'), true)
  assert.equal(layout.boxes.length, 3)
  assert.deepEqual(layout.boxes.find(box => box.members.length === 2).members, ['node_modules/a', 'node_modules/b'])
  const cycle = layout.boxes.find(box => box.members.length === 2)
  assert.equal(new Set(cycle.packages.map(node => node.x)).size, 2, 'two-package cycles sit side by side')
  assert.equal(cycle.internalEdges.length, 2, 'both import directions are visible')
  assert.notEqual(cycle.internalEdges[0].path, cycle.internalEdges[1].path)
  for (const edge of layout.edges) {
    const from = layout.boxes.find(box => box.id === edge.from), to = layout.boxes.find(box => box.id === edge.to)
    assert.ok(from.y + from.height < to.y)
  }
})

test('compact cycle grids preserve every internal edge without overlapping cards or escaping their group', () => {
  for (const count of [3, 4, 9, 40]) {
    const ids = Array.from({ length: count }, (_, i) => `package-${i}`)
    const imports = new Map(ids.map((id, i) => [id, new Set([ids[(i + 1) % count], ids[(i + count - 1) % count]])]))
    const group = layoutDependencyGroup(0, ids, imports)
    assert.ok(new Set(group.packages.map(node => node.x)).size > 1)
    assert.ok(new Set(group.packages.map(node => node.y)).size > 1)
    assert.ok(group.height < count * 86, 'shorter than the former stack')
    assert.equal(group.internalEdges.length, count * 2)
    assert.deepEqual(group, layoutDependencyGroup(0, ids, imports), 'deterministic layout')
    for (const node of group.packages) {
      assert.ok(node.x >= 0 && node.x + DEPENDENCY_CARD_WIDTH <= group.width)
      assert.ok(node.y >= 20 && node.y + DEPENDENCY_CARD_HEIGHT <= group.height)
      for (const peer of group.packages) {
        if (node === peer) continue
        assert.ok(node.x + DEPENDENCY_CARD_WIDTH <= peer.x || peer.x + DEPENDENCY_CARD_WIDTH <= node.x
          || node.y + DEPENDENCY_CARD_HEIGHT <= peer.y || peer.y + DEPENDENCY_CARD_HEIGHT <= node.y)
      }
    }
    for (const edge of group.internalEdges) {
      const points = [...edge.path.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/gu)].map(([, x, y]) => [Number(x), Number(y)])
      for (const [x, y] of points) {
        assert.ok(x >= 0 && x <= group.width && y >= 0 && y <= group.height)
        assert.ok(group.packages.every(node => x <= node.x || x >= node.x + DEPENDENCY_CARD_WIDTH
          || y <= node.y || y >= node.y + DEPENDENCY_CARD_HEIGHT), 'edge bends stay in the gutters')
      }
    }
  }
})

function clusteredCycle(count) {
  // Alphabetical order interleaves groups, although most imports stay inside
  // each group. The group entry packages also form a cycle with each other.
  const ids = Array.from({ length: count }, (_, i) => `part-${String(i % 10).padStart(2, '0')}-team-${String(Math.floor(i / 10)).padStart(2, '0')}`)
  const imports = new Map(ids.map(id => [id, new Set()]))
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i / 10) * 10
    imports.get(ids[i]).add(ids[start + (i + 1) % 10])
    imports.get(ids[i]).add(ids[i % 10 === 0 ? (i + 10) % count : start])
    if (i % 3 === 0) imports.get(ids[i]).add(ids[start + (i + 9) % 10])
  }
  return { ids, imports }
}

test('40- and 190-package cycles place connected packages closer than alphabetical rows', () => {
  for (const count of [40, 190]) {
    const { ids, imports } = clusteredCycle(count)
    const distance = placement => {
      const positions = new Map(placement.map(node => [node.id, node]))
      let total = 0
      for (const [from, targets] of imports) {for (const to of targets) {
        const a = positions.get(from), b = positions.get(to)
        total += Math.abs(a.col - b.col) + Math.abs(a.row - b.row)
      }}
      return total
    }
    const baseline = ids.toSorted().map((id, i) => ({ id, col: i % 5, row: Math.floor(i / 5) }))
    const placement = placeDependencyCycle(ids, imports, 5)
    assert.ok(distance(placement) < distance(baseline) / 2, 'connected clusters shorten imports')
    assert.equal(new Set(placement.map(node => `${node.col},${node.row}`)).size, count)
    assert.deepEqual(placeDependencyCycle(ids.toReversed(), imports, 5), placement)
  }
})

test('a 190-package cycle at the top regroups to fit desktop, tablet and phone widths', () => {
  const { ids, imports } = clusteredCycle(190)
  const graph = { nodes: new Map(ids.map(id => [id, { id }])), imports }
  const edgeCount = [...imports.values()].reduce((count, targets) => count + targets.size, 0)
  for (const [maxWidth, columns] of [[1280, 5], [900, 3], [600, 2], [375, 1]]) {
    const layout = layoutDependencyChains(graph, { maxWidth })
    assert.equal(layout.boxes.length, 1)
    const box = layout.boxes[0]
    assert.equal(box.packages.length, 190)
    assert.equal(new Set(box.packages.map(node => node.x)).size, columns)
    assert.equal(box.internalEdges.length, edgeCount, 'resizing preserves all connections')
    assert.ok(layout.width + DEPENDENCY_DIALOG_GUTTER <= maxWidth, 'all columns fit inside the dialog')
    assert.ok(box.packages.every(node => node.x + DEPENDENCY_CARD_WIDTH <= box.width && node.y + DEPENDENCY_CARD_HEIGHT <= box.height))
  }
})

test('large cycles reserve space for excluded manifest reads pointing to earlier rows', () => {
  const { ids, imports } = clusteredCycle(190)
  imports.get(ids[0]).add('codegen')
  const cycleImports = new Map([...imports].map(([id, targets]) => [id, new Set(targets)]))
  imports.set('codegen', new Set([ids[0]]))
  const graph = { nodes: new Map([...ids, 'codegen'].map(id => [id, { id }])), imports, cycleImports }
  for (const maxWidth of [1280, 900, 600, 375]) {
    const layout = layoutDependencyChains(graph, { maxWidth })
    const cycle = layout.boxes.find(box => box.members.length === 190)
    const codegen = layout.boxes.find(box => box.members.includes('codegen'))
    assert.equal(layout.boxes.length, 2, 'the excluded read does not enlarge the cycle')
    assert.ok(codegen.y > cycle.y, 'ordinary imports determine the row order')
    assert.ok(layout.edges.some(edge => edge.from === codegen.id && edge.to === cycle.id), 'retain the backward read')
    assert.ok(layout.width + DEPENDENCY_DIALOG_GUTTER <= maxWidth, 'the cycle and backward route fit together')
  }
})

test('missing metadata or version produces an empty graph', () => {
  for (const details of [undefined, { kind: 'stasis', managedId: 'metadata-unavailable' }, fixture({ modules: { 'node_modules/dep': dep('dep', '2.0.0') } })]) {
    const graph = bundleDependencyChains(details, query)
    assert.equal(graph.nodes.size, 0)
    assert.deepEqual(layoutDependencyChains(graph).boxes, [])
  }
})

test('tracing follows only paths through the focused package, excluding siblings and shortcuts', () => {
  const details = fixture({ modules: { '.': {}, 'node_modules/a': dep('a'), 'node_modules/b': dep('b'), 'node_modules/dep': dep('dep') },
    links: [['.', 'node_modules/a'], ['.', 'node_modules/b'], ['.', 'node_modules/dep'], ['node_modules/a', 'node_modules/dep'], ['node_modules/b', 'node_modules/dep']] })
  const layout = layoutDependencyChains(bundleDependencyChains(details, query))
  const box = id => layout.boxes.find(group => group.members.includes(id)).id
  const highlighted = traceDependencyChains(layout, box('node_modules/a'))
  assert.deepEqual(highlighted.groups, new Set([box('.'), box('node_modules/a'), box('node_modules/dep')]))
  assert.deepEqual([...highlighted.edges].map(edge => [edge.from, edge.to]).toSorted(), [
    [box('.'), box('node_modules/a')], [box('node_modules/a'), box('node_modules/dep')],
  ].toSorted())
  assert.equal(traceDependencyChains(layout, null), null)
})

test('long dependency chains do not recurse and repeated diamonds do not enumerate paths', () => {
  const links = [], modules = { '.': {} }
  let previous = ['.']
  for (let i = 0; i < 1000; i++) {
    const current = [`node_modules/a${i}`, `node_modules/b${i}`]
    for (const id of current) { modules[id] = dep(id); for (const from of previous) links.push([from, id]) }
    previous = current
  }
  modules['node_modules/dep'] = dep('dep')
  for (const from of previous) links.push([from, 'node_modules/dep'])
  const graph = bundleDependencyChains(fixture({ modules, links }), query), layout = layoutDependencyChains(graph)
  assert.equal(graph.nodes.size, 2002)
  assert.equal(layout.boxes.length, 2002)
  assert.equal(layout.edges.length, 4000)
})
