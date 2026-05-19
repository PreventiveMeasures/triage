// PBKDF2 iteration count for `password-crypto.js`. Lives in its own
// module so tests can mock it via `node:test`'s `mock.module()` —
// production code imports the real constant and never carries a
// test-time escape hatch (no env-var guard, no NODE_ENV branch).
//
// Touching this constant is a wire-format event: bundles encrypted
// at N iterations only decrypt at N iterations. Increasing it
// invalidates every previously-encrypted bundle / share link.
export const PBKDF2_ITERATIONS = 3_000_000
