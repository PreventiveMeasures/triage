import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleSourcesAsMap } from '../common/bundle-sources.js'
import { buildBundleSourceTree, bundleSourceTreePrefix, compactSourceDirectory, filterBundleSourceTree, sourceDirectoryLabel } from '../ui/view/bundle-source-tree.js'

test('display paths retain original source keys, including special directory names', () => {
  const tree = buildBundleSourceTree(['src/a.js', 'src/b.ts', '__proto__/c.js'], ['/repo/src/a.js', '/repo/src/b.ts', '/repo/__proto__/c.js'])
  assert.deepEqual([...tree.dirs.get('src').files], [['a.js', '/repo/src/a.js'], ['b.ts', '/repo/src/b.ts']])
  assert.equal(tree.dirs.get('__proto__').files.get('c.js'), '/repo/__proto__/c.js')
})

test('compacts short directory chains without changing the tree or losing files', () => {
  const tree = buildBundleSourceTree(['src/lib/util/a.js', 'src/lib/util/b.js'])
  const src = tree.dirs.get('src')
  const compact = compactSourceDirectory('src', src, 0)
  assert.deepEqual(compact.names, ['src', 'lib', 'util'])
  assert.deepEqual([...compact.node.files.values()], ['src/lib/util/a.js', 'src/lib/util/b.js'])
  assert.ok(src.dirs.has('lib'), 'compaction must not mutate the search tree')
})

test('preserves branching directories and directories that contain their own files', () => {
  const tree = buildBundleSourceTree(['src/lib/a.js', 'src/test/b.js', 'app/index.js', 'app/lib/c.js'])
  assert.deepEqual(compactSourceDirectory('src', tree.dirs.get('src'), 0).names, ['src'])
  assert.deepEqual(compactSourceDirectory('app', tree.dirs.get('app'), 0).names, ['app'])
})

test('keeps long paths and package roots readable, and limits very short chains', () => {
  const tree = buildBundleSourceTree(['has-symbols@1.1.0/node_modules/has-symbols/index.js', 'a/b/c/d/e.js', 'src/very-long-directory-name/deep/a.js'])
  const pkg = tree.dirs.get('has-symbols@1.1.0')
  assert.deepEqual(compactSourceDirectory('has-symbols@1.1.0', pkg, 0).names, ['has-symbols@1.1.0'])
  assert.deepEqual(compactSourceDirectory('node_modules', pkg.dirs.get('node_modules'), 1).names, ['node_modules'])
  assert.deepEqual(compactSourceDirectory('a', tree.dirs.get('a'), 0).names, ['a', 'b', 'c'])
  assert.deepEqual(compactSourceDirectory('src', tree.dirs.get('src'), 0).names, ['src'])
})

function leaves(node) {
  return [...node.files.values(), ...[...node.dirs.values()].flatMap(child => leaves(child))].toSorted()
}

function pnpmStore(tree) {
  return tree.dirs.get('node_modules').dirs.get('.pnpm')
}

test('pnpm installs present one package row with a version and physical path', () => {
  const paths = [
    'node_modules/.pnpm/@noble+ciphers@2.2.0/node_modules/@noble/ciphers/aes.js',
    'node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/buffer-util.js',
    'node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/constants.js',
  ]
  const originals = paths.map(path => `/repo/${path}`)
  const tree = buildBundleSourceTree(paths, originals)
  const store = pnpmStore(tree)
  const scoped = store.dirs.get('@noble+ciphers@2.2.0')
  assert.equal(sourceDirectoryLabel('@noble+ciphers@2.2.0', scoped), '@noble/ciphers@2.2.0')
  assert.equal(scoped.path, 'node_modules/.pnpm/@noble+ciphers@2.2.0/node_modules/@noble/ciphers')
  assert.equal(scoped.sourcePath, `/repo/${scoped.path}`)
  assert.equal(scoped.files.get('aes.js'), originals[0])
  const ws = store.dirs.get('ws@8.20.0')
  assert.deepEqual(ws.package, { name: 'ws', version: '8.20.0' })
  assert.ok(ws.dirs.has('lib'))
  assert.equal(compactSourceDirectory('ws@8.20.0', ws, 1).node, ws, 'never join package and content roots')
  assert.deepEqual(compactSourceDirectory('node_modules', tree.dirs.get('node_modules'), 0).names, ['node_modules', '.pnpm'])
  assert.deepEqual(leaves(tree), originals.toSorted(), 'every source appears exactly once')
})

