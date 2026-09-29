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

// A local import owns exactly one upload result. Drops that arrive meanwhile
// wait in the regular queue, then run separately so their failures cannot turn
// a successful import into a retry (and duplicate the managed report).
export async function uploadLocalFile(host, file, upload, families) {
  if (host._busy || !host._csrf) throw new Error('Wait for the current operation to finish, then try again.')
  host._busy = true
  try { await host.appState.mutate(() => upload(file), families) }
  finally {
    await host._load()
    host._busy = false
    const queued = host._queue.splice(0)
    if (queued.length > 0) void host._upload(queued)
  }
}

// Drain files in arrival order. A drop during an upload joins the same batch;
// the first failure discards its remaining files and survives the list refresh.
export async function uploadFiles(host, files, upload, families) {
  if (files.length === 0) return
  host._queue.push(...files)
  if (host._busy) return
  host._busy = true
  host._error = null
  try {
    while (host._queue.length > 0) {
      const file = host._queue.shift()
      await host.appState.mutate(() => upload(file), families)
    }
  } catch (err) {
    host._queue = []
    host._error = `Upload failed: ${String(err?.message ?? err)}`
  } finally {
    host._busy = false
    await host._load({ preserveError: true })
  }
}
