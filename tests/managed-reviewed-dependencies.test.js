// The reviewed dependencies a host registers through @preventive/triage/server
// (server-managed/reviewed-dependencies.ts): a lookup and optionally a parser
// of comments, once, before the server is assembled, which then keeps them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerReviewedDependencies } from '../server.ts'
import { askBases, assembledReviewedDependencies } from '../server-managed/reviewed-dependencies.ts'

test('reviewed dependencies are registered once, a lookup and optionally a parser of comments and a formatter of one\'s dependency reviews, before the server is assembled, never after', async () => {
  for (const bad of [{}, () => Promise.resolve(true), { lookup: true }, { lookup: () => Promise.resolve(true), parseComments: 'no' },
    { lookup: () => Promise.resolve(true), formatDependencyReviews: 'no' }, { lookup: () => Promise.resolve(true), base: 'no' }]) {
    assert.throws(() => registerReviewedDependencies(bad), TypeError)
  }
  const host = { reviewed: new Set(['ms']), lookup(dependency) { return Promise.resolve(this.reviewed.has(dependency.name)) }, parseComments: () => Promise.resolve([]),
    bases: { ms: { name: 'ms', version: '2.1.2' } }, base(dependency) { return Promise.resolve(this.bases[dependency.name] ?? null) },
    prefix: 'Reviewed', formatDependencyReviews(input) { return Promise.resolve(`${this.prefix} ${input.reviews.length}`) } }
  registerReviewedDependencies(host)
  assert.throws(() => registerReviewedDependencies({ lookup: () => Promise.resolve(false) }), /registered already/u)
  const assembled = assembledReviewedDependencies()
  assert.equal(await assembled.lookup({ name: 'ms' }), true, 'its methods called as its own')
  assert.deepEqual(await assembled.parseComments({}), [])
  assert.deepEqual(await assembled.base({ name: 'ms' }), { name: 'ms', version: '2.1.2' })
  assert.equal(await assembled.formatDependencyReviews({ reviews: [] }), 'Reviewed 0')
  assert.throws(() => registerReviewedDependencies(host), /before init\(\)/u)
  assert.equal(assembledReviewedDependencies(), assembled, 'the server assembled takes them')
})

test('the version `base` names each dependency, of its own package or another, as an exact version; none where it names none, or fails', async t => {
  const warned = t.mock.method(console, 'warn', () => {})
  const answers = { ms: { name: 'ms', version: '2.1.2' }, fork: { name: 'ms', version: '2.1.3' }, none: null, range: { name: 'range', version: '^1.0.0' }, odd: { name: 'Not A Name', version: '1.0.0' } }
  const base = dependency => dependency.name === 'fails' ? Promise.reject(new Error('down')) : Promise.resolve(answers[dependency.name])
  const named = await askBases(base, new Map(['ms', 'fork', 'none', 'range', 'odd', 'fails'].map(name => [name, { ecosystem: 'npm', lockfile: 'npm', name, version: '1.0.0', integrity: 'x' }])))
  assert.deepEqual(Object.fromEntries(named), { ms: answers.ms, fork: answers.fork })
  assert.equal(warned.mock.callCount(), 1, 'its failing logged')
})
