import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type ObjectPage, type RawObjectStorage, objectPath } from './object-storage.ts'

function missing(err: unknown): boolean { return (err as NodeJS.ErrnoException).code === 'ENOENT' }
function version(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])
}

// Keyset pagination survives concurrent file creation/deletion. A final sweep
// catches objects inserted before the cursor during migration.
async function listFiles(dir: string, prefix: string, cursor: string | null, limit: number): Promise<ObjectPage> {
  const objects: ObjectPage['objects'] = []
  async function visit(key: string): Promise<void> {
    let entries
    try { entries = await readdir(join(dir, key), { withFileTypes: true }) }
    catch (err) { if (missing(err)) return; throw err }
    const order = (entry: typeof entries[number]) => `${entry.name}${entry.isDirectory() ? '/' : ''}`
    entries.sort((a, b) => order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0)
    for (const entry of entries) {
      const child = `${key}${entry.name}`
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not supported in managed object storage')
      if (entry.isDirectory()) {
        const folder = `${child}/`
        if (cursor && folder < cursor && !cursor.startsWith(folder)) continue
        await visit(folder)
        if (objects.length > limit) return
      }
      else if (entry.isFile() && (!cursor || child > cursor)) {
        try { objects.push({ key: objectPath(child), modifiedAt: (await stat(join(dir, child))).mtimeMs }) }
        catch (err) { if (!missing(err)) throw err }
        if (objects.length > limit) return
      }
    }
  }
  if (!prefix.endsWith('/') || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid storage page')
  objectPath(`${prefix}validate`)
  await visit(prefix)
  return { objects: objects.slice(0, limit), cursor: objects.length > limit ? objects[limit - 1]!.key : null }
}

export function createDiskObjectStorage(dir: string): RawObjectStorage {
  const path = (key: string) => join(dir, objectPath(key))
  return {
    async open(key, signal) {
      signal?.throwIfAborted()
      let file
      try { file = await open(path(key), 'r') }
      catch (err) { if (missing(err)) return null; throw err }
      try {
        const info = await file.stat()
        return { size: info.size, version: version(info), modifiedAt: info.mtimeMs,
          stream: file.createReadStream(signal ? { signal } : {}) }
      } catch (err) { await file.close(); throw err }
    },
    async exists(key) {
      try { await stat(path(key)); return true } catch (err) { if (missing(err)) return false; throw err }
    },
    async put(key, bytes, signal) {
      const target = path(key)
      // Temporary ciphertext is in the same namespace and filesystem. Startup
      // never exposes it; maintenance collects abandoned encrypted candidates.
      const temp = `${target}.${randomUUID()}.tmp`
      await mkdir(dirname(target), { recursive: true })
      const file = await open(temp, 'wx', 0o600)
      try {
        await file.writeFile(bytes, signal ? { signal } : {})
        await file.sync(); await file.close()
        signal?.throwIfAborted()
        await rename(temp, target)
        const directory = await open(dirname(target), 'r')
        try { await directory.sync() } finally { await directory.close() }
      } finally { await file.close(); await rm(temp, { force: true }) }
    },
    async delete(key, expected) {
      try {
        if (expected !== undefined && version(await stat(path(key))) !== expected) return false
        await rm(path(key), { force: true }); return true
      } catch (err) { if (missing(err)) return true; throw err }
    },
    list: (prefix, cursor, limit) => listFiles(dir, prefix, cursor, limit),
  }
}
