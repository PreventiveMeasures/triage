import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchReport, fetchTeamAnnotations } from '../client/managed/session.js'

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

test('team annotation transport validates batches and filters report views lazily', async t => {
  const controller = new AbortController()
  let body = { reports: { r: ['f', 'shared'], s: ['g', 'shared'], empty: [] },
    entries: { f: null, g: { color: 'red' }, shared: { fix: 'Shared' } },
    comments: [{ id: 'one', findingId: 'shared' }, { id: 'two', findingId: 'f' }, { id: 'three', findingId: 'g' }] }
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, '/api/teams/team%20id/annotations')
    assert.equal(options.signal, controller.signal)
    return Promise.resolve(Response.json(body))
  })
  const read = await fetchTeamAnnotations('team id', { signal: controller.signal })
  assert.deepEqual(read('r'), { entries: { f: null, shared: body.entries.shared }, comments: body.comments.slice(0, 2) })
  assert.deepEqual(read('s'), { entries: { g: body.entries.g, shared: body.entries.shared }, comments: [body.comments[0], body.comments[2]] })
  assert.equal(read('r').comments[0], read('s').comments[0], 'shared comment bodies stay shared in memory')
  assert.deepEqual(read('empty'), { entries: {}, comments: [] })
  assert.equal(read('missing'), null)
  assert.equal(read('toString'), null, 'inherited properties are not reports')
  for (body of [{}, { reports: [], entries: {}, comments: [] }, { reports: { r: [null] }, entries: {}, comments: [] },
    { reports: {}, entries: [], comments: [] }, { reports: {}, entries: {}, comments: [null] },
    { reports: {}, entries: {}, comments: [{}] }, { reports: {}, entries: {}, comments: null }]) {
    assert.equal(await fetchTeamAnnotations('team id', { signal: controller.signal }), null)
  }
})

test('focused annotation transport encodes its selector and forwards cancellation', async t => {
  const controller = new AbortController()
  const reportId = 'report /?&id'
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, '/api/teams/team%20id/annotations?reportId=report%20%2F%3F%26id')
    assert.equal(options.signal, controller.signal)
    assert.equal(Object.hasOwn(options, 'reportId'), false)
    return Promise.resolve(Response.json({ reports: { [reportId]: [] }, entries: {}, comments: [] }))
  })
  const read = await fetchTeamAnnotations('team id', { signal: controller.signal, reportId })
  assert.deepEqual(read(reportId), { entries: {}, comments: [] })
  assert.equal(read('unrelated'), null)
})

test('annotation projections use indexed comments and are reused by both report consumers', async t => {
  const commentCount = 400, reportCount = 100
  let findingReads = 0
  const comments = Array.from({ length: commentCount }, (_, i) => ({ id: `c${i}`,
    get findingId() { findingReads++; return `f${i % reportCount}` }, body: 'Comment' }))
  const reports = Object.fromEntries(Array.from({ length: reportCount }, (_, i) => [`r${i}`, [`f${i}`]]))
  const entries = Object.fromEntries(Array.from({ length: reportCount }, (_, i) => [`f${i}`, { color: 'red' }]))
  const body = { reports, entries, comments }
  t.mock.method(globalThis, 'fetch', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) }))
  const read = await fetchTeamAnnotations('team')
  const before = findingReads
  const first = read('r0')
  const second = read('r0')
  assert.equal(second, first, 'triage and comment consumers reuse the same report projection')
  for (let i = 0; i < reportCount; i++) {
    const report = read(`r${i}`)
    assert.deepEqual(report.comments.map(comment => comment.id), [i, i + 100, i + 200, i + 300].map(index => `c${index}`))
    assert.deepEqual(report.entries, { [`f${i}`]: { color: 'red' } })
  }
  assert.equal(findingReads, before, 'report reads do not scan unrelated comments')
})

test('repeated scans reuse projections while preserving comment order and batch isolation', async t => {
  const body = { reports: { first: ['b', 'a', 'a'], repeat: ['b', 'a', 'a'], restricted: ['b'], empty: [] },
    entries: { a: null, b: { fix: 'Shared' } },
    comments: [{ id: 'a1', findingId: 'a' }, { id: 'b1', findingId: 'b' }, { id: 'a2', findingId: 'a' }, { id: 'b2', findingId: 'b' }] }
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json(body)))
  const read = await fetchTeamAnnotations('team')
  assert.equal(read('first'), read('repeat'), 'identical repeated scans share entries and comment arrays')
  assert.deepEqual(read('first').comments, body.comments, 'wire order wins over report finding order; repeated IDs do not duplicate comments')
  assert.deepEqual(read('restricted').comments, [body.comments[1], body.comments[3]])
  assert.deepEqual(read('restricted').entries, { b: body.entries.b })
  assert.deepEqual(read('empty'), { entries: {}, comments: [] })
  const next = await fetchTeamAnnotations('team')
  assert.notEqual(next('first'), read('first'), 'a later batch cannot inherit stale projections')
})
