import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { githubJson } from '../server-managed/github-app.ts'
import { githubGraphql } from '../server-managed/repository-history.ts'

const url = 'https://api.github.com/repos/org/repo'
const query = 'query($name: String!) { repository(owner: "org", name: $name) { id } }'

test('overlapping GitHub GETs share the complete body read, then subsequent reads ask again', async () => {
  const body = Promise.withResolvers()
  let calls = 0
  const fetch = () => {
    calls++
    return Promise.resolve({ ok: true, status: 200, json: () => body.promise })
  }
  const first = githubJson(url, 'alice', fetch)
  await setImmediate()
  const second = githubJson(url, 'alice', fetch)
  assert.equal(calls, 1, 'headers arriving does not end the shared read')
  body.resolve({ permissions: { pull: true } })
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  a.permissions.pull = false
  assert.equal(b.permissions.pull, true, 'each caller owns its parsed answer')
  await githubJson(url, 'alice', fetch)
  assert.equal(calls, 2, 'no completed answers are cached, including access rechecks')
})

test('GitHub GET sharing is scoped to the exact URL, token and transport', async () => {
  const gate = Promise.withResolvers()
  const calls = []
  const fetch = async (input, options) => {
    calls.push([input, options.headers.authorization])
    await gate.promise
    return Response.json({ read: true })
  }
  const otherFetch = (input, options) => fetch(input, options)
  const reads = [
    githubJson(url, 'alice', fetch), githubJson(url, 'alice', fetch),
    githubJson(url, 'bob', fetch), githubJson(url, null, fetch),
    githubJson(`${url}?page=2`, 'alice', fetch), githubJson(url, 'alice', otherFetch),
  ]
  gate.resolve()
  await Promise.all(reads)
  assert.equal(calls.length, 5)
})

test('a GET GitHub answered with an ETag is asked again If-None-Match, a 304 answered by the body kept; by its URL, token and transport', async () => {
  const asked = []
  let body = { name: 'one' }, etag = 'W/"one"'
  const fetch = (input, options) => {
    asked.push([input, options.headers.authorization ?? null, options.headers['if-none-match'] ?? null])
    if (options.headers['if-none-match'] === etag) return Promise.resolve(new Response(null, { status: 304, headers: { etag } }))
    return Promise.resolve(Response.json(body, { headers: { etag } }))
  }
  const first = await githubJson(url, 'alice', fetch)
  first.name = 'changed by its caller'
  assert.deepEqual(await githubJson(url, 'alice', fetch), { name: 'one' }, 'not modified: the body kept, each caller its own')
  assert.deepEqual(asked.at(-1), [url, 'Bearer alice', 'W/"one"'])
  await githubJson(url, 'bob', fetch)
  await githubJson(`${url}?page=2`, 'alice', fetch)
  await githubJson(url, 'alice', (input, options) => fetch(input, options))
  assert.deepEqual(asked.slice(2).map(([, , tag]) => tag), [null, null, null], 'another token, URL or transport its own')
  ;[body, etag] = [{ name: 'two' }, 'W/"two"']
  assert.deepEqual(await githubJson(url, 'alice', fetch), { name: 'two' }, 'modified: read whole, and kept by its new ETag')
  assert.deepEqual(await githubJson(url, 'alice', fetch), { name: 'two' })
  assert.equal(asked.at(-1)[2], 'W/"two"')
  // A POST is never asked so.
  await githubJson(url, 'alice', fetch, 'POST', { name: 'post' })
  await githubJson(url, 'alice', fetch, 'POST', { name: 'post' })
  assert.equal(asked.at(-1)[2], null)
})

test('a GET GitHub refuses after answering it with an ETag is refused, its body kept not answered', async () => {
  let refuse = false
  const fetch = (input, options) => Promise.resolve(refuse ? Response.json({ message: 'Not Found' }, { status: 404 })
    : options.headers['if-none-match'] ? new Response(null, { status: 304 }) : Response.json({ name: 'one' }, { headers: { etag: '"one"' } }))
  await githubJson(url, 'alice', fetch)
  refuse = true
  await assert.rejects(githubJson(url, 'alice', fetch), { status: 404 })
  // One not answered with an ETag is not kept: a 304 to it, never asked for, is a failure.
  const untagged = (input, options) => Promise.resolve(options.headers['if-none-match'] ? new Response(null, { status: 304 }) : Response.json({ name: 'two' }))
  await githubJson(`${url}/untagged`, 'alice', untagged)
  assert.deepEqual(await githubJson(`${url}/untagged`, 'alice', untagged), { name: 'two' })
})