test('ordinary and nested node_modules keep scoped packages together and package boundaries intact', () => {
  const paths = [
    'node_modules/@scope/one/lib/a.js',
    'node_modules/@scope/two/b.js',
    'node_modules/ws/lib/a.js',
    'node_modules/ws/node_modules/@scope/one/index.js',
    'src/node_modules/local/lib/c.js',
  ]
  const tree = buildBundleSourceTree(paths)
  const modules = tree.dirs.get('node_modules')
  assert.deepEqual([...modules.dirs.keys()], ['@scope/one', '@scope/two', 'ws'])
  const one = modules.dirs.get('@scope/one')
  assert.equal(one.package.name, '@scope/one')
  assert.equal(compactSourceDirectory('@scope/one', one, 1).node, one)
  assert.ok(modules.dirs.get('ws').dirs.get('node_modules').dirs.has('@scope/one'))
  assert.deepEqual(compactSourceDirectory('src', tree.dirs.get('src'), 0).names, ['src'])
  assert.deepEqual(leaves(tree), paths.toSorted())
})

test('versions and peer/hash variants remain distinct and stable through filtering', () => {
  const base = 'node_modules/.pnpm/'
  const ids = ['foo@2.0.0', 'foo@1.0.0(react@19.0.0)', 'foo@1.0.0(react@18.0.0)', 'foo@1.0.0', 'foo@1.0.0_hash']
  const paths = ids.map(id => `${base}${id}/node_modules/foo/index.js`)
  const tree = buildBundleSourceTree(paths)
  const store = pnpmStore(tree)
  assert.equal(store.dirs.size, 5)
  assert.equal(store.dirs.get('foo@2.0.0').package.variant, undefined)
  assert.equal(new Set([...store.dirs.values()].filter(n => n.package.version === '1.0.0').map(n => n.package.variant)).size, 4)
  const filtered = pnpmStore(filterBundleSourceTree(tree, 'react@19'))
  assert.equal(filtered.dirs.size, 1)
  assert.equal(filtered.dirs.get(ids[1]).package.variant, store.dirs.get(ids[1]).package.variant)
  const reversed = pnpmStore(buildBundleSourceTree(paths.toReversed()))
  assert.deepEqual([...store.dirs].map(([id, n]) => [id, n.package.variant]).toSorted(), [...reversed.dirs].map(([id, n]) => [id, n.package.variant]).toSorted())
  assert.deepEqual(leaves(tree), paths.toSorted())
})

test('unfamiliar or nonempty pnpm wrappers preserve every file and sibling', () => {
  const base = 'node_modules/.pnpm/'
  const paths = [
    `${base}foo@1.0.0/node_modules/foo/a.js`,
    `${base}foo@1.0.0/patch.js`,
    `${base}bar@1.0.0/node_modules/bar/b.js`,
    `${base}bar@1.0.0/node_modules/other/c.js`,
    `${base}alias@1.0.0/node_modules/real/d.js`,
    `${base}git-snapshot/node_modules/foo/e.js`,
    `${base}foo@next/node_modules/foo/f.js`,
    `${base}@scope+pkg@1.0.0/node_modules/@scope/pkg/g.js`,
    `${base}@scope+pkg@1.0.0/node_modules/@scope/extra.js`,
    `${base}lock.js`,
  ]
  const tree = buildBundleSourceTree(paths)
  for (const entry of pnpmStore(tree).dirs.values()) assert.equal(entry.package, undefined)
  assert.deepEqual(leaves(tree), paths.toSorted())
  const filtered = pnpmStore(filterBundleSourceTree(tree, 'a.js'))
  assert.equal(filtered.dirs.get('foo@1.0.0').package, undefined, 'filtering must not hide evidence of a nonstandard wrapper')
  assert.ok(filtered.dirs.get('foo@1.0.0').dirs.has('node_modules'))
})

test('file filtering accepts displayed scoped names with versions and original storage paths', () => {
  const paths = [
    'node_modules/.pnpm/@noble+ciphers@2.2.0/node_modules/@noble/ciphers/aes.js',
    'node_modules/.pnpm/@noble+ciphers@2.2.0/node_modules/@noble/ciphers/utils.js',
    'src/index.js',
  ]
  const originals = paths.map(path => `/repo/${path}`)
  const tree = buildBundleSourceTree(paths, originals)
  for (const query of ['@NOBLE/CIPHERS@2.2.0', '@noble+ciphers@2.2.0']) {
    assert.deepEqual(leaves(filterBundleSourceTree(tree, query, '/repo/')), originals.slice(0, 2).toSorted())
  }
  assert.deepEqual(leaves(filterBundleSourceTree(tree, '@noble/ciphers@2.2.0/aes.js')), [originals[0]])
  assert.equal(filterBundleSourceTree(tree, 'missing'), null)
  assert.equal(filterBundleSourceTree(tree, '/repo/', '/repo/'), null, 'the shared prefix is not searchable in the rail')
  assert.equal(filterBundleSourceTree(tree, ''), tree)
})

