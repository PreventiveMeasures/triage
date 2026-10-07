// Open a file picker (hidden input, created on demand) and hand the chosen files
// to `onFiles`. `multiple` allows batch uploads.
export function pickFiles(onFiles, multiple = true) {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = multiple
  input.addEventListener('change', () => { onFiles([...input.files]) }, { once: true })
  input.click()
}

// Wire file drag&drop onto a host element: `onFiles(File[])` fires on drop, and
// `onState(active)` toggles as a file drag enters / leaves (drives the drop
// overlay). Enter/leave are tracked with a depth counter so moving over child
// nodes doesn't flicker the overlay, and only drags that actually carry files
// are handled (so dragging text / a link is ignored). Returns a teardown.
export function installFileDropZone(host, onFiles, onState) {
  let depth = 0
  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const onEnter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth += 1; onState(true) }
  const onOver = (e) => { if (hasFiles(e)) e.preventDefault() } // preventDefault marks us a drop target
  const onLeave = (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (depth === 0) onState(false) }
  const onDrop = (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation() // this page owns the drop — don't let the app's global drop handler also see it
    depth = 0
    onState(false)
    onFiles([...e.dataTransfer.files])
  }
  host.addEventListener('dragenter', onEnter)
  host.addEventListener('dragover', onOver)
  host.addEventListener('dragleave', onLeave)
  host.addEventListener('drop', onDrop)
  return () => {
    host.removeEventListener('dragenter', onEnter)
    host.removeEventListener('dragover', onOver)
    host.removeEventListener('dragleave', onLeave)
    host.removeEventListener('drop', onDrop)
  }
}

// A failed upload can still have stored part of its file (a product of a split
// Markdown import) or committed before its response was lost, so its
// collections are refreshed as after a success. A session change reset them.
async function mutateUpload(host, file, upload, families) {
  const generation = host.appState.generation
  try { return await host.appState.mutate(() => upload(file), families) }
  catch (err) {
    if (generation === host.appState.generation) host.appState.invalidate(families)
    throw err
  }
}

// A local import owns exactly one upload result. Drops that arrive meanwhile
// wait in the regular queue, then run separately so their failures cannot turn
// a successful import into a retry (and duplicate the managed report).
export async function uploadLocalFile(host, file, upload, families) {
  if (host._busy || !host._csrf) throw new Error('Wait for the current operation to finish, then try again.')
  host._busy = true
  try { await mutateUpload(host, file, upload, families) }
  finally {
    await host._load()
    host._busy = false
    const queued = host._queue.splice(0)
    if (queued.length > 0) void host._upload(queued)
  }
}

// Drain files in arrival order. A drop during an upload joins the same batch.
// A failed file does not stop the rest: every failure is named in one message
// that survives the list refresh. A session change ends the batch, since its
// remaining files belong to the previous session.
export async function uploadFiles(host, files, upload, families) {
  if (files.length === 0) return
  host._queue.push(...files)
  if (host._busy) return
  host._busy = true
  host._error = null
  const generation = host.appState.generation
  const failures = []
  let attempted = 0
  try {
    while (host._queue.length > 0) {
      if (host.appState.generation !== generation) { host._queue = []; break }
      const file = host._queue.shift()
      try { await mutateUpload(host, file, upload, families) }
      catch (err) {
        if (err?.name === 'AbortError' || host.appState.generation !== generation) { host._queue = []; break }
        failures.push(`${file.name}: ${String(err?.message ?? err)}`)
      }
      attempted++
    }
  } finally {
    if (failures.length > 0) {
      host._error = attempted === 1 ? `Upload failed: ${failures[0]}`
        : `Upload failed for ${failures.length} of ${attempted} files: ${failures.join('; ')}`
    }
    host._busy = false
    await host._load({ preserveError: true })
  }
}
