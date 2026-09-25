import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import './_polyfills.js'
import { createManagedLocalImportSource } from '../client/managed/local-import.js'
import { LINKS_KIND } from '../client/linked-findings.js'
import { ManagedLocalImport } from '../ui/managed/local-import.js'
import '../ui/client-managed.js'

function fixture({ encrypted = false, unlocked = false } = {}) {
  const listeners = new Set()
  const fileListeners = new Set()
  const bundleListeners = new Set()
  const calls = []
  const deps = {
    withStoredItem: (_kind, _value, work) => work(),
    isEncryptionEnabled: () => encrypted,
    isUnlocked: () => unlocked,
    onVaultStateChange: callback => { listeners.add(callback); return () => listeners.delete(callback) },
    onFileMutated: callback => { fileListeners.add(callback); return () => fileListeners.delete(callback) },
    onBundleMutated: callback => { bundleListeners.add(callback); return () => bundleListeners.delete(callback) },
    unlockEncryption: () => { calls.push('unlock'); return false },
    listFiles: () => { calls.push('listFiles'); return ['report.md'] },
    getKind: () => undefined,
    getFileKinds: names => new Map(names.map(name => [name, deps.getKind(name)])),
    hasStoredBundleBytes: () => { calls.push('hasStoredBundleBytes'); return true },
    listBundles: () => { calls.push('listBundles'); return [{ name: 'source.map', integrity: 'sha512-test' }] },
    readFile: () => { calls.push('readFile'); return '# Report\nOriginal contents 🐈\n' },
    readBundle: () => { calls.push('readBundle'); return new Uint8Array([0, 128, 255, 7]) },
  }
  const source = createManagedLocalImportSource(deps)
  return {
    deps, source, calls, listeners, fileListeners, bundleListeners,
    change(next) { unlocked = next; for (const callback of listeners) callback() },
    mutateFile(name, kind) { for (const callback of fileListeners) callback(name, kind) },
    mutateBundle(integrity, kind) { for (const callback of bundleListeners) callback(integrity, kind) },
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
  assert.deepEqual(f.calls, ['listFiles', 'hasStoredBundleBytes'])
  assert.equal(f.listeners.size, 0)
  assert.equal(f.fileListeners.size, 0)
  assert.equal(f.bundleListeners.size, 0)
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
  assert.equal(f.bundleListeners.size, 0)
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

test('report imports exclude known links while preserving reports with known and unknown kinds', async () => {
  const f = fixture()
  f.deps.listFiles = () => ['report.md', 'native.json', 'legacy.json', 'links.json']
  f.deps.getKind = name => ({ 'report.md': 'deepsec', 'native.json': null, 'links.json': LINKS_KIND })[name]
  assert.equal(await f.source.hasData('report'), true)
  assert.deepEqual((await f.source.list('report')).map(option => option.value), ['report.md', 'native.json', 'legacy.json'])
  await assert.rejects(f.source.importItem('report', 'links.json', () => assert.fail('must not upload links')), /no longer/u)
  assert.equal(f.calls.includes('readFile'), false, 'known links are excluded before reading their contents')
  f.deps.getKind = () => LINKS_KIND
  await assert.rejects(f.source.importItem('report', 'report.md', () => assert.fail('must revalidate the selected kind')), /no longer/u)
})

test('links-only local storage does not show report Import or ask to unlock', async () => {
  for (const encrypted of [false, true]) {
    const f = fixture({ encrypted })
    f.deps.listFiles = () => ['links.json']
    f.deps.getKind = () => LINKS_KIND
    const ui = controller(f.source)
    try {
      await ui.refresh()
      assert.equal(ui.hasData, false)
      assert.equal(await f.source.hasData('report'), false)
      assert.equal(f.calls.includes('readFile'), false)
      assert.equal(f.calls.includes('unlock'), false)
    } finally { ui.hostDisconnected() }
  }
})

test('a links file with a missing or stale kind cache cannot reach the report upload', async () => {
  for (const cachedKind of [undefined, 'deepsec']) {
    const f = fixture()
    f.deps.getKind = () => cachedKind
    f.deps.readFile = () => '[[{"id":"one"},{"id":"two"}]]'
    await assert.rejects(f.source.importItem('report', 'report.md', () => assert.fail('must not upload links')), /Links files cannot be imported as reports/u)
  }
})

test('removal, read failure and upload failure propagate without uploading a missing file', async () => {
  const f = fixture()
  await assert.rejects(f.source.importItem('report', 'removed.md', () => assert.fail('missing')), /no longer/u)
  f.deps.readFile = () => { throw new Error('read failed') }
  await assert.rejects(f.source.importItem('report', 'report.md', () => assert.fail('read failed')), /read failed/u)
  await assert.rejects(f.source.importItem('bundle', 'sha512-test', () => Promise.reject(new Error('HTTP 403'))), /HTTP 403/u)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.fileListeners.size, 0)
  assert.equal(f.bundleListeners.size, 0)
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
      assert.equal(f.bundleListeners.size, 0)
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
  assert.equal(f.bundleListeners.size, 0)
})

test('unrelated item mutations do not cancel imports and the guard detaches when upload starts', async () => {
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
    f.mutateBundle('sha512-unrelated', 'save')
    f.mutateBundle('sha512-unrelated', 'delete')
    if (kind === 'report') f.mutateBundle('report.md', 'delete')
    else f.mutateFile('sha512-test', 'delete')
    finishRead('selected contents')
    await setImmediate()
    assert.equal(await uploaded.text(), 'selected contents')
    assert.equal(f.listeners.size, 0)
    assert.equal(f.fileListeners.size, 0)
    assert.equal(f.bundleListeners.size, 0)
    f.mutateFile('report.md', 'delete')
    f.mutateBundle('sha512-test', 'delete')
    finishUpload('uploaded')
    assert.equal(await pending, 'uploaded')
  }
})

