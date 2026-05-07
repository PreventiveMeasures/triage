import { state } from './state.js'
import { sidebar, fileList } from './dom.js'
import { esc } from './format.js'
import { listFiles } from './storage.js'
import { switchToFile, switchToWorkspace, deleteCurrent } from './ingest.js'
import { getCount, getKind, ensureCounts } from './counts.js'
import { listWorkspaces, createWorkspace, setReportWorkspace, renameWorkspace } from './workspaces.js'
import { migrateLegacyFilenames } from './migrate-legacy.js'
import { exportWorkspace } from './workspace-export.js'

// dataTransfer mime used by intra-sidebar drag-and-drop. The value is
// the report's filename. We carry both this private mime AND
// text/plain so browsers that drop the private mime in cross-frame
// scenarios still have a fallback payload — the type-check below
// uses the private mime so OS file drags (which only carry Files)
// don't accidentally match.
const REPORT_DT = 'application/x-deepview-report'

// Sidebar source-grouping. Each known finding-source format gets its
// own bucket; the JSON bucket renders under "Reports" since that's
// the analyzer's native dump format. The counts cache stores a
// detected `source` alongside each file's count, so the bucket
// follows what the parser identified rather than the filename — both
// DeepSec and Claude Security ship as `.md`, so an extension check
// alone can't tell them apart. When the cache hasn't filled yet
// (pre-existing OPFS entries on first sidebar render) we fall back
// to extension; ensureCounts repopulates and re-renders shortly.
function groupOf(name) {
  const kind = getKind(name)
  if (kind === 'deepsec') return 'deepsec'
  if (kind === 'claude-security') return 'claude-security'
  const lower = name.toLowerCase()
  if (lower.endsWith('.codex')) return 'codex-security'
  if (lower.endsWith('.md')) return 'claude-security'
  return 'default'
}

// Section header label per group. The default JSON bucket renders
// under "Reports" — broad enough to fit any analyzer-native dump
// (deduplicate output, single-run output, etc.) without naming the
// pipeline. Named buckets carry the upstream's product name —
// DeepSec is Vercel's tool (https://github.com/vercel-labs/deepsec).
const GROUP_LABELS = {
  'default': 'Reports',
  'claude-security': 'Claude Security',
  'codex-security': 'Codex Security',
  'deepsec': 'DeepSec',
}

// Render order for buckets — default (analyzer dumps) first, then
// named sources in alphabetical-ish reading order.
const GROUP_ORDER = ['default', 'claude-security', 'codex-security', 'deepsec']

// Filename-to-label transform for the bucket-marker suffixes ingest
// stamps on at drop time. `.codex` filenames are derived (e.g.
// `org__repo:scan-suffix.codex`) — un-sanitize the slashes and strip
// the suffix for the visible label so the sidebar reads as the
// original `org/repo:scan-suffix`. DeepSec drops keep their original
// `.md` extension and need no transform.
function displayName(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.codex')) return name.slice(0, -'.codex'.length).replace(/__/gu, '/')
  return name
}

