import assert from 'node:assert/strict'
import { test } from 'node:test'
import { treemapGroups } from '../ui/view/treemap-groups.js'

const groups = (paths, prefix) => Object.fromEntries(treemapGroups(paths, prefix))

test('a package\'s files group by the top-most directories that tell them apart', () => {
  assert.deepEqual(groups(['a/a.js', 'b/b.js', 'c.js'], 'src/'), { 'a/a.js': 'src/a/', 'b/b.js': 'src/b/', 'c.js': 'src/*.js' })
  assert.deepEqual(groups(['a/x/1.js', 'a/y/2.js', 'b/3.js']), { 'a/x/1.js': 'a/', 'a/y/2.js': 'a/', 'b/3.js': 'b/' }, 'the top-most that differ, not deeper ones')
})

test('directories every file shares but those loose beside them are passed through', () => {
  assert.deepEqual(groups(['package.json', 'README.md', 'dist/a/1.js', 'dist/b/2.js', 'dist/index.js']), {
    'package.json': '*', 'README.md': '*', 'dist/a/1.js': 'dist/a/', 'dist/b/2.js': 'dist/b/', 'dist/index.js': 'dist/*.js',
  })
  assert.deepEqual(groups(['LICENSE', 'lib/core/a/1.js', 'lib/core/b/2.js']), { LICENSE: '*', 'lib/core/a/1.js': 'lib/core/a/', 'lib/core/b/2.js': 'lib/core/b/' })
  assert.deepEqual(groups(['lib/a.js', 'lib/b.js', 'index.js']), { 'lib/a.js': 'lib/*.js', 'lib/b.js': 'lib/*.js', 'index.js': '*.js' },
    'a directory of loose files alone is its loose files')
})

test('loose files alone group by extension', () => {
  assert.deepEqual(groups(['index.js', 'util.js', 'package.json', 'LICENSE']), { 'index.js': '*.js', 'util.js': '*.js', 'package.json': '*.json', LICENSE: 'No extension' })
  assert.deepEqual(groups(['only.js']), { 'only.js': '*.js' })
  assert.deepEqual(groups([]), {})
})
