// `client/migrate-legacy.js` — one-time rename of `.deepseek` OPFS
// entries back to `.md` (legacy from a build that briefly bucketed
// DeepSec markdown by extension). The migration carries the count
// cache, workspace membership, repo URL, and last-viewed-file pointer
// along with the rename.
//
// `migrateLegacyFilenames()` memoizes via a module-level promise, so
// each test loads a fresh module instance (cache-busted import) to
// re-run the migration cleanly.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

function createLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
    get length() { return store.size },
    key: (i) => Array.from(store.keys())[i] ?? null,
  }
}
if (globalThis.localStorage === undefined) {
  globalThis.localStorage = createLocalStorage()
}

// Import the modules once — fresh `migrate-legacy` instance per test
// is the only one that needs cache-busting. storage / counts /
// workspaces share state across tests, but we work with unique names
// per scenario to avoid bleed.
const { saveFile, listFiles, readFile } = await import('../client/storage.js')
const { setCount, getCount, getKind } = await import('../client/counts.js')
const { upsertWorkspace, listWorkspaces, deleteWorkspace } = await import('../client/workspaces.js')
const { saveRepoUrlFor, loadRepoUrlFor, state } = await import('../client/state.ts')

const LAST_FILE_KEY = 'deepview.lastFile'

let nameCounter = 0
function uniqueLegacyName(stem) {
  nameCounter += 1
  return `${stem}-${Date.now()}-${nameCounter}.deepseek`
}

async function freshMigrate() {
  const mod = await import(`../client/migrate-legacy.js?t=${Date.now()}-${++nameCounter}`)
  return mod.migrateLegacyFilenames()
}

