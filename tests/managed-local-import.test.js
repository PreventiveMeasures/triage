import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import './_polyfills.js'
import { createManagedLocalImportSource } from '../client/managed/local-import.js'
import { ManagedLocalImport } from '../ui/managed/local-import.js'
import '../ui/client-managed.js'

function fixture({ encrypted = false, unlocked = false } = {}) {
  const listeners = new Set()
  const fileListeners = new Set()
  const calls = []
  const deps = {
    isEncryptionEnabled: () => encrypted,
    isUnlocked: () => unlocked,
    onVaultStateChange: callback => { listeners.add(callback); return () => listeners.delete(callback) },
    onFileMutated: callback => { fileListeners.add(callback); return () => fileListeners.delete(callback) },
    unlockEncryption: () => { calls.push('unlock'); return false },
    listFiles: () => { calls.push('listFiles'); return ['report.md'] },
    hasAnyBundles: () => { calls.push('hasAnyBundles'); return true },
    listBundles: () => { calls.push('listBundles'); return [{ name: 'source.map', integrity: 'sha512-test' }] },
    readFile: () => { calls.push('readFile'); return '# Report\nOriginal contents 🐈\n' },
    readBundle: () => { calls.push('readBundle'); return new Uint8Array([0, 128, 255, 7]) },
  }
  const source = createManagedLocalImportSource(deps)
  return {
    deps, source, calls, listeners, fileListeners,
    change(next) { unlocked = next; for (const callback of listeners) callback() },
    mutateFile(name, kind) { for (const callback of fileListeners) callback(name, kind) },
  }
}

test('locked local data is discoverable without decrypting metadata or reading content', async () => {
  const f = fixture({ encrypted: true })
  assert.equal(f.source.locked, true)
  assert.equal(await f.source.hasData('report'), true)
  assert.equal(await f.source.hasData('bundle'), true)
  for (const kind of ['report', 'bundle']) {
    await assert.rejects(f.source.list(kind), /locked/u)
    await assert.rejects(f.source.importItem(kind, 'anything', () => assert.fail('must not upload')), /locked/u)
  }
  assert.deepEqual(f.calls, ['listFiles', 'hasAnyBundles'])
  assert.equal(f.listeners.size, 0)
  assert.equal(f.fileListeners.size, 0)
})

test('passkeys are optional: plaintext reports and original bundle bytes import without an unlock', async () => {
  const f = fixture()
  assert.equal(f.source.locked, false, 'an absent session key does not gate unencrypted storage')
  for (const [kind, id, name, expected] of [
    ['report', 'report.md', 'report.md', new TextEncoder().encode('# Report\nOriginal contents 🐈\n')],
    ['bundle', 'sha512-test', 'source.map', new Uint8Array([0, 128, 255, 7])],
  ]) {
    assert.equal((await f.source.list(kind))[0].value, id)
    const result = await f.source.importItem(kind, id, async file => {
      assert.equal(file.name, name)
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), expected)
      return { ok: true }
    })
    assert.deepEqual(result, { ok: true })
  }
  assert.equal(f.calls.includes('unlock'), false)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.fileListeners.size, 0)
})

test('encrypted data only imports after successful unlock; cancellation stays locked', async () => {
  const f = fixture({ encrypted: true })
  assert.equal(await f.source.unlock(), false)
  await assert.rejects(f.source.list('bundle'), /locked/u)
  f.deps.unlockEncryption = () => { f.change(true); return true }
  assert.equal(await f.source.unlock(), true)
  let uploaded = false
  await f.source.importItem('bundle', 'sha512-test', () => { uploaded = true })
  assert.equal(uploaded, true)
})

test('empty local collections do not offer Import, including an empty bundle metadata file', async () => {
  const f = fixture()
  f.deps.listFiles = () => []
  f.deps.listBundles = () => []
  assert.equal(await f.source.hasData('report'), false)
  assert.equal(await f.source.hasData('bundle'), false)
})

test('removal, read failure and upload failure propagate without uploading a missing file', async () => {
  const f = fixture()
  await assert.rejects(f.source.importItem('report', 'removed.md', () => assert.fail('missing')), /no longer/u)
  f.deps.readFile = () => { throw new Error('read failed') }
  await assert.rejects(f.source.importItem('report', 'report.md', () => assert.fail('read failed')), /read failed/u)
  await assert.rejects(f.source.importItem('bundle', 'sha512-test', () => Promise.reject(new Error('HTTP 403'))), /HTTP 403/u)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.fileListeners.size, 0)
})

