import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type ObjectPage, type RawObjectStorage, objectPath } from './object-storage.ts'

function missing(err: unknown): boolean { return (err as NodeJS.ErrnoException).code === 'ENOENT' }
function version(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])
}

async function syncDirectory(dir: string): Promise<void> {
  const directory = await open(dir, 'r')
  try { await directory.sync() } finally { await directory.close() }
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
    // Another migration worker can observe an unlink before its writer has
    // synced the directory. Persist those observed removals before an empty
    // inventory can mark the shared migration complete.
    await syncDirectory(join(dir, key))
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
    async put(key, bytes, signal, expected) {
      const target = path(key)
      // Temp-file + rename makes replacement atomic to readers. Concurrent
      // migrations use the same persisted data key and immutable plaintext.
      const temp = `${target}.${randomUUID()}.tmp`
      await mkdir(dirname(target), { recursive: true })
      const file = await open(temp, 'wx', 0o600)
      try {
        await file.writeFile(bytes, signal ? { signal } : {})
        await file.sync(); await file.close()
        signal?.throwIfAborted()
        if (expected !== undefined) {
          try { if (version(await stat(target)) !== expected) return false }
          catch (err) { if (missing(err)) return false; throw err }
        }
        await rename(temp, target)
        await syncDirectory(dirname(target))
        return true
      } finally { await file.close(); await rm(temp, { force: true }) }
    },
    async delete(key, expected) {
      try {
        if (expected !== undefined && version(await stat(path(key))) !== expected) return false
        await rm(path(key), { force: true })
        // Persist plaintext removal before migration checkpoints completion.
        // Otherwise a crash could restore the directory entry after SQL has
        // durably disabled further plaintext inventory sweeps.
        await syncDirectory(dirname(path(key)))
        return true
      } catch (err) { if (missing(err)) return true; throw err }
    },
    sync: key => syncDirectory(dirname(path(key))),
    list: (prefix, cursor, limit) => listFiles(dir, prefix, cursor, limit),
  }
}
