// The reviewed dependencies a host registers through @preventive/triage/server
// (server-managed/reviewed-dependencies.ts): an async method, once, before
// the server is assembled, which then keeps it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerReviewedDependencies } from '../server.ts'
import { assembledReviewedDependencies } from '../server-managed/reviewed-dependencies.ts'

test('reviewed dependencies are registered once, as a method, before the server is assembled, never after', () => {
  assert.throws(() => registerReviewedDependencies({}), TypeError)
  const reviewed = () => Promise.resolve(true)
  registerReviewedDependencies(reviewed)
  assert.throws(() => registerReviewedDependencies(() => Promise.resolve(false)), /registered already/u)
  assert.equal(assembledReviewedDependencies(), reviewed, 'the server assembled takes them')
  assert.throws(() => registerReviewedDependencies(reviewed), /before init\(\)/u)
  assert.equal(assembledReviewedDependencies(), reviewed)
})
