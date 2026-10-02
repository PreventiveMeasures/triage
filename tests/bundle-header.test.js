import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brotliCompressSync } from 'node:zlib'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleRepo } from '../server-managed/bundle.ts'

const compressed = text => brotliCompressSync(Buffer.from(text))
const repo = { github: 'org/repo', directory: 'packages/app' }

test('reads a Stasis origin header without parsing the source body', async () => {
  const header = new Bundle({ repo, package: { npm: { name: 'app', version: '1' } } }).serialize()
  assert.deepEqual(await bundleRepo(compressed(header)), repo)
  // The valid header is sufficient even when a large source body cannot parse.
  const invalidTail = `{"version":1,"config":{"scope":"full"},"repo":${JSON.stringify(repo)},"sources":${'!'.repeat(100_000)}}`
  assert.deepEqual(await bundleRepo(compressed(invalidTail)), repo)
})

test('ignores nested repo fields and origins after the header ends', async () => {
  for (const data of [
    { version: 1, config: { scope: 'full', repo }, sources: {}, repo },
    { version: 1, config: { scope: 'full' }, entries: [], repo },
    { version: 1, config: { scope: 'full' }, package: { npm: { name: 'app' } }, sources: {} },
  ]) assert.equal(await bundleRepo(compressed(JSON.stringify(data))), null)
})

test('handles chunk boundaries, escaped strings and UTF-8 in preceding metadata', async () => {
  const data = { version: 1, config: { scope: 'full', note: `"repo":{${'€😀\\"'.repeat(1400)}}` }, package: { npm: { name: 'app' } }, repo, sources: {} }
  assert.deepEqual(await bundleRepo(compressed(JSON.stringify(data))), repo)
})

test('bounds header decoding and tolerates invalid or absent metadata', async () => {
  for (const text of ['not json', '[]', '{"repo":null}', '{"repo":[]}', '{"repo":"org/repo"}',
    '{"repo":', new Bundle().serialize(), JSON.stringify({ config: { note: 'x'.repeat(70_000) }, repo })]) {
    assert.equal(await bundleRepo(compressed(text)), null)
  }
  assert.equal(await bundleRepo(Buffer.from('not brotli')), null)
})
