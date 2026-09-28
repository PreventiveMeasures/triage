import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManagedConfig } from '../server-managed/config.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { openManagedStorage } from '../server-managed/storage.ts'
import { loadConfig } from '../server-e2e/config.ts'

const auth = {
  GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret',
  OAUTH_CALLBACK_URL: 'https://app.example/api/oauth/github/callback',
  CONFIG_PATH: '/nonexistent/triage-storage-test-config.json',
}

function replaceEnv(values) {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, values)
}

function useEnv(t, values) {
  const previous = { ...process.env }
  t.after(() => { replaceEnv(previous) })
  replaceEnv({ ...auth, ...values })
}

test('public workspace sharing requires exactly DEEPVIEW_ALLOW_SHARE=1', t => {
  useEnv(t, {})
  assert.equal(loadManagedConfig().allowShare, false)
  for (const value of ['', '0', 'true', 'yes', ' 1 ', '1']) {
    process.env.DEEPVIEW_ALLOW_SHARE = value
    for (const combined of [false, true]) assert.equal(loadManagedConfig({ combined }).allowShare, value === '1')
  }
})

test('managed storage encryption is opt-in and validates its key before opening storage', t => {
  useEnv(t, {})
  assert.equal(loadManagedConfig().storageEncryptionKey, null)
  const key = Buffer.alloc(32, 123).toString('base64')
  process.env.MANAGED_STORAGE_ENCRYPTION_KEY = key
  for (const combined of [false, true]) assert.equal(loadManagedConfig({ combined }).storageEncryptionKey, key)
  process.env.MANAGED_STORAGE_ENCRYPTION_KEY = 'not-a-valid-key'
  assert.throws(() => loadManagedConfig(), err => /MANAGED_STORAGE_ENCRYPTION_KEY/u.test(err.message) && !err.message.includes('not-a-valid-key'))
})

test('initial admin configuration accepts only one positive numeric GitHub ID, and defaults off', t => {
  useEnv(t, {})
  assert.equal(loadManagedConfig().initialAdminGithubId, null)
  process.env.MANAGED_INITIAL_ADMIN_GITHUB_ID = ''
  assert.equal(loadManagedConfig().initialAdminGithubId, null)
  for (const value of ['1', '123456', String(Number.MAX_SAFE_INTEGER)]) {
    process.env.MANAGED_INITIAL_ADMIN_GITHUB_ID = value
    for (const combined of [false, true]) assert.equal(loadManagedConfig({ combined }).initialAdminGithubId, Number(value))
  }
  for (const value of ['octocat', '1,2', '0', '-1', '1.5', '1e3', '0x10', '01', ' 1 ', '9007199254740992']) {
    process.env.MANAGED_INITIAL_ADMIN_GITHUB_ID = value
    assert.throws(() => loadManagedConfig(), /MANAGED_INITIAL_ADMIN_GITHUB_ID/u, value)
  }
})

for (const shared of [false, true]) {
  for (const e2e of [false, true]) {
    for (const managed of [false, true]) {
      test(`database URLs: shared=${shared}, e2e=${e2e}, managed=${managed}`, t => {
        useEnv(t, {
          BLOB_READ_WRITE_TOKEN: 'token',
          ...(shared ? { DATABASE_URL: 'postgres://example/shared' } : {}),
          ...(e2e ? { E2E_DATABASE_URL: 'postgres://example/e2e' } : {}),
          ...(managed ? { MANAGED_DATABASE_URL: 'postgres://example/managed' } : {}),
        })
        if (shared && (e2e || managed)) {
          for (const load of [loadConfig, loadManagedConfig, () => loadManagedConfig({ combined: true })]) {
            assert.throws(load, /DATABASE_URL cannot be combined/u)
          }
          return
        }
        assert.equal(loadConfig().neonUrl, shared ? process.env.DATABASE_URL : process.env.E2E_DATABASE_URL ?? null)
        const expected = shared ? process.env.DATABASE_URL : process.env.MANAGED_DATABASE_URL ?? null
        assert.equal(loadManagedConfig().neonUrl, expected, 'standalone ignores the inactive backend')
        if (e2e === managed) assert.equal(loadManagedConfig({ combined: true }).neonUrl, expected)
        else assert.throws(() => loadManagedConfig({ combined: true }), /Mixing Neon and SQLite/u)
      })
    }
  }
}

