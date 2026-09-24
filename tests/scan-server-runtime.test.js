import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { bootServer } from './_helpers.js'

for (const configured of ['', 'https://scan.example:8443/prefix']) {
  test(`E2E discovery and CSP use runtime scan configuration (${configured || 'unset'})`, async () => {
    const original = await readFile('out/index.html', 'utf8')
    const server = await bootServer({ env: { DEEPVIEW_SCAN_SERVER: configured } })
    try {
      const info = await (await fetch(server.httpOrigin + '/api/config')).json()
      assert.deepEqual(info, { mode: 'e2e', managed: null, ...(configured ? { deepviewScanServer: configured + '/' } : {}) })
      const response = await fetch(server.httpOrigin, { headers: { 'x-forwarded-host': 'e2e.example', 'x-forwarded-proto': 'https' } })
      const html = await response.text()
      assert.ok(html.includes(configured ? "connect-src 'self' https://scan.example:8443" : "connect-src 'self'\""))
      assert.equal(html.includes('deepview-scan-server'), false, 'E2E advertises through discovery, not dev metadata')
      const localhost = await (await fetch(server.httpOrigin, { headers: { 'x-forwarded-host': 'localhost' } })).text()
      assert.equal(localhost.includes("connect-src 'self' http://127.0.0.1:3123"), false)
      const loopback = await fetch(server.httpOrigin)
      const loopbackHtml = await loopback.text()
      assert.ok(loopbackHtml.includes(configured ? "connect-src 'self' https://scan.example:8443" : "connect-src 'self'\""))
      assert.equal(loopback.headers.get('etag'), response.headers.get('etag'), 'E2E has no host-specific scan override')
      assert.equal(await readFile('out/index.html', 'utf8'), original, 'runtime configuration never changes packaged files')
    } finally { await server.teardown() }
  })
}