// Inline `<svg>` for the file-row icon. 14px to match the chrome's
// other icon buttons. Each bucket renders as a filled "sticker":
// the sheet body fills with a brand color, a translucent black
// triangle in the corner reads as a folded-over flap, and the mark
// sits centered in the foreground color. The default Reports bucket
// uses DeepView's own house mark (white on blue) — eye + iris rings
// + camera aperture surrounded by circuit ornaments — so
// analyzer-native dumps still get a recognizable sticker. The
// surrounding decorative ring from the source artwork is dropped;
// the 100×101.3 logo is scaled by 0.095 around (8, 8.5) so it fits
// inside the file body. Source buckets pull the upstream's official
// mark (Claude on salmon, OpenAI on white, Vercel on black). Bg /
// fg fills are themed via the `.brand-*` classes on the SVG root in
// sidebar.css; path coordinates have been baked through svgo so the
// brand glyphs land at their final positions without runtime
// transforms. Re-baked into each row's HTML rather than referenced
// by id so a single `innerHTML` write paints the whole list.
const STICKER_BASE = '<path class="bg" d="M3 2h6l4 4v8H3z"/><path fill="rgba(0,0,0,.18)" d="M9 2v4h4Z"/>'
const FILE_ICONS = {
  'default': `<svg class="file-icon brand-deepview" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${STICKER_BASE}<path class="fg" d="M7.843 6.719c-1.605 0-2.926 1.292-3.477 1.947.466.58 1.872 2.024 3.496 2.024s2.907-1.292 3.486-2.005c-.627-.703-1.88-1.966-3.505-1.966m.019 3.857c-1.51 0-2.802-1.263-3.353-1.9.55-.617 1.814-1.852 3.334-1.852 1.51 0 2.698 1.12 3.335 1.852-.533.618-1.787 1.9-3.316 1.9m-.019-3.42c-.826 0-1.577.694-1.577 1.596 0 .789.599 1.577 1.577 1.577.893 0 1.587-.684 1.587-1.577-.01-.779-.627-1.596-1.587-1.596m0 3.069a1.476 1.476 0 0 1-1.482-1.473c0-.722.599-1.491 1.482-1.491.846 0 1.482.693 1.492 1.491 0 .808-.618 1.473-1.492 1.473m.01-2.727c-.637 0-1.264.532-1.264 1.244 0 .627.475 1.235 1.245 1.245.684 0 1.254-.522 1.254-1.244 0-.58-.475-1.236-1.235-1.245m-.02 2.403a1.167 1.167 0 0 1-1.149-1.159c0-.532.456-1.14 1.169-1.149.56 0 1.149.427 1.159 1.15 0 .636-.485 1.158-1.179 1.158m-.769-1.833c-.19.238-.275.494-.237.864l.74.057zm1.026-.294c-.295-.057-.665 0-.912.228l.323.607zm.133.047-.38.56.988.114c-.057-.275-.323-.579-.608-.674m-.124.741.456.912c.21-.209.352-.484.314-.836zm-1.225.504a.97.97 0 0 0 .57.617l.399-.551zm.713.664c.313.076.636.01.845-.161l-.295-.618zm-.637 1.55c0 .028-.028.066-.066.066h-.59c-.028 0-.066-.028-.066-.066s.029-.066.067-.066h.579c.048 0 .076.028.076.066m.712 0c0 .028-.028.066-.066.066h-.437c-.028 0-.066-.028-.066-.066s.028-.066.066-.066h.437c.038 0 .066.028.066.066m.666 0c0 .028-.029.066-.067.066h-.37c-.029 0-.067-.028-.067-.066s.029-.066.067-.066h.37c.038 0 .067.028.067.066m-1.672.351c0 .029-.029.067-.067.067h-.295c-.028 0-.066-.028-.066-.066 0-.029.029-.067.067-.067h.294c.038 0 .066.028.066.066m.694 0c0 .029-.028.067-.066.067h-.409c-.028 0-.066-.028-.066-.066 0-.029.028-.067.066-.067h.399c.038 0 .076.028.076.066m.732 0c0 .029-.029.067-.067.067h-.465c-.029 0-.067-.028-.067-.066 0-.029.029-.067.067-.067h.465c.038 0 .067.028.067.066m-1.093.371a.065.065 0 0 1-.067.066h-.627c-.028 0-.075-.028-.066-.066 0-.028.029-.066.067-.066h.627c.038 0 .066.028.066.066m.684 0a.065.065 0 0 1-.066.066h-.39c-.028 0-.076-.028-.066-.066 0-.028.028-.066.066-.066h.39c.038 0 .066.028.066.066M5.088 6.263c-.019-.105-.114-.19-.237-.19s-.257.104-.257.237.105.238.247.238c.105 0 .218-.076.238-.18h.864v.826l.095-.048V6.31c0-.028-.019-.057-.048-.057h-.902zm-.237.19c-.076 0-.143-.066-.143-.143s.066-.142.143-.142.142.066.142.143c.01.076-.066.142-.143.142m2.89-.323H6.38l.418-.475v-.332a.255.255 0 0 0 .218-.248c0-.123-.114-.256-.256-.256s-.266.114-.266.257c0 .123.095.228.209.247v.284l-.456.523v.893l.095-.047v-.742h1.396c.029 0 .067-.009.067-.057 0-.028-.019-.047-.067-.047m-1.13-1.054c0-.076.066-.152.152-.152s.152.066.152.151c0 .076-.066.152-.152.152s-.152-.066-.152-.152m-.836 5.264h-.874c-.019-.105-.114-.219-.247-.219s-.256.105-.256.257c0 .132.114.275.266.275.104 0 .218-.076.237-.19h.827v.608l-.257.285a.3.3 0 0 0-.095-.019c-.133 0-.256.105-.256.228 0 .133.104.238.237.238.124 0 .247-.105.247-.238a.23.23 0 0 0-.057-.152l.285-.304v-.712c0-.029-.019-.058-.057-.058m-1.121.219a.16.16 0 0 1-.152-.161c0-.077.066-.162.152-.162s.152.066.152.152-.066.171-.152.171m.713 1.14c-.076 0-.143-.066-.143-.143s.066-.133.143-.133.142.067.142.143c0 .066-.066.133-.143.133m5.472-1.377a.24.24 0 0 0-.237.208h-1.13c-.029 0-.038.02-.038.048v.712l-.323.39h-.029a.245.245 0 0 0-.247.247c0 .133.114.256.247.256s.247-.113.247-.256a.26.26 0 0 0-.123-.219l.313-.38v-.674h1.083c.019.105.114.2.238.2.133 0 .266-.105.266-.257 0-.133-.105-.276-.266-.276m-1.758 1.767a.15.15 0 0 1-.143-.152c0-.075.067-.142.143-.142s.152.066.152.143a.15.15 0 0 1-.152.151m1.758-1.33a.15.15 0 0 1-.143-.152.147.147 0 0 1 .294.001.15.15 0 0 1-.152.151M8.917 5.55h-.399a.075.075 0 0 1-.076-.076c0-.028.029-.066.067-.066h.418c.028 0 .066.028.066.066s-.038.076-.076.076m.742 0H9.22c-.038 0-.067-.028-.067-.076 0-.028.029-.066.067-.066h.437c.038 0 .066.028.066.066s-.028.076-.066.076m.883 0h-.598c-.029 0-.067-.028-.067-.076 0-.028.029-.066.067-.066h.598c.028 0 .066.028.066.066s-.028.076-.066.076m-1.282.4h-.741c-.038 0-.076-.029-.076-.067s.028-.076.066-.076h.75c.039 0 .067.038.067.076 0 .029-.028.067-.066.067m.797 0h-.503c-.038 0-.076-.029-.076-.067s.028-.066.066-.066h.513c.038 0 .067.028.067.066 0 .029-.029.067-.067.067m.476 0h-.19c-.039 0-.067-.029-.067-.067s.028-.066.066-.066h.2c.028 0 .066.028.066.066 0 .029-.028.067-.075.067m-1.682.398h-.332c-.039 0-.077-.028-.077-.066s.029-.066.067-.066h.342c.038 0 .076.028.076.066s-.028.066-.076.066m.789 0h-.494c-.038 0-.067-.028-.067-.066s.029-.066.067-.066h.494c.038 0 .066.028.066.066s-.028.066-.066.066m.893 0h-.599c-.038 0-.076-.028-.076-.066s.028-.066.066-.066h.618c.028 0 .066.028.066.066s-.028.066-.076.066m.418.305a.69.69 0 0 0-.674.712c0 .086.019.18.048.257l.085.066c-.028-.085-.057-.171-.057-.304 0-.285.228-.646.598-.646.295 0 .599.228.599.636a.58.58 0 0 1-.599.59.8.8 0 0 1-.237-.048l.123.114a.4.4 0 0 0 .114.01c.39 0 .684-.276.684-.666 0-.313-.266-.712-.684-.722m.353.552-.019-.01-.161.19-.143-.01-.057-.047-.019-.133.19-.2a.28.28 0 0 0-.361.077c-.076.095-.076.209-.038.351l-.247.304.171.152.266-.266c.142.038.285.019.38-.095a.31.31 0 0 0 .038-.313"/></svg>`,
  'claude-security': `<svg class="file-icon brand-claude" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${STICKER_BASE}<path class="fg" d="m5.875 10.154 1.376-.772.023-.067-.023-.037h-.067l-.23-.015-.787-.02-.681-.03-.661-.035-.166-.035-.156-.205.016-.103.14-.094.2.018.442.03.665.046.481.028.714.075h.113l.016-.047-.039-.028-.03-.028-.687-.466-.744-.492-.39-.284-.21-.143-.106-.135-.046-.294.19-.21.258.017.065.018.26.2.557.43.726.535.106.089.042-.03.006-.022-.048-.08-.395-.713-.422-.726-.187-.301-.05-.18a1 1 0 0 1-.03-.213l.218-.296.12-.039.29.039.123.106.18.413.293.65.453.884.133.262.07.242.027.075h.046v-.043l.038-.497.069-.611.067-.787.023-.221.11-.266.218-.143.17.081.14.2-.02.13-.083.54-.163.846-.106.567h.062l.07-.07.287-.382.482-.602.213-.239.248-.264.159-.125h.301l.221.329-.099.34-.31.393-.256.333-.369.496-.23.397.021.032.055-.006.832-.177.45-.081.537-.092.243.113.026.115-.096.236-.573.141-.673.135-1.003.237-.012.01.014.017.452.042.193.01h.473l.88.066.23.153.138.186-.023.141-.354.181-.478-.113-1.116-.266-.383-.096h-.053v.032l.32.312.584.528.731.68.037.168-.094.133-.099-.014-.643-.484-.248-.218-.561-.472H9.08v.05l.129.189.684 1.027.035.315-.05.103-.177.062-.194-.036-.4-.561-.413-.632-.333-.567-.041.023-.197 2.116-.092.108-.212.082-.177-.135-.094-.218.094-.43.113-.561.092-.447.083-.554.05-.184-.004-.013-.04.006-.418.574-.636.858-.503.539-.12.048-.21-.108.02-.193.117-.172.696-.886.42-.549.27-.317-.001-.046h-.016l-1.85 1.201-.328.042-.142-.132.018-.218.067-.071.556-.383Z"/></svg>`,
  'codex-security': `<svg class="file-icon brand-codex" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${STICKER_BASE}<path class="fg" d="M11.04 8.364a1.72 1.72 0 0 0-.152-1.432 1.8 1.8 0 0 0-1.925-.846 1.8 1.8 0 0 0-.778-.498 1.8 1.8 0 0 0-.927-.05 1.8 1.8 0 0 0-.827.414 1.77 1.77 0 0 0-.507.767 1.8 1.8 0 0 0-.683.297 1.75 1.75 0 0 0-.499.549 1.75 1.75 0 0 0 .22 2.07 1.72 1.72 0 0 0 .151 1.432 1.8 1.8 0 0 0 1.926.846 1.77 1.77 0 0 0 1.333.587c.78 0 1.47-.496 1.707-1.227a1.8 1.8 0 0 0 .684-.298 1.75 1.75 0 0 0 .499-.548 1.75 1.75 0 0 0-.222-2.063m-2.667 3.678a1.33 1.33 0 0 1-.851-.304l.042-.024 1.413-.804a.23.23 0 0 0 .116-.199V8.747l.597.34q.01.005.011.015v1.629a1.323 1.323 0 0 1-1.328 1.31m-2.857-1.203a1.3 1.3 0 0 1-.158-.879l.042.025 1.414.805a.23.23 0 0 0 .23 0l1.729-.982v.68a.02.02 0 0 1-.01.018l-1.431.814a1.34 1.34 0 0 1-1.816-.48m-.372-3.037a1.32 1.32 0 0 1 .7-.574v1.656a.22.22 0 0 0 .114.197l1.72.979-.598.34a.02.02 0 0 1-.021 0L5.63 9.587a1.304 1.304 0 0 1-.487-1.791zm4.907 1.125L8.327 7.94l.596-.34a.02.02 0 0 1 .02 0l1.43.814a1.3 1.3 0 0 1 .512.528 1.3 1.3 0 0 1-.118 1.4 1.33 1.33 0 0 1-.595.436V9.122a.23.23 0 0 0-.12-.195m.594-.881-.042-.025-1.411-.812a.23.23 0 0 0-.232 0l-1.727.983v-.68a.02.02 0 0 1 .008-.018l1.429-.813a1.34 1.34 0 0 1 1.425.061 1.3 1.3 0 0 1 .55 1.298zM6.908 9.252l-.597-.34a.02.02 0 0 1-.012-.016V7.271c0-.249.073-.493.209-.703s.329-.378.557-.483a1.35 1.35 0 0 1 1.415.18l-.042.023-1.413.804a.23.23 0 0 0-.116.2zm.324-.69.77-.438.77.438v.875l-.768.437-.77-.437z"/></svg>`,
  'deepsec': `<svg class="file-icon brand-vercel" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${STICKER_BASE}<path class="fg" d="m8 5.97 3.5 6.062h-7Z"/></svg>`,
}

