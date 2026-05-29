// `server/config.ts` boot-time guards. Spawns `server/index.ts` as a
// subprocess (same shape as `_helpers.bootServer`) but asserts the exit
// code + output instead of awaiting a listening port — both paths under
// test `process.exit` before the server binds.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Run `node server/index.ts [args]` to completion, capturing exit code
// + stdio. PORT=0 / HOST=127.0.0.1 so a path that DOES reach bind would
// still be harmless, but the cases here exit before that.
function runServerToExit({ args = [], env = {} } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['server/index.ts', ...args], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('server/config.ts: boot guards', () => {
  it('--help wins over a malformed env var (exits 0 with help)', async () => {
    // The --help check is honored BEFORE intEnv('PORT') etc. — so an
    // operator running --help to diagnose a typo'd PORT can reach the
    // help text. Pre-fix, intEnv('PORT') process.exit(1)'d first.
    const { code, stdout } = await runServerToExit({ args: ['--help'], env: { PORT: 'not-a-number' } })
    assert.equal(code, 0, '--help exits 0 even with a malformed PORT')
    assert.match(stdout, /Usage: node server\/index\.ts/u, 'prints the help text')
  })

  it('rejects a non-object config.json with a clear error (not a raw TypeError)', async () => {
    // `config.json` containing literal `null` is valid JSON but not an
    // object. Pre-fix, the cast let loadConfig crash on
    // `serverConfig.password` with a TypeError; now readServerConfigFile
    // fails loud with an operator-facing message.
    const dir = mkdtempSync(path.join(tmpdir(), 'deepview-cfg-'))
    const cfg = path.join(dir, 'config.json')
    writeFileSync(cfg, 'null')
    try {
      const { code, stderr } = await runServerToExit({ env: { CONFIG_PATH: cfg } })
      assert.equal(code, 1, 'exits 1 on a non-object config.json')
      assert.match(stderr, /expected a JSON object/u, 'clear operator-facing error, not a raw TypeError')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
