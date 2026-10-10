import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import { assignHubs, buildGraph } from '../ui/view/graph/data.js'
import { layoutSpiral } from '../ui/view/graph/layout.js'

const H = 640, W = 1000

// A Metro-like capture: an Expo entry in node_modules imports the app, a few
// large dependencies, and hundreds of native packages nothing imports.
function metro(app = 'src', natives = 600) {
  const tree = { 'node_modules/expo/AppEntry.js': { size: 1, imports: [`${app}/App.js`] } }
  for (let i = 0; i < 3000; i++) tree[i ? `${app}/f${i}.js` : `${app}/App.js`] = { size: 1, imports: [`node_modules/dep${i % 5}/f${i % 50}.js`] }
  for (let d = 0; d < 5; d++) for (let i = 0; i < 800 + d * 200; i++) tree[`node_modules/dep${d}/f${i}.js`] = { size: 1, imports: [] }
  for (let n = 0; n < natives; n++) for (let i = 0; i < 10; i++) tree[`node_modules/native${n}/f${i}.js`] = { size: 1, imports: [] }
  const pkgOf = file => file.match(/node_modules\/([^/]+)/u)?.[1] ?? (file.startsWith('src/') ? '__own__' : file.split('/')[0])
  const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf })
  assignHubs(graph)
  layoutSpiral(graph, W, H)
  return graph
}

// Each package's files as a disk: their centroid and farthest file.
function disks(graph) {
  return [...graph.byPkg].map(([pkg, nodes]) => {
    const x = nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length, y = nodes.reduce((sum, n) => sum + n.y, 0) / nodes.length
    return { pkg, x, y, r: Math.max(...nodes.map(n => Math.hypot(n.x - x, n.y - y))) }
  })
}

test('own source sits at the center even when an entry in node_modules imports it', () => {
  const own = disks(metro()).find(disk => disk.pkg === '__own__')
  assert.ok(Math.hypot(own.x - W / 2, own.y - H / 2) < 1, 'not a native package nothing imports')

  const graph = metro('app', 50)
  graph.ownSourcePackages = new Set(['app'])
  graph.entryPackages = new Set(['app'])
  layoutSpiral(graph, W, H)
  const app = disks(graph).find(disk => disk.pkg === 'app')
  assert.ok(Math.hypot(app.x - W / 2, app.y - H / 2) < 1, 'workspace packages count as own source')
})

test('package disks never overlap, even when a native package takes the center', () => {
  // Without recorded own source the center falls back to a package nothing
  // imports, and the large app package competes for inner ring slots.
  for (const graph of [metro(), metro('app')]) {
    const all = disks(graph)
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j]
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r - 1, `${a.pkg} overlaps ${b.pkg}`)
      }
    }
  }
})