// Live module state — the search-box query, applied as a
// case-insensitive substring match on each file's display name.
// Cleared by switchToFile / deleteCurrent indirectly (a fresh render
// starts from this same value), so users can switch files without
// losing their search.
let searchQuery = ''

function fileItemHtml(n, opts = {}) {
  const indented = opts.indented ? ' indented' : ''
  const cls = `file-item${n === state.currentFile ? ' current' : ''}${indented}`
  const label = displayName(n)
  const count = getCount(n)
  const countHtml = count !== undefined ? `<span class="file-count">${count}</span>` : ''
  const icon = FILE_ICONS[groupOf(n)] ?? FILE_ICONS.default
  // Indented rows live inside a workspace; carry the workspace id so a
  // drop onto one of these is treated as "assign to this workspace"
  // (which is idempotent if it's the report's current home, and a
  // move when it isn't). Top-level rows have no workspace attribute,
  // so dropping onto them is treated as "outside any workspace" and
  // falls through to the unfiled-section drop target.
  const wsAttr = opts.workspaceId ? ` data-workspace-id="${esc(opts.workspaceId)}"` : ''
  return `<li class="${cls}" data-file="${esc(n)}"${wsAttr} draggable="true"><button type="button" class="file-name" title="${esc(label)}">${icon}<span class="file-label">${esc(label)}</span>${countHtml}</button></li>`
}

