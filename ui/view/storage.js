// Persistent file storage backs the sidebar. OPFS — Origin Private
// File System — is the preferred layer (real files, larger quota); on
// origins where OPFS is unavailable (file://, older browsers) we
// transparently fall back to localStorage with each report stored
// gzipped + base64 under a fixed prefix. Both layers key by basename;
// filename collisions overwrite.
const OPFS_DIR = 'deepview-reports'
const LS_REPORT_PREFIX = 'deepview.report:'

let opfsWarned = false
async function getOpfsDir() {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(OPFS_DIR, { create: true })
  } catch (err) {
    if (!opfsWarned) {
      opfsWarned = true
      // file:// and older browsers reject OPFS. We fall back to gzipped
      // localStorage automatically; surface this once so a user wondering
      // about quota / size limits sees what's happening.
      console.warn('OPFS unavailable, falling back to gzipped localStorage (limited quota).', err)
    }
    return null
  }
}

// Compress / decompress JSON text via gzip + base64 for the localStorage
// fallback. CompressionStream / DecompressionStream are well supported
// (same primitive used by loadTriage / saveTriage). Base64 is the
// transport because localStorage values are strings.
async function gzipString(text) {
  const bytes = new TextEncoder().encode(text)
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  const arr = new Uint8Array(await new Response(stream).arrayBuffer())
  return arr.toBase64()
}
async function gunzipString(b64) {
  const bytes = Uint8Array.fromBase64(b64)
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  const arr = new Uint8Array(await new Response(stream).arrayBuffer())
  return new TextDecoder().decode(arr)
}

// Storage layer: try OPFS first (real files, large quota), fall back to
// gzipped localStorage when OPFS is unavailable. Each function probes
// OPFS once per call — caching is unnecessary because getDirectoryHandle
// is cheap. localStorage paths read/write a key prefixed with
// LS_REPORT_PREFIX; the file list is enumerated by scanning that prefix.
export async function listFiles() {
  const dir = await getOpfsDir()
  if (dir) {
    const names = []
    for await (const [name] of dir.entries()) names.push(name)
    return names.sort()
  }
  const names = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(LS_REPORT_PREFIX)) names.push(key.slice(LS_REPORT_PREFIX.length))
  }
  return names.sort()
}

export async function saveFile(name, content) {
  const dir = await getOpfsDir()
  if (dir) {
    // Remove first so a shorter overwrite shrinks the underlying file.
    try { await dir.removeEntry(name) } catch {}
    const fh = await dir.getFileHandle(name, { create: true })
    const writable = await fh.createWritable()
    await writable.write(content)
    await writable.close()
    return
  }
  const compressed = await gzipString(content)
  try {
    localStorage.setItem(LS_REPORT_PREFIX + name, compressed)
  } catch (err) {
    // Most likely QuotaExceededError. Re-throw so the drop handler can
    // surface a useful message to the user instead of silently dropping.
    throw new Error(`localStorage write failed for ${name}: ${err.message}`)
  }
}

export async function readFile(name) {
  const dir = await getOpfsDir()
  if (dir) {
    const fh = await dir.getFileHandle(name)
    const file = await fh.getFile()
    return await file.text()
  }
  const compressed = localStorage.getItem(LS_REPORT_PREFIX + name)
  if (compressed === null) throw new Error(`File not found: ${name}`)
  return await gunzipString(compressed)
}

export async function deleteFile(name) {
  const dir = await getOpfsDir()
  if (dir) {
    try { await dir.removeEntry(name) } catch {}
    return
  }
  localStorage.removeItem(LS_REPORT_PREFIX + name)
}
