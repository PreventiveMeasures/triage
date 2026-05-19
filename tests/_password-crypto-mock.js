// Replace the production PBKDF2 iteration count (3M) with a small
// constant for test runs. Each encrypt or decrypt call drops from
// ~700 ms to <1 ms — the password-crypto test suites add up to ~80 s
// otherwise. The mock targets `password-crypto-params.js`, which
// is the only place production code reads the constant from, so
// password-crypto.js picks up the override transparently.
//
// Import this BEFORE any module that (transitively) imports
// password-crypto, so the mock is registered before the import map
// resolves. Static imports are hoisted in source order, so the
// import line for this helper must precede everything else.
//
// Requires `--experimental-test-module-mocks`. Without the flag,
// `mock.module` is undefined; the helper no-ops so per-file runs
// (`node --test ./tests/foo.test.js`) still work — just slowly.

import { mock } from 'node:test'

if (typeof mock.module === 'function') {
  mock.module('../client/password-crypto-params.js', {
    namedExports: { PBKDF2_ITERATIONS: 100 },
  })
}