test('common prefixes stop before dependency identities; absolute physical keys stay intact', () => {
  for (const suffix of ['', '.pnpm/', '.pnpm/ws@8.20.0/node_modules/ws/lib/', '@scope/pkg/lib/']) {
    assert.equal(bundleSourceTreePrefix(`/repo/node_modules/${suffix}`), '/repo/')
    assert.equal(bundleSourceTreePrefix(`node_modules/${suffix}`), '')
  }
  assert.equal(bundleSourceTreePrefix('/repo/src/'), '/repo/src/')
  assert.equal(bundleSourceTreePrefix('my_node_modules/src/'), 'my_node_modules/src/')
  const tree = buildBundleSourceTree(['/repo/node_modules/pkg/a.js'])
  assert.equal(tree.dirs.get('').dirs.get('repo').dirs.get('node_modules').dirs.get('pkg').path, '/repo/node_modules/pkg')
})

test('a sibling file or directory at any skipped wrapper level opts out of the pnpm shortcut', () => {
  const entry = 'node_modules/.pnpm/@scope+pkg@1.2.3'
  const file = `${entry}/node_modules/@scope/pkg/lib/index.js`
  for (const level of [entry, `${entry}/node_modules`, `${entry}/node_modules/@scope`]) {
    for (const sibling of ['sibling.js', 'sibling/extra.js']) {
      const paths = [file, `${level}/${sibling}`]
      const tree = buildBundleSourceTree(paths)
      assert.equal(pnpmStore(tree).dirs.get('@scope+pkg@1.2.3').package, undefined, `${level}/${sibling}`)
      assert.deepEqual(leaves(tree), paths.toSorted())
    }
  }
  // Siblings outside the skipped chain (or inside the package) remain visible
  // without preventing the one safe package shortcut.
  for (const level of ['', 'node_modules/', 'node_modules/.pnpm/', `${entry}/node_modules/@scope/pkg/`]) {
    const paths = [file, `${level}sibling.js`, `${level}other/sibling.js`]
    const tree = buildBundleSourceTree(paths)
    assert.equal(pnpmStore(tree).dirs.get('@scope+pkg@1.2.3').package.name, '@scope/pkg')
    assert.deepEqual(leaves(tree), paths.toSorted())
  }
})

test('pnpm shortcuts apply recursively to workspace and nested package installs', () => {
  const outer = 'packages/app/node_modules/.pnpm/@scope+outer@1.2.3/node_modules/@scope/outer'
  const nested = `${outer}/node_modules/.pnpm/inner@4.5.6/node_modules/inner`
  const paths = [`${outer}/index.js`, `${nested}/lib/index.js`, 'packages/tools/node_modules/.pnpm/ws@8.20.0/node_modules/ws/index.js']
  const tree = buildBundleSourceTree(paths)
  const app = tree.dirs.get('packages').dirs.get('app')
  const outerPkg = pnpmStore(app).dirs.get('@scope+outer@1.2.3')
  assert.equal(outerPkg.package.name, '@scope/outer')
  const innerPkg = pnpmStore(outerPkg).dirs.get('inner@4.5.6')
  assert.deepEqual(innerPkg.package, { name: 'inner', version: '4.5.6' })
  assert.equal(innerPkg.path, nested)
  assert.equal(pnpmStore(tree.dirs.get('packages').dirs.get('tools')).dirs.get('ws@8.20.0').package.version, '8.20.0')
  assert.deepEqual(leaves(tree), paths.toSorted())
})

function cargoTree(files) {
  const bundle = Bundle.parse(new Bundle({ modules: new Map([
    ['vendor/ahash', { name: 'ahash', version: '0.8.12', ecosystem: 'cargo', files }],
  ]) }).serialize())
  const paths = [...bundle.sources.keys()]
  return buildBundleSourceTree(paths, paths, bundle.modules)
}

test('Cargo rows use recorded package identities and fold a sole src directory', () => {
  const tree = cargoTree({ 'src/lib.rs': 'lib', 'src/hash.rs': 'hash', 'src/deep/a.rs': 'deep' })
  const vendor = tree.dirs.get('vendor')
  const pkg = vendor.dirs.get('ahash')
  assert.deepEqual(pkg.package, { name: 'ahash', version: '0.8.12', ecosystem: 'cargo' })
  assert.equal(sourceDirectoryLabel('ahash', pkg), 'ahash - 0.8.12')
  assert.deepEqual(compactSourceDirectory('vendor', vendor, 0).names, ['vendor'], 'the package boundary keeps the vendor group visible')
  const compact = compactSourceDirectory('ahash', pkg, 1)
  assert.deepEqual(compact.names, ['ahash'])
  assert.deepEqual([...compact.node.files.keys()].toSorted(), ['hash.rs', 'lib.rs'])
  assert.ok(compact.node.dirs.has('deep'))
  assert.equal(compact.node.sourcePath, 'vendor/ahash/src', 'the tooltip includes the folded directory')
  assert.deepEqual(leaves(compact.node), leaves(pkg), 'flattening retains every original source key')
  assert.ok(pkg.dirs.has('src'), 'presentation must not mutate the captured tree')
})

