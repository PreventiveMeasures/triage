// Load the requested finding's report row for an in-place Links preview. Keep the
// Links file and loaded reports unchanged; the card uses the usual ID-keyed
// triage store and the original report's source/bundle metadata.
import { computeLinkHint, loadRepoUrlFor, readFile, state, triageLoadPromise, workspacesHoldingReport } from '#client/index.js'
import { store } from '@rray/frontend/state-management'
import { inheritReportMeta, loadFindings, reportEntries, reportRepoGithub } from '../../report/index.js'

let preview = null
let generation = 0

export function getLinksPreview() {
  return state.currentView === 'links' && preview?.owner === state.currentLinks ? preview : null
}

export function closeLinksPreview() {
  generation++
  preview = null
}

export async function openLinksPreview(id, reportName, rowIndex) {
  if (state.currentView !== 'links' || !state.currentLinks) return
  // Use the canonical reactive wrapper from the outset. StateElement
  // lazily wraps nested state on its first tracked read; retaining the raw
  // object here would then mistake the card's first render for navigation.
  const owner = store(state.currentLinks)
  const ticket = ++generation
  preview = { owner, id, reportName, group: null, error: '' }
  state.focusCodeStack = []
  state.focusCodeAt = 0
  const active = () => ticket === generation && state.currentView === 'links' && state.currentLinks === owner
  try {
    const parsed = await loadFindings(await readFile(reportName))
    if (!active()) return
    const rows = (reportEntries(parsed?.data) ?? []).map((entry) => Array.isArray(entry) ? entry : [entry])
    const includesFinding = (row) => row?.some((f) => String(f?.id) === id)
    const row = includesFinding(rows[rowIndex]) ? rows[rowIndex] : rows.find(includesFinding)
    if (!row) throw new Error('This finding is no longer in the report.')
    const { data } = parsed
    const group = row.filter((f) => f?.id).map((finding) => {
      const filled = {
        ...finding,
        _reportName: reportName,
        _repoFallback: reportRepoGithub(data) ?? loadRepoUrlFor(reportName),
        _bundleHashes: data.bundleHashes ?? [],
        _source: finding.source ?? data.source ?? null,
      }
      inheritReportMeta(filled, data)
      filled._analyzer = filled._source ?? filled.type ?? null
      return filled
    })
    // Prime the same hints as report navigation for the card's Copy link.
    await Promise.all([
      triageLoadPromise,
      computeLinkHint('report', reportName),
      ...workspacesHoldingReport(reportName).map((w) => computeLinkHint('workspace', w.id)),
    ])
    if (active()) {
      preview.group = group
      state.activeTabByGroup.set(group[0].id, id)
    }
  } catch (err) {
    if (active()) preview.error = err.message || 'Unable to load this finding.'
  }
}
