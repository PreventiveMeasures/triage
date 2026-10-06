// Replace the production PBKDF2 iteration count (3M) with a small
// constant for test runs. Each encrypt or decrypt call drops from
// ~700 ms to <1 ms — the password-crypto test suites add up to ~80 s
// otherwise. The mock targets `password-crypto-params.js`, which
// is the only place production code reads the constant from, so
// password-crypto.js picks up the override transparently.
//
// Import this statically, then use await import() for every module
// that (transitively) imports password-crypto. Static imports are
// linked before this helper runs, regardless of source order, so
// they can capture the real iteration count before it is mocked.
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
