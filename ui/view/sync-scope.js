// Which workspace the sync surfaces (the badge, its upload dialog, the
// objstore recovery dialog) are about, and which of its files they can act
// on — headless, so the upload rule tests without a browser. That rule is
// membership ∩ this device:
//   - membership, not `state.reports`: a links file is a member but carries
//     no findings, so never loads, and read from there it stayed local-only
//     forever, unbadged, never reaching peers;
//   - this device: a member without bytes here is the sidebar's muted
//     "missing" row, and an upload of it would fail on its read.

import { listWorkspaces, state } from '#client/index.js'

// The members this device can hand the workspace's remote, in membership
// order. `stored` is the OPFS listing (`state.storedFiles`, from
// renderSidebar); `loaded` the loaded reports' names, present by
// construction, so a paint beating the first listing still offers them.
export function syncableMembers(members, stored, loaded) {
  const here = new Set(stored)
  for (const name of loaded) here.add(name)
  return members.filter((name) => here.has(name))
}

// The workspace + files the badge applies to: `mode` 'single' for one
// member opened on its own (a report, or a links file's page), 'workspace'
// for the merged view — the `local` / `cloud` chip or the "N cloud / M
// local" aggregate. Null outside any workspace.
export function resolveWorkspaceContext() {
  if (state.currentWorkspace) {
    const ws = listWorkspaces().find((w) => w.id === state.currentWorkspace)
    const loaded = state.reports.map((r) => r.fileName).filter((n) => typeof n === 'string')
    return {
      mode: 'workspace',
      workspaceId: state.currentWorkspace,
      // Without a record for the id (shouldn't happen), the loaded reports
      // are still what is open, and a badge counting them beats none.
      fileNames: ws
        ? syncableMembers(ws.reports ?? [], state.storedFiles ?? [], loaded)
        : loaded,
    }
  }
  if (state.currentFile) {
    const ws = listWorkspaces().find((w) => Array.isArray(w.reports) && w.reports.includes(state.currentFile))
    if (!ws) return null
    return { mode: 'single', workspaceId: ws.id, fileNames: [state.currentFile] }
  }
  return null
}