function controller(source, upload = () => {}, kind = 'report') {
  const host = { localImportSource: source, addController() {}, requestUpdate() {} }
  const ui = new ManagedLocalImport(host, kind, upload)
  ui.hostConnected()
  return ui
}

test('unrelated mutations preserve the picker and pending imports through the UI subscription', async () => {
  for (const kind of ['report', 'bundle']) {
    const f = fixture()
    const selected = kind === 'report' ? 'report.md' : 'sha512-test'
    const label = kind === 'report' ? 'report.md' : 'source.map'
    const read = Promise.withResolvers()
    f.deps[kind === 'report' ? 'readFile' : 'readBundle'] = () => read.promise
    let uploaded
    const ui = controller(f.source, file => { uploaded = file }, kind)
    try {
      ui.toggle()
      await ui.refresh()
      ui.value = selected
      const pending = ui.importSelected()
      await setImmediate()
      for (const mutation of ['save', 'delete']) {
        f.mutateFile('unrelated.md', mutation)
        f.mutateBundle('sha512-unrelated', mutation)
        // An identical identifier in the other collection is also unrelated.
        if (kind === 'report') f.mutateBundle(selected, mutation)
        else f.mutateFile(selected, mutation)
        await setImmediate()
        assert.equal(ui.value, selected)
        assert.equal(ui.error, '')
        assert.equal(ui.readAbort.signal.aborted, false)
      }
      read.resolve('selected contents')
      await pending
      assert.equal(await uploaded.text(), 'selected contents')
      assert.equal(ui.success, `Imported ${label}.`)
      assert.equal(ui.busy, false)
    } finally { ui.hostDisconnected() }
    assert.equal(f.listeners.size, 0)
    assert.equal(f.fileListeners.size, 0)
    assert.equal(f.bundleListeners.size, 0)
  }
})

test('unrelated collection updates refresh choices without clearing the current selection', async () => {
  for (const kind of ['report', 'bundle']) {
    const f = fixture()
    const selected = kind === 'report' ? 'report.md' : 'sha512-test'
    const added = kind === 'report' ? 'added.md' : 'sha512-added'
    const mutate = kind === 'report' ? f.mutateFile : f.mutateBundle
    const ui = controller(f.source, undefined, kind)
    try {
      ui.toggle()
      await ui.refresh()
      ui.value = selected
      const list = kind === 'report' ? 'listFiles' : 'listBundles'
      const original = f.deps[list]
      f.deps[list] = () => [...original(), kind === 'report' ? added : { name: 'added.map', integrity: added }]
      mutate(added, 'save')
      await setImmediate()
      assert.equal(ui.value, selected)
      assert.deepEqual(ui.options.map(option => option.value), [selected, added])
      f.deps[list] = original
      mutate(added, 'delete')
      await setImmediate()
      assert.equal(ui.value, selected)
      assert.deepEqual(ui.options.map(option => option.value), [selected])
    } finally { ui.hostDisconnected() }
  }
})

