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

test('the version `base` names to review each dependency against: of its own package or another, by its exact version; none where it names none, what isn\'t one, the dependency itself unpatched, or fails', async t => {
  const warned = t.mock.method(console, 'warn', () => {})
  const of = (name, version, more = {}) => [`${name}@${version}`, { ecosystem: 'npm', lockfile: 'npm', name, version, integrity: 'sha512-x', ...more }]
  const answers = { 'ms@2.1.3': { name: 'ms', version: '2.1.2' }, '@fork/ms@3.0.0': { name: 'ms', version: '2.1.3' }, 'new@1.0.0': null, 'gone@1.0.0': undefined,
    'self@1.0.0': { name: 'self', version: '1.0.0' }, 'patched@1.0.0': { name: 'patched', version: '1.0.0' }, 'range@1.0.0': { name: 'range', version: '^1.0.0' },
    'odd@1.0.0': { name: 'Not A Name', version: '1.0.0' }, 'text@1.0.0': 'ms@2.1.2' }
  const asked = []
  const base = dependency => {
    asked.push(`${dependency.name}@${dependency.version}`)
    return dependency.name === 'fails' ? Promise.reject(new Error('down')) : Promise.resolve(answers[`${dependency.name}@${dependency.version}`])
  }
  const dependencies = new Map([of('ms', '2.1.3'), of('@fork/ms', '3.0.0'), of('new', '1.0.0'), of('gone', '1.0.0'), of('self', '1.0.0'), of('patched', '1.0.0', { patchHash: 'a'.repeat(64) }),
    of('range', '1.0.0'), of('odd', '1.0.0'), of('text', '1.0.0'), of('fails', '1.0.0')])
  const named = await askBases(base, dependencies)
  assert.deepEqual(Object.fromEntries(named), { 'ms@2.1.3': { name: 'ms', version: '2.1.2' }, '@fork/ms@3.0.0': { name: 'ms', version: '2.1.3' },
    'patched@1.0.0': { name: 'patched', version: '1.0.0' } }, 'another package\'s too; a patched one against itself unpatched')
  assert.equal(warned.mock.callCount(), 5, 'what names none of a version logged, and its failing')
  assert.equal(asked.length, 10)
  await askBases(base, dependencies)
  assert.equal(asked.length, 11, 'each answer kept a while, one failing asked again')
})
