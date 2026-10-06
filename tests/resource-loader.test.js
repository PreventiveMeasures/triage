import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const loader = fileURLToPath(new URL('./_resource-loader.js', import.meta.url))
const probe = `
  import assert from 'node:assert/strict'
  import { spawnSync } from 'node:child_process'
  import { getCompileCacheDir } from 'node:module'
  const depth = Number(process.argv[1])
  console.log(JSON.stringify({ directory: getCompileCacheDir() ?? null, base: process.env.NODE_COMPILE_CACHE ?? null }))
  if (depth < 2) {
    // The runner and worker preload the loader; a spawned server only inherits env.
    const args = depth === 0 ? process.execArgv : process.execArgv.filter(arg => !arg.startsWith('--require='))
    const child = spawnSync(process.execPath, [...args, String(depth + 1)], { encoding: 'utf8', timeout: 10000 })
    assert.ifError(child.error)
    assert.equal(child.status, 0, child.stderr)
    process.stdout.write(child.stdout)
  }
`

for (const mode of ['default', 'configured', 'disabled', 'coverage']) {
  test(`resource loader shares the compile cache across processes (${mode})`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-compile-cache-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const env = { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir }
    delete env.NODE_COMPILE_CACHE
    delete env.NODE_DISABLE_COMPILE_CACHE
    delete env.NODE_V8_COVERAGE
    if (mode === 'configured') env.NODE_COMPILE_CACHE = join(dir, 'custom-cache')
    if (mode === 'disabled') env.NODE_DISABLE_COMPILE_CACHE = '1'
    if (mode === 'coverage') env.NODE_V8_COVERAGE = join(dir, 'coverage')

    const child = spawnSync(process.execPath, [`--require=${loader}`, '--input-type=module', '--eval', probe, '0'], {
      env, encoding: 'utf8', timeout: 30000,
    })
    assert.ifError(child.error)
    assert.equal(child.status, 0, child.stderr)
    const caches = child.stdout.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(caches.length, 3)
    if (mode === 'disabled' || mode === 'coverage') {
      assert.deepEqual(caches, Array.from({ length: 3 }, () => ({ directory: null, base: null })))
    } else {
      assert.ok(caches[0].directory)
      assert.deepEqual(caches[1], caches[0])
      assert.deepEqual(caches[2], caches[0])
      if (mode === 'configured') assert.equal(caches[0].base, env.NODE_COMPILE_CACHE)
    }
  })
}

const coverageModes = [
  ['NODE_V8_COVERAGE', true],
  ['--experimental-test-coverage', true],
  ['--experimental-test-coverage=true', true],
  ['--experimental-test-coverage=false', true],
  ['--experimental_test_coverage=true', true],
  ['--no-experimental_test_coverage --experimental-test_coverage=true', true],
  ['--no-experimental_test_coverage', false],
  ['--experimental-test-coverage --no-experimental-test-coverage', false],
]
for (const [mode, coverage] of coverageModes) {
  test(`resource loader respects coverage options in workers and servers (${mode})`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-coverage-cache-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const env = { ...process.env, NODE_COMPILE_CACHE: join(dir, 'cache') }
    delete env.NODE_DISABLE_COMPILE_CACHE
    delete env.NODE_V8_COVERAGE
    delete env.NODE_TEST_CONTEXT
    const args = [`--require=${loader}`, '--test']
    if (mode === 'NODE_V8_COVERAGE') env.NODE_V8_COVERAGE = join(dir, 'coverage')
    else args.push(...mode.split(' '))

    const checkCache = `
      import assert from 'node:assert/strict'
      import { constants, enableCompileCache, getCompileCacheDir } from 'node:module'
      if (${coverage}) {
        assert.equal(getCompileCacheDir(), undefined)
        assert.equal(process.env.NODE_COMPILE_CACHE, undefined)
        assert.equal(enableCompileCache().status, constants.compileCacheStatus.DISABLED)
      } else {
        assert.ok(getCompileCacheDir())
        assert.ok(process.env.NODE_COMPILE_CACHE)
        assert.equal(enableCompileCache().status, constants.compileCacheStatus.ALREADY_ENABLED)
      }
    `
    const fixture = join(dir, 'coverage.test.mjs')
    writeFileSync(fixture, `
      ${checkCache}
      import { spawnSync } from 'node:child_process'
      // A server inherits the worker environment without preloading the loader.
      const server = spawnSync(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(checkCache)}], {
        encoding: 'utf8', timeout: 10000,
      })
      assert.ifError(server.error)
      assert.equal(server.status, 0, server.stderr)
    `)
    const runner = spawnSync(process.execPath, [...args, fixture], { env, encoding: 'utf8', timeout: 30000 })
    assert.ifError(runner.error)
    assert.equal(runner.status, 0, runner.stdout + runner.stderr)
    if (mode !== 'NODE_V8_COVERAGE') assert.equal(runner.stdout.includes('start of coverage report'), coverage)
  })
}
