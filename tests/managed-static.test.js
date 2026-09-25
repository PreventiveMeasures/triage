import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadManagedStatic } from '../server-managed/static.ts'
import { loadStatic } from '../server-e2e/static.ts'
import { MANAGED_PAGES } from '../common/managed/routes.js'

test('managed page GET/HEAD share HTML; API and missing assets never fall back; E2E unchanged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-static-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const html = '<!doctype html><html><head><link rel="modulepreload" href="./view.js"><script type="module" src="./view.js"></script></head><body>App</body></html>'
  await writeFile(join(dir, 'index.html'), html)
  await writeFile(join(dir, 'view.js'), 'export const app = true')
  const e2e = loadStatic(dir)
  const managed = loadManagedStatic(dir)
  const combined = loadManagedStatic(dir, { indexOnly: true })
  for (const [label, handler] of [['managed', managed], ['combined', (req, res) => combined(req, res) || e2e(req, res)], ['e2e', e2e]]) {
    const server = createServer((req, res) => { if (!handler(req, res)) { res.writeHead(404); res.end('not-found') } })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise(resolve => { server.close(resolve) }))
    const origin = `http://127.0.0.1:${server.address().port}`
    const root = await fetch(origin)
    const body = await root.text()
    for (const path of [...Object.values(MANAGED_PAGES), '/teams/t', '/teams/t/files', '/teams/t/reports/r', '/teams/t/reports/r/files', '/unknown-page']) {
      const response = await fetch(origin + path)
      if (label === 'e2e') { assert.equal(response.status, 404); continue }
      assert.equal(response.status, 200, path)
      assert.equal(await response.text(), body, path)
      assert.equal(response.headers.get('etag'), root.headers.get('etag'))
      assert.match(response.headers.get('link'), /<\/view.js>/u)
      const head = await fetch(origin + path, { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(await head.text(), '')
    }
    if (label === 'e2e') assert.doesNotMatch(body, /<base/u)
    else assert.match(body, /<base href="\/">/u)
    for (const path of ['/api', '/api/config', '/api/sync', '/api/unknown', '/%61pi/unknown', '/missing.js']) assert.equal((await fetch(origin + path)).status, 404, `${label} ${path}`)
    assert.equal(await (await fetch(`${origin}/view.js`)).text(), 'export const app = true')
    assert.equal((await fetch(`${origin}/manage`, { method: 'POST', body: 'x' })).status, 404)
  }
})
