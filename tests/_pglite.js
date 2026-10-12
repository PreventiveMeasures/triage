// PGlite started from a cached data directory. initdb takes ~3s in every test
// process; restoring its dump takes ~0.4s. The first process to start one
// dumps it while still pristine and caches the dump for the others.
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@electric-sql/pglite')), 'utf8'))
const prefix = 'triage-pglite-'
const cache = join(tmpdir(), `${prefix}${version}.tar`)

export async function startPglite() {
  try {
    const restored = new PGlite({ loadDataDir: new Blob([readFileSync(cache)]) })
    await restored.waitReady
    return restored
  } catch { /* no cache yet, or a stale one: initdb below rewrites it */ }
  const pg = new PGlite()
  const dump = Buffer.from(await (await pg.dumpDataDir('none')).arrayBuffer())
  try {
    // Concurrent processes each write their own file; renaming is atomic.
    const temporary = `${cache}.${process.pid}`
    writeFileSync(temporary, dump)
    renameSync(temporary, cache)
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith(prefix) && name.endsWith('.tar') && join(tmpdir(), name) !== cache) rmSync(join(tmpdir(), name), { force: true })
    }
  } catch { /* the cache only saves time */ }
  return pg
}