test('Cargo src folding preserves root files and disambiguates duplicate names through filtering', () => {
  const tree = cargoTree({ 'Cargo.toml': 'manifest', 'lib.rs': 'root', 'src/lib.rs': 'source' })
  const pkg = tree.dirs.get('vendor').dirs.get('ahash')
  const compact = compactSourceDirectory('ahash', pkg, 1)
  assert.deepEqual([...compact.node.files.keys()].toSorted(), ['Cargo.toml', 'lib.rs', 'src/lib.rs'])
  assert.deepEqual(leaves(compact.node), leaves(pkg))
  const filtered = filterBundleSourceTree(tree, 'ahash - 0.8.12/src/lib.rs').dirs.get('vendor').dirs.get('ahash')
  assert.deepEqual([...compactSourceDirectory('ahash', filtered, 1).node.files], [['src/lib.rs', 'vendor/ahash/src/lib.rs']])
})

test('Cargo keeps src visible when another directory is captured, even after search filtering', () => {
  const tree = cargoTree({ 'src/lib.rs': 'source', 'examples/demo.rs': 'example' })
  const pkg = tree.dirs.get('vendor').dirs.get('ahash')
  assert.equal(compactSourceDirectory('ahash', pkg, 1).node, pkg)
  assert.equal(compactSourceDirectory('ahash', pkg, 1).node.sourcePath, 'vendor/ahash')
  assert.ok(pkg.dirs.has('src'))
  const filtered = filterBundleSourceTree(tree, 'lib.rs').dirs.get('vendor').dirs.get('ahash')
  assert.ok(compactSourceDirectory('ahash', filtered, 1).node.dirs.has('src'))
  assert.equal(compactSourceDirectory('ahash', filtered, 1).node.sourcePath, 'vendor/ahash')
})

test('Cargo rows without src retain their package path in the tooltip', () => {
  const tree = cargoTree({ 'lib.rs': 'root', 'hash/a.rs': 'hash' })
  const pkg = tree.dirs.get('vendor').dirs.get('ahash')
  assert.equal(compactSourceDirectory('ahash', pkg, 1).node.sourcePath, 'vendor/ahash')
})

test('Cargo filtering matches name-version labels with hidden src paths and physical paths', () => {
  const tree = cargoTree({ 'src/lib.rs': 'lib', 'src/hash.rs': 'hash' })
  for (const query of ['AHASH - 0.8.12', 'vendor/ahash/src/']) {
    assert.deepEqual(leaves(filterBundleSourceTree(tree, query)), leaves(tree))
  }
  assert.deepEqual(leaves(filterBundleSourceTree(tree, 'ahash - 0.8.12/lib.rs')), ['vendor/ahash/src/lib.rs'])
  assert.equal(filterBundleSourceTree(tree, 'ahash - 9.9.9'), null)
})

test('Cargo package metadata follows original paths when a checkout prefix is stripped', () => {
  const original = '/checkout/vendor/renamed/src/lib.rs'
  const modules = new Map([
    ['/checkout/vendor/renamed', { name: 'ahash', version: '0.8.12', ecosystem: 'cargo' }],
  ])
  const tree = buildBundleSourceTree(['vendor/renamed/src/lib.rs'], [original], modules)
  const pkg = tree.dirs.get('vendor').dirs.get('renamed')
  assert.equal(sourceDirectoryLabel('renamed', pkg), 'ahash - 0.8.12')
  assert.deepEqual(leaves(compactSourceDirectory('renamed', pkg, 1).node), [original])
  assert.equal(bundleSourceTreePrefix('/checkout/vendor/renamed/src/', modules), '/checkout/')
  assert.equal(bundleSourceTreePrefix('vendor/renamed/src/', new Map([
    ['vendor/renamed', { name: 'ahash', ecosystem: 'cargo' }],
  ])), '')
  assert.equal(bundleSourceTreePrefix('/checkout/vendor/renamed/src/'), '/checkout/vendor/renamed/src/', 'ordinary source trees keep their prefix behavior')
})

test('vendored packages with an unfamiliar ecosystem retain ordinary directory labels', () => {
  const path = 'vendor/org/package/src/a.go'
  const tree = buildBundleSourceTree([path], [path], new Map([
    ['vendor/org/package', { name: 'org/package', version: '1.0.0', ecosystem: 'go' }],
  ]))
  const pkg = tree.dirs.get('vendor').dirs.get('org').dirs.get('package')
  assert.equal(pkg.package, undefined)
  assert.equal(sourceDirectoryLabel('package', pkg), 'package')
})

function composerTree(files) {
  const bundle = Bundle.parse(new Bundle({ modules: new Map([
    ['vendor/org/package', { name: 'org/package', version: 'v1.2.3', ecosystem: 'composer', files }],
  ]) }).serialize())
  const paths = [...bundle.sources.keys()]
  return buildBundleSourceTree(paths, paths, bundle.modules)
}