function groupHeaderHtml(label, count, opts = {}) {
  const extraClass = opts.dropTarget ? ' default-reports' : ''
  const dataAttr = opts.dropTarget ? ' data-default-reports="true"' : ''
  return `<li class="file-group-header${extraClass}"${dataAttr}><span class="group-label">${esc(label)}</span><span class="group-count">${count}</span></li>`
}

// Workspaces section header — same chrome as a regular bucket header,
// but the right slot carries a plus button instead of a count chip.
// `data-action="new-workspace"` is what the sidebar click delegate
// dispatches on; the chip's title gives the affordance a tooltip
// mirroring the "Delete current" button below.
const WORKSPACE_PLUS_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>'
function workspaceHeaderHtml(count) {
  return `<li class="file-group-header workspace-header"><span class="group-label">Workspaces</span><span class="workspace-header-actions"><span class="group-count">${count}</span><button type="button" class="workspace-add" data-action="new-workspace" title="Create a new workspace" aria-label="Create a new workspace">${WORKSPACE_PLUS_ICON}</button></span></li>`
}

const WORKSPACE_ICON = '<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="11" height="9" rx="1.2"/><path d="M6 4V3h4v1"/></svg>'
// Stacked-list glyph for the open-workspace button — three short
// horizontal bars suggesting "merged list of findings". Distinct
// from the download icon so the two affordances don't look alike.
const WORKSPACE_OPEN_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h10"/></svg>'
// Download glyph used by the per-workspace export button — a
// downward arrow over a tray. Sized to match the "+" affordance in
// the section header.
const WORKSPACE_EXPORT_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8M5 7l3 3 3-3M3 13h10"/></svg>'
function workspaceItemHtml(w, reportCount) {
  const isCurrent = state.currentWorkspace === w.id
  const cls = `file-item workspace-item${isCurrent ? ' current' : ''}`
  const countHtml = reportCount > 0 ? `<span class="file-count workspace-count">${reportCount}</span>` : ''
  // Per-workspace action buttons: open (loads every report into a
  // single merged view) on the left, download (export the workspace
  // as a `.gz` bundle) on the right. Both hover-revealed; clicking
  // the workspace name itself is intentionally a no-op so the user
  // doesn't trip into a merged load by accident.
  const openBtn = `<button type="button" class="workspace-open" data-action="open-workspace" title="Open workspace as merged list" aria-label="Open workspace">${WORKSPACE_OPEN_ICON}</button>`
  const exportBtn = `<button type="button" class="workspace-export" data-action="export-workspace" title="Export workspace" aria-label="Export workspace">${WORKSPACE_EXPORT_ICON}</button>`
  return `<li class="${cls}" data-workspace-id="${esc(w.id)}"><button type="button" class="file-name" title="${esc(w.name)}">${WORKSPACE_ICON}<span class="file-label">${esc(w.name)}</span></button>${openBtn}${exportBtn}${countHtml}</li>`
}