test('bundle deletion during the choices check prevents reading and uploading its old entry', async () => {
  const f = fixture()
  let finish
  f.deps.listBundles = () => new Promise(resolve => { finish = resolve })
  const pending = f.source.importItem('bundle', 'sha512-test', () => assert.fail('must not upload a deleted bundle'))
  f.mutateBundle('sha512-test', 'delete')
  finish([{ name: 'source.map', integrity: 'sha512-test' }])
  await assert.rejects(pending, /bundle changed/u)
  assert.equal(f.calls.includes('readBundle'), false)
  assert.equal(f.bundleListeners.size, 0)
})

test('bundle mutations clear the picker and prevent an in-flight snapshot from being uploaded', async () => {
  for (const kind of ['save', 'delete']) {
    const f = fixture()
    let finish, uploads = 0
    f.deps.readBundle = () => new Promise(resolve => { finish = resolve })
    const ui = controller(f.source, () => { uploads++ }, 'bundle')
    ui.toggle()
    await ui.refresh()
    ui.value = 'sha512-test'
    const pending = ui.importSelected()
    await setImmediate()
    f.mutateBundle('sha512-test', kind)
    assert.equal(ui.value, null)
    finish(new Uint8Array([1]))
    await pending
    await setImmediate()
    assert.equal(uploads, 0)
    assert.match(ui.error, /bundle changed/u)
    assert.equal(ui.success, '')
    assert.equal(ui.busy, false)
    assert.equal(f.bundleListeners.size, 1, 'only the UI subscription remains')
    ui.hostDisconnected()
    assert.equal(f.listeners.size, 0)
    assert.equal(f.fileListeners.size, 0)
    assert.equal(f.bundleListeners.size, 0)
  }
})

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
    assert.equal(f.bundleListeners.size, 0)
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
  assert.equal(f.bundleListeners.size, 0)
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
  assert.equal(f.bundleListeners.size, 0)
})

test('cross-tab refresh signals cancel pending snapshot imports for reports and bundles', async () => {
  for (const kind of ['report', 'bundle']) {
    for (const event of ['focus', 'storage']) {
      const f = fixture()
      let finish, uploads = 0
      f.deps[kind === 'report' ? 'readFile' : 'readBundle'] = () => new Promise(resolve => { finish = resolve })
      const ui = controller(f.source, () => { uploads++ }, kind)
      try {
        ui.toggle()
        await ui.refresh()
        ui.value = kind === 'report' ? 'report.md' : 'sha512-test'
        const pending = ui.importSelected()
        await setImmediate()
        // A sibling document changes OPFS without firing this realm's registries.
        globalThis.dispatchEvent(new Event(event))
        assert.equal(ui.value, null)
        finish('old snapshot')
        await pending
        await setImmediate()
        assert.equal(uploads, 0)
        assert.match(ui.error, /Select.*again/u)
        assert.equal(ui.success, '')
        assert.equal(ui.busy, false)
      } finally { ui.hostDisconnected() }
    }
  }
})

