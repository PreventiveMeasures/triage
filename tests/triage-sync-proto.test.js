// Round-12 H6 regression: `applyChangeset` must not let a peer-
// controlled changeset pollute the prototype chain. JSON.parse of
// `{"__proto__": {…}}` creates `__proto__` as an OWN property; on
// a normal-`{}` out, `out['__proto__'] = entry` triggers
// Object.prototype's `__proto__` setter and mutates out's prototype
// to the attacker-supplied entry. Subsequent `baseState[id]`
// lookups (hydrateStateFromBaseState, statesEqual, etc.) then walk
// the polluted chain and return attacker-controlled triage.
//
// Fix: applyChangeset uses `Object.create(null)` for out — no
// setter on the prototype chain, so `out['__proto__'] = entry`
// becomes an inert own data property.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

function createLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
    get length() { return store.size },
    key: (i) => Array.from(store.keys())[i] ?? null,
  }
}
if (globalThis.localStorage === undefined) {
  globalThis.localStorage = createLocalStorage()
}

const { applyChangeset } = await import('../client/triage-sync.js')

describe('triage-sync — applyChangeset prototype-pollution defense', () => {
  it('a `__proto__` key in the changeset does not mutate the returned out\'s prototype chain', () => {
    // Build the changeset via a JSON string so `__proto__` lands as
    // an OWN property — that's the wire shape (peer JSON.parses
    // the decrypted blob the same way). Object literals use the
    // `__proto__` slot for prototype assignment, which would
    // sidestep the test by setting the prototype at construction
    // time instead.
    const changeset = JSON.parse('{"__proto__": {"hijacked": "gotcha"}}')
    assert.ok(Object.prototype.hasOwnProperty.call(changeset, '__proto__'),
      'JSON.parse turned `__proto__` into an own key (sanity)')

    const baseState = { realId: { color: 'red' } }
    const out = applyChangeset(baseState, changeset)

    // Pre-fix: `out['__proto__'] = entry` on Object.prototype-having
    // out triggers the setter, mutating out's [[Prototype]] to the
    // attacker entry. Subsequent `out.hijacked` lookup walks the
    // chain and returns "gotcha". With null-prototype out, the
    // setter doesn't fire (no chain), and `__proto__` becomes an
    // inert own data property.
    assert.notEqual(out.hijacked, 'gotcha',
      'out\'s prototype chain was not polluted with the attacker entry')
    // Reading `out.hijacked` should be undefined (no inherited
    // property; only own keys).
    assert.equal(out.hijacked, undefined,
      'out has no chain-inherited polluted entries')
  })

  it('`out` returned by applyChangeset is null-prototyped (no setter on chain)', () => {
    // The defense: out has no Object.prototype, so `__proto__` /
    // `constructor` / etc. set on it become inert own data
    // properties — no setter to mutate the chain.
    const baseState = { existing: { color: 'blue' } }
    const out = applyChangeset(baseState, {})
    assert.equal(Object.getPrototypeOf(out), null,
      'applyChangeset returns a null-prototyped object')
    // Existing entry preserved.
    assert.deepEqual(out.existing, { color: 'blue' })
  })

  it('a `__proto__` key in the changeset becomes an inert own property, not a prototype mutation', () => {
    const changeset = JSON.parse('{"__proto__": {"poisoned": "yes"}}')
    const out = applyChangeset({}, changeset)

    // out's prototype is null (set by Object.create(null)), so the
    // setter doesn't fire; `out['__proto__'] = entry` stores it as
    // an own data property. Reading `out['__proto__']` returns the
    // own value, not a prototype. Either way, the prototype CHAIN
    // is not polluted with `poisoned`.
    assert.notEqual(Object.getPrototypeOf(out)?.poisoned, 'yes',
      'out\'s prototype was not mutated to the attacker entry')
    // And out['poisoned'] (looked up via prototype chain) is
    // undefined — there's no chain to walk.
    assert.equal(out.poisoned, undefined,
      'lookup of attacker key returns undefined (no chain pollution)')
  })

  it('a `constructor` key in the changeset is also stored inertly', () => {
    // The companion vector: `constructor` is also a sensitive
    // property name. Object.create(null) means setting
    // `out.constructor = …` is just an own data property, not a
    // method-table swap.
    const changeset = JSON.parse('{"constructor": {"prototype": {"x": 1}}}')
    const out = applyChangeset({}, changeset)
    assert.equal(out.constructor !== Object, true,
      'out.constructor is NOT the global Object constructor (own data prop instead)')
    // Any unrelated `{}` is still default-constructed.
    assert.equal(({}).constructor, Object)
  })

  it('legitimate id-keyed entries still apply (functional regression check)', () => {
    const baseState = { a: { color: 'red' }, b: { color: 'blue' } }
    const changeset = { a: { color: 'green' }, c: { color: 'gray' } }
    const out = applyChangeset(baseState, changeset)
    assert.equal(out.a.color, 'green', 'overwrite applied')
    assert.equal(out.b.color, 'blue', 'untouched id preserved')
    assert.equal(out.c.color, 'gray', 'new id inserted')
  })

  it('null entries delete from out (functional regression check)', () => {
    const baseState = { a: { color: 'red' }, b: { color: 'blue' } }
    const out = applyChangeset(baseState, { a: null })
    assert.equal('a' in out, false, 'null entry removed')
    assert.equal(out.b.color, 'blue', 'untouched id preserved')
  })
})
