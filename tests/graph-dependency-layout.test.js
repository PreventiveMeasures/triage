import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { layoutPackageDependencies } from '../ui/view/graph/dependency-layout.js'

describe('package dependency graph layout', () => {
  it('keeps a long package topology compact and deterministic', () => {
    const ids = ['app', 'router', 'auth', 'db', 'logger', 'shared']
    const imports = new Map([
      ['app', ['router', 'auth']], ['router', ['shared', 'logger']],
      ['auth', ['db', 'shared']], ['db', ['shared']], ['logger', ['shared']], ['shared', []],
    ])
    const first = layoutPackageDependencies(ids, imports, ['app'], { width: 900, height: 600 })
    const second = layoutPackageDependencies(ids, imports, ['app'], { width: 900, height: 600 })
    assert.deepEqual([...first.nodes].map(([id, p]) => [id, p.x, p.y]), [...second.nodes].map(([id, p]) => [id, p.x, p.y]))
    assert.ok(first.width < 900, 'connected packages should not reserve the whole viewport')
    assert.ok(first.height < 600, 'connected packages should use a compact canvas')
    assert.ok(first.nodes.get('shared').y > first.nodes.get('router').y)
    assert.ok(first.nodes.get('shared').y > first.nodes.get('auth').y)
    assert.equal(first.edges.length, 8)
  })

  it('keeps cycles together while assigning every package a usable depth', () => {
    const ids = ['a', 'b', 'c', 'd']
    const imports = new Map([['a', ['b']], ['b', ['a', 'c']], ['c', ['d']], ['d', []]])
    const layout = layoutPackageDependencies(ids, imports, ['a'])
    assert.deepEqual(layout.cycles, [['a', 'b']])
    assert.equal(layout.nodes.get('a').level, layout.nodes.get('b').level)
    assert.ok(layout.nodes.get('c').level > layout.nodes.get('a').level)
    assert.ok(layout.nodes.get('d').level > layout.nodes.get('c').level)
  })
})
