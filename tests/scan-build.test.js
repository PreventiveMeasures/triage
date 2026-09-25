import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { litSvgAsHtml } from '../build-lit-svg.js'
import { configuredScanServer, scanServerHtml } from '../server-common/scan-config.ts'
import { DEFAULT_SCAN_SERVER } from '../common/scan-server.ts'
import { availableScanServer } from '../ui/scan/availability.js'
import { scanServerRequest } from '../ui/scan/request.js'
import { fetchScanModels } from '../ui/view/scan-models.js'

test('scan availability follows runtime configuration and the exact loopback hostname', () => {
  const base = { hostname: 'example.com', serverMode: 'e2e', localMode: false }
  assert.equal(availableScanServer(base), null)
  for (const hostname of ['localhost', '::1', '127.0.0.2', '127.0.0.1.example.com']) assert.equal(availableScanServer({ ...base, hostname }), null)
  assert.equal(availableScanServer({ ...base, hostname: '127.0.0.1' }), null)
  assert.equal(availableScanServer({ ...base, serverMode: 'standalone', hostname: '127.0.0.1' }), DEFAULT_SCAN_SERVER)
  assert.equal(availableScanServer({ ...base, deepviewScanServer: 'https://scan.example/path' }), 'https://scan.example/path/')
  assert.equal(availableScanServer({ ...base, devServer: DEFAULT_SCAN_SERVER, deepviewScanServer: 'https://scan.example' }), 'https://scan.example/')
  assert.equal(availableScanServer({ ...base, devServer: DEFAULT_SCAN_SERVER }), null, 'dev metadata cannot override an E2E server')
  assert.equal(availableScanServer({ ...base, serverMode: 'standalone', devServer: DEFAULT_SCAN_SERVER }), DEFAULT_SCAN_SERVER)
  assert.equal(availableScanServer({ ...base, serverMode: 'managed', hostname: '127.0.0.1', devServer: DEFAULT_SCAN_SERVER }), null)
  assert.equal(availableScanServer({ ...base, serverMode: 'managed', localMode: true, hostname: '127.0.0.1' }), DEFAULT_SCAN_SERVER)
  assert.equal(availableScanServer({ ...base, serverMode: 'standalone', deepviewScanServer: 'https://scan.example' }), null)
})

test('runtime CSP grants only the configured origin and dev advertises its request prefix', async () => {
  const html = await readFile('ui/index.html', 'utf8')
  assert.equal(configuredScanServer(undefined), null)
  assert.equal(scanServerHtml(html, null), html)
  const server = configuredScanServer('https://scan.example:8443/deepview')
  assert.equal(server, 'https://scan.example:8443/deepview/')
  const expected = html.replace("connect-src 'self'", "connect-src 'self' https://scan.example:8443")
  assert.equal(scanServerHtml(html, server), expected)
  assert.ok(scanServerHtml(html, server, { advertise: true }).includes('<meta name="deepview-scan-server" content="https://scan.example:8443/deepview/">'))
  for (const url of ['host.invalid', 'javascript:alert(1)', 'https://user:password@scan.example', 'https://scan.example/?key=secret', 'https://scan.example/#fragment']) {
    assert.throws(() => configuredScanServer(url), /DEEPVIEW_SCAN_SERVER/u)
  }
})

test('Scans is always in the main bundle, without managed fixtures or transport', async () => {
  const { metafile } = await build({
    entryPoints: ['ui/view.js', 'ui/client-managed.js'], bundle: true, format: 'esm',
    outdir: 'out', write: false, loader: { '.css': 'text' }, plugins: [litSvgAsHtml], metafile: true,
  })
  const main = metafile.outputs['out/view.js'].inputs
  const managed = metafile.outputs['out/client-managed.js'].inputs
  assert.ok(main['ui/scan/page.js'])
  assert.ok(main['ui/view/scan-navigation.js'])
  assert.ok(main['ui/scan/default-models.js'])
  assert.equal(Object.hasOwn(main, 'ui/managed/pages.js'), false)
  assert.equal(Object.hasOwn(main, 'client/managed/request.js'), false)
  assert.equal(Object.hasOwn(main, 'ui/scan/fixtures.js'), false)
  assert.equal(Object.hasOwn(managed, 'ui/view/scan-local-source.js'), false)
  assert.ok(managed['ui/scan/page.js'])
  assert.equal(Object.hasOwn(managed, 'ui/view/scan-navigation.js'), false)
  assert.equal(Object.hasOwn(managed, 'ui/scan/default-models.js'), false)
})

test('model requests use only the configured scan service and explicit API key', async () => {
  const calls = []
  const network = (url, options) => {
    calls.push({ url: url.href, options })
    return Promise.resolve(Response.json({ models: [{ id: 'openai/test', efforts: ['low', 'max'] }] }))
  }
  const controller = new AbortController()
  const authenticated = scanServerRequest('https://scan.example/prefix/', network, 'test-key')
  const models = await fetchScanModels(controller.signal, authenticated)
  assert.equal(models.defaultModel, 'openai/test')
  assert.equal(calls[0].url, 'https://scan.example/prefix/api/admin/models')
  assert.equal(calls[0].options.headers.get('authorization'), 'Bearer test-key')
  assert.equal(calls[0].options.credentials, 'omit')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.signal, controller.signal)
  assert.throws(() => authenticated('https://other.example/models'), /configured server/u)
  assert.equal(calls.length, 1)
  await fetchScanModels(undefined, scanServerRequest('https://scan.example/', network))
  assert.equal(calls[1].options.headers.has('authorization'), false)
})
