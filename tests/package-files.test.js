// Guard: every server source file must be listed in package.json `files`.
//
// The server ships as raw .ts run through strip-types-loader (the
// `triage-server` bin → server-e2e/cli.js, and the `./server` export →
// server-e2e/index.ts). `files` is the npm publish allowlist, so a server module
// that's absent from it is simply MISSING from the published package and the
// server throws on import at startup. There's no bundler to paper over it.
//
// This catches the "added a new server-e2e/*.ts but forgot to list it" class of
// bug — which is exactly how the objstore REST-mint modules (rest-mint.ts,
// rest-deny.ts, fetch-mint-guard.ts) shipped unpublished until this guard.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('package.json "files" lists every server source file (publish allowlist)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const allow = new Set(pkg.files)
  // Tracked files only — skips gitignored operator state (server-e2e/config.json,
  // server-e2e/data/*) that must NOT be published.
  const tracked = execSync('git ls-files server-e2e', { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
  // Every runtime source module (.ts/.js) under server-e2e/ is published; type
  // decls and the colocated-nothing test files (there are none under server-e2e/,
  // but guard anyway) are not runtime imports.
  const needsPublish = tracked.filter((f) =>
    /\.(ts|js)$/u.test(f) && !f.endsWith('.d.ts') && !/\.test\.(ts|js)$/u.test(f))
  const missing = needsPublish.filter((f) => !allow.has(f))
  assert.deepEqual(
    missing, [],
    `server source files missing from package.json "files" — they'd be absent ` +
    `from the published triage-server package and crash on import:\n  ${missing.join('\n  ')}`,
  )
})

// Every `exports` target must be in `files` too — an entry point that isn't
// published resolves to a missing file for consumers (e.g. the `./reap`
// Vercel-cron handler lives under `api/`, outside the `server-e2e/` scan above).
test('package.json "files" includes every exports target', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const allow = new Set(pkg.files)
  const missing = Object.entries(pkg.exports)
    .map(([sub, target]) => [sub, target.replace(/^\.\//u, '')])
    // `package.json` is always included by npm; everything else must be listed.
    .filter(([, rel]) => rel !== 'package.json' && !allow.has(rel))
    .map(([sub, rel]) => `exports["${sub}"] → ${rel}`)
  assert.deepEqual(missing, [], `exports targets missing from "files":\n  ${missing.join('\n  ')}`)
})
