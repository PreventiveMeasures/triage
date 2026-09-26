import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManagedConfig } from '../server-managed/config.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { openManagedStorage } from '../server-managed/storage.ts'

const auth = {
  GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret',
  OAUTH_CALLBACK_URL: 'https://app.example/api/oauth/github/callback',
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

test('combined e2e Neon configuration preserves existing managed SQLite data', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-managed-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.db')
  const existing = openSqliteManagedDb(path)
  const userId = await existing.upsertUser({ githubUserId: 1, login: 'existing-admin', name: null, avatarUrl: null }, 1)
  await existing.close()
  useEnv(t, { DATABASE_URL: 'postgres://e2e.invalid/e2e', BLOB_READ_WRITE_TOKEN: 'e2e-token', DB_PATH: join(dir, 'e2e.db'), MANAGED_DB_PATH: path })
  const config = loadManagedConfig({ combined: true })
  assert.equal(config.neonUrl, null)
  assert.equal(config.dbPath, path)
  const storage = await openManagedStorage(config)
  try {
    const users = await storage.db.listUsers()
    assert.equal(users.length, 1)
    assert.equal(users[0].id, userId)
    assert.equal(users[0].login, 'existing-admin')
    assert.equal(users[0].role, 'admin')
  } finally { await storage.db.close() }
})

test('only standalone managed deployments fall back to the generic database URL', t => {
  useEnv(t, { DATABASE_URL: 'postgres://e2e.invalid/e2e', BLOB_READ_WRITE_TOKEN: 'token' })
  assert.equal(loadManagedConfig().neonUrl, process.env.DATABASE_URL)
  assert.equal(loadManagedConfig({ combined: true }).neonUrl, null)
  process.env.MANAGED_DATABASE_URL = ''
  assert.equal(loadManagedConfig({ combined: true }).neonUrl, null)
  process.env.MANAGED_DATABASE_URL = 'postgres://managed.invalid/managed'
  for (const combined of [false, true]) assert.equal(loadManagedConfig({ combined }).neonUrl, process.env.MANAGED_DATABASE_URL)
  delete process.env.MANAGED_DATABASE_URL
  process.env.VERCEL = '1'
  assert.equal(loadManagedConfig().neonUrl, process.env.DATABASE_URL)
  assert.throws(() => loadManagedConfig({ combined: true }), /requires MANAGED_DATABASE_URL\./u)
})

test('combined managed storage requires Blob credentials only for its explicit Neon URL', t => {
  useEnv(t, { DATABASE_URL: 'postgres://e2e.invalid/e2e' })
  assert.equal(loadManagedConfig({ combined: true }).neonUrl, null)
  process.env.MANAGED_DATABASE_URL = 'postgres://managed.invalid/managed'
  assert.throws(() => loadManagedConfig({ combined: true }), /BLOB_READ_WRITE_TOKEN/u)
})
