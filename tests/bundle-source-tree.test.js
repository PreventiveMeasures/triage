import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBundleSourceTree, compactSourceDirectory } from '../ui/view/bundle-source-tree.js'

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
  assert.deepEqual(compactSourceDirectory('node_modules', pkg.dirs.get('node_modules'), 1).names, ['node_modules', 'has-symbols'])
  assert.deepEqual(compactSourceDirectory('a', tree.dirs.get('a'), 0).names, ['a', 'b', 'c'])
  assert.deepEqual(compactSourceDirectory('src', tree.dirs.get('src'), 0).names, ['src'])
})
