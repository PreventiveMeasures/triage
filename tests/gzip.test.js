// Coverage for the centralised gzip helpers — specifically the
// `maxBytes` decompression cap on `gunzipBytes`. Gzip expands up to
// ~1032:1, so a small hostile payload can balloon to GiBs before any
// content validation runs; `client/sync/sync-crypto.ts` passes the cap
// when decompressing inbound (peer-controlled) changesets so a bomb
// fails at the budget instead of OOMing the tab. Uncapped callers
// (storage, export/import — local trusted bytes) keep the one-shot
// read; both paths must yield identical bytes for sane input.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { gunzipBytes, gzipBytes } from '../common/gzip.js'

describe('gunzipBytes maxBytes cap', () => {
  it('uncapped round-trip is unchanged', async () => {
    const data = new Uint8Array(1024).fill(7)
    assert.deepEqual(await gunzipBytes(await gzipBytes(data)), data)
  })

  it('capped read yields identical bytes when within budget', async () => {
    // Multi-chunk shape (1 MiB spans several DecompressionStream
    // chunks) so the capped path's concat logic is exercised, not just
    // the single-chunk trivial case.
    const data = new Uint8Array(1024 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = i % 251
    const gz = await gzipBytes(data)
    assert.deepEqual(await gunzipBytes(gz, { maxBytes: 2 * 1024 * 1024 }), data)
  })

  it('rejects a payload expanding past the cap (decompression bomb)', async () => {
    // 8 MiB of zeros gzips to a few KiB — the classic bomb ratio. The
    // capped read must throw once the budget is crossed, NOT
    // materialise the full expansion first.
    const bomb = await gzipBytes(new Uint8Array(8 * 1024 * 1024))
    assert.ok(bomb.length < 64 * 1024, `bomb is small on the wire (${bomb.length}B)`)
    await assert.rejects(
      gunzipBytes(bomb, { maxBytes: 1024 * 1024 }),
      /decompressed size exceeds/u,
    )
  })

  it('cap exactly at the decompressed size passes (boundary)', async () => {
    const data = new Uint8Array(4096).fill(3)
    const gz = await gzipBytes(data)
    assert.deepEqual(await gunzipBytes(gz, { maxBytes: 4096 }), data)
  })
})
