import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScanAccess } from '../ui/scan/access.js'

const models = [{ id: 'anthropic/claude-fable-5.1', efforts: ['low', 'max'] }, { id: 'moonshotai/kimi-k3', efforts: ['high'] }]

function fixture(reply) {
  const calls = []
  const access = new ScanAccess('https://scan.example/prefix/', () => {}, (url, options) => {
    calls.push({ url, options })
    return reply(url, options)
  })
  return { access, calls }
}

test('managed Connect discovers without provider and uses the returned catalogue and effort limits', async () => {
  const { access, calls } = fixture(() => Response.json({ valid: true, managed: true, models }))
  access.setKey(' test-key ')
  await access.setProvider('openai')
  assert.equal(calls.length, 0)
  assert.equal(access.ready, false)
  await access.connect()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.href, 'https://scan.example/prefix/api/models')
  assert.equal(calls[0].options.headers.get('authorization'), 'Bearer test-key')
  assert.equal(calls[0].options.headers.get('accept'), 'application/json')
  assert.equal(calls[0].options.credentials, 'omit')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.cache, 'no-store')
  assert.equal(access.connected, true)
  assert.equal(access.managed, true)
  assert.equal(access.ready, true)
  assert.deepEqual(await access.loadModels(), { models, defaultModel: models[0].id })
  await access.setProvider('anthropic')
  await Promise.all([access.loadModels(), access.loadModels()])
  assert.equal(calls.length, 1, 'managed requests never name a provider; pickers share one catalogue')
})

test('non-managed Connect waits for a provider, then refreshes models on provider changes', async () => {
  const { access, calls } = fixture(url => Response.json({ valid: true, managed: false,
    ...(url.searchParams.has('provider') ? { models: [{ id: `${url.searchParams.get('provider')}/model`, efforts: ['medium'] }] } : {}),
  }))
  access.setKey('direct-key')
  await access.connect()
  assert.equal(access.connected, true)
  assert.equal(access.managed, false)
  assert.equal(access.ready, false)
  assert.equal(calls.length, 1)
  await access.setProvider('anthropic')
  assert.equal(access.ready, true)
  assert.equal((await access.loadModels()).defaultModel, 'anthropic/model')
  await access.setProvider('openai')
  assert.equal((await access.loadModels()).defaultModel, 'openai/model')
  await access.setProvider('openai')
  assert.deepEqual(calls.map(call => call.url.search), ['', '?provider=anthropic', '?provider=openai'])
  access.setKey('changed-key')
  assert.equal(access.connected, false)
  assert.equal(access.ready, false)
  await access.setProvider('moonshot')
  await access.loadModels()
  assert.equal(calls.length, 3, 'key and provider edits send nothing until Connect')
  await access.connect()
  assert.deepEqual(calls.slice(3).map(call => call.url.search), ['', '?provider=moonshot'])
  access.setKey('')
  await access.connect()
  await access.setProvider('openrouter')
  assert.equal(calls.length, 5)
  assert.equal(access.ready, false)
})

test('unknown keys disconnect; HTTP and invalid catalogue errors cannot authorize scans', async () => {
  let reply = () => new Response(null, { status: 401 })
  const { access, calls } = fixture(() => reply())
  access.setKey('unknown')
  await access.connect()
  assert.equal(access.error, 'DeepView API key not recognized.')
  assert.equal(access.connected, false)
  await access.setProvider('openai')
  assert.equal(calls.length, 1)
  for (const body of [{ valid: false, managed: true, models }, { valid: true }, { valid: true, managed: true }, { valid: true, managed: true, models: [] }]) {
    reply = () => Response.json(body)
    await access.connect()
    assert.equal(access.connected, false)
    assert.equal(access.ready, false)
    assert.ok(access.error)
  }
  reply = () => Response.json({ valid: true, managed: false, models })
  await access.connect()
  assert.equal(access.ready, true)
  reply = () => new Response(null, { status: 400 })
  await access.setProvider('anthropic')
  assert.match(access.error, /HTTP 400/u)
  assert.equal(access.ready, false)
  reply = () => new Response(null, { status: 401 })
  await access.setProvider('moonshot')
  assert.equal(access.connected, false)
  assert.equal(access.ready, false)
  assert.equal(access.error, 'DeepView API key not recognized.')
  const last = calls.length
  await access.setProvider('openrouter')
  assert.equal(calls.length, last)
})