function matchesSearch(name) {
  if (!searchQuery) return true
  return displayName(name).toLowerCase().includes(searchQuery)
}

// Render the OPFS file list into the sidebar. Highlights the active
// file. Disables Delete when nothing's open. Hides the whole sidebar
// when there are no files AND nothing's currently loaded — keeps the
// empty-state drop zone uncluttered. Section headers render for every
// non-empty bucket (including the default Reports group) so the
// vocabulary stays consistent across mixed-format collections. Called
// after every state transition that could change the file list, the
// current selection, or the search query.
export async function renderSidebar() {
  // One-shot migration of `.deepseek` OPFS entries back to `.md`
  // (relic of an earlier build). Cached after the first call so
  // subsequent renders are a no-op; awaiting before listFiles makes
  // sure the listing reflects the post-rename state.
  await migrateLegacyFilenames()
  const names = await listFiles()
  const workspaces = listWorkspaces()
  // The sidebar always shows now — Workspaces is a first-class feature
  // and its "+" button must be reachable on first launch (before any
  // report or workspace exists). The drop zone still owns the welcome
  // copy in main; the sidebar just exposes the create-workspace
  // affordance alongside.
  sidebar.classList.remove('empty')

  // Reports already claimed by a workspace render INSIDE that workspace
  // and are dropped from the default buckets. Stale entries (a workspace
  // referencing a report that no longer exists in OPFS) are ignored at
  // render time — they round-trip in the JSON until a setReportWorkspace
  // call rewrites the list and prunes them.
  const nameSet = new Set(names)
  const claimed = new Set()
  for (const w of workspaces) {
    for (const r of w.reports) if (nameSet.has(r)) claimed.add(r)
  }

  // Bucket by group, applying the search filter as we go so empty
  // post-filter groups skip their header entirely.
  const buckets = new Map()
  for (const g of GROUP_ORDER) buckets.set(g, [])
  for (const n of names) {
    if (claimed.has(n)) continue
    if (!matchesSearch(n)) continue
    const g = groupOf(n)
    if (!buckets.has(g)) buckets.set(g, [])
    buckets.get(g).push(n)
  }

  let html = ''
  // Workspaces above Reports. The header itself is filtered by name;
  // each workspace's own reports are filtered too so a name search
  // surfaces matches inside workspaces without the parent disappearing.
  const visibleWorkspaces = workspaces.filter((w) => {
    if (!searchQuery) return true
    if (w.name.toLowerCase().includes(searchQuery)) return true
    return w.reports.some((r) => nameSet.has(r) && matchesSearch(r))
  })
  html += workspaceHeaderHtml(visibleWorkspaces.length)
  for (const w of visibleWorkspaces) {
    const visibleReports = w.reports.filter((r) => nameSet.has(r) && matchesSearch(r))
    html += workspaceItemHtml(w, visibleReports.length)
    for (const r of visibleReports) html += fileItemHtml(r, { indented: true, workspaceId: w.id })
  }

  // Default buckets — render unfiled reports under their format header.
  // The Reports (default JSON) header is also a drop target for "remove
  // from workspace": dropping a workspace-internal report there detaches
  // it back to the unfiled list. When no unfiled JSON reports exist but
  // some workspace has reports, we still render the Reports header (with
  // count 0) so the unassign affordance stays reachable.
  const anyWorkspaceHasReports = workspaces.some((w) => w.reports.some((r) => nameSet.has(r)))
  for (const g of GROUP_ORDER) {
    const list = buckets.get(g) ?? []
    const isDefault = g === 'default'
    if (list.length === 0 && !(isDefault && anyWorkspaceHasReports)) continue
    html += groupHeaderHtml(GROUP_LABELS[g] ?? g, list.length, { dropTarget: isDefault })
    for (const n of list) html += fileItemHtml(n)
  }
  fileList.innerHTML = html

  const deleteBtn = document.getElementById('delete-current')
  if (deleteBtn) deleteBtn.disabled = !state.currentFile

  // Lazy-fill counts for any pre-existing OPFS entries that don't
  // have one cached yet. Re-renders incrementally as each lands so
  // the user sees badges populate progressively rather than waiting
  // for the whole batch. Fire-and-forget — the awaited path here
  // would block initial render for as long as the slowest file's
  // parse takes.
  ensureCounts(names, () => { renderSidebar() })
}