test('Composer namespaces present one name-version row per package and retain original source keys', () => {
  const bundle = Bundle.parse(new Bundle({ modules: new Map([
    ['.', { name: 'app', files: { 'index.php': 'own' } }],
    ['vendor/org/one', { name: 'org/one', version: '1.2.3', ecosystem: 'composer', files: { 'src/a.php': 'one' } }],
    ['vendor/org/two', { name: 'org/two', version: 'dev-main', ecosystem: 'composer', files: { 'lib/b.php': 'two' } }],
    ['vendor/other/three', { name: 'other/three', ecosystem: 'composer', files: { 'c.php': 'three' } }],
  ]) }).serialize())
  const paths = [...bundle.sources.keys()]
  const tree = buildBundleSourceTree(paths, paths, bundle.modules)
  const vendor = tree.dirs.get('vendor')
  assert.deepEqual([...vendor.dirs.keys()], ['org/one', 'org/two', 'other/three'])
  const one = vendor.dirs.get('org/one')
  assert.deepEqual(one.package, { name: 'org/one', version: '1.2.3', ecosystem: 'composer' })
  assert.equal(sourceDirectoryLabel('org/one', one), 'org/one - 1.2.3')
  assert.equal(sourceDirectoryLabel('org/two', vendor.dirs.get('org/two')), 'org/two - dev-main')
  assert.equal(sourceDirectoryLabel('other/three', vendor.dirs.get('other/three')), 'other/three')
  assert.equal(one.path, 'vendor/org/one')
  assert.equal(one.sourcePath, one.path)
  assert.equal(tree.files.get('index.php'), 'index.php')
  assert.deepEqual(compactSourceDirectory('vendor', vendor, 0).names, ['vendor'])
  assert.deepEqual(leaves(tree), paths.toSorted())
})

test('Composer folds a sole src directory without losing root files or duplicate filenames', () => {
  const tree = composerTree({ 'composer.json': 'manifest', 'bootstrap.php': 'root', 'src/bootstrap.php': 'source', 'src/deep/a.php': 'deep' })
  const pkg = tree.dirs.get('vendor').dirs.get('org/package')
  const compact = compactSourceDirectory('org/package', pkg, 1)
  assert.deepEqual([...compact.node.files.keys()].toSorted(), ['bootstrap.php', 'composer.json', 'src/bootstrap.php'])
  assert.ok(compact.node.dirs.has('deep'))
  assert.equal(compact.node.sourcePath, 'vendor/org/package/src')
  assert.deepEqual(leaves(compact.node), leaves(pkg))
  assert.ok(pkg.dirs.has('src'), 'presentation does not mutate the package tree')
  const filtered = filterBundleSourceTree(tree, 'org/package - v1.2.3/src/bootstrap.php').dirs.get('vendor').dirs.get('org/package')
  assert.deepEqual([...compactSourceDirectory('org/package', filtered, 1).node.files], [['src/bootstrap.php', 'vendor/org/package/src/bootstrap.php']])
})

test('Composer tooltips append src only when it is actually folded', () => {
  for (const files of [{ 'main.php': 'root' }, { 'src/main.php': 'source', 'lib/extra.php': 'sibling' }]) {
    const tree = composerTree(files)
    const pkg = tree.dirs.get('vendor').dirs.get('org/package')
    assert.equal(compactSourceDirectory('org/package', pkg, 1).node.sourcePath, 'vendor/org/package')
    const filtered = filterBundleSourceTree(tree, 'main.php').dirs.get('vendor').dirs.get('org/package')
    const compact = compactSourceDirectory('org/package', filtered, 1)
    assert.equal(compact.node.sourcePath, 'vendor/org/package')
    if ('src/main.php' in files) assert.ok(compact.node.dirs.has('src'), 'filtering cannot hide a directory with captured siblings')
  }
  const tree = composerTree({ 'root.php': 'root', 'src/main.php': 'source' })
  const filtered = filterBundleSourceTree(tree, 'root.php').dirs.get('vendor').dirs.get('org/package')
  assert.equal(compactSourceDirectory('org/package', filtered, 1).node.sourcePath, 'vendor/org/package', 'a filtered-out src is not folded')
})

test('Composer searches match displayed name-version paths and physical paths after folding', () => {
  const tree = composerTree({ 'src/main.php': 'main', 'src/helper.php': 'helper' })
  for (const query of ['ORG/PACKAGE - V1.2.3', 'vendor/org/package/src/']) {
    assert.deepEqual(leaves(filterBundleSourceTree(tree, query)), leaves(tree))
  }
  assert.deepEqual(leaves(filterBundleSourceTree(tree, 'org/package - v1.2.3/main.php')), ['vendor/org/package/src/main.php'])
  assert.equal(filterBundleSourceTree(tree, 'org/package - v9.9.9'), null)
})

