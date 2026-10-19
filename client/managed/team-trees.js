import { managedFetch } from './request.js'

// GET /api/teams/:id/trees: a team's reports' file trees by report ID, asked
// for apart from them (session.js fetchTeamReports), once a graph or Files
// needs them; for a hidden report's preview, `reportId` as its reports were.
export async function fetchTeamTrees(teamId, { signal, reportId = null } = {}) {
  const query = reportId === null ? '' : `?reportId=${encodeURIComponent(reportId)}`
  let trees
  try {
    const res = await managedFetch(`/api/teams/${encodeURIComponent(teamId)}/trees${query}`,
      { credentials: 'same-origin', headers: { accept: 'application/json' }, signal })
    if (!res.ok) return null
    trees = (await res.json())?.trees
  } catch { return null }
  if (!trees || typeof trees !== 'object' || Array.isArray(trees)) return null
  const entries = Object.entries(trees)
  return entries.every(([, tree]) => tree && typeof tree === 'object' && !Array.isArray(tree)) ? new Map(entries) : null
}
