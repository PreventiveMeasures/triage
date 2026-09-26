import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchReport } from '../client/managed/session.js'

test('managed report loads request content with the server repository assignment', async (t) => {
  const body = { data: { repo: { github: 'wrong/embedded' }, findings: [] }, repo: { github: 'server/assigned', directory: 'packages/ui' } }
  const fetch = t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, '/api/reports/report%20id')
    assert.equal(options.headers.accept, 'application/json')
    assert.equal(options.credentials, 'same-origin')
    return Promise.resolve(Response.json(body))
  })
  assert.deepEqual(await fetchReport('report id'), body)
  body.repo = { github: null, directory: '' }
  assert.deepEqual(await fetchReport('report id'), body, 'explicitly unassigned is a valid server answer')
  assert.equal(fetch.mock.callCount(), 2)
})

test('managed report loads never fall back to report metadata when the response lacks its assignment', async (t) => {
  let response
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(response))
  for (const body of [null, {}, { data: {} }, { data: { findings: [] }, repo: {} }, { data: { findings: [] }, repo: { github: 7, directory: '' } },
    { content: '{"findings":[]}', repo: { github: null, directory: '' } }]) {
    response = Response.json(body)
    assert.equal(await fetchReport('id'), null)
  }
  response = new Response('{"findings":[]}', { status: 200 })
  assert.equal(await fetchReport('id'), null, 'legacy raw content cannot override the server assignment')
  for (const status of [401, 403, 404, 503]) {
    response = new Response(null, { status })
    assert.equal(await fetchReport('id'), null)
  }
})