test('Composer namespace wrappers with extra files or unknown directories remain intact through filtering', () => {
  const file = 'vendor/org/package/src/main.php'
  const modules = new Map([['vendor/org/package', { name: 'org/package', ecosystem: 'composer' }]])
  for (const sibling of ['vendor/org/helper.php', 'vendor/org/unknown/helper.php']) {
    const tree = buildBundleSourceTree([file, sibling], [file, sibling], modules)
    const org = tree.dirs.get('vendor').dirs.get('org')
    assert.ok(org.dirs.has('package'))
    assert.deepEqual(leaves(tree), [file, sibling].toSorted())
    const filtered = filterBundleSourceTree(tree, 'main.php').dirs.get('vendor').dirs.get('org')
    assert.ok(filtered.dirs.has('package'), 'search cannot turn an unfamiliar wrapper into a package row')
    assert.equal(filtered.package, undefined)
  }
})

test('Composer identities follow custom install paths and preserve package roots under common prefixes', () => {
  for (const dir of ['/checkout/vendor/renamed/library', '/checkout/plugins/library']) {
    const original = `${dir}/src/main.php`
    const modules = new Map([[dir, { name: 'org/package', version: '1.2.3', ecosystem: 'composer' }]])
    const prefix = bundleSourceTreePrefix(`${dir}/src/`, modules)
    assert.equal(prefix, dir.includes('/vendor/') ? '/checkout/' : '/checkout/plugins/')
    const tree = buildBundleSourceTree([original.slice(prefix.length)], [original], modules)
    const pkg = dir.includes('/vendor/') ? tree.dirs.get('vendor').dirs.get('renamed/library') : tree.dirs.get('library')
    assert.equal(sourceDirectoryLabel('library', pkg), 'org/package - 1.2.3')
    assert.equal(compactSourceDirectory('library', pkg, 0).node.sourcePath, `${dir}/src`)
    assert.deepEqual(leaves(tree), [original])
  }
  assert.equal(bundleSourceTreePrefix('src/', new Map([['.', { name: 'org/app', ecosystem: 'composer' }]])), 'src/', 'the root workspace is not a dependency')
})

test('Cargo, Composer, Soldeer, and npm packages retain their own grouping in a mixed-language bundle', () => {
  const paths = ['vendor/ahash/src/lib.rs', 'vendor/org/package/src/main.php', 'dependencies/@openzeppelin-contracts-5.2.0/Token.sol', 'node_modules/@scope/pkg/index.js']
  const tree = buildBundleSourceTree(paths, paths, new Map([
    ['vendor/ahash', { name: 'ahash', version: '0.8.12', ecosystem: 'cargo' }],
    ['vendor/org/package', { name: 'org/package', version: '1.2.3', ecosystem: 'composer' }],
    ['dependencies/@openzeppelin-contracts-5.2.0', { name: '@openzeppelin-contracts', version: '5.2.0', ecosystem: 'soldeer' }],
  ]))
  const vendor = tree.dirs.get('vendor')
  assert.equal(sourceDirectoryLabel('ahash', vendor.dirs.get('ahash')), 'ahash - 0.8.12')
  assert.equal(sourceDirectoryLabel('org/package', vendor.dirs.get('org/package')), 'org/package - 1.2.3')
  const npm = tree.dirs.get('node_modules').dirs.get('@scope/pkg')
  assert.equal(sourceDirectoryLabel('@scope/pkg', npm), '@scope/pkg')
  assert.equal(npm.package.ecosystem, undefined)
  const soldeer = tree.dirs.get('dependencies').dirs.get('@openzeppelin-contracts-5.2.0')
  assert.equal(sourceDirectoryLabel('@openzeppelin-contracts-5.2.0', soldeer), '@openzeppelin-contracts - 5.2.0')
  assert.deepEqual(leaves(tree), paths.toSorted())
})

test('Soldeer uses recorded identities and keeps versions and original source paths distinct', () => {
  const modules = new Map([
    ['dependencies/@openzeppelin-contracts-5.2.0', { name: '@openzeppelin-contracts', version: '5.2.0', ecosystem: 'soldeer', files: { 'contracts/Token.sol': 'token' } }],
    ['dependencies/@openzeppelin-contracts-4.9.6', { name: '@openzeppelin-contracts', version: '4.9.6', ecosystem: 'soldeer', files: { 'contracts/Token.sol': 'old token' } }],
    ['dependencies/renamed-install', { name: 'solmate', ecosystem: 'soldeer', files: { 'src/Token.sol': 'solmate' } }],
  ])
  const bundle = Bundle.parse(new Bundle({ modules }).serialize())
  const paths = [...bundle.sources.keys()]
  const tree = buildBundleSourceTree(paths, paths, bundle.modules)
  const dependencies = tree.dirs.get('dependencies')
  assert.equal(dependencies.boundary, true)
  for (const version of ['5.2.0', '4.9.6']) {
    const name = `@openzeppelin-contracts-${version}`
    const pkg = dependencies.dirs.get(name)
    assert.deepEqual(pkg.package, { name: '@openzeppelin-contracts', version, ecosystem: 'soldeer' })
    assert.equal(sourceDirectoryLabel(name, pkg), `@openzeppelin-contracts - ${version}`)
    assert.deepEqual(compactSourceDirectory(name, pkg, 1).names, [name])
    assert.deepEqual(leaves(filterBundleSourceTree(tree, `@openzeppelin-contracts - ${version}`)), [`dependencies/${name}/contracts/Token.sol`])
  }
  const renamed = dependencies.dirs.get('renamed-install')
  assert.equal(sourceDirectoryLabel('renamed-install', renamed), 'solmate', 'use metadata instead of parsing the directory name')
  assert.equal(compactSourceDirectory('renamed-install', renamed, 1).node.sourcePath, 'dependencies/renamed-install/src')
  assert.deepEqual(leaves(filterBundleSourceTree(tree, 'solmate/Token.sol')), ['dependencies/renamed-install/src/Token.sol'])
  assert.deepEqual(leaves(filterBundleSourceTree(tree, 'dependencies/renamed-install/src/')), ['dependencies/renamed-install/src/Token.sol'])
  assert.deepEqual(leaves(tree), paths.toSorted())
})

