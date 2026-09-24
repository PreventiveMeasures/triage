export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`
  return `${(bytes / 1_073_741_824).toFixed(1)} GiB`
}

export function sourceMetrics(files) {
  if (!Array.isArray(files)) return { bytes: null, lines: null }
  return files.reduce((total, file) => ({
    bytes: total.bytes != null && Number.isFinite(file.bytes) ? total.bytes + file.bytes : null,
    lines: total.lines != null && Number.isFinite(file.lines) ? total.lines + file.lines : null,
  }), { bytes: 0, lines: 0 })
}
