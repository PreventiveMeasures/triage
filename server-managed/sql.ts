// Each public store operation owns a transaction. SQLite serializes access to
// its single connection across awaits; Neon can reuse a request-owned connection.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { ManagedDb } from './db-methods.ts'
import { countStatement, timed } from './request-timing.ts'

type MaybePromise<T> = T | Promise<T>
export interface ManagedSql {
  prepare(sql: string): {
    get(...params: unknown[]): MaybePromise<unknown>
    all(...params: unknown[]): MaybePromise<unknown[]>
    run(...params: unknown[]): MaybePromise<{ changes: number | bigint }>
  }
  close(): MaybePromise<void>
}
export interface ManagedSqlDriver extends ManagedSql {
  scope<T>(write: boolean, work: () => Promise<T>, options?: { lock?: boolean; statement?: boolean }): Promise<T>
}

// These operations execute exactly one SQL statement. Postgres already gives
// that statement an atomic snapshot; an explicit BEGIN/COMMIT adds only trips.
// Lease and cache writes coordinate through their conditional UPSERT/UPDATE alone.
const SINGLE_STATEMENTS = new Set(['getReport', 'getBundle', 'getStorageRow', 'getStorageEncryption', 'getTeam', 'getComment',
  'userCanReadReport', 'userCanReadRepo', 'userCanReadRepoPath', 'userCanReadBundle', 'reportPermissionsFor', 'listComments', 'listManagedIssues',
  'listTriageHistory', 'listUsers', 'listUserOptions', 'listActivityReports', 'getRepoFullName', 'getUser', 'getSessionWithUser', 'getViewSessionWithUser',
  'listTriageFixes', 'getRepoDependencyReviews', 'listTeamDependencyReviews', 'getNpmReviewReader',
  'sessionWithUser', 'getTeamReportAccessSnapshot', 'getReportAccessSnapshot', 'getReportView', 'getUserGithubId', 'getUserTeamFeedSnapshot', 'getAnnotations', 'getAnnotationRevision', 'getUserTokens',
  'listReports', 'listBundles', 'listReadableBundleIds', 'listAllRepos', 'listSelectedRepos', 'listRepoScopesForUser', 'listTriage',
  'getFeedState', 'getWorkspaceShareFeedState', 'claimMaintenanceLease', 'finishMaintenanceLease', 'cacheRepoDefaultBranch', 'releaseBundleBuildLease',
  'getUpstreamCacheEntry', 'getUpstreamCacheEntries', 'getFirstUpstreamCacheEntries', 'setUpstreamCacheEntry', 'setUpstreamCacheEntries', 'ensureSessionUploadKey',
  'listGithubCommits', 'listGithubCommitTags', 'setGithubCommits', 'getAvatarKey', 'listUsersByAccount'])
// Session presence and upload keys change only their own rows.
const UNLOCKED_WRITES = new Set(['sessionWithUser', 'viewSessionWithUser', 'ensureSessionUploadKey'])

export function scopeManagedMethods(methods: ManagedDb, driver: ManagedSqlDriver): ManagedDb {
  const entries = Object.entries(methods).map(([name, method]) => {
    if (name === 'close') return [name, async () => { await driver.close() }]
    const write = !/^(?:get|list|userCanRead|reportPermissionsFor)/u.test(name)
    // Each operation's time told in its request's Server-Timing (request-timing.ts).
    return [name, (...args: unknown[]) => timed('db', () => driver.scope(write, () => method(...args), {
      // Presence writes only one user's timestamp; they need no application
      // writer lock. Keep the session/user read and timestamp in one transaction.
      lock: write && !UNLOCKED_WRITES.has(name), statement: SINGLE_STATEMENTS.has(name),
    }))]
  })
  return Object.fromEntries(entries) as ManagedDb
}

export function createSqliteDriver(db: DatabaseSync): ManagedSqlDriver {
  let queue = Promise.resolve()
  let closed = false
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work)
    queue = result.then(() => undefined, () => undefined)
    return result
  }
  return {
    prepare(sql) {
      const stmt = db.prepare(sql)
      return {
        get: (...args) => { countStatement(); return stmt.get(...args as SQLInputValue[]) },
        all: (...args) => { countStatement(); return stmt.all(...args as SQLInputValue[]) },
        run: (...args) => { countStatement(); return stmt.run(...args as SQLInputValue[]) },
      }
    },
    scope(write, work) {
      if (closed) return Promise.reject(new Error('Managed database is closed'))
      return enqueue(async () => {
        countStatement()
        db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
        try {
          const result = await work()
          countStatement()
          db.exec('COMMIT')
          return result
        } catch (err) {
          db.exec('ROLLBACK')
          throw err
        }
      })
    },
    async close() { closed = true; await queue; db.close() },
  }
}
