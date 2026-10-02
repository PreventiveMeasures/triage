// Servers ship as raw source through strip-types-loader. Keep all modes and
// their transitive runtime imports in npm's explicit publish allowlist.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isBuiltin } from 'node:module'
import { build } from 'esbuild'

test('package.json "files" lists every server source file (publish allowlist)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const allow = new Set(pkg.files)
  // Tracked sources only: operator configuration/data and the development-only
  // managed test server are not part of the published runtime.
  const tracked = execSync('git ls-files cli.js server.ts strip-types-loader.js server-e2e server-managed server-common common/managed', { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
  const needsPublish = tracked.filter((f) =>
    /\.(ts|js)$/u.test(f) && f !== 'server-managed/test-server.ts' && !/\.test\.(ts|js)$/u.test(f))
  const missing = needsPublish.filter((f) => !allow.has(f))
  assert.deepEqual(
    missing, [],
    `server source files missing from package.json "files" — they'd be absent ` +
    `from the published triage-server package and crash on import:\n  ${missing.join('\n  ')}`,
  )
})

test('package.json "files" includes every exports and bin target', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const allow = new Set(pkg.files)
  const missing = [...Object.entries(pkg.exports), ...Object.entries(pkg.bin)]
    .map(([sub, target]) => [sub, target.replace(/^\.\//u, '')])
    // `package.json` is always included by npm; everything else must be listed.
    .filter(([, rel]) => rel !== 'package.json' && !allow.has(rel))
    .map(([sub, rel]) => `${sub} → ${rel}`)
  assert.deepEqual(missing, [], `entry points missing from "files":\n  ${missing.join('\n  ')}`)
})

// The tarball ships the license texts beside the modules. They have to be
// named in `files`: pnpm packs a LICENSE-* file regardless, but npm only packs
// LICENSE or LICENSE.<ext> unasked, so `npm publish` would ship neither.
test('package.json "files" includes LICENSE-APACHE and LICENSE-MIT', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.license, 'MIT OR Apache-2.0')
  for (const name of ['LICENSE-APACHE', 'LICENSE-MIT']) {
    assert.ok(pkg.files.includes(name), `${name} is not in package.json files, so npm would publish without it`)
    assert.ok(existsSync(new URL(`../${name}`, import.meta.url)), `${name} is in package.json files but not in the root`)
  }
})

test('published entry points include their complete runtime dependency graph', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // Parse static and dynamic imports without executing server initialization.
  // This also follows shared helpers outside the server source directories.
  const entryPoints = [...new Set(['./server.ts', './cli.js', ...Object.values(pkg.exports), ...Object.values(pkg.bin)])]
    .filter(path => /\.(ts|js)$/u.test(path))
  const { metafile } = await build({
    absWorkingDir: root, entryPoints, bundle: true, platform: 'node', format: 'esm',
    packages: 'external', metafile: true, write: false, outdir: 'unused', logLevel: 'silent',
  })
  const missing = Object.keys(metafile.inputs).filter(path => !pkg.files.includes(path))
  assert.deepEqual(missing, [], `runtime imports missing from "files":\n  ${missing.join('\n  ')}`)

  const dependencies = { ...pkg.dependencies, ...pkg.peerDependencies }
  const external = new Set(Object.values(metafile.outputs).flatMap(output => output.imports.map(entry => entry.path)))
  const undeclared = [...external].filter(path => {
    if (isBuiltin(path)) return false
    const name = path.split('/').slice(0, path.startsWith('@') ? 2 : 1).join('/')
    return !Object.hasOwn(dependencies, name)
  })
  assert.deepEqual(undeclared, [], `undeclared runtime dependencies:\n  ${undeclared.join('\n  ')}`)
})
