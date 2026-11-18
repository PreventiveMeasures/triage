// The loader the servers ship their TypeScript through (strip-types-loader.js),
// run as a consumer runs it, `node --import`, over files written for it: each
// that is UTF-8 and erasable runs as Node would run it, and one that is not
// is refused, rather than run otherwise than written.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const LOADER = fileURLToPath(new URL('../strip-types-loader.js', import.meta.url))

test('the loader runs TypeScript that is UTF-8 and erasable, a byte order mark first or not, and refuses what is not', t => {
  const dir = mkdtempSync(join(tmpdir(), 'strip-types-loader-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // A file of `bytes` run through the loader: its output, or why it failed.
  const run = (name, bytes) => {
    const path = join(dir, name)
    writeFileSync(path, bytes)
    const { status, stdout, stderr } = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', LOADER, path], { encoding: 'utf8' })
    return status === 0 ? stdout : `failed: ${stderr}`
  }
  const utf8 = text => Buffer.from(text, 'utf8')
  assert.equal(run('plain.ts', utf8('const a: number = 1\nconsole.log(a)\n')), '1\n')
  assert.equal(run('bom.ts', utf8('﻿const a: number = 2\nconsole.log(a)\n')), '2\n', 'a byte order mark first, as Node runs it')
  assert.equal(run('wide.ts', utf8('const a: "é一\u{1F600}" = "é" // —\nconsole.log(a)\n')), 'é\n', 'types and comments of any width erased')
  assert.equal(run('common.cts', utf8('const b: string = "c"\nmodule.exports = b\nconsole.log(require(__filename))\n')), 'c\n', 'a .cts file as CommonJS')
  assert.match(run('latin1.ts', Buffer.from('const a: "é" = "é"\nconsole.log(a)\n', 'latin1')), /^failed: [^]*is not valid UTF-8/u, 'not UTF-8, refused unread')
  assert.match(run('enum.ts', utf8('enum E { A }\nconsole.log(E.A)\n')), /^failed: [^]*ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/u, 'nothing but types erased')
})