test('losing focus cancels pending reads before any refocus or storage event', async () => {
  const previousDocument = globalThis.document
  const doc = new EventTarget()
  globalThis.document = doc
  try {
    for (const [kind, event] of [['report', 'blur'], ['report', 'visibilitychange'], ['bundle', 'blur'], ['bundle', 'visibilitychange']]) {
      doc.visibilityState = 'visible'
      const f = fixture()
      const read = Promise.withResolvers()
      let uploads = 0
      f.deps[kind === 'report' ? 'readFile' : 'readBundle'] = () => read.promise
      const ui = controller(f.source, () => { uploads++ }, kind)
      try {
        ui.toggle()
        await ui.refresh()
        ui.value = kind === 'report' ? 'report.md' : 'sha512-test'
        const pending = ui.importSelected()
        await setImmediate()
        doc.visibilityState = 'hidden'
        if (event === 'blur') globalThis.dispatchEvent(new Event(event))
        else doc.dispatchEvent(new Event(event))
        // The old snapshot finishes while this tab is still in the background.
        read.resolve('old snapshot')
        await pending
        assert.equal(uploads, 0)
        assert.equal(ui.value, null)
        assert.match(ui.error, /Select.*again/u)
      } finally { ui.hostDisconnected() }
    }
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('focus, blur, and storage refreshes do not abort an upload already handed to the server', async () => {
  const f = fixture()
  const upload = Promise.withResolvers()
  let uploads = 0
  const ui = controller(f.source, () => { uploads++; return upload.promise })
  try {
    ui.toggle()
    await ui.refresh()
    ui.value = 'report.md'
    const pending = ui.importSelected()
    await setImmediate()
    assert.equal(uploads, 1)
    globalThis.dispatchEvent(new Event('blur'))
    globalThis.dispatchEvent(new Event('focus'))
    globalThis.dispatchEvent(new Event('storage'))
    upload.resolve()
    await pending
    await setImmediate()
    assert.equal(ui.error, '')
    assert.equal(ui.success, 'Imported report.md.')
  } finally { ui.hostDisconnected() }
})

test('passkey unlock survives blur, focus, storage, and vault notifications', async () => {
  const f = fixture({ encrypted: true })
  const unlock = Promise.withResolvers()
  let signal
  f.deps.unlockEncryption = options => { signal = options.signal; return unlock.promise }
  const ui = controller(f.source)
  try {
    ui.toggle()
    await ui.refresh()
    const pending = ui.unlock()
    globalThis.dispatchEvent(new Event('blur'))
    globalThis.dispatchEvent(new Event('focus'))
    globalThis.dispatchEvent(new Event('storage'))
    f.change(true)
    assert.equal(signal.aborted, false)
    unlock.resolve(true)
    await pending
    assert.equal(ui.error, '')
    assert.equal(ui.options[0].value, 'report.md')
  } finally { ui.hostDisconnected() }
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

test('a local import completes independently of a later dropped file', async (t) => {
  for (const [kind, success] of [['report', true], ['bundle', true], ['report', false], ['bundle', false]]) {
    const f = fixture()
    const Page = customElements.get(`managed-admin-${kind}s`)
    const page = new Page()
    page._csrf = 'test-csrf'
    page.localImportSource = f.source
    const local = Promise.withResolvers()
    const dropped = Promise.withResolvers()
    const requests = []
    const fetch = t.mock.method(globalThis, 'fetch', (url, options = {}) => {
      if (options.method === 'POST') {
        requests.push(options.body.name)
        return requests.length === 1 ? local.promise : dropped.promise
      }
      return Promise.resolve(Response.json(url === '/api/auth/session'
        ? { user: { role: 'admin' }, csrfToken: 'test-csrf' }
        : { [`${kind}s`]: [], repos: [] }))
    })
    const ui = page._localImport
    ui.connectSource()
    try {
      ui.toggle()
      await ui.refresh()
      ui.value = ui.options[0].value
      const importing = ui.importSelected()
      await setImmediate()
      // This is the same upload path used by the page's active drop handler.
      await page._upload([new File(['later file'], 'later.json')])
      local.resolve(Response.json(success ? { ok: true } : { error: 'denied' }, { status: success ? 200 : 403 }))
      await importing
      const expectedSuccess = success ? `Imported ${kind === 'report' ? 'report.md' : 'source.map'}.` : ''
      const expectedError = success ? '' : 'HTTP 403'
      assert.equal(ui.error, expectedError)
      assert.equal(ui.success, expectedSuccess, 'the local result is available while the later upload is still pending')
      dropped.resolve(Response.json({ error: 'failed' }, { status: 500 }))
      await setImmediate()
      assert.equal(ui.error, expectedError)
      assert.equal(ui.success, expectedSuccess)
      assert.equal(ui.value, success ? null : kind === 'report' ? 'report.md' : 'sha512-test', 'only a failed local import should allow retry')
      assert.deepEqual(requests, [kind === 'report' ? 'report.md' : 'source.map', 'later.json'])
    } finally { ui.hostDisconnected(); fetch.mock.restore() }
  }
})