test('lock and vault identity changes during async reads prevent plaintext upload', async () => {
  for (const kind of ['report', 'bundle']) {
    for (const relock of [false, true]) {
      const f = fixture({ encrypted: true, unlocked: true })
      let finish
      f.deps[kind === 'report' ? 'readFile' : 'readBundle'] = () => new Promise(resolve => { finish = resolve })
      const pending = f.source.importItem(kind, kind === 'report' ? 'report.md' : 'sha512-test', () => assert.fail('must not upload'))
      await setImmediate()
      f.change(false)
      if (relock) f.change(true)
      finish(new Uint8Array([1]))
      await assert.rejects(pending, /locked or has changed/u)
      assert.equal(f.listeners.size, 0)
      assert.equal(f.fileListeners.size, 0)
    }
  }
})

test('a vault transition during listing discards the result; aborting a read prevents upload', async () => {
  const f = fixture({ encrypted: true, unlocked: true })
  f.deps.listBundles = () => { f.change(false); return [{ name: 'private.map', integrity: 'private' }] }
  await assert.rejects(f.source.list('bundle'), /locked or has changed/u)
  f.change(true)
  const abort = new AbortController()
  f.deps.readFile = () => { abort.abort(); return 'report' }
  await assert.rejects(f.source.importItem('report', 'report.md', () => assert.fail('must not upload'), { signal: abort.signal }), { name: 'AbortError' })
})

test('selected report changes during the choices check prevent reading and uploading it', async () => {
  const f = fixture()
  let finish
  f.deps.listFiles = () => new Promise(resolve => { finish = resolve })
  const pending = f.source.importItem('report', 'report.md', () => assert.fail('must not upload a changed report'))
  f.mutateFile('report.md', 'save')
  finish(['report.md'])
  await assert.rejects(pending, /report changed/u)
  assert.equal(f.calls.includes('readFile'), false)
  assert.equal(f.fileListeners.size, 0)
})

test('unrelated report mutations do not cancel imports and the guard detaches when upload starts', async () => {
  for (const kind of ['report', 'bundle']) {
    const f = fixture()
    let finishRead, finishUpload
    f.deps[kind === 'report' ? 'readFile' : 'readBundle'] = () => new Promise(resolve => { finishRead = resolve })
    let uploaded
    const pending = f.source.importItem(kind, kind === 'report' ? 'report.md' : 'sha512-test', file => {
      uploaded = file
      return new Promise(resolve => { finishUpload = resolve })
    })
    await setImmediate()
    f.mutateFile('unrelated.md', 'save')
    f.mutateFile('unrelated.md', 'delete')
    finishRead('selected contents')
    await setImmediate()
    assert.equal(await uploaded.text(), 'selected contents')
    assert.equal(f.listeners.size, 0)
    assert.equal(f.fileListeners.size, 0)
    f.mutateFile('report.md', 'delete')
    finishUpload('uploaded')
    assert.equal(await pending, 'uploaded')
  }
})

function controller(source, upload = () => {}) {
  const host = { localImportSource: source, addController() {}, requestUpdate() {} }
  const ui = new ManagedLocalImport(host, 'report', upload)
  ui.hostConnected()
  return ui
}

test('overwriting or deleting the selected report during a read cancels import when the UI clears selection', async () => {
  for (const kind of ['save', 'delete']) {
    const f = fixture()
    let finish, uploads = 0
    f.deps.readFile = () => new Promise(resolve => { finish = resolve })
    const ui = controller(f.source, () => { uploads++ })
    ui.toggle()
    await ui.refresh()
    ui.value = 'report.md'
    const pending = ui.importSelected()
    await setImmediate()
    f.mutateFile('report.md', kind)
    assert.equal(ui.value, null)
    finish('old snapshot')
    await pending
    await setImmediate() // Allow the mutation-triggered option refresh to finish.
    assert.equal(uploads, 0)
    assert.match(ui.error, /report changed/u)
    assert.equal(ui.success, '')
    assert.equal(ui.busy, false)
    assert.equal(f.fileListeners.size, 1, 'only the UI subscription remains')
    ui.hostDisconnected()
    assert.equal(f.listeners.size, 0)
    assert.equal(f.fileListeners.size, 0)
  }
})