describe('migrateLegacyFilenames', () => {
  it('renames `.deepseek` entries back to `.md` and carries the content', async () => {
    const legacy = uniqueLegacyName('a')
    const target = legacy.replace(/\.deepseek$/u, '.md')
    await saveFile(legacy, '# DeepSec body\n\n## HIGH (1)\n\n### F\n')

    await freshMigrate()

    const names = await listFiles()
    assert.equal(names.includes(legacy), false, 'legacy entry removed')
    assert.equal(names.includes(target), true, 'target entry created')
    assert.match(await readFile(target), /# DeepSec body/u, 'content preserved')
  })

  it('skips when a `.md` already exists at the target name (collision)', async () => {
    const legacy = uniqueLegacyName('collide')
    const target = legacy.replace(/\.deepseek$/u, '.md')
    await saveFile(legacy, 'legacy content')
    await saveFile(target, 'target content already here')

    await freshMigrate()

    const names = await listFiles()
    assert.equal(names.includes(legacy), true, 'legacy left alone on collision')
    assert.equal(await readFile(target), 'target content already here', 'existing target untouched')
  })

  it('carries the count cache across the rename', async () => {
    const legacy = uniqueLegacyName('count')
    const target = legacy.replace(/\.deepseek$/u, '.md')
    await saveFile(legacy, '# Vulnerability Scan Report\n\n## HIGH (1)\n\n### F\n\n- **File:** `x.js`\n- **Lines:** 1\n')
    setCount(legacy, 7, 'deepsec')

    await freshMigrate()

    assert.equal(getCount(target), 7, 'count survived rename')
    assert.equal(getKind(target), 'deepsec', 'source survived rename')
    assert.equal(getCount(legacy), undefined, 'legacy count cleared')
  })

  it('populates count from content when the legacy entry had no cache', async () => {
    const legacy = uniqueLegacyName('count-fresh')
    const target = legacy.replace(/\.deepseek$/u, '.md')
    const content = '# Vulnerability Scan Report\n\n## HIGH (2)\n\n### F1\n\n- **File:** `x.js`\n- **Lines:** 1\n\n---\n\n### F2\n\n- **File:** `y.js`\n- **Lines:** 1\n'
    await saveFile(legacy, content)

    await freshMigrate()

    assert.equal(getCount(target), 2, 'count derived from content via analyzeContent')
    assert.equal(getKind(target), 'deepsec')
  })

  it('rewrites workspace `reports[]` membership entries', async () => {
    const legacy = uniqueLegacyName('ws')
    const target = legacy.replace(/\.deepseek$/u, '.md')
    await saveFile(legacy, '# DeepSec\n\n## HIGH (1)\n\n### F\n')
    const wsId = `ws-${Date.now()}-${nameCounter}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: 'AAAA', reports: [legacy] })

    await freshMigrate()

    const ws = listWorkspaces().find((w) => w.id === wsId)
    assert.ok(ws, 'workspace survived migration')
    assert.equal(ws.reports.includes(legacy), false, 'legacy name removed from workspace.reports')
    assert.equal(ws.reports.includes(target), true, 'renamed name added to workspace.reports')

    await deleteWorkspace(wsId)
  })

  it('rewrites orphan workspace references even when the OPFS file is absent', async () => {
    // The migration loop writes new content first, then catches up
    // workspace memberships in a separate pass at the end. That
    // second pass also catches references where the corresponding
    // OPFS file was already gone (user deleted it but the workspace
    // JSON still pinned the legacy name).
    const legacy = `orphan-${Date.now()}-${++nameCounter}.deepseek`
    const target = legacy.replace(/\.deepseek$/u, '.md')
    const wsId = `ws-orphan-${Date.now()}-${nameCounter}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: 'AAAA', reports: [legacy] })

    await freshMigrate()

    const ws = listWorkspaces().find((w) => w.id === wsId)
    assert.equal(ws.reports.includes(legacy), false, 'orphan legacy reference cleared')
    assert.equal(ws.reports.includes(target), true, 'orphan rewritten to .md')

    await deleteWorkspace(wsId)
  })

  it('updates the last-viewed-file pointer', async () => {
    const legacy = uniqueLegacyName('last')
    const target = legacy.replace(/\.deepseek$/u, '.md')
    await saveFile(legacy, '# X\n\n## HIGH (1)\n\n### F\n')
    globalThis.localStorage.setItem(LAST_FILE_KEY, legacy)
    // migrate-legacy.js now reads/writes LAST_FILE_KEY through the
    // secure-storage cache; hydrate it so the just-written LS value
    // is visible.
    const { hydrate: hydrateSecureStorage } = await import('../client/secure-storage.js')
    await hydrateSecureStorage()

    await freshMigrate()

    assert.equal(globalThis.localStorage.getItem(LAST_FILE_KEY), target)
  })

  it('leaves the last-viewed pointer alone when it points elsewhere', async () => {
    const legacy = uniqueLegacyName('last-other')
    const sentinel = `unrelated-${Date.now()}-${++nameCounter}.json`
    await saveFile(legacy, '# X\n\n## HIGH (1)\n\n### F\n')
    globalThis.localStorage.setItem(LAST_FILE_KEY, sentinel)

    await freshMigrate()

    assert.equal(globalThis.localStorage.getItem(LAST_FILE_KEY), sentinel,
      'unrelated pointer not touched')
  })

  it('carries per-report repo URL across the rename', async () => {
    const legacy = uniqueLegacyName('repo')
    const target = legacy.replace(/\.deepseek$/u, '.md')
    await saveFile(legacy, '# X\n\n## HIGH (1)\n\n### F\n')
    saveRepoUrlFor(legacy, 'https://github.com/o/r')

    await freshMigrate()

    assert.equal(loadRepoUrlFor(target), 'https://github.com/o/r')
    assert.equal(loadRepoUrlFor(legacy), '', 'legacy repo URL cleared')
  })

  it('is idempotent — a second run finds no legacy entries and is a no-op', async () => {
    const legacy = uniqueLegacyName('idempotent')
    const target = legacy.replace(/\.deepseek$/u, '.md')
    await saveFile(legacy, '# X\n\n## HIGH (1)\n\n### F\n')

    await freshMigrate()
    const namesAfter1 = await listFiles()
    assert.equal(namesAfter1.includes(target), true)

    // Second run via a fresh module instance should walk listFiles,
    // find no .deepseek, and exit cleanly.
    await freshMigrate()
    const namesAfter2 = await listFiles()
    assert.deepEqual(namesAfter2, namesAfter1, 'second run is a no-op')
  })

  it('memoizes within a single module instance — concurrent calls share one promise', async () => {
    const mod = await import(`../client/migrate-legacy.js?memo=${Date.now()}-${++nameCounter}`)
    const a = mod.migrateLegacyFilenames()
    const b = mod.migrateLegacyFilenames()
    assert.equal(a, b, 'concurrent calls return the same promise')
    await Promise.all([a, b])
  })

  it('rewrites state.ignoredIds keys for the renamed report (audit round-12 M-D)', async () => {
    // Per-report ignore is stored as `${reportName}\0${id}` in
    // state.ignoredIds (and the persisted deepview.triage blob's
    // `ignoredReports` arrays). Pre-fix the migration carried the
    // count cache + repo URL + last-file pointer but missed
    // ignoredIds — ignored findings reappeared in the renamed
    // report. Now the rename loop rewrites matching prefixes and
    // re-persists via saveTriage.
    const legacy = uniqueLegacyName('ig')
    const target = legacy.replace(/\.deepseek$/u, '.md')
    await saveFile(legacy, '# DeepSec\n\n## HIGH (1)\n\n### F\n')

    // Seed two ignoredIds keys for the legacy name + one unrelated
    // key that should survive untouched.
    state.ignoredIds.add(`${legacy}\0finding-a`)
    state.ignoredIds.add(`${legacy}\0finding-b`)
    state.ignoredIds.add(`unrelated.json\0finding-c`)

    await freshMigrate()

    assert.equal(state.ignoredIds.has(`${legacy}\0finding-a`), false, 'legacy-prefixed key removed')
    assert.equal(state.ignoredIds.has(`${legacy}\0finding-b`), false, 'legacy-prefixed key removed')
    assert.equal(state.ignoredIds.has(`${target}\0finding-a`), true, 'target-prefixed key added')
    assert.equal(state.ignoredIds.has(`${target}\0finding-b`), true, 'target-prefixed key added')
    assert.equal(state.ignoredIds.has(`unrelated.json\0finding-c`), true, 'unrelated keys untouched')

    // Cleanup
    state.ignoredIds.delete(`${target}\0finding-a`)
    state.ignoredIds.delete(`${target}\0finding-b`)
    state.ignoredIds.delete(`unrelated.json\0finding-c`)
  })

  it('skips workspace membership rewrite on collision (audit round-12 M-E)', async () => {
    // Collision case: a `.md` already exists at the target name.
    // The per-file rename loop skips this entry. The workspace-
    // membership rewrite at the end MUST also skip — pre-fix it
    // unconditionally rewrote `.deepseek` → `.md` in workspace
    // reports[], silently grafting membership onto an unrelated
    // existing `.md` while the actual `.deepseek` becomes
    // workspace-orphaned.
    const legacy = uniqueLegacyName('col-ws')
    const target = legacy.replace(/\.deepseek$/u, '.md')
    await saveFile(legacy, 'legacy content')
    await saveFile(target, 'pre-existing target content')
    const wsId = `ws-collide-${Date.now()}-${nameCounter}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: 'AAAA', reports: [legacy] })

    await freshMigrate()

    const ws = listWorkspaces().find((w) => w.id === wsId)
    assert.ok(ws, 'workspace survived')
    assert.equal(ws.reports.includes(legacy), true,
      'membership stays at .deepseek when rename was blocked by collision')
    assert.equal(ws.reports.includes(target), false,
      'membership NOT silently grafted onto the unrelated existing .md')
    // Both files still on disk
    const names = await listFiles()
    assert.equal(names.includes(legacy), true, 'legacy file still on disk')
    assert.equal(names.includes(target), true, 'target file still on disk')

    await deleteWorkspace(wsId)
  })
})
