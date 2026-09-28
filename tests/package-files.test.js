// Servers ship as raw source through strip-types-loader. Keep all modes and
// their transitive runtime imports in npm's explicit publish allowlist.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
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

// `report/` publishes TWICE, from two hand-maintained allowlists that have to
// agree with each other and with what is on disk:
//
//   - `@preventive/report` — its own package.json, whose `files` is the
//     tarball; a source missing from it is absent from the published library,
//     and since every module there is reached by a relative import from
//     `index.js`, the first thing a consumer does throws ERR_MODULE_NOT_FOUND.
//   - `@preventive/triage` — the root `files`, behind the `./report` export.
//
// Neither list is generated, and the first guard above only scans server sources,
// so a new `report/*.js` is one forgotten line away from a library that cannot
// be imported. The library also has to stay STANDALONE to be publishable at all:
// it may import nothing outside its own directory, since nothing outside ships
// in its tarball.
test('report/ is publishable from both package.json files, and imports nothing outside itself', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const rootPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const libPkg = JSON.parse(readFileSync(new URL('../report/package.json', import.meta.url), 'utf8'))
  // Tests ship in neither tarball — they are the library's own suite, run from
  // a checkout (`node --run test` in report/), not something a consumer imports.
  const sources = execSync('git ls-files report', { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter((f) => f.endsWith('.js') && !f.startsWith('report/tests/'))

  // One entry point, and only one: the package exports `.` and its own
  // package.json, nothing else. Every module lives under `src/` and is
  // reached through `index.js`, so what that file names IS the contract
  // — a `./*.js` here would put every internal back on the surface,
  // where a rename becomes a breaking change for consumers.
  assert.deepEqual(
    Object.keys(libPkg.exports).toSorted(), ['.', './package.json'],
    'report/ must expose one entry point — index.js — and not its internals',
  )
  assert.equal(libPkg.exports['.'], './index.js')
  const deep = sources.filter((f) => f !== 'report/index.js' && !f.startsWith('report/src/'))
  assert.deepEqual(deep, [], `report modules outside src/ (only index.js sits at the root):\n  ${deep.join('\n  ')}`)

  const libAllow = new Set(libPkg.files.map((f) => `report/${f}`))
  const missingFromLib = sources.filter((f) => !libAllow.has(f))
  assert.deepEqual(
    missingFromLib, [],
    `report sources missing from report/package.json "files" — absent from the ` +
    `published @preventive/report tarball:\n  ${missingFromLib.join('\n  ')}`,
  )

  const rootAllow = new Set(rootPkg.files)
  const missingFromRoot = sources.filter((f) => !rootAllow.has(f))
  assert.deepEqual(
    missingFromRoot, [],
    `report sources missing from the root package.json "files" — the ./report ` +
    `export resolves to a missing file:\n  ${missingFromRoot.join('\n  ')}`,
  )

  // Inverse: a list naming a file that no longer exists. npm ignores the entry
  // silently, so a rename would leave the module unpublished with both lists
  // still looking full.
  const onDisk = new Set(sources)
  const phantom = [...libAllow, ...rootAllow.values()]
    .filter((f) => f.startsWith('report/') && f.endsWith('.js') && !onDisk.has(f))
  assert.deepEqual(phantom, [], `allowlisted report files that don't exist:\n  ${phantom.join('\n  ')}`)

  // Standalone: every import in the library resolves inside the library. A
  // `../common/…` would work in this checkout and break in the tarball.
  const escaping = []
  for (const f of sources) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      // Comments carry example import lines (index.js shows how to call in);
      // only real statements matter.
      .replaceAll(/^\s*(?:\/\/.*|\*.*)$/gmu, '')
    for (const m of text.matchAll(/\bfrom\s+'([^']+)'/gu)) {
      // `./…` inside src/, and `./src/…` from index.js — anything
      // climbing out of the package is what this is looking for.
      if (!m[1].startsWith('./')) escaping.push(`${f} → ${m[1]}`)
    }
  }
  assert.deepEqual(
    escaping, [],
    `report/ must import nothing outside itself — these would be missing from ` +
    `the tarball:\n  ${escaping.join('\n  ')}`,
  )
})
