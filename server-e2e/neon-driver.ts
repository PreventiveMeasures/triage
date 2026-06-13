// Single import indirection for the optional `@neondatabase/serverless`
// peer dep. Both Neon planes — `db-neon.ts` (workspace_revision) and
// `objstore/store-neon.ts` (the objstore tables) — dynamically import
// THIS module instead of the bare specifier, and tests mock THIS
// module to swap the real driver for an in-process Postgres (PGlite).
//
// Why the indirection: node:test's `mock.module` can only intercept a
// specifier it can RESOLVE. `@neondatabase/serverless` is an optional
// peer dep that a SQLite-only checkout never installs, so mocking the
// bare specifier fails with ERR_MODULE_NOT_FOUND at resolve time. A
// local wrapper path always resolves; and because the mock loader
// serves synthetic exports, it never evaluates this file's `export *`,
// so the absent peer dep is never loaded under test.
//
// In production the wrapper is only ever imported on the Neon path
// (`DATABASE_URL` set), where the operator has installed the peer dep
// (`pnpm add @neondatabase/serverless`) so the re-export resolves. A
// SQLite-only deploy never imports this module — the dynamic `import()`
// sites are gated behind the `DATABASE_URL` branch in `index.ts`.
//
// `@ts-ignore` rather than `@ts-expect-error`: when the peer dep IS
// installed the specifier resolves and tsc sees a real type, which
// would flip `@ts-expect-error` into a TS2578 "unused directive" error
// and break the operator's `tsc --noEmit`.
// @ts-ignore optional peer dep: '@neondatabase/serverless'
export * from '@neondatabase/serverless'
