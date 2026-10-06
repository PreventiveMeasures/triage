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

function assertExternalPathClear(commands, cards, layout) {
  let point = commands[0].values
  for (const { command, values } of commands.slice(1)) {
    const end = values.slice(-2), start = point
    for (let step = 0; step <= 12; step++) {
      const t = step / 12
      const [x, y] = end.map((value, axis) => command === 'Q'
        ? (1 - t) ** 2 * start[axis] + 2 * (1 - t) * t * values[axis] + t ** 2 * value
        : start[axis] + t * (value - start[axis]))
      assert.ok(x >= 0 && x <= layout.width && y >= 0 && y <= layout.height)
      assert.ok(cards.every(card => x <= card.x || x >= card.x + card.w || y <= card.y || y >= card.y + card.h), 'external arrows stay outside every card')
    }
    point = end
  }
}

test('external arrows retain exact package endpoints through cycle expansion without crossing cards', () => {
  const h = DEPENDENCY_CARD_HEIGHT, w = DEPENDENCY_CARD_WIDTH
  for (const count of [7, 11, 190]) {
    const ids = Array.from({ length: count }, (_, i) => `source-${i}`), targets = ['dest-a', 'dest-b', 'dest-c']
    const imports = new Map([
      ['app', new Set([ids[0], 'short'])], ['short', new Set(['target'])], ['target', new Set()],
      ...[ids, targets].flatMap(group => group.map((id, i) => [id, new Set([group[(i + 1) % group.length]])])),
    ])
    imports.get(ids[0]).add(targets[0]).add(targets[1])
    imports.get(ids[1]).add(targets[0])
    imports.get(targets[2]).add('target')
    const graph = { nodes: new Map([...imports.keys()].map(id => [id, { id }])), imports }
    const initial = layoutDependencyChains(graph)
    for (const [maxWidth, expand] of [1280, 600, 375].flatMap(width => [false, true].map(open => [width, open]))) {
      const layout = layoutDependencyChains(graph, { maxWidth, expandedCycles: new Set(expand ? initial.boxes.map(box => box.id) : []) })
      assert.equal(layout.edges.length, 7, 'separate imports between the same two cycles are never merged')
      const sharedTarget = layout.edges.filter(edge => edge.toPackage === targets[0])
      assert.notEqual(sharedTarget[0].path.split(' L').at(-1), sharedTarget[1].path.split(' L').at(-1), 'direct importers get distinct arrowheads')
      assert.deepEqual(layout.edges.map(({ fromPackage, toPackage }) => [fromPackage, toPackage]), initial.edges.map(({ fromPackage, toPackage }) => [fromPackage, toPackage]))
      const boxes = new Map(layout.boxes.map(box => [box.id, box]))
      const cards = layout.boxes.flatMap(box => box.collapsed ? [{ x: box.x, y: box.y, w: box.width, h: box.height }]
        : box.packages.map(node => ({ x: box.x + node.x, y: box.y + node.y, w, h })))
      for (const edge of layout.edges) {
        const from = boxes.get(edge.from), to = boxes.get(edge.to)
        const a = from.packages.find(node => node.id === edge.fromPackage), b = to.packages.find(node => node.id === edge.toPackage)
        const commands = [...edge.path.matchAll(/([MLQ])([\d.,-]+)/gu)].map(([, command, args]) => ({ command, values: args.split(',').map(Number) }))
        const [sx, sy] = commands[0].values, [tx, ty] = commands.at(-1).values
        if (from.collapsed || from.members.length === 1) {
          assert.equal(sy, from.y + from.height)
          assert.ok(sx > from.x && sx < from.x + from.width)
        } else assert.deepEqual([sx, sy], [from.x + a.x + w, from.y + a.y + h / 2])
        if (to.collapsed || to.members.length === 1) {
          assert.equal(ty, to.y - 5)
          assert.ok(tx > to.x && tx < to.x + to.width)
        } else {
          assert.equal(tx, to.x + b.x - 4)
          assert.ok(ty > to.y + b.y && ty < to.y + b.y + h)
        }
        assertExternalPathClear(commands, cards, layout)
      }
    }
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
  const expandedCycles = new Set(layoutDependencyChains(graph).boxes.map(box => box.id))
  for (const [maxWidth, columns] of [[1280, 5], [900, 3], [600, 2], [375, 1]]) {
    const layout = layoutDependencyChains(graph, { maxWidth, expandedCycles })
    assert.equal(layout.boxes.length, 1)
    const box = layout.boxes[0]
    assert.equal(box.packages.length, 190)
    assert.equal(new Set(box.packages.map(node => node.x)).size, columns)
    assert.equal(box.internalEdges.length, edgeCount, 'resizing preserves all connections')
    assert.ok(layout.width + DEPENDENCY_DIALOG_GUTTER <= maxWidth, 'all columns fit inside the dialog')
    assert.ok(box.packages.every(node => node.x + DEPENDENCY_CARD_WIDTH <= box.width && node.y + DEPENDENCY_CARD_HEIGHT <= box.height))
  }
})

test('only cycles larger than ten start collapsed, and expansion preserves their chains', () => {
  for (const count of [2, 8, 10, 11, 40, 190]) {
    const ids = Array.from({ length: count }, (_, i) => `package-${i}`)
    const imports = new Map([['app', new Set([ids[0]])], ...ids.map((id, i) => [id, new Set([ids[(i + 1) % count]])])])
    imports.get(ids[0]).add('target')
    const graph = { nodes: new Map(['app', ...ids, 'target'].map(id => [id, { id }])), imports }
    const initial = layoutDependencyChains(graph)
    const group = initial.boxes.find(box => box.members.length === count)
    assert.equal(group.collapsed, count > 10)
    assert.equal(group.collapsible, count > 10)
    assert.equal(group.packages.length, count > 10 ? 0 : count)
    const expanded = layoutDependencyChains(graph, { expandedCycles: new Set([group.id]) })
    const opened = expanded.boxes.find(box => box.id === group.id)
    assert.equal(opened.packages.length, count)
    assert.equal(opened.internalEdges.length, count)
    assert.deepEqual(initial.edges.map(({ from, to }) => [from, to]), expanded.edges.map(({ from, to }) => [from, to]))
    assert.deepEqual(initial.componentOf, expanded.componentOf)
    if (count > 10) {
      assert.ok(initial.height < expanded.height, 'collapsed groups free space for the rest of the chain')
      assert.ok(initial.boxes.find(box => box.members.includes('target')).y < expanded.boxes.find(box => box.members.includes('target')).y)
    }
    assert.deepEqual(layoutDependencyChains(graph), initial, 'collapsing restores the compact layout')
  }
})

test('discovery-only branches are neither followed nor drawn, while ordinary imports between the same packages remain', async () => {
  for (const [count, ordinary] of [7, 11, 190].flatMap(size => [false, true].map(include => [size, include]))) {
    const core = 'node_modules/@babel/core/lib/config/files/plugins.js'
    const paths = [core, ...Array.from({ length: count - 1 }, (_, i) => `node_modules/helper-${i}/index.js`)]
    const modules = new Map([
      ['.', { name: 'app', files: { 'index.js': 'app' } }],
      ['node_modules/bridge', { ...dep('bridge'), files: { 'index.js': 'bridge', 'babel.config.js': 'config' } }],
      ['node_modules/dep', { ...dep('dep'), files: { 'index.js': 'dep', 'babel.config.js': 'config' } }],
      ['node_modules/@babel/core', { ...dep('@babel/core'), files: { 'lib/config/files/plugins.js': 'loader' } }],
      ...paths.slice(1).map((path, i) => [path.slice(0, -'/index.js'.length), { ...dep(`helper-${i}`), files: { 'index.js': 'helper' } }]),
    ])
    const imports = new Map([
      ['index.js', new Map([['dep', 'node_modules/dep/index.js'], ['bridge', 'node_modules/bridge/index.js']])],
      ['node_modules/bridge/index.js', new Map([['core', core]])],
      ...paths.map((path, i) => [path, new Map([['next', paths[(i + 1) % count]]])]),
    ])
    imports.get(core).set('config', 'node_modules/dep/babel.config.js')
    imports.get(core).set('return', 'node_modules/bridge/babel.config.js')
    if (ordinary) imports.get(core).set('dep', 'node_modules/dep/index.js')
    const details = { kind: 'stasis', integrity: `discovery-${count}-${ordinary}`, size: 1, bundle: new Bundle({ config: { scope: 'full' }, modules, imports: new Map([['node,import', imports]]) }) }
    const metadata = parseBundleMetadata(await createBundleMetadata(details), details.integrity)
    for (const input of [details, metadata]) {
      const graph = bundleDependencyChains(input, query)
      assert.equal(graph.imports.get('node_modules/dep').size, 0)
      assert.equal(graph.nodes.has('node_modules/@babel/core'), ordinary, 'do not follow discovery-only importers')
      assert.equal(graph.nodes.has('node_modules/bridge'), ordinary, 'do not follow their ancestors either')
      assert.deepEqual(graph.importedBy.get('node_modules/dep'), new Set(ordinary ? ['.', 'node_modules/@babel/core'] : ['.']))
      const initial = layoutDependencyChains(graph)
      const groupId = initial.componentOf.get('node_modules/@babel/core')
      for (const maxWidth of [1280, 600, 375]) {for (const expandedCycles of [new Set(), new Set([groupId])]) {
        const result = layoutDependencyChains(graph, { maxWidth, expandedCycles })
        assert.equal(result.edges.length, ordinary ? 4 : 1)
        assert.equal(result.boxes.length, ordinary ? 4 : 2)
        assert.ok(result.edges.every(edge => {
          const from = result.boxes.find(box => box.id === edge.from), to = result.boxes.find(box => box.id === edge.to)
          return from.y + from.height < to.y
        }), 'external imports always point to a later row, including expanded cycles')
      }}
    }
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
