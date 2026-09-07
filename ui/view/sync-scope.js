// Which workspace the sync surfaces are talking about, and which of
// its files they can act on.
//
// The sync-status badge (render.js), the upload dialog it opens, and
// the objstore recovery dialog all need the same two answers: which
// workspace is in view, and which of its files live on this device.
// This module is where those are decided — headless, so the rule that
// decides what can be uploaded is testable without a browser, and so
// the badge's own module stays presentation.
//
// The rule is membership ∩ this device, and BOTH halves matter:
//
//   - Membership, not `state.reports`, because the loaded reports are
//     the workspace's FINDINGS-bearing members. A links file is a
//     member like any other (client/linked-findings.js) and carries no
//     findings, so it never enters `state.reports` — and reading the
//     upload set from there left it local-only forever, with no badge
//     ever saying so and peers never receiving it.
//
//   - This device, because a member whose bytes aren't here is exactly
//     what the sidebar draws as a muted "missing" row. Offering to
//     upload one would be offering to upload nothing, and the dialog
//     would fail the item on a read that can't succeed.

import { listWorkspaces, state } from '#client/index.js'

// The members of `members` this device can hand to the workspace's
// remote, in membership order.
//
// `stored` is the OPFS listing (cached on `state.storedFiles` by
// renderSidebar, the same way `state.bundles` is) — the direct answer
// to "is it here". `loaded` is the currently-loaded reports' names,
// and is a belt to that braces: a report in `state.reports` was read
// off disk to get there, so it is present by construction, and
// including it means this can never offer LESS than the loaded set
// even on a paint that beats the first OPFS listing.
export function syncableMembers(members, stored, loaded) {
  const here = new Set(stored)
  for (const name of loaded) here.add(name)
  return members.filter((name) => here.has(name))
}

// Resolve which workspace + which of its files the sync-status badge
// applies to. `mode` differentiates a single-file view (one member,
// opened on its own) from a workspace-merged view (all of them), so
// the badge template can pick between the `local` / `cloud` chip and
// the "N cloud / M local" aggregate. Returns null when the active view
// isn't a workspace member at all.
export function resolveWorkspaceContext() {
  if (state.currentWorkspace) {
    const ws = listWorkspaces().find((w) => w.id === state.currentWorkspace)
    const loaded = state.reports.map((r) => r.fileName).filter((n) => typeof n === 'string')
    return {
      mode: 'workspace',
      workspaceId: state.currentWorkspace,
      // No workspace record for the id in `state` shouldn't happen —
      // but if it does, the loaded reports are still the truth about
      // what is open, and a badge counting them beats no badge.
      fileNames: ws
        ? syncableMembers(ws.reports ?? [], state.storedFiles ?? [], loaded)
        : loaded,
    }
  }
  // Single-file view — a report, or a links file on its own page. Both
  // are members by filename, so neither needs a special case here.
  if (state.currentFile) {
    const ws = listWorkspaces().find((w) => Array.isArray(w.reports) && w.reports.includes(state.currentFile))
    if (!ws) return null
    return { mode: 'single', workspaceId: ws.id, fileNames: [state.currentFile] }
  }
  return null
}