test('Soldeer retains its dependencies group when every source shares a package prefix', () => {
  for (const checkout of ['', '/checkout/', 'packages/app/']) {
    const dir = `${checkout}dependencies/@openzeppelin-contracts-5.2.0`
    const file = `${dir}/src/Token.sol`
    const modules = new Map([[dir, { name: '@openzeppelin-contracts', version: '5.2.0', ecosystem: 'soldeer' }]])
    const prefix = bundleSourceTreePrefix(`${dir}/src/`, modules)
    assert.equal(prefix, checkout)
    const tree = buildBundleSourceTree([file.slice(prefix.length)], [file], modules)
    const dependencies = tree.dirs.get('dependencies')
    assert.equal(dependencies.boundary, true)
    assert.deepEqual(compactSourceDirectory('dependencies', dependencies, 0).names, ['dependencies'])
    const pkg = dependencies.dirs.get('@openzeppelin-contracts-5.2.0')
    assert.deepEqual(leaves(compactSourceDirectory('@openzeppelin-contracts-5.2.0', pkg, 1).node), [file])
    assert.deepEqual(leaves(filterBundleSourceTree(tree, '@openzeppelin-contracts - 5.2.0/Token.sol', prefix)), [file])
  }
})

test('vendored packages retain a shared container prefix when no project sources are captured', () => {
  for (const [ecosystem, container, installs, file] of [
    ['soldeer', 'dependencies', ['foo-1.0.0', 'bar-2.0.0'], 'src/Token.sol'],
    ['cargo', 'vendor', ['foo', 'bar'], 'src/lib.rs'],
    ['composer', 'vendor', ['org/foo', 'org/bar'], 'src/main.php'],
  ]) {
    for (const checkout of ['', '/checkout/', 'packages/app/']) {
      const modules = new Map(installs.map(name => [`${checkout}${container}/${name}`, { name, ecosystem }]))
      const paths = [...modules.keys()].map(dir => `${dir}/${file}`)
      const prefix = bundleSourceTreePrefix(`${checkout}${container}/`, modules, paths)
      assert.equal(prefix, checkout)
      const tree = buildBundleSourceTree(paths.map(path => path.slice(prefix.length)), paths, modules)
      assert.deepEqual([...tree.dirs.keys()], [container])
      assert.equal(tree.dirs.get(container).boundary, true)
      assert.equal(tree.dirs.get(container).dirs.size, 2)
      assert.deepEqual(leaves(tree), paths.toSorted())
    }
  }
})

test('Soldeer recognition does not guess ecosystems or fold a src directory with siblings', () => {
  const dir = 'dependencies/pkg-1.0.0'
  const paths = [`${dir}/src/Token.sol`, `${dir}/test/Token.t.sol`]
  const info = { name: 'pkg', version: '1.0.0' }
  for (const ecosystem of [undefined, 'github', 'npm']) {
    const modules = new Map([[dir, { ...info, ecosystem }]])
    const tree = buildBundleSourceTree(paths, paths, modules)
    const pkg = tree.dirs.get('dependencies').dirs.get('pkg-1.0.0')
    assert.equal(pkg.package, undefined)
    assert.equal(sourceDirectoryLabel('pkg-1.0.0', pkg), 'pkg-1.0.0')
    assert.equal(bundleSourceTreePrefix(`${dir}/src/`, modules), `${dir}/src/`)
  }
  const tree = buildBundleSourceTree(paths, paths, new Map([[dir, { ...info, ecosystem: 'soldeer' }]]))
  const pkg = filterBundleSourceTree(tree, 'src/Token.sol').dirs.get('dependencies').dirs.get('pkg-1.0.0')
  assert.equal(pkg.hideSrc, false)
  assert.ok(compactSourceDirectory('pkg-1.0.0', pkg, 1).node.dirs.has('src'))
})

