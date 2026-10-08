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

// Source panel counts. Until a bundle's inventory loads, its catalogue
// summary (the counts the bundle picker already shows) stands in, so a
// selection doesn't blank them while metadata is fetched. Code counts only
// Code inputs, as codeScanFiles does. Packages need the inventory itself;
// unknown counts are null.
export function sourceStats(bundle, files, mode) {
  if (Array.isArray(bundle?.files)) {
    return { files: files.length, lines: sourceMetrics(files).lines, packages: new Set(files.map(file => file.module)).size }
  }
  const known = value => Number.isSafeInteger(value) && value >= 0 ? value : null
  const summary = bundle?.summary
  return { files: known(summary?.[mode === 'code' ? 'codeFiles' : 'files']), lines: known(summary?.lines), packages: null }
}

// Binary resources and directory captures are bundle entries, not Code scan
// inputs. Use the recorded format rather than guessing from the path.
export function codeScanFiles(files) {
  return (files ?? []).filter(file => !['resource:base64', 'directory'].includes(file.format))
}
