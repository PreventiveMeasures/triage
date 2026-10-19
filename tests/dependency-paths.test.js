import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dependencyDirectory, treeDependencyDirectory } from '../client/dependency-paths.js'

const own = [[{ file: 'src/app.js' }]]

test('a team\'s report telling the dependency directory its tree names classifies as the tree itself does', () => {
  for (const tree of [{ 'src/app.js': {}, 'node_modules/x/index.js': {} }, { 'src/app.js': {}, 'vendor/x.go': {} }, { 'src/app.js': {} }]) {
    const named = treeDependencyDirectory(tree)
    assert.equal(dependencyDirectory([{ groups: own, treeDependencies: named }]), dependencyDirectory([{ groups: own, tree }]))
  }
  assert.equal(dependencyDirectory([{ groups: own, treeDependencies: 'vendor' }, { groups: own, treeDependencies: 'node_modules' }]), 'node_modules')
  assert.equal(dependencyDirectory([{ groups: own, treeDependencies: null }]), 'dependencies')
  assert.equal(dependencyDirectory([{ groups: own, tree: { 'src/app.js': {} }, treeDependencies: 'node_modules' }]), 'dependencies',
    'a tree read since is what it names')
})