test('untagged PHP-only vendor modules use Composer rows and preserve package roots under common prefixes', () => {
  const dir = 'vendor/symfony/deprecation-contracts'
  const bundle = Bundle.parse(new Bundle({ modules: new Map([
    [dir, { name: 'symfony/deprecation-contracts', version: 'v3.6.0', files: { 'function.php': '<?php' } }],
  ]) }).serialize())
  const paths = [...bundle.sources.keys()]
  const prefix = bundleSourceTreePrefix(`${dir}/`, bundle.modules, paths)
  assert.equal(prefix, '')
  const tree = buildBundleSourceTree(paths.map(path => path.slice(prefix.length)), paths, bundle.modules)
  const pkg = tree.dirs.get('vendor').dirs.get('symfony/deprecation-contracts')
  assert.deepEqual(pkg.package, { name: 'symfony/deprecation-contracts', version: 'v3.6.0', ecosystem: 'composer' })
  assert.equal(sourceDirectoryLabel('symfony/deprecation-contracts', pkg), 'symfony/deprecation-contracts - v3.6.0')
  assert.equal(compactSourceDirectory('symfony/deprecation-contracts', pkg, 1).node.sourcePath, dir)
  assert.deepEqual(leaves(tree), paths)
  assert.deepEqual(leaves(filterBundleSourceTree(tree, 'symfony/deprecation-contracts - v3.6.0/function.php')), paths)
  assert.equal(bundle.modules.get(dir).ecosystem, undefined, 'inference does not change the original metadata')
  const absoluteDir = `/checkout/${dir}`
  const absoluteModules = new Map([[absoluteDir, bundle.modules.get(dir)]])
  const absolutePaths = paths.map(path => `/checkout/${path}`)
  assert.equal(bundleSourceTreePrefix(`${absoluteDir}/`, absoluteModules, absolutePaths), '/checkout/')
  const absoluteTree = buildBundleSourceTree(paths, absolutePaths, absoluteModules)
  assert.equal(absoluteTree.dirs.get('vendor').dirs.get('symfony/deprecation-contracts').package.ecosystem, 'composer')
  assert.deepEqual(leaves(absoluteTree), absolutePaths)
})

test('inferred Composer packages fold src and ignore captured resources when classifying source files', () => {
  const dir = 'vendor/org/package'
  const bundle = Bundle.parse(new Bundle({ modules: new Map([
    [dir, { name: 'org/package', version: '1.2.3', files: {
      'src/main.PHP': '<?php', 'src/view.phtml': '<?php',
      'image.png': 'AA==', 'LICENSE': 'license', 'src': '["main.PHP","view.phtml"]',
    } }],
  ]), formats: new Map([
    [`${dir}/image.png`, 'resource:base64'], [`${dir}/LICENSE`, 'resource'], [`${dir}/src`, 'directory'],
  ]) }).serialize())
  const paths = [...bundleSourcesAsMap({ kind: 'stasis', bundle }).keys()]
  assert.equal(bundleSourceTreePrefix(`${dir}/src/`, bundle.modules, paths), '')
  const tree = buildBundleSourceTree(paths, paths, bundle.modules)
  const pkg = tree.dirs.get('vendor').dirs.get('org/package')
  assert.equal(pkg.package.ecosystem, 'composer')
  assert.equal(compactSourceDirectory('org/package', pkg, 1).node.sourcePath, `${dir}/src`)
  assert.deepEqual(leaves(tree), paths.toSorted())
})

test('PHP inference requires a matching vendor identity, only PHP source files, and an unrecorded ecosystem', () => {
  const cases = [
    { dir: 'vendor/org/package', info: { name: 'org/package', files: { 'main.php': 'php', 'helper.js': 'js' } } },
    { dir: 'vendor/org/package', info: { name: 'org/package', ecosystem: 'go', files: { 'main.php': 'php' } } },
    { dir: 'vendor/org/package', info: { name: 'other/package', files: { 'main.php': 'php' } } },
    { dir: 'vendor/org/package', info: { files: { 'main.php': 'php' } } },
    { dir: 'vendor/org/package', info: { name: 'org/package', files: {} } },
    { dir: 'vendor/org/package', info: { name: 'org/package', files: { 'image.png': 'AA==' } } },
    { dir: 'packages/org/package', info: { name: 'org/package', files: { 'main.php': 'php' } } },
  ]
  for (const { dir, info } of cases) {
    const paths = Object.keys(info.files).map(path => `${dir}/${path}`)
    const modules = new Map([[dir, info]])
    assert.equal(bundleSourceTreePrefix(`${dir}/`, modules, paths), `${dir}/`)
    const tree = buildBundleSourceTree(paths, paths, modules)
    let node = tree
    for (const part of dir.split('/')) node = node?.dirs.get(part)
    assert.equal(node?.package, undefined, `${dir}: ${info.name}, ${info.ecosystem}`)
    assert.deepEqual(leaves(tree), paths.toSorted())
  }
})