test('import UI refreshes after unlock and clears names immediately when local data locks', async () => {
  const f = fixture({ encrypted: true })
  const ui = controller(f.source)
  await ui.refresh()
  assert.equal(ui.hasData, true)
  ui.toggle()
  await ui.refresh()
  assert.deepEqual(ui.options, [])
  assert.equal(f.calls.includes('readFile'), false)
  await ui.unlock() // cancellation
  assert.equal(ui.busy, false)
  assert.equal(ui.error, '')
  f.deps.unlockEncryption = () => { f.change(true); return true }
  await ui.unlock()
  assert.equal(ui.options[0].label, 'report.md')
  ui.value = 'report.md'
  f.change(false)
  assert.deepEqual(ui.options, [])
  assert.equal(ui.value, null)
  ui.hostDisconnected()
  assert.equal(f.listeners.size, 0)
  assert.equal(f.fileListeners.size, 0)
})

test('import UI exposes upload errors, allows retry, and cannot upload twice while busy', async () => {
  const f = fixture()
  let finish
  let uploads = 0
  const ui = controller(f.source, () => { uploads++; return new Promise((resolve, reject) => { finish = { resolve, reject } }) })
  ui.toggle()
  await ui.refresh()
  ui.value = 'report.md'
  const pending = ui.importSelected()
  await ui.importSelected()
  await setImmediate()
  assert.equal(uploads, 1)
  finish.reject(new Error('Upload denied'))
  await pending
  assert.equal(ui.error, 'Upload denied')
  assert.equal(ui.busy, false)
  const retry = ui.importSelected()
  await setImmediate()
  finish.resolve()
  await retry
  assert.equal(ui.error, '')
  assert.equal(ui.success, 'Imported report.md.')
  assert.equal(ui.value, null)
  ui.hostDisconnected()
})

test('leaving the page while reading local data aborts import and detaches listeners', async () => {
  const f = fixture()
  let finish
  f.deps.readFile = () => new Promise(resolve => { finish = resolve })
  const ui = controller(f.source, () => assert.fail('must not upload after navigation'))
  ui.toggle()
  await ui.refresh()
  ui.value = 'report.md'
  const pending = ui.importSelected()
  await setImmediate()
  ui.hostDisconnected()
  finish('report')
  await pending
  assert.equal(ui.success, '')
  assert.equal(ui.error, '')
  assert.equal(f.listeners.size, 0)
  assert.equal(f.fileListeners.size, 0)
})

test('both managed pages send selected local files through their authenticated upload routes', async (t) => {
  for (const kind of ['report', 'bundle']) {
    const f = fixture()
    const Page = customElements.get(`managed-admin-${kind}s`)
    const page = new Page()
    page._csrf = 'test-csrf'
    page._repoId = 101
    page.localImportSource = f.source
    const posts = []
    const fetch = t.mock.method(globalThis, 'fetch', (url, options = {}) => {
      if (options.method === 'POST') {
        posts.push({ url, options })
        return Promise.resolve(Response.json({ ok: true }))
      }
      return Promise.resolve(Response.json(url === '/api/auth/session'
        ? { user: { role: 'admin' }, csrfToken: 'test-csrf' }
        : { [`${kind}s`]: [], repos: [] }))
    })
    const ui = page._localImport
    ui.connectSource()
    ui.toggle()
    await ui.refresh()
    ui.value = ui.options[0].value
    await ui.importSelected()
    assert.equal(ui.error, '')
    assert.equal(posts.length, 1)
    const { url, options } = posts[0]
    assert.equal(url, `/api/admin/${kind}s`)
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.headers['x-csrf-token'], 'test-csrf')
    assert.equal(options.headers['x-repo-id'], '101')
    assert.equal(options.headers[`x-${kind}-filename`], kind === 'report' ? 'report.md' : 'source.map')
    assert.equal(options.body instanceof File, true)
    assert.equal(page._busy, false)
    ui.hostDisconnected()
    fetch.mock.restore()
  }
})
