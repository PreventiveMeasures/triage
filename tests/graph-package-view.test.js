// `ui/view/graph/data.js` — `buildPackageGraph` derives the
// package-level graph behind the bundle Graph tab's "Packages"
// toggle: one node per package with aggregated finding / size /
// file counts, and one edge per connected package pair with
// directional flags + the number of file-level imports collapsed
// into it. The mapping under test that's easiest to get wrong:
// file edges store direction in lo/hi FILE-path order, while
// package edges store it in lo/hi PACKAGE-name order, and the two
// orders can disagree (an own-source dir sorting after a
// node_modules path whose package name sorts before it).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// data.js → utils.js → format.js → frontend-global.js throws at
// module load when the `@rray/frontend` slot isn't installed. Tests
// don't run the boot path that installs it, so stub it before the
// import chain evaluates; buildPackageGraph never calls any of
// these symbols.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const { buildGraph, buildPackageGraph } = await import('../ui/view/graph/data.js')
const { bundlePkgOf } = await import('../ui/view/bundle-pkg-of.js')

function graphFrom(treeData, { ownCounts = new Map(), splitOwnDirs = false } = {}) {
  const files = Object.keys(treeData)
  return buildGraph(treeData, files, ownCounts, null, null, null, null, {
    pkgOf: (p) => bundlePkgOf(p, { splitOwnDirs }),
  })
}

describe('buildPackageGraph', () => {
  // src/{a,b} → __own__; x and y under node_modules. Cross imports:
  //   a → x, b → x        (2 file links own → x)
  //   b → y               (1 file link own → y)
  //   x/i → y/i, y/u → x/i (bidirectional x ↔ y pair)
  const tree = {
    'src/a.js': { imports: ['src/b.js', 'node_modules/x/i.js'], size: 100 },
    'src/b.js': { imports: ['node_modules/x/i.js', 'node_modules/y/i.js'], size: 50 },
    'node_modules/x/i.js': { imports: ['node_modules/y/i.js'], size: 1000 },
    'node_modules/y/i.js': { imports: [] },
    'node_modules/y/u.js': { imports: ['node_modules/x/i.js'] },
  }

  it('aggregates one node per package with file counts and sizes', () => {
    const pg = buildPackageGraph(graphFrom(tree))
    assert.deepEqual(
      [...pg.byPkg.keys()].toSorted(),
      ['__own__', 'x', 'y'],
    )
    assert.equal(pg.byPkg.get('__own__').fileCount, 2)
    assert.equal(pg.byPkg.get('__own__').label, 'own source')
    assert.equal(pg.byPkg.get('__own__').size, 150)
    assert.equal(pg.byPkg.get('x').size, 1000)
    // y's files carry no `size` at all — null, not 0, so the
    // tooltip's byte readout hides instead of claiming "0 B".
    assert.equal(pg.byPkg.get('y').size, null)
  })

  it('collapses file links into per-pair edges with counts and directions', () => {
    const pg = buildPackageGraph(graphFrom(tree))
    const byPair = new Map(pg.edges.map((e) => [`${e.a}->${e.b}`, e]))
    assert.equal(pg.edges.length, 3)

    const ownX = byPair.get('__own__->x')
    assert.equal(ownX.count, 2)
    assert.equal(ownX.fromLo, true)   // own imports into x…
    assert.equal(ownX.fromHi, false)  // …never the reverse

    const ownY = byPair.get('__own__->y')
    assert.equal(ownY.count, 1)
    assert.equal(ownY.fromLo, true)
    assert.equal(ownY.fromHi, false)

    const xy = byPair.get('x->y')
    assert.equal(xy.count, 2)
    assert.equal(xy.fromLo, true)     // x → y
    assert.equal(xy.fromHi, true)     // and y → x: bidirectional

    // deg = distinct connected packages.
    assert.equal(pg.byPkg.get('__own__').deg, 2)
    assert.equal(pg.byPkg.get('x').deg, 2)
    assert.equal(pg.byPkg.get('y').deg, 2)
  })

  it('exposes a directed importsOf map for the layout solver', () => {
    const pg = buildPackageGraph(graphFrom(tree))
    assert.deepEqual(pg.importsOf.get('__own__').toSorted(), ['x', 'y'])
    assert.deepEqual(pg.importsOf.get('x'), ['y'])
    assert.deepEqual(pg.importsOf.get('y'), ['x'])
  })

  it('sums per-severity finding counts and derives the top tier', () => {
    const ownCounts = new Map([
      ['src/a.js', { medium: 1 }],
      ['src/b.js', { medium: 2, low: 1 }],
      ['node_modules/x/i.js', { low: 4 }],
    ])
    const pg = buildPackageGraph(graphFrom(tree, { ownCounts }))
    const own = pg.byPkg.get('__own__')
    assert.equal(own.own.medium, 3)
    assert.equal(own.own.low, 1)
    assert.equal(own.totalIssues, 4)
    assert.equal(own.issue, 'medium')
    assert.equal(pg.byPkg.get('x').issue, 'low')
    assert.equal(pg.byPkg.get('y').issue, null)
    assert.equal(pg.byPkg.get('y').totalIssues, 0)
  })

  it('maps direction flags when package order disagrees with file order', () => {
    // File order: 'b/x.js' < 'node_modules/a/x.js' (lo = the b-pkg
    // file), but package order: 'a' < 'b' (lo = a). The import
    // b → a must land as fromHi on the package edge, not fromLo.
    const pg = buildPackageGraph(graphFrom({
      'b/x.js': { imports: ['node_modules/a/x.js'] },
      'node_modules/a/x.js': { imports: [] },
    }, { splitOwnDirs: true }))
    assert.equal(pg.edges.length, 1)
    const e = pg.edges[0]
    assert.equal(e.a, 'a')
    assert.equal(e.b, 'b')
    assert.equal(e.fromLo, false)
    assert.equal(e.fromHi, true)
    assert.deepEqual(pg.importsOf.get('b'), ['a'])
    assert.deepEqual(pg.importsOf.get('a'), [])
  })

  it('keeps intra-package imports out of the package edges', () => {
    const pg = buildPackageGraph(graphFrom({
      'src/a.js': { imports: ['src/b.js'] },
      'src/b.js': { imports: [] },
    }))
    assert.equal(pg.edges.length, 0)
    assert.equal(pg.byPkg.get('__own__').deg, 0)
  })
})
