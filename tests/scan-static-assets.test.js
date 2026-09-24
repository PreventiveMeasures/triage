import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadStatic } from '../server-e2e/static.ts'

test('static serving includes top-level SVGs without opening subdirectories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-assets-'))
  try {
    await mkdir(join(dir, 'provider-icons'))
    await mkdir(join(dir, 'private'))
    await writeFile(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await writeFile(join(dir, 'provider-icons/openai.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await writeFile(join(dir, 'provider-icons/private.txt'), 'private')
    await writeFile(join(dir, 'private/key.svg'), 'private')
    await symlink(join(dir, 'private/key.svg'), join(dir, 'provider-icons/link.svg'))
    const handle = loadStatic(dir)
    let body, headers
    const response = { writeHead: (status, value) => { assert.equal(status, 200); headers = value }, end: value => { body = value } }
    assert.equal(handle({ method: 'GET', url: '/icon.svg', headers: {} }, response), true)
    assert.equal(headers['content-type'], 'image/svg+xml')
    assert.match(body.toString(), /<svg/u)
    assert.equal(headers['content-security-policy'], "default-src 'none'")
    for (const url of ['/provider-icons/openai.svg', '/provider-icons/private.txt', '/provider-icons/link.svg', '/private/key.svg', '/provider-icons/../private/key.svg', '/provider-icons/%2e%2e/private/key.svg']) {
      assert.equal(handle({ method: 'GET', url, headers: {} }, response), false, url)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