test('a full pending-read map lets new reads proceed without evicting work already shared', async () => {
  const gate = Promise.withResolvers()
  let calls = 0
  const fetch = async () => { calls++; await gate.promise; return Response.json({ ok: true }) }
  const reads = Array.from({ length: 1001 }, (_, index) => githubJson(`${url}?page=${index}`, 'alice', fetch))
  reads.push(githubJson(`${url}?page=0`, 'alice', fetch), githubJson(`${url}?page=1000`, 'alice', fetch))
  const started = calls
  gate.resolve()
  await Promise.all(reads)
  assert.equal(started, 1002, 'the overflow read proceeds independently; the first still shares')
})

for (const failure of ['network', '401', '429', 'json', 'body']) {
  test(`a shared GitHub ${failure} failure releases the read for a retry`, async () => {
    const gate = Promise.withResolvers()
    let calls = 0, failed = true
    const fetch = async () => {
      calls++
      await gate.promise
      if (!failed) return Response.json({ recovered: true })
      if (failure === 'network') throw new TypeError('offline')
      if (failure === 'json') return new Response('not JSON')
      if (failure === 'body') return { ok: true, status: 200, json: () => Promise.reject(new TypeError('terminated')) }
      return Response.json({ message: 'refused' }, { status: Number(failure), headers: { 'retry-after': '1' } })
    }
    const reads = Promise.allSettled([githubJson(url, 'alice', fetch), githubJson(url, 'alice', fetch)])
    gate.resolve()
    const answers = await reads
    assert.equal(calls, 1)
    assert.ok(answers.every(answer => answer.status === 'rejected'))
    assert.equal(answers[0].reason.message, answers[1].reason.message)
    failed = false
    assert.deepEqual(await githubJson(url, 'alice', fetch), { recovered: true })
    assert.equal(calls, 2)
  })
}

test('GraphQL queries share matching reads but keep variables, tokens and error policies separate', async () => {
  const gate = Promise.withResolvers()
  let calls = 0
  const fetch = async () => {
    calls++
    await gate.promise
    return Response.json({ data: { repository: { id: 'one' } }, errors: [{ type: 'FORBIDDEN', path: ['repository', 'checks'] }] })
  }
  const allow = () => true
  const reads = Promise.allSettled([
    githubGraphql(query, { name: 'repo' }, 'alice', fetch, allow),
    githubGraphql(query, { name: 'repo' }, 'alice', fetch),
    githubGraphql(query, { name: 'another' }, 'alice', fetch, allow),
    githubGraphql(query, { name: 'repo' }, 'bob', fetch, allow),
    githubGraphql(query + ' ', { name: 'repo' }, 'alice', fetch, allow),
  ])
  gate.resolve()
  const answers = await reads
  assert.equal(calls, 4)
  assert.deepEqual(answers[0].value, { repository: { id: 'one' } })
  assert.equal(answers[1].status, 'rejected', 'each caller applies its own tolerated errors')
  assert.equal(answers[1].reason.message, 'github-status-403')
  await githubGraphql(query, { name: 'repo' }, 'alice', fetch, allow)
  assert.equal(calls, 5, 'a finished query is read again')
})

test('POST requests, including GraphQL mutations, are never implicitly shared', async () => {
  const gate = Promise.withResolvers()
  let calls = 0
  const fetch = async () => { calls++; await gate.promise; return Response.json({ ok: true }) }
  const mutation = { query: 'mutation { updateIssue(input: { id: "issue", title: "Title" }) { clientMutationId } }' }
  const reads = [
    ...Array.from({ length: 2 }, () => githubJson(url, 'alice', fetch, 'POST', { title: 'Title' })),
    ...Array.from({ length: 2 }, () => githubJson('https://api.github.com/graphql', 'alice', fetch, 'POST', mutation)),
  ]
  gate.resolve()
  await Promise.all(reads)
  assert.equal(calls, 4)
})
