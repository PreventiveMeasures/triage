import assert from 'node:assert/strict'
import { it } from 'node:test'
import { bundleGraphPackageOf, bundleGraphReasons, bundleImportsAsMap, bundleLayerRoots, filterBundleGraphReason } from '../ui/view/bundle-graph-inputs.js'
import { bundlePkgOf } from '../ui/view/bundle-pkg-of.js'
import { Bundle } from '@exodus/stasis-core/bundle'

function inputs({ dirs, entries = [], imports = {}, splitOwnDirs = false }) {
  const details = { kind: 'stasis', bundle: {
    entries: new Set(entries),
    imports: new Map([['node,import', new Map(Object.entries(imports).map(([p, targets]) => [p, new Map(Object.entries(targets))]))]]),
  } }
  const paths = new Map(Object.keys(dirs).map((p) => [p, p]))
  const packageDirs = new Map(Object.entries(dirs))
  const pkgOf = (p) => bundlePkgOf(p, { splitOwnDirs, packageDir: packageDirs.get(p) })
  return bundleLayerRoots(details, paths, pkgOf, packageDirs)
}

it('classifies dependencies before display-prefix stripping and own directories afterwards', () => {
  assert.equal(bundleGraphPackageOf('a/index.js', 'node_modules/a/index.js'), 'a')
  assert.equal(bundleGraphPackageOf('index.js', 'node_modules/a/index.js'), 'a')
  assert.equal(bundleGraphPackageOf('src/index.js', 'project/src/index.js', { splitOwnDirs: true }), 'src')
  assert.equal(bundleGraphPackageOf('src/index.js', 'project/src/index.js'), '__own__')
})

it('recognizes app/ as the root without explicit entry metadata', () => {
  assert.deepEqual(inputs({
    dirs: { 'app/index.js': 'app', 'node_modules/a/index.js': 'node_modules/a' },
    imports: { 'app/index.js': { a: 'node_modules/a/index.js' }, 'node_modules/a/index.js': { app: 'app/index.js' } },
  }), { roots: ['app'], appImports: [] })
})

it('keeps every split app directory at the root, with or without entries or package metadata', () => {
  for (const packageDir of ['.', undefined]) {
    for (const entries of [[], ['src/main.js']]) {
      const options = {
        dirs: { 'src/main.js': packageDir, 'lib/helper.js': packageDir, 'index.js': packageDir, 'node_modules/dep/index.js': 'node_modules/dep' },
        imports: { 'src/main.js': { helper: 'lib/helper.js' }, 'lib/helper.js': { dep: 'node_modules/dep/index.js', back: 'src/main.js' } },
        entries,
      }
      assert.deepEqual(inputs(options).roots, ['__own__'])
      assert.deepEqual(inputs({ ...options, splitOwnDirs: true }).roots, ['src', 'lib', '__own__'])
    }
  }
})

it('uses entry packages even when a workspace dependency points back to the app', () => {
  assert.deepEqual(inputs({
    dirs: { 'apps/web/main.js': 'apps/web', 'packages/common/index.js': 'packages/common' },
    entries: ['apps/web/main.js'],
    imports: { 'apps/web/main.js': { common: 'packages/common/index.js' }, 'packages/common/index.js': { app: 'apps/web/main.js' } },
  }).roots, ['apps/web'])
})

it('keeps other workspace packages at their dependency level when inferring the app', () => {
  assert.deepEqual(inputs({
    dirs: { 'app/index.js': 'app', 'packages/common/index.js': 'packages/common', 'vendor/a/index.php': 'vendor/a' },
    imports: { 'app/index.js': { common: 'packages/common/index.js', vendor: 'vendor/a/index.php' } },
  }).roots, ['app'])
})

it('retains recorded app imports when app source is excluded from the bundle', () => {
  assert.deepEqual(inputs({
    dirs: { 'node_modules/a/index.js': 'node_modules/a', 'node_modules/b/index.js': 'node_modules/b' },
    imports: { 'app/index.js': { a: 'node_modules/a/index.js' }, 'node_modules/missing/index.js': { b: 'node_modules/b/index.js' } },
  }), { roots: ['__own__'], appImports: ['a'] })
})

it('does not pretend a dependency-only bundle has a known app when importer data is absent', () => {
  assert.deepEqual(inputs({ dirs: { 'node_modules/a/index.js': 'node_modules/a' } }), { roots: [], appImports: [] })
})

it('collects platform-specific resolutions as well as ordinary imports', () => {
  const details = { kind: 'stasis', bundle: { imports: new Map([
    ['default', new Map([['app/index.js', new Map([
      ['a', 'node_modules/a/index.js'],
      ['platform', new Map([['ios', 'node_modules/b/ios.js'], ['android', 'node_modules/b/android.js']])],
    ])]])],
  ]) } }
  assert.deepEqual([...bundleImportsAsMap(details).get('app/index.js')], ['node_modules/a/index.js', 'node_modules/b/ios.js', 'node_modules/b/android.js'])
  assert.equal(bundleImportsAsMap({ kind: 'sourcemap' }).size, 0)
})

