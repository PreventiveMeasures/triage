// Last-viewed reports share the encrypted deepview.lastFile slot with
// workspace and bundle pointers. Keep plain filenames readable for old
// saves, and store a selected parent atomically with its report name.
export function encodeReportLocation(name, workspaceId) {
  if (!workspaceId) return name
  return `r:${JSON.stringify({ name, workspaceId })}`
}

export function decodeReportLocation(value) {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith('r:')) {
    try {
      const location = JSON.parse(value.slice(2))
      if (location && typeof location.name === 'string' && location.name
          && typeof location.workspaceId === 'string' && location.workspaceId) {
        return { name: location.name, workspaceId: location.workspaceId }
      }
    } catch {}
  }
  // Old saves (and filenames that merely start with r:) have no parent.
  return { name: value, workspaceId: null }
}