test('equal URL values still cannot mix global and per-mode settings; empty values are unset', t => {
  useEnv(t, { DATABASE_URL: 'postgres://example/shared', E2E_DATABASE_URL: '', MANAGED_DATABASE_URL: '', BLOB_READ_WRITE_TOKEN: 'token' })
  assert.equal(loadManagedConfig({ combined: true }).neonUrl, loadConfig().neonUrl)
  for (const key of ['E2E_DATABASE_URL', 'MANAGED_DATABASE_URL']) {
    process.env[key] = process.env.DATABASE_URL
    assert.throws(loadConfig, /cannot be combined/u)
    assert.throws(loadManagedConfig, /cannot be combined/u)
    process.env[key] = ''
  }
  delete process.env.DATABASE_URL
  process.env.E2E_DATABASE_URL = 'postgres://example/shared'
  process.env.MANAGED_DATABASE_URL = process.env.E2E_DATABASE_URL
  assert.equal(loadManagedConfig({ combined: true }).neonUrl, loadConfig().neonUrl)
})

test('standalone managed preserves its local data when only the inactive e2e URL is set', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-managed-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.db')
  const existing = openSqliteManagedDb(path)
  const userId = await existing.upsertUser({ githubUserId: 1, login: 'existing-admin', name: null, avatarUrl: null }, 1)
  await existing.setUserRole(userId, 'admin')
  await existing.close()
  useEnv(t, { E2E_DATABASE_URL: 'postgres://e2e.invalid/e2e', DB_PATH: join(dir, 'e2e.db'), MANAGED_DB_PATH: path })
  const config = loadManagedConfig()
  assert.equal(config.neonUrl, null)
  const storage = await openManagedStorage(config)
  try {
    const users = await storage.db.listUsers()
    assert.equal(users.length, 1)
    assert.equal(users[0].id, userId)
    assert.equal(users[0].role, 'admin')
  } finally { await storage.db.close() }
})

test('SQLite paths retain standalone/combined precedence', t => {
  useEnv(t, { DB_PATH: '/data/e2e.db' })
  assert.equal(loadManagedConfig().dbPath, '/data/e2e.db')
  assert.equal(loadManagedConfig({ combined: true }).dbPath, 'server-managed/data/managed.db')
  process.env.MANAGED_DB_PATH = '/data/managed/managed.db'
  for (const combined of [false, true]) assert.equal(loadManagedConfig({ combined }).dbPath, process.env.MANAGED_DB_PATH)
  assert.equal(loadConfig().dbPath, process.env.DB_PATH)
  assert.equal(loadConfig().objstoreDir, '/data/objstore')
})

test('Vercel requires a managed database URL and Blob credentials', t => {
  useEnv(t, { VERCEL: '1', E2E_DATABASE_URL: 'postgres://example/e2e' })
  assert.throws(loadManagedConfig, /requires DATABASE_URL or MANAGED_DATABASE_URL/u)
  process.env.MANAGED_DATABASE_URL = 'postgres://example/managed'
  for (const combined of [false, true]) assert.throws(() => loadManagedConfig({ combined }), /BLOB_READ_WRITE_TOKEN/u)
  process.env.BLOB_READ_WRITE_TOKEN = 'token'
  assert.equal(loadManagedConfig({ combined: true }).neonUrl, process.env.MANAGED_DATABASE_URL)
})

test('GitHub issue labels are optional and shared by managed/e2e configuration', t => {
  useEnv(t, auth)
  assert.equal(loadManagedConfig().githubNewIssueLabels, '')
  assert.equal(loadConfig().githubNewIssueLabels, '')
  process.env.GITHUB_NEW_ISSUE_LABELS = 'team,needs-review'
  assert.equal(loadManagedConfig().githubNewIssueLabels, 'team,needs-review')
  assert.equal(loadConfig().githubNewIssueLabels, 'team,needs-review')
})
