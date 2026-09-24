import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadStatic } from '../server-e2e/static.ts'
import { bootServer } from './_helpers.js'

for (const configured of ['', 'https://scan.example:8443/prefix']) {
  test(`E2E discovery and CSP use runtime scan configuration (${configured || 'unset'})`, async (t) => {
    // CI runs tests without building out/. Give the static loader its own
    // source HTML fixture rather than depending on or modifying local builds.
    const assets = await mkdtemp(join(tmpdir(), 'scan-runtime-'))
    t.after(() => rm(assets, { recursive: true, force: true }))
    const original = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8')
    const index = join(assets, 'index.html')
    await writeFile(index, original)
    const server = await bootServer({ env: { DEEPVIEW_SCAN_SERVER: configured } })
    try {
      const info = await (await fetch(server.httpOrigin + '/api/config')).json()
      assert.deepEqual(info, { mode: 'e2e', managed: null, ...(configured ? { deepviewScanServer: configured + '/' } : {}) })
      const handleStatic = loadStatic(assets, info.deepviewScanServer ?? null)
      const serve = (headers = {}) => {
        let html, responseHeaders
        const consumed = handleStatic({ method: 'GET', url: '/', headers }, {
          writeHead(status, values) { assert.equal(status, 200); responseHeaders = values },
          end(body) { html = body.toString('utf8') },
        })
        assert.equal(consumed, true)
        return { html, headers: responseHeaders }
      }
      const response = serve({ 'x-forwarded-host': 'e2e.example', 'x-forwarded-proto': 'https' })
      const html = response.html
      assert.ok(html.includes(configured ? "connect-src 'self' https://scan.example:8443" : "connect-src 'self'\""))
      assert.equal(html.includes('deepview-scan-server'), false, 'E2E advertises through discovery, not dev metadata')
      const localhost = serve({ 'x-forwarded-host': 'localhost' })
      assert.equal(localhost.html.includes("connect-src 'self' http://127.0.0.1:3123"), false)
      const loopback = serve()
      assert.ok(loopback.html.includes(configured ? "connect-src 'self' https://scan.example:8443" : "connect-src 'self'\""))
      assert.equal(loopback.headers.etag, response.headers.etag, 'E2E has no host-specific scan override')
      assert.equal(await readFile(index, 'utf8'), original, 'runtime configuration never changes packaged files')
    } finally { await server.teardown() }
  })
}