// Sidebar event delegation: file-list click switches; Delete removes
// the current file; toggle collapses / expands; search filters on
// input. The workspace "+" button intercepts BEFORE the file-row
// match because a workspace header is itself a `<li>` that contains
// no `data-file` — but the add button still bubbles to the same
// listener.
sidebar.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="new-workspace"]')) {
    const name = window.prompt('Workspace name')
    if (name && name.trim()) {
      createWorkspace(name)
      renderSidebar()
    }
    return
  }
  // Open-workspace icon — load every report in the workspace into a
  // single merged view. Distinct from clicking the workspace name
  // itself (which is intentionally inert): a stray click on the row
  // shouldn't replace the user's current view.
  const openEl = e.target.closest('[data-action="open-workspace"]')
  if (openEl) {
    const wsEl = openEl.closest('[data-workspace-id]')
    if (wsEl) switchToWorkspace(wsEl.dataset.workspaceId)
    return
  }
  // Per-workspace export — find the enclosing workspace li, look the
  // workspace up, hand it to exportWorkspace. Listed before the
  // file-item handler because the export button lives inside the
  // workspace li and we don't want a stray click to fall through.
  const exportEl = e.target.closest('[data-action="export-workspace"]')
  if (exportEl) {
    const wsEl = exportEl.closest('[data-workspace-id]')
    const ws = wsEl ? listWorkspaces().find((w) => w.id === wsEl.dataset.workspaceId) : null
    if (ws) exportWorkspace(ws).catch((err) => alert(`Failed to export workspace: ${err.message}`))
    return
  }
  const fileEl = e.target.closest('.file-item[data-file]')
  if (fileEl) {
    const name = fileEl.dataset.file
    if (name && name !== state.currentFile) switchToFile(name)
    return
  }
  if (e.target.closest('#delete-current')) {
    deleteCurrent()
    return
  }
  if (e.target.closest('#sidebar-toggle')) {
    sidebar.classList.toggle('collapsed')
    try { localStorage.setItem('deepview.sidebarCollapsed', sidebar.classList.contains('collapsed') ? '1' : '0') } catch {}
  }
})

