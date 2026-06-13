// Shared async-statement primitives. Both `server-e2e/db.ts` (workspace_revision
// chain) and `server-e2e/objstore/store.ts` (objstore tables) expose Handles
// whose statements look like `{ get(...) → Promise<…>, all(...) → Promise<[…]>,
// run(...) → Promise<void> }`. The underlying `node:sqlite` driver is
// synchronous; the wrappers below catch sync errors and route them through
// the returned Promise. A future async-native backend would implement these
// same shapes with real I/O.
//
// Error-propagation contract: every wrapper returns a Promise. If the
// underlying sync driver throws (constraint violation, type bind error,
// closed DB, …), the wrapper converts the throw into a `Promise.reject`.
// Callers `.catch()` / `Promise.allSettled` / `await` uniformly without
// having to wrap each call in `try`.

import { type StatementSync } from 'node:sqlite'

export type GetStmt<P extends unknown[], T> = { get: (...args: P) => Promise<T | undefined> }
export type AllStmt<P extends unknown[], T> = { all: (...args: P) => Promise<T[]> }
export type RunStmt<P extends unknown[]> = { run: (...args: P) => Promise<void> }

// `StatementSync` types parameters as `SQLInputValue` (a narrow union).
// Callers pass our generic `P extends unknown[]`; widen via `unknown` so
// the spread compiles. Call-site types enforce the right shape — the
// driver validates parameter types at bind time, so a wrong type fails
// loud at the SQLite layer, surfaced as a rejection.
type AnyStmt = {
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
  run: (...args: unknown[]) => unknown
}
function asAny(stmt: StatementSync): AnyStmt { return stmt as unknown as AnyStmt }

// Each wrapper is an `async` function with no internal `await` — the
// `async` keyword is what guarantees a sync throw from the driver
// surfaces as a Promise rejection rather than escaping the wrapper.
// `require-await` warns on async-without-await, but here it is the
// whole point: the lint disable is the intent.
export function wrapGet<P extends unknown[], T>(stmt: StatementSync): GetStmt<P, T> {
  const s = asAny(stmt)
  // eslint-disable-next-line require-await
  return { get: async (...args: P) => s.get(...args) as T | undefined }
}
export function wrapAll<P extends unknown[], T>(stmt: StatementSync): AllStmt<P, T> {
  const s = asAny(stmt)
  // eslint-disable-next-line require-await
  return { all: async (...args: P) => s.all(...args) as T[] }
}
export function wrapRun<P extends unknown[]>(stmt: StatementSync): RunStmt<P> {
  const s = asAny(stmt)
  // eslint-disable-next-line require-await
  return { run: async (...args: P) => { s.run(...args) } }
}

