import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type ObjectPage, type RawObjectStorage, objectPath } from './object-storage.ts'

function missing(err: unknown): boolean { return (err as NodeJS.ErrnoException).code === 'ENOENT' }
function version(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])
}

async function syncDirectory(dir: string): Promise<void> {
  try {
    const directory = await open(dir, 'r')
    try { await directory.sync() } finally { await directory.close() }
  } catch (err) {
    // Windows and some mounted filesystems cannot open/fsync directories.
    // Preserve real I/O failures; file fsync remains mandatory on every write.
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR', 'EBADF', 'EPERM'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
  }
}

// Keyset pagination survives concurrent file creation/deletion. A final sweep
// catches objects inserted before the cursor during migration.
async function listFiles(dir: string, prefix: string, cursor: string | null, limit: number, signal?: AbortSignal): Promise<ObjectPage> {
  const objects: ObjectPage['objects'] = []
  async function visit(key: string): Promise<void> {
    signal?.throwIfAborted()
    let entries
    try {
      if (!(await lstat(join(dir, key))).isDirectory()) {
        console.warn('managed-storage: skipping unsupported directory', JSON.stringify(key))
        return
      }
      entries = await readdir(join(dir, key), { withFileTypes: true })
    }
    catch (err) { if (missing(err)) return; throw err }
    const order = (entry: typeof entries[number]) => `${entry.name}${entry.isDirectory() ? '/' : ''}`
    entries.sort((a, b) => order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0)
    for (const entry of entries) {
      signal?.throwIfAborted()
      const child = `${key}${entry.name}`
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        console.warn('managed-storage: skipping unsupported entry', JSON.stringify(child))
        continue
      }
      try { objectPath(child) }
      catch { console.warn('managed-storage: skipping invalid entry', JSON.stringify(child)); continue }
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
    try { await syncDirectory(join(dir, key)) } catch (err) { if (!missing(err)) throw err }
  }
  if (!prefix.endsWith('/') || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid storage page')
  objectPath(`${prefix}validate`)
  await visit(prefix)
  return { objects: objects.slice(0, limit), cursor: objects.length > limit ? objects[limit - 1]!.key : null }
}

export function createDiskObjectStorage(dir: string): RawObjectStorage {
  const path = (key: string) => join(dir, objectPath(key))
  return {
    async head(key, signal) {
      signal?.throwIfAborted()
      try {
        const info = await stat(path(key))
        return { size: info.size, version: version(info), modifiedAt: info.mtimeMs }
      } catch (err) { if (missing(err)) return null; throw err }
    },
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
        if (expected === null) {
          try { await link(temp, target) }
          catch (err) { if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false; throw err }
        } else if (expected === undefined) await rename(temp, target)
        else {
          try { if (version(await stat(target)) !== expected) return false }
          catch (err) { if (missing(err)) return false; throw err }
          await rename(temp, target)
        }
        await syncDirectory(dirname(target))
        return true
      } finally { await file.close(); await rm(temp, { force: true }) }
    },
    async delete(key, expected, signal) {
      signal?.throwIfAborted()
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
    async sync(key, signal) { signal?.throwIfAborted(); await syncDirectory(dirname(path(key))) },
    async prune(prefix, signal) {
      if (!prefix.endsWith('/')) throw new Error('Invalid storage prefix')
      objectPath(`${prefix}validate`)
      async function visit(folder: string): Promise<void> {
        signal?.throwIfAborted()
        let entries
        try {
          if (!(await lstat(folder)).isDirectory()) return
          entries = await readdir(folder, { withFileTypes: true })
        }
        catch (err) { if (missing(err)) return; throw err }
        for (const entry of entries) if (entry.isDirectory()) await visit(join(folder, entry.name))
        try { await rmdir(folder); await syncDirectory(dirname(folder)) }
        catch (err) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err }
      }
      await visit(join(dir, prefix))
    },
    list: (prefix, cursor, limit, signal) => listFiles(dir, prefix, cursor, limit, signal),
  }
}