const searchInput = document.getElementById('sidebar-search-input')
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase()
    renderSidebar()
  })
}

// Double-click a workspace row → inline rename. Replaces the label
// span with an <input> on the fly; Enter or blur commits, Escape
// reverts. The row's other affordances (open / export / drop
// targets) stay live but a re-render after commit/revert paints
// fresh chrome anyway. Imperative DOM swap rather than a state flag
// because the edit is a one-off, scoped to a single row.
sidebar.addEventListener('dblclick', (e) => {
  const wsRow = e.target.closest('.file-item.workspace-item')
  if (!wsRow) return
  const labelSpan = wsRow.querySelector('.file-label')
  if (!labelSpan || labelSpan.querySelector('input')) return
  const id = wsRow.dataset.workspaceId
  const ws = listWorkspaces().find((w) => w.id === id)
  if (!ws) return
  e.preventDefault()
  const input = document.createElement('input')
  input.type = 'text'
  input.value = ws.name
  input.className = 'workspace-rename-input'
  labelSpan.textContent = ''
  labelSpan.appendChild(input)
  input.focus()
  input.select()
  let done = false
  const finish = (commit) => {
    if (done) return
    done = true
    if (commit) renameWorkspace(id, input.value)
    renderSidebar()
  }
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true) }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
  // Stop bubbling so the row's click delegate doesn't fire while the
  // user clicks inside the input (focusing / selecting text shouldn't
  // open the workspace).
  input.addEventListener('click', (ev) => ev.stopPropagation())
  input.addEventListener('dblclick', (ev) => ev.stopPropagation())
})

