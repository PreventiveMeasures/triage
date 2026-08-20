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

// Inverse guard: the managed server is deliberately NOT released yet.
//
// `server-managed/` (the `triage-managed-server` bin) and the `common/managed/`
// modules it imports at runtime are held back from the publish allowlist while
// the managed mode is still being built out. The client half stays in the
// tarball — `out/client-managed.js` / `out/client-admin.js` are inert without a
// server that advertises `mode: 'managed'` (see common/server-info.ts), so they
// cost a few KB and change nothing for an e2e deployment.
//
// This guard exists because the hold is otherwise one edit deep: `files` is a
// hand-maintained allowlist that every `managed:` commit has been appending to,
// and the first guard above only scans `server-e2e/`. That gap is how the
// managed server came to be published with blob-store.ts and bundle.ts missing
// — a `triage-managed-server` that throws on import at startup.
//
// TO LIFT THE HOLD: delete this test, add `server-managed` (and `common/managed`)
// to the tracked-source scan in the first test so the allowlist stays complete,
// then list the files and restore the `triage-managed-server` bin.
const HELD_BACK = /^(?:\.\/)?(?:server-managed|common\/managed)(?:\/|$)/u

test('managed server is held back from the published package', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  const listed = pkg.files.filter((f) => HELD_BACK.test(f))
  assert.deepEqual(
    listed, [],
    `managed sources are in the publish allowlist but the managed server is not ` +
    `released yet — drop them from package.json "files":\n  ${listed.join('\n  ')}`,
  )

  // A bin pointing into an unpublished tree installs a command that dies on its
  // first import, which is worse than no command at all.
  const bins = Object.entries(pkg.bin ?? {})
    .filter(([, target]) => HELD_BACK.test(target))
    .map(([name, target]) => `bin["${name}"] → ${target}`)
  assert.deepEqual(bins, [], `bin entries point into the held-back managed tree:\n  ${bins.join('\n  ')}`)

  // Same for `exports` — and the "every exports target is in files" test above
  // would only catch this as a missing-file error, not as a released-too-early one.
  const exported = Object.entries(pkg.exports ?? {})
    .filter(([, target]) => HELD_BACK.test(target))
    .map(([sub, target]) => `exports["${sub}"] → ${target}`)
  assert.deepEqual(exported, [], `exports point into the held-back managed tree:\n  ${exported.join('\n  ')}`)
})