it('reads reason metadata using the installed Stasis parser, including a single reason', () => {
  const original = new Bundle({ modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'index.js': 'export {}' } }]]) }).withReason('run')
  const bundle = Bundle.parse(original.serialize())
  const reasons = bundleGraphReasons({ kind: 'stasis', bundle }, bundle.sources.keys())
  assert.deepEqual([...reasons], [['run', new Set(['index.js'])]])
  assert.equal(bundleGraphReasons({ kind: 'sourcemap' }, ['index.js']).size, 0)
})

it('ignores malformed and unavailable reason files and preserves shared membership', () => {
  const reasons = bundleGraphReasons({ kind: 'stasis', bundle: { reason: {
    run: ['app.js', 'shared.js', 'shared.js', 2, '../missing'],
    build: ['shared.js'], broken: 'app.js', missing: ['not-bundled.js'],
  } } }, ['app.js', 'shared.js'])
  assert.deepEqual([...reasons], [['build', new Set(['shared.js'])], ['run', new Set(['app.js', 'shared.js'])]])
})

it('filters both nodes and edges by reason while preserving original-path mapping and bytes', () => {
  const tree = {
    'app.js': { imports: ['run.js', 'build.js', 'shared.js'], size: 100 },
    'run.js': { imports: ['shared.js'], size: 200 },
    'build.js': { imports: ['shared.js'], size: 300 },
    'shared.js': { imports: [], size: 50 },
    'unattributed.js': { imports: [], size: 25 },
  }
  const paths = new Map(Object.keys(tree).map((p) => [`project/${p}`, p]))
  const reasons = new Map([
    ['run', new Set(['project/app.js', 'project/run.js', 'project/shared.js'])],
    ['build', new Set(['project/app.js', 'project/build.js', 'project/shared.js'])],
  ])
  const before = structuredClone({ tree, paths, reasons })
  const filtered = filterBundleGraphReason(tree, paths, reasons, 'run')
  assert.equal(filtered.selected, 'run')
  assert.deepEqual(Object.keys(filtered.tree), ['app.js', 'run.js', 'shared.js'])
  assert.deepEqual(filtered.tree['app.js'].imports, ['run.js', 'shared.js'])
  assert.equal(Object.values(filtered.tree).reduce((sum, file) => sum + file.size, 0), 350)
  assert.deepEqual([...filtered.origToStripped], [['project/app.js', 'app.js'], ['project/run.js', 'run.js'], ['project/shared.js', 'shared.js']])
  assert.deepEqual({ tree, paths, reasons }, before)
  for (const reason of [null, 'not-present']) {
    const all = filterBundleGraphReason(tree, paths, reasons, reason)
    assert.equal(all.tree, tree)
    assert.equal(all.selected, null)
  }
  const single = filterBundleGraphReason(tree, paths, new Map([['build', reasons.get('build')]]), 'build')
  assert.equal(single.selected, 'build')
  assert.deepEqual(Object.keys(single.tree), ['app.js', 'build.js', 'shared.js'])
  assert.equal(filterBundleGraphReason(tree, paths, new Map(), 'build').selected, null)
})

it('does not restore reason-excluded app imports as virtual connections', () => {
  const tree = {
    'src/run.js': { imports: [], size: 100 },
    'src/build.js': { imports: ['node_modules/dep/index.js'], size: 200 },
    'node_modules/dep/index.js': { imports: [], size: 300 },
    'node_modules/other/index.js': { imports: [], size: 400 },
  }
  const paths = new Map(Object.keys(tree).map((p) => [`project/${p}`, p]))
  const imports = new Map([
    ['project/src/build.js', new Map([['dep', 'project/node_modules/dep/index.js']])],
  ])
  const details = { kind: 'stasis', bundle: {
    imports: new Map([['default', imports]]),
    entries: new Set(['project/src/build.js']),
  } }
  const pkgOf = (p) => bundlePkgOf(p, { splitOwnDirs: false })
  const reasons = new Map([
    ['run', new Set(['project/src/run.js', 'project/node_modules/dep/index.js'])],
    ['deps', new Set(['project/node_modules/dep/index.js'])],
  ])
  for (const reason of reasons.keys()) {
    const filtered = filterBundleGraphReason(tree, paths, reasons, reason)
    assert.deepEqual(bundleLayerRoots(details, filtered.origToStripped, pkgOf, undefined, paths), {
      roots: reason === 'run' ? ['__own__'] : [], appImports: [],
    })
  }

  // Source truly absent from the bundle can still supply virtual edges,
  // but only to targets retained by the reason filter.
  imports.set('project/absent.js', new Map([
    ['dep', 'project/node_modules/dep/index.js'],
    ['other', 'project/node_modules/other/index.js'],
  ]))
  const filtered = filterBundleGraphReason(tree, paths, reasons, 'deps')
  assert.deepEqual(bundleLayerRoots(details, filtered.origToStripped, pkgOf, undefined, paths), {
    roots: ['__own__'], appImports: ['dep'],
  })
})