// Intra-sidebar drag-and-drop — move reports between workspaces and
// the unfiled list. The whole sidebar is a drop zone:
//   - drop on any element with `[data-workspace-id]` (workspace row
//     OR one of its indented children) → assign to that workspace
//   - drop anywhere else in the sidebar → detach (back to the unfiled
//     list, where the report's filename extension routes it to the
//     correct format bucket)
// The Reports header lights up as the visual affordance for the
// detach drop (when it's rendered), but the drop works regardless of
// what the cursor is over so "drag back" is forgiving.
//
// OS file drops are NOT mistaken for this: the type check below looks
// for our private mime, which only the dragstart below sets. The
// document-level drop handler in ingest.js still handles OS files
// (its `e.dataTransfer.files` check no-ops on internal drags).
function clearDragOver() {
  for (const el of sidebar.querySelectorAll('.drag-over')) el.classList.remove('drag-over')
}

sidebar.addEventListener('dragstart', (e) => {
  const fileEl = e.target.closest('.file-item[data-file]')
  if (!fileEl) return
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData(REPORT_DT, fileEl.dataset.file)
  e.dataTransfer.setData('text/plain', fileEl.dataset.file)
  fileEl.classList.add('dragging')
})

sidebar.addEventListener('dragend', () => {
  for (const el of sidebar.querySelectorAll('.dragging')) el.classList.remove('dragging')
  clearDragOver()
})

sidebar.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes(REPORT_DT)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  clearDragOver()
  const wsTarget = e.target.closest('[data-workspace-id]')
  if (wsTarget) {
    // Highlight at the workspace level so dropping on either the
    // workspace row or any of its indented children reads as the
    // same target.
    const wsId = wsTarget.dataset.workspaceId
    for (const el of sidebar.querySelectorAll(`[data-workspace-id="${CSS.escape(wsId)}"]`)) {
      el.classList.add('drag-over')
    }
  } else {
    // Anywhere outside a workspace block detaches; mark the Reports
    // header as the visible affordance when it's rendered.
    const indicator = sidebar.querySelector('[data-default-reports]')
    if (indicator) indicator.classList.add('drag-over')
  }
})

sidebar.addEventListener('dragleave', (e) => {
  // Only clear if we've left the sidebar entirely — internal moves
  // between target / non-target elements re-trigger dragover and
  // re-paint the highlight.
  if (!sidebar.contains(e.relatedTarget)) clearDragOver()
})

sidebar.addEventListener('drop', (e) => {
  if (!e.dataTransfer.types.includes(REPORT_DT)) return
  const filename = e.dataTransfer.getData(REPORT_DT)
  if (!filename) {
    clearDragOver()
    return
  }
  e.preventDefault()
  e.stopPropagation()
  clearDragOver()
  const wsTarget = e.target.closest('[data-workspace-id]')
  const targetId = wsTarget ? wsTarget.dataset.workspaceId : null
  setReportWorkspace(filename, targetId)
  renderSidebar()
})
