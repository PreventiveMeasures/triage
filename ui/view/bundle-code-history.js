// File history is separate from both issue stepping and the finding panel's
// history. A changed bundle or an externally replaced selection starts fresh.
export function bundleFileHistory(history, bundle, file) {
  if (history?.bundle === bundle && history.files[history.at] === file) return history
  return { bundle, files: file ? [file] : [], at: 0 }
}

export function visitBundleFile(history, file) {
  if (history.files[history.at] === file) return history
  const files = [...history.files.slice(0, history.at + 1), file]
  return { ...history, files, at: files.length - 1 }
}

export function stepBundleFile(history, direction) {
  return { ...history, at: Math.max(0, Math.min(history.at + direction, history.files.length - 1)) }
}