function deferredFixture() {
  const pending = []
  const data = fixture((url, options) => new Promise(resolve => { pending.push({ url, signal: options.signal, resolve: body => resolve(Response.json(body)) }) }))
  return { ...data, pending }
}

test('key edits and leaving or changing the service invalidate delayed discovery', async () => {
  const { access, pending, calls } = deferredFixture()
  access.setKey('old-key')
  const old = access.connect()
  assert.equal(access.loading, true)
  access.setKey('new-key')
  assert.equal(pending[0].signal.aborted, true)
  pending[0].resolve({ valid: true, managed: true, models })
  await old
  assert.equal(access.connected, false)
  assert.equal(access.ready, false)
  assert.equal(access.apiKey, 'new-key')
  const next = access.connect()
  access.reset('https://other.example/')
  pending[1].resolve({ valid: true, managed: true, models })
  await next
  assert.equal(access.connected, false)
  assert.equal(access.apiKey, '')
  assert.equal(access.provider, null)
  assert.equal(access.server, 'https://other.example/')
  assert.equal(calls.length, 2)
})

test('discovery uses the latest provider and delayed provider replies cannot replace newer models', async () => {
  const { access, pending } = deferredFixture()
  access.setKey('direct-key')
  await access.setProvider('anthropic')
  const connecting = access.connect()
  await access.setProvider('openai')
  assert.equal(pending.length, 1)
  pending[0].resolve({ valid: true, managed: false })
  await new Promise(resolve => { setImmediate(resolve) })
  assert.equal(pending[1].url.searchParams.get('provider'), 'openai')
  const changing = access.setProvider('moonshot')
  assert.equal(pending[1].signal.aborted, true)
  assert.equal(access.ready, false)
  pending[2].resolve({ valid: true, managed: false, models: [models[1]] })
  await changing
  pending[1].resolve({ valid: true, managed: false, models: [models[0]] })
  await connecting
  assert.deepEqual(access.catalogue.models, [models[1]])
  assert.equal(access.ready, true)
})

test('provider changes during managed discovery still finish with the managed catalogue', async () => {
  const { access, pending } = deferredFixture()
  access.setKey('managed-key')
  const connecting = access.connect()
  await access.setProvider('openai')
  pending[0].resolve({ valid: true, managed: true, models })
  await connecting
  assert.deepEqual((await access.loadModels()).models, models)
  assert.equal(pending.length, 1)
})

test('default and previous catalogues remain available throughout discovery, provider changes, and failures', async () => {
  const { access, pending, calls } = deferredFixture()
  const defaults = await access.loadModels()
  access.setKey('direct-key')
  const connecting = access.connect()
  assert.deepEqual(await access.loadModels(), defaults)
  assert.equal(access.ready, false)
  pending[0].resolve({ valid: true, managed: false })
  await connecting
  const loading = access.setProvider('anthropic')
  assert.deepEqual(await access.loadModels(), defaults)
  pending[1].resolve({ valid: true, managed: false, models })
  await loading
  const previous = await access.loadModels()
  const changing = access.setProvider('moonshot')
  assert.deepEqual(await access.loadModels(), previous)
  assert.equal(access.ready, false)
  pending[2].resolve({ valid: true, managed: false, models: [models[1]] })
  await changing
  assert.deepEqual((await access.loadModels()).models, [models[1]])
  const failed = access.setProvider('openai')
  pending[3].resolve({ valid: true, managed: false, models: [] })
  await failed
  assert.deepEqual((await access.loadModels()).models, [models[1]])
  assert.equal(access.ready, false)
  access.setKey('changed-key')
  assert.deepEqual((await access.loadModels()).models, [models[1]])
  assert.equal(calls.length, 4, 'reading displayed models never makes a request')
})
