// The reviewed dependencies a host registers through @preventive/triage/server
// (server-managed/reviewed-dependencies.ts): a lookup and optionally a parser
// of comments, once, before the server is assembled, which then keeps them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerReviewedDependencies } from '../server.ts'
import { assembledReviewedDependencies } from '../server-managed/reviewed-dependencies.ts'

test('reviewed dependencies are registered once, a lookup and optionally a parser of comments and a formatter of one\'s dependency reviews, before the server is assembled, never after', async () => {
  for (const bad of [{}, () => Promise.resolve(true), { lookup: true }, { lookup: () => Promise.resolve(true), parseComments: 'no' },
    { lookup: () => Promise.resolve(true), formatDependencyReviews: 'no' }]) {
    assert.throws(() => registerReviewedDependencies(bad), TypeError)
  }
  const host = { reviewed: new Set(['ms']), lookup(dependency) { return Promise.resolve(this.reviewed.has(dependency.name)) }, parseComments: () => Promise.resolve([]),
    prefix: 'Reviewed', formatDependencyReviews(input) { return Promise.resolve(`${this.prefix} ${input.reviews.length}`) } }
  registerReviewedDependencies(host)
  assert.throws(() => registerReviewedDependencies({ lookup: () => Promise.resolve(false) }), /registered already/u)
  const assembled = assembledReviewedDependencies()
  assert.equal(await assembled.lookup({ name: 'ms' }), true, 'its methods called as its own')
  assert.deepEqual(await assembled.parseComments({}), [])
  assert.equal(await assembled.formatDependencyReviews({ reviews: [] }), 'Reviewed 0')
  assert.throws(() => registerReviewedDependencies(host), /before init\(\)/u)
  assert.equal(assembledReviewedDependencies(), assembled, 'the server assembled takes them')
})
