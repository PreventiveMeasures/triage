// `client/persistence.js` — the policy-free Storage API layer.
//
// Node 24 ships a global `navigator` WITHOUT `navigator.storage`, so
// the unsupported paths run against the real environment; the
// supported paths install a mock `navigator.storage` per test and
// restore it in `finally` (the module holds no state, so no
// cache-busted re-imports are needed).

/* eslint-disable require-await -- mocks mirror the async
   navigator.storage API surface; their bodies are synchronous by
   design. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getStorageInfo, requestPersistentStorage } from '../client/persistence.js'

async function withNavigatorStorage(mock, fn) {
  const had = Object.hasOwn(navigator, 'storage')
  const prev = had ? navigator.storage : undefined
  navigator.storage = mock
  try {
    return await fn()
  } finally {
    if (had) navigator.storage = prev
    else delete navigator.storage
  }
}

describe('persistence — unsupported environment (no navigator.storage)', () => {
  it('requestPersistentStorage resolves false', async () => {
    assert.equal(await requestPersistentStorage(), false)
  })

  it('getStorageInfo reports unsupported with all-null fields', async () => {
    assert.deepEqual(await getStorageInfo(), { supported: false, persisted: null, usage: null, quota: null })
  })
})

describe('persistence — requestPersistentStorage', () => {
  it('returns the grant verbatim on true', async () => {
    await withNavigatorStorage({ persist: async () => true }, async () => {
      assert.equal(await requestPersistentStorage(), true)
    })
  })

  it('returns false on denial', async () => {
    await withNavigatorStorage({ persist: async () => false }, async () => {
      assert.equal(await requestPersistentStorage(), false)
    })
  })

  it('returns false when persist() throws instead of propagating', async () => {
    await withNavigatorStorage({ persist: async () => { throw new Error('nope') } }, async () => {
      assert.equal(await requestPersistentStorage(), false)
    })
  })

  it('returns false when the storage manager lacks persist()', async () => {
    await withNavigatorStorage({}, async () => {
      assert.equal(await requestPersistentStorage(), false)
    })
  })

  it('coerces a non-boolean resolution to false, not truthy leak-through', async () => {
    await withNavigatorStorage({ persist: async () => 'granted' }, async () => {
      assert.equal(await requestPersistentStorage(), false)
    })
  })
})

describe('persistence — getStorageInfo', () => {
  it('reports persisted + usage + quota when all probes work', async () => {
    const mock = {
      persisted: async () => true,
      estimate: async () => ({ usage: 12_345, quota: 600_000_000 }),
    }
    await withNavigatorStorage(mock, async () => {
      assert.deepEqual(await getStorageInfo(), { supported: true, persisted: true, usage: 12_345, quota: 600_000_000 })
    })
  })

  it('null means unknown: a throwing persisted() does not read as "not persisted"', async () => {
    const mock = {
      persisted: async () => { throw new Error('boom') },
      estimate: async () => ({ usage: 1, quota: 2 }),
    }
    await withNavigatorStorage(mock, async () => {
      assert.deepEqual(await getStorageInfo(), { supported: true, persisted: null, usage: 1, quota: 2 })
    })
  })

  it('missing estimate() leaves usage/quota null while persisted still resolves', async () => {
    await withNavigatorStorage({ persisted: async () => false }, async () => {
      assert.deepEqual(await getStorageInfo(), { supported: true, persisted: false, usage: null, quota: null })
    })
  })

  it('non-numeric estimate fields stay null', async () => {
    const mock = {
      persisted: async () => false,
      estimate: async () => ({ usage: undefined, quota: 'lots' }),
    }
    await withNavigatorStorage(mock, async () => {
      assert.deepEqual(await getStorageInfo(), { supported: true, persisted: false, usage: null, quota: null })
    })
  })
})
