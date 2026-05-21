import { render as litRender, nothing } from 'lit'
import { analyzeContent, deleteFile, deleteWorkspace, listWorkspaces, loadRepoUrlFor, pruneOrphanTriage, readFile, removeCount, removeSecureItem, saveBundle, saveFile, saveRepoUrlFor, setCount, setReportWorkspace, setSecureItem, state, triageLoadPromise } from '#client/index.js'
import { closeWorkspace as closePresence, deleteFromRemote as deletePresence, openWorkspace as openPresence, triageSync } from './client-sync.js'
import { dropZone, report } from './dom.js'
import { toGroup } from './group.js'
import { resetFilters } from './filters.js'
import { render } from './render.js'
import { renderSidebar } from './sidebar.js'
import { cleanupGraph2, graph2 } from './graph/state.js'
import { openBundle, prefetchBundleHashes } from './bundle-load.js'
import { parseMarkdownFindings } from '../../common/parse-md.js'
import { parseCodexCsvToScans } from '../../common/parse-codex.js'
import { parseDeepsecFindings } from '../../common/parse-deepsec.js'
import { deriveFindingId } from '../../common/finding-id.js'
import { importWorkspaceFromGzip } from './workspace-import.js'
import { maybePromptFirstImport } from './first-import-prompt.js'
import { openPasskeyUnlockDialog } from './dialogs/passkey-unlock-dialog.js'

// Run-level meta fields that the analyzer emits at the top of each report
// (and that the deduplicate command stamps on each finding individually).
// `ingestReport` lifts any of these from the report header onto each
// finding at ingest, so the renderer can show per-finding mode info
// uniformly without branching on whether the file came from a
// deduplicated dump.
const META_FIELDS = ['type', 'model', 'think', 'effort', 'exportsMode']
// localStorage key for the last-viewed file — restored on page load so
// the user picks back up where they left off. The stored value is the
// OPFS filename for a single-file view; prefixed with `ws:` for a
// workspace view; or prefixed with `b:` followed by the SRI-shaped
// integrity for a bundle view, optionally followed by a space and the
// active sub-tab (`b:<integrity> <tab>`). Mutually exclusive — one
// current selection at a time, last-clicked wins.
export const LAST_FILE_KEY = 'deepview.lastFile'
// Sub-tabs in the bundles details panel — the tab strip rendered by
// render-bundle.js, the data-bundle-tab click handler in events.js,
// and the boot-time restore in view.js all key off this list.
// 'packages' is the default and is omitted from the LAST_FILE_KEY
// suffix; an unrecognised value on restore falls back to 'packages'.
export const BUNDLE_TABS = new Set(['packages', 'files', 'reports', 'graph', 'treemap', 'issues', 'code', 'terminal'])

// Persist a bundle selection to LAST_FILE_KEY, encoding the active
// sub-tab as `b:<integrity> <tab>`. The default 'packages' tab is
// dropped from the suffix so the round-trip lands on a clean
// `b:<integrity>` when nothing further is meaningful.
export function persistLastBundle(integrity, tab = 'packages') {
  const suffix = tab && tab !== 'packages' && BUNDLE_TABS.has(tab) ? ` ${tab}` : ''
  setSecureItem(LAST_FILE_KEY, `b:${integrity}${suffix}`).catch(() => {})
}

// Generation token shared by every async load path
// (switchToFile / switchToWorkspace / deleteCurrent). Bumped at
// the entry of each; in-flight loads from a previous generation
// see their captured token go stale and bail out before touching
// state.reports. Without this, a quick second click in the
// sidebar could let two concurrent reads interleave their pushes
// — the new array would briefly hold the previous file's data
// merged with the new one. The headless `window.__loadFile` path
// stays unguarded (it doesn't touch loadGen) so the print flow's
// repeated-ingest accumulation still works.
let loadGen = 0
const isStaleLoad = (captured) => captured !== loadGen

// Drag/drop entry point. Each file is read, persisted to OPFS (replacing
// any existing entry of the same name), and the LAST one becomes the
// active view. Multiple drops at once still all save, but only the
// final one renders — merging across files is no longer a thing in the
// UI; the user switches via the sidebar.
// `.csv` drops are treated as Codex Security exports — the upstream
// merges several scans into one CSV and we split them at drop time so
// each scan ends up as its own sidebar entry. Slashes in repo names
// are sanitized to `__` because OPFS doesn't accept `/` in filenames;
// sidebar.js converts the substitution back for display. Each scan is
// stored as its derived JSON (the exact shape ingestReport expects),
// so loading later goes through the regular JSON.parse path.
// Bundle classifier — sourcemap (.map) or stasis (`.stasis.code.br`
// or the bare `stasis.code.br` filename for top-level drops).
// Returns the kind, or null when the file isn't a bundle. The
// stasis marker is the full `stasis.code.br` suffix (brotli-
// compressed JSON snapshot, see src/loaders/stasis.js); a plain
// `.br` could be any brotli-compressed payload, so we don't accept
// that. Both markers are filename-based; ingest doesn't validate
// the shape — bundles are archived as-is so the analyzer pipeline
// can consume them later.
function bundleKind(name) {
  const lower = stripDownloadDup(name.toLowerCase())
  if (lower.endsWith('.map')) return 'sourcemap'
  if (lower === 'stasis.code.br' || lower.endsWith('.stasis.code.br')) return 'stasis'
  return null
}

// Browsers (Chrome / Firefox / Safari) prepend ` (N)` to the LAST
// `.ext` segment when re-downloading a duplicate file —
// `foo.deepview-workspace.enc` becomes `foo.deepview-workspace (1).enc`,
// `bar.stasis.code.br` becomes `bar.stasis.code (1).br`. Strip a
// single trailing ` (\d+)` immediately before the final extension so
// drop-routing matches the canonical filename. Conservative: only
// the rightmost occurrence (lookahead pins it to the last `.foo`),
// and only when the trailer is bare digits — a legitimate name like
// `foo (final).enc` is left alone.
function stripDownloadDup(name) {
  return name.replace(/ \(\d+\)(?=\.[^.]*$)/u, '')
}

export async function addFiles(files) {
  // First-import nudge: ask once whether to enable passkey
  // encryption before this drop's files hit disk, so that an
  // accepted enable seals the very first write rather than landing
  // it as plaintext and then immediately re-writing the migration.
  // Skipped silently when the vault is already enabled, the
  // browser doesn't support WebAuthn, or the user already chose.
  await maybePromptFirstImport()
  let last = null
  let lastBundleIntegrity = null
  // Track every newly-saved bundle integrity in this drop so we
  // can prefetch their per-file hashes after `renderSidebar()`
  // refreshes `state.bundles` — the prefetch helper looks up
  // the entry there. Lets existing reports' "Code →" buttons
  // surface as soon as the matching bundle lands, without the
  // user having to manually open it.
  const newBundleIntegrities = new Set()
  for (const file of files) {
    try {
      // Route plaintext gzip and encrypted bundles to workspace import
      // BEFORE the file.text() read — UTF-8 decoding would mangle the
      // binary bytes. importWorkspaceFromGzip throws if the payload
      // doesn't match our export shape. `stripDownloadDup` normalises
      // browser-added ` (N)` duplicate suffixes so a redownloaded
      // `foo.deepview-workspace (1).enc` still routes here.
      const lower = stripDownloadDup(file.name.toLowerCase())
      if (lower.endsWith('.gz') || lower.endsWith('.deepview-workspace.enc')) {
        await importWorkspaceFromGzip(file)
        continue
      }
      // Bundle drops (sourcemap / stasis) — archive in the bundles
      // OPFS dir and skip the report-ingest pipeline. The dropped name
      // is preserved verbatim so the bundles list shows what the user
      // dropped. Binary content (stasis is brotli-compressed); read
      // as ArrayBuffer rather than text.
      const kind = bundleKind(file.name)
      if (kind) {
        const buf = new Uint8Array(await file.arrayBuffer())
        const { integrity } = await saveBundle(file.name, buf)
        lastBundleIntegrity = integrity
        newBundleIntegrities.add(integrity)
        continue
      }
      const content = await file.text()
      if (lower.endsWith('.csv')) {
        const scans = parseCodexCsvToScans(content)
        for (const { displayName, data } of scans) {
          const codexName = displayName.replaceAll('/', '__') + '.codex'
          const json = JSON.stringify(data)
          await saveFile(codexName, json)
          const { count, source } = analyzeContent(json)
          setCount(codexName, count, source)
          last = { name: codexName, content: json }
        }
      } else {
        // Validate before persisting — analyzeContent recognises
        // analyzer-native JSON, DeepSec, and Claude / Codex /
        // markdown imports. Anything else is rejected so we don't
        // litter OPFS with files the report viewer can't parse.
        const result = analyzeContent(content)
        if (!result.recognized) {
          throw new Error('not a recognized DeepView, DeepSec, Claude Security, or Codex report')
        }
        // The original drop name (and its extension) is preserved.
        await saveFile(file.name, content)
        setCount(file.name, result.count, result.source)
        last = { name: file.name, content }
      }
    } catch (err) {
      alert(`Failed to load ${file.name}: ${err.message}`)
    }
  }
  // renderSidebar refreshes state.bundles from OPFS so the bundle
  // we just imported is visible to the bundles view path below.
  await renderSidebar()
  // Now that state.bundles is fresh, kick a background hash
  // pre-parse for every bundle this drop saved. The hash index
  // populates the cross-bundle map the finding-card's "Code →"
  // button consults, so existing reports' findings can resolve
  // matches without the user manually opening every bundle.
  for (const integrity of newBundleIntegrities) {
    prefetchBundleHashes(integrity).catch(() => {})
  }
  if (last) {
    // Single-report drop wins over a bundle when both happen in
    // the same drop — the user's primary intent was the report.
    await switchToFile(last.name, last.content)
  } else if (lastBundleIntegrity) {
    // Bundle-only drop: switch to the bundles view AND open the
    // dropped bundle's details panel automatically. Mirrors the
    // events.js data-select-bundle flow — clear stale source-
    // viewer state, reset search, then hand off to the shared
    // open-bundle pipeline so the panel populates without a
    // second click.
    state.currentView = 'bundles'
    state.selectedBundle = lastBundleIntegrity
    state.bundleDetails = null
    state.bundleDetailsTab = 'packages'
    state.bundleSourceFile = null
    state.bundleSourceFindingIdx = null
    state.bundleCodeSearchQuery = ''
    state.bundleCodeSearchMode = 'files'
    state.shownTriage = null
    graph2.showAll = true
    persistLastBundle(lastBundleIntegrity)
    render()
    await renderSidebar()
    openBundle(lastBundleIntegrity)
  }
}

// Replace the active view with the named OPFS file. Pre-fetched
// `content` skips a redundant OPFS read (drop path passes it through).
export async function switchToFile(name, content) {
  const gen = ++loadGen
  // Subscribe-on-report-open: a single-file view of a workspace
  // member should still ride the workspace's chain, so the user
  // sees peer edits and pushes their own without having to switch
  // to the workspace tab first. A report can sit in more than one
  // workspace (cross-workspace finding share); open a session for
  // each. Sessions for OTHER workspaces close — the smarter
  // intersection (vs. the previous `closeSession()`-all-then-open)
  // keeps existing same-workspace sessions in memory across file
  // switches so we don't pay key derivation again.
  const desiredWorkspaceIds = new Set(
    listWorkspaces()
      .filter((w) => Array.isArray(w.reports) && w.reports.includes(name))
      .map((w) => w.id),
  )
  for (const info of triageSync.openSessions) {
    if (info && !desiredWorkspaceIds.has(info.workspaceId)) {
      // Close BOTH planes in lockstep. An objstore presence session must
      // never outlive its sync subscription: the objstore client rides
      // triage-sync's `workspace-subscribe` (which carries the inventory
      // snapshot and registers the socket for objstore-put/-deleted
      // broadcasts), so a presence session kept warm past its sync
      // session would, on the next reconnect, have no subscribe to seed
      // its inventory or deliver broadcasts. Keeping presence ⊆ sync (at
      // the cost of a cold cache on return visits) makes that impossible.
      triageSync.closeSession(info.workspaceId)
      closePresence(info.workspaceId)
    }
  }
  state.reports = []
  state.currentFile = name
  state.currentWorkspace = null
  // Switching to a regular report drops out of the bundles or
  // packages view — the user clicked a file row, they want to see
  // its findings.
  if (state.currentView === 'bundles' || state.currentView === 'packages' || state.currentView === 'repositories') {
    state.currentView = 'findings'
  }
  // Per-report repo URL (see state.js / saveRepoUrlFor). The user's
  // last-typed URL for THIS file lights up the header repo chip; an
  // unseen file starts empty. Reset before ingest so a stale URL
  // from the previous file doesn't briefly drive the header chip
  // until the new report's findings determine it isn't needed.
  state.repoUrl = loadRepoUrlFor(name)
  state.repoEditing = false
  // Reset graph v2 state so a new report doesn't open with stale
  // selection / hidden packages / a soloed pkg from the previous
  // file. The layout cache also invalidates (a new tree → re-layout).
  graph2.selected = null
  graph2.focusedPkg = null
  graph2.layoutCache = null
  graph2.solo = null
  graph2.hidden.clear()
  graph2.pathFilter = ''
  cleanupGraph2()
  setSecureItem(LAST_FILE_KEY, name).catch(() => {})
  if (content === undefined) {
    try {
      content = await readFile(name)
    } catch (err) {
      // Skip the alert / state-reset when a newer switch already
      // took over — its setup has already replaced the things we
      // would have cleared, and surfacing an error from the dead
      // load would just confuse the user.
      if (isStaleLoad(gen)) return
      // A "vault locked" failure is actionable: prompt the user to
      // unlock and retry on success. Mirrors the boot-time prompt
      // for users who dismissed it earlier in the session.
      if (err && err.message?.includes('vault locked')) {
        const ok = await openPasskeyUnlockDialog()
        if (ok && !isStaleLoad(gen)) {
          await switchToFile(name)
          return
        }
        // User dismissed the unlock dialog (or a newer switch took
        // over). Clear the about-to-be-current file so the sidebar
        // doesn't leave the row highlighted with no content loaded.
        if (!isStaleLoad(gen)) {
          state.currentFile = null
          await renderSidebar()
        }
        return
      }
      alert(`Failed to read ${name}: ${err.message}`)
      state.currentFile = null
      await renderSidebar()
      return
    }
    if (isStaleLoad(gen)) return
  }
  await ingestReport(name, content, gen)
  if (isStaleLoad(gen)) return
  // Open the session(s) AFTER ingest so buildWorkspaceIds sees the
  // freshly-loaded findings (without this it'd run against the
  // empty state.reports we just reset above and the session's
  // initial id-set would be empty until the next save). openSession
  // is idempotent on already-open ids; for those we then
  // `refreshSession` to pick up newly-in-scope ids from the freshly-
  // loaded state.reports — without this, a report dragged into the
  // workspace while a different file was focused would never
  // propagate its triage when the user finally loads it (the
  // session was already open with stale ids and openSession's
  // idempotence would skip the rebuild).
  for (const id of desiredWorkspaceIds) {
    triageSync.openSession(id)
    triageSync.refreshSession(id)
    openPresence(id)
  }
  await renderSidebar()
}

// Replace the active view with the merged contents of an entire
// workspace — every report assigned to the workspace is loaded
// sequentially via `ingestReport`, accumulating in `state.reports`.
// `state.currentFile` is cleared (workspace mode is mutually
// exclusive with single-file mode); `state.currentWorkspace` carries
// the workspace id. Per-report repo URLs round-trip via the
// `_repoFallback` stamp on each finding (see ingestReport above), so
// the global `state.repoUrl` is empty in this mode and the editable
// header chip is omitted. Reports the workspace references but that
// no longer exist in OPFS are skipped silently — no need to disturb
// the rest of the load.
export async function switchToWorkspace(workspaceId) {
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) return
  const gen = ++loadGen
  // Close triage-sync sessions for OTHER workspaces (not the one we're
  // switching to). Keeping the target's existing session alive avoids
  // a close + open + re-subscribe round-trip on every click of the
  // workspace title. After the ingest loop below, we call
  // `triageSync.refreshSession(workspaceId)` to bring the session's
  // id-set up to date with the freshly-loaded state.reports.
  // Close each other workspace's presence session in lockstep — an
  // objstore presence session must never outlive its sync subscription
  // (it rides triage-sync's `workspace-subscribe`), so presence ⊆ sync.
  for (const info of triageSync.openSessions) {
    if (info && info.workspaceId !== workspaceId) {
      triageSync.closeSession(info.workspaceId)
      closePresence(info.workspaceId)
    }
  }
  // Same drop-out as switchToFile — opening a workspace lands in
  // findings, not the bundles / packages list.
  if (state.currentView === 'bundles' || state.currentView === 'packages' || state.currentView === 'repositories') {
    state.currentView = 'findings'
  }
  state.reports = []
  state.currentFile = null
  state.currentWorkspace = workspaceId
  state.repoUrl = ''
  state.repoEditing = false
  graph2.selected = null
  graph2.focusedPkg = null
  graph2.layoutCache = null
  graph2.solo = null
  graph2.hidden.clear()
  graph2.pathFilter = ''
  cleanupGraph2()
  setSecureItem(LAST_FILE_KEY, `ws:${workspaceId}`).catch(() => {})
  // Empty workspace — no reports to ingest, so the readFile loop below
  // is a no-op. Without explicitly clearing the report pane here, the
  // user sees whatever was last rendered (a stale finding, a bundle,
  // etc.) while the sidebar marks this workspace as current — a "dead
  // click" UX. Mirror leaveWorkspace's empty-state teardown so the
  // drop zone re-appears and the user knows the workspace exists but
  // has nothing to show yet. Bundle-only workspaces (no reports, some
  // bundles) get the same treatment — the bundles render in the
  // sidebar; clicking the workspace row itself is a no-op for the main
  // pane until reports land.
  if (ws.reports.length === 0) {
    report.classList.remove('active')
    litRender(nothing, report)
    dropZone.classList.remove('hidden')
    document.body.classList.remove('show-print-btn')
  }
  // Kick off every readFile concurrently up front, then ingest the
  // results in workspace order. The await inside the loop only blocks
  // until each report's bytes land — slower reads carry on in the
  // background while the earlier ones get parsed + rendered, so the
  // first report's findings show up as soon as its read finishes
  // rather than waiting for the slowest read in the batch. ingest
  // ordering is preserved because the awaits walk the promise array
  // in workspace.reports order. Per-read failures resolve to `null`
  // (caught at the promise) so a single bad file doesn't reject the
  // whole batch.
  const reads = ws.reports.map((name) => readFile(name).catch(() => null))
  for (let i = 0; i < ws.reports.length; i++) {
    const content = await reads[i]
    if (isStaleLoad(gen)) return
    if (content === null) continue
    await ingestReport(ws.reports[i], content, gen)
    if (isStaleLoad(gen)) return
  }
  // Open the per-workspace sync session AFTER every report has been
  // ingested — the session needs a complete view of state.reports to
  // build its workspace-id set. No-op when sync is disabled (no
  // server URL).
  triageSync.openSession(workspaceId)
  // Refresh the session's id-set: when the session was already open
  // (intersection-close preserved it across the switch) its `ids`
  // still reflects the OLD state.reports. Any newly-in-scope ids
  // (reports loaded just now that weren't loaded before) get their
  // triage propagated to the workspace's chain. Also covers the case
  // where a report was dragged into this workspace while a different
  // file was focused — its finding-ids are only visible to triage-
  // sync once state.reports actually carries the report.
  triageSync.refreshSession(workspaceId)
  openPresence(workspaceId)
  await renderSidebar()
}

// Remove the current file from OPFS and close the view. Doesn't
// auto-switch to another — the user picks from the sidebar.
//
// Also strips the name from any workspace's `reports` array so the
// workspaces JSON doesn't accumulate ghost references over time —
// that's the canonical "prune at write time" point. Without this,
// a deleted file would stay listed inside any workspace it had
// been moved into; render skips ghosts but `workspace-export`
// would otherwise log skip-warnings forever and the next workspace
// import on another machine would re-resurrect the stale entry.
//
// `triage` ('keep' | 'wipe', default 'keep') controls whether
// `pruneOrphanTriage` runs after the OPFS removal. The sidebar
// click handler precomputes the orphan count via
// `analyzeTriageImpact` and surfaces the destructive action
// through `<delete-report-dialog>` on every click — the dialog's
// triage section adapts to the precomputed counts (terse note
// when nothing's attached, terse note when everything's also
// reachable from a kept report, keep-vs-wipe radio when orphans
// exist). The default 'keep' is the no-op path and is what the
// dialog resolves with when there are no orphans to ask about.
export async function deleteCurrent({ triage = 'keep', deleteFromRemote = null } = {}) {
  if (!state.currentFile) return
  // Bump the load generation AND capture it. The bump alone (pre-
  // fix) gated other in-flight switchTo*/ingestReport calls from
  // clobbering state.reports — but deleteCurrent's own tail
  // (state.currentFile = null; state.reports = []; ...) ran
  // unconditionally even if a NEW switchTo* / switchToWorkspace
  // landed during one of the awaits below (deletePresence,
  // deleteFile, setReportWorkspace, pruneOrphanTriage). That would
  // clobber the freshly-built view. Mirror the switchToFile pattern:
  // capture the captured gen, re-check `isStaleLoad(gen)` at every
  // await checkpoint, and bail before the state mutations if a
  // newer load has superseded us. Concurrency audit
  // `ui/view/ingest.js:366`.
  const gen = ++loadGen
  const name = state.currentFile
  // Drop name-scoped cache + localStorage entries up-front, BEFORE
  // any await. removeCount + saveRepoUrlFor are synchronous and
  // scoped to the captured `name`, so they can't clobber the
  // active file's state even if a switchTo* races in. If we deferred
  // these until after the awaits, an early stale-bail would leave
  // a stale repoUrl entry in localStorage that resurrects on a
  // future same-name re-import. Audit follow-up: PR-73 cross-
  // module review.
  removeCount(name)
  saveRepoUrlFor(name, '')
  // Delete the remote copy FIRST. Doing the remote delete after
  // the local one would leave a window where the next `openWorkspace`
  // auto-download could re-pull the report (the remote tag is still
  // there); ordering remote-first closes that window.
  //
  // Throw on `conflict` — the row is still in remote and a peer
  // would otherwise auto-download it back the moment we proceed
  // with the local delete (matching the "next openWorkspace would
  // resurrect" guard this code is here to provide). `not-found`
  // is fine (nothing to remove). Review r3242639305.
  if (deleteFromRemote) {
    const remoteResult = await deletePresence(deleteFromRemote, name)
    if (isStaleLoad(gen)) return
    if (remoteResult && remoteResult.ok === false && remoteResult.reason !== 'not-found') {
      throw new Error(`Failed to delete '${name}' from remote: ${remoteResult.reason}`)
    }
  }
  await deleteFile(name)
  if (isStaleLoad(gen)) return
  await setReportWorkspace(name, null)
  if (isStaleLoad(gen)) return
  // GC orphan triage entries only when the user picked "wipe"
  // in the dialog. Default ('keep') leaves them in localStorage
  // so a future re-import of the same report resurfaces the
  // triage automatically. A GC error (round-1 review #1: now
  // propagated rather than silently wiping everything) is
  // warned and swallowed — the OPFS removal already landed and
  // the orphans get to stay until the next clean prune.
  if (triage === 'wipe') {
    try { await pruneOrphanTriage() }
    catch (err) { console.warn('Skipped orphan-triage GC:', err) }
    if (isStaleLoad(gen)) return
  }
  // Final stale-check guarding the unguarded-tail mutation block.
  // Pre-fix the block below (state.* + graph2.* + cleanupGraph2 +
  // localStorage.removeItem + litRender) ran whenever the previous
  // gate passed, even though no await separates them — but a
  // switchTo*'s `++loadGen` is synchronous and can happen between
  // any two JS statements. Re-check here so a brand-new view
  // doesn't have its `state.reports` cleared / `graph2` torn down
  // out from under it. Audit follow-up: PR-73 cross-module review.
  if (isStaleLoad(gen)) return
  state.currentFile = null
  state.reports = []
  state.repoUrl = ''
  graph2.selected = null
  graph2.focusedPkg = null
  graph2.layoutCache = null
  graph2.solo = null
  graph2.hidden.clear()
  graph2.pathFilter = ''
  cleanupGraph2()
  removeSecureItem(LAST_FILE_KEY)
  report.classList.remove('active')
  // Drop the rendered findings via Lit so any cached parts on
  // #report (slot-reuse holds them across renders) get cleaned up
  // alongside the DOM. A bare `report.innerHTML = ''` would leave
  // the next render() walking a stale part-cache.
  litRender(nothing, report)
  dropZone.classList.remove('hidden')
  document.title = 'deepview results'
  document.body.classList.remove('show-print-btn')
  await renderSidebar()
}

// Leave a workspace from THIS browser. Always drops the workspace
// entry in localStorage and the persisted triage base (the latter
// via triage-sync's `onWorkspaceDeleted` listener); what happens
// to attached reports depends on `mode`:
//   - 'detach' (default): the OPFS bytes stay in place — reports
//     reappear in the sidebar's unattached list under their format
//     bucket. Their cached counts and saved repo URLs survive.
//   - 'delete': the OPFS bytes go too, alongside their cached
//     counts + per-report repo URLs.
// `triage` controls the persisted-triage GC (only meaningful in
// delete mode):
//   - 'keep' (default): orphaned triage stays in localStorage so a
//     future re-import of a matching report can resurface it.
//   - 'wipe': run `pruneOrphanTriage` after the OPFS removal so
//     any triage entry whose finding-id isn't reachable from a
//     remaining report gets dropped.
// In both modes the server's workspace chain is left untouched —
// peers still subscribed keep their copy, and a future re-import
// of the same workspace bundle resumes against the same chain.
// The UI layer's responsibility: if the active view was this
// workspace (merged-mode) — or, in delete mode, one of its
// reports — clear `state.currentFile` / `state.currentWorkspace`
// and drop back to the drop zone so the renderer doesn't trip
// over an active reference to gone data.
export async function leaveWorkspace(workspaceId, mode = 'detach', { triage = 'keep' } = {}) {
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) return
  // Bump the load generation so any switchTo* / ingestReport
  // already in flight (e.g. a click on the workspace that started
  // a merged-view load) bails before pushing into the cleared
  // state.reports — mirrors the guard in `deleteCurrent`.
  ++loadGen
  const reports = Array.isArray(ws.reports) ? [...ws.reports] : []
  // Tear down the live sync session BEFORE we touch the workspace
  // entry. `deleteWorkspace`'s listener does the same teardown
  // (and drops the persisted base), but a manual `closeSession`
  // here also stops the in-flight save loop from picking up a
  // mid-deletion view of state.reports and emitting a doomed
  // save against a chain whose identity is about to vanish.
  triageSync.closeSession(workspaceId)
  closePresence(workspaceId)
  if (mode === 'delete') {
    // Drop each report's OPFS bytes and its localStorage sidekicks
    // (counts, repo URL). The reports array on a workspace owns the
    // files exclusively (a report belongs to at most one workspace),
    // so no other view will be left dangling by these deletes.
    for (const name of reports) {
      try { await deleteFile(name) } catch {}
      removeCount(name)
      saveRepoUrlFor(name, '')
    }
    // GC orphan triage entries only when the user explicitly
    // picked "wipe" in the dialog. Default ('keep') leaves
    // orphans in localStorage so a future re-import of a matching
    // report can resurface the triage automatically. Same
    // single-source-of-truth as `deleteCurrent`: any marker /
    // triage state / comment / fix / per-report ignore whose
    // finding-id no longer matches a finding in any remaining
    // OPFS report gets dropped. Triage that's also reachable
    // from a report we still have (cross-workspace, or in an
    // unattached report) survives either way. A GC error
    // (round-1 review #1: now propagated rather than silently
    // wiping) is warned and swallowed — the reports are
    // already gone; orphans get to stay until the next clean
    // prune.
    if (triage === 'wipe') {
      try { await pruneOrphanTriage() }
      catch (err) { console.warn('Skipped orphan-triage GC:', err) }
    }
  }
  // In detach mode the reports become unfiled — no per-report
  // mutation is needed here because `deleteWorkspace` below drops
  // the whole workspace entry, taking the `reports` array with it.
  // The OPFS bytes stay where they are, and the sidebar's unfiled
  // bucket re-claims them on the next renderSidebar pass.
  //
  // Reset the active view if it pointed at the leaving workspace
  // (merged-mode) or — in delete mode only — at one of its
  // reports. In detach mode the report files survive, so a
  // single-file view of one of them is still valid: leaving the
  // user looking at the same report under the unfiled bucket is
  // less disruptive than slamming them back to the drop zone.
  const wasActiveWorkspace = state.currentWorkspace === workspaceId
  const wasActiveFile = mode === 'delete'
    && state.currentFile != null
    && reports.includes(state.currentFile)
  if (wasActiveWorkspace || wasActiveFile) {
    state.currentFile = null
    state.currentWorkspace = null
    state.reports = []
    state.repoUrl = ''
    graph2.selected = null
    graph2.focusedPkg = null
    graph2.layoutCache = null
    graph2.solo = null
    graph2.hidden.clear()
    graph2.pathFilter = ''
    cleanupGraph2()
    removeSecureItem(LAST_FILE_KEY)
    report.classList.remove('active')
    litRender(nothing, report)
    dropZone.classList.remove('hidden')
    document.title = 'deepview results'
    document.body.classList.remove('show-print-btn')
  }
  // Finally drop the workspace entry. Fires `onWorkspaceDeleted`,
  // which is where the persisted triage base for this workspace
  // gets wiped (see triage-sync.ts). No server message is sent —
  // the relay retains the workspace's chain until a future
  // operator-side delete (not exposed yet).
  await deleteWorkspace(workspaceId)
  await renderSidebar()
}

// Pure parse + render path — no FileReader, no OPFS. Used both by
// switchToFile (after content is materialized) and by the headless
// print flow (`window.__loadFile`), so that flow can still merge
// multiple inputs by calling repeatedly.
//
// `gen` is the optional load-generation token captured by the
// caller (switchToFile / switchToWorkspace). When set, every await
// inside checks it on resume and bails before mutating
// state.reports; that's how a stale load triggered by a
// since-superseded sidebar click avoids interleaving its push
// with the current one. The headless `window.__loadFile` path
// passes nothing, so it stays unguarded and continues to
// accumulate across repeated calls (the print pipeline relies on
// that).
export async function ingestReport(name, content, gen = null) {
  const stale = () => gen !== null && isStaleLoad(gen)
  try {
    // Persistent triage (markers/deletedIds keyed by uuid) is loaded
    // once at module init; await it before rendering so the first
    // drop already shows stored marks/deletions for matching findings.
    await triageLoadPromise
    if (stale()) return
    // Primary input is JSON (the analyzer's native dump format).
    // When that fails, walk the markdown parser chain: DeepSec
    // first (most specific format guard — `## SEVERITY (n)`), then
    // Claude Security (any `# Title` doc). Each parser returns the
    // standard { type, findings, … } shape, or null when the input
    // doesn't look like its format.
    let data
    try {
      data = JSON.parse(content)
    } catch (jsonErr) {
      data = parseDeepsecFindings(content)
        ?? parseMarkdownFindings(content)
      if (!data) throw new Error(`Not JSON, and not a recognized markdown format. (JSON error: ${jsonErr.message})`, { cause: jsonErr })
    }
    // Reset filters whenever this is the first report in the current
    // view (cleared on switchToFile / deleteCurrent, accumulating in
    // the headless print flow). The auto-tune that follows uses the
    // same gate.
    const isFirst = state.reports.length === 0
    // Dedup by exporter-provided uuid id across ALL loaded reports.
    // Input entries are either a single Finding or a Finding[] (a
    // dedup group from an upstream pass). A new group is dropped if
    // ANY of its members' ids match a previously-seen id — one
    // overlap is enough to conclude "already loaded" (groups don't
    // split / reshape across reloads). Findings without an id (legacy
    // JSON or pre-uuid exports) can't be deduped and always pass through.
    const seenIds = new Set()
    for (const r of state.reports) {
      for (const g of r.groups) {
        for (const f of g) if (f.id) seenIds.add(f.id)
      }
    }
    // Derive deterministic ids for any finding that doesn't already
    // carry one — must run BEFORE the dedup loop so MD-imported (and
    // id-less JSON) findings dedupe by content the same way exporter-
    // id'd findings do, and so triage (markers / deletions) persists
    // across reloads of the same source. Mutates the original finding
    // objects in place; `toGroup` returns them by reference, so the
    // ids are visible to the loop below. Batched via Promise.all
    // since crypto.subtle.digest is async — sequential awaits would
    // serialize hundreds of hashes for no reason.
    const rawEntries = data.findings || []
    const idLess = rawEntries.flatMap(toGroup).filter((f) => !f.id)
    if (idLess.length > 0) {
      const computed = await Promise.all(idLess.map(deriveFindingId))
      if (stale()) return
      idLess.forEach((f, i) => { if (computed[i]) f.id = computed[i] })
    }
    // Per-report repo URL stamped on each finding so format.js's
    // fileUrl / lineLink can resolve the right fallback in workspace
    // mode (where state.repoUrl can't represent N reports' settings
    // at once). Empty string for headless / print-flow ingests where
    // the OPFS file isn't backing a saved URL.
    const repoFallback = loadRepoUrlFor(name)
    const groups = []
    let dupeCount = 0
    for (const entry of rawEntries) {
      const members = toGroup(entry)
      if (members.length === 0) continue
      const anyDupe = members.some((f) => f.id && seenIds.has(f.id))
      if (anyDupe) { dupeCount++; continue }
      // Stamp a session-local `_id` on each member as a fallback key
      // for findings that lack the exporter-provided uuid `id`.
      // `tabKey(f)` prefers `f.id` (persistent) and falls back to
      // `String(f._id)`. Register ids as we stamp so duplicate entries
      // WITHIN this drop are caught too. Also fill in run-level meta
      // (type / effort / exportsMode) from the report header — but
      // only when the finding has NO per-finding meta at all. A finding
      // that came out of the deduplicate command already has its own
      // per-source meta stamped (each source report's header projected
      // onto its findings); a missing field there means "that source
      // run didn't have it" and is intentional. Mixing in the dedup
      // dump's top-level meta would mask those gaps with the dedup
      // model's settings (e.g. printing effort=max on a finding whose
      // source run had no effort flag).
      // Plain for-loop rather than .map((f) => …) — the callback
      // form closes over the outer loop's `data` / `name` /
      // `repoFallback`, which oxlint's no-loop-func can't reason
      // about. The function is invoked synchronously inside this
      // iteration, so the closure capture is actually safe; the
      // for-loop sidesteps the lint without changing semantics.
      //
      // Inherit run-level meta from the report header onto
      // findings that don't carry their own — but ONLY for native
      // analyzer JSON dumps (no `data.source` marker). For
      // codex / claude-security imports, the report-level type
      // is a category label for the file as a whole, not a
      // per-finding analyzer descriptor.
      const stamped = []
      for (const f of members) {
        if (f.id) seenIds.add(f.id)
        // `_bundleHashes` is the report-level array of integrities
        // the analyzer was run against. Stamped per-finding so the
        // finding-card's "Code →" button lookup can constrain its
        // search to bundles this report is actually about. Empty
        // array when the report didn't carry the field.
        const filled = {
          ...f,
          _id: state.nextFindingId++,
          _repoFallback: repoFallback,
          _reportName: name,
          _bundleHashes: data.bundleHashes ?? [],
        }
        if (!data.source) {
          const hasOwnMeta = META_FIELDS.some((k) => filled[k] !== undefined)
          if (!hasOwnMeta) {
            for (const key of META_FIELDS) {
              if (data[key] !== undefined) filled[key] = data[key]
            }
          }
        }
        // Effective analyzer string used by the toolbar's analyzer
        // filter. Source-marked reports (deepsec / codex-security /
        // claude-security) carry their tool name as the analyzer; for
        // native JSON dumps the per-finding `type` is the analyzer
        // (and can be undefined → stamped as null so the "no analyzer"
        // bucket has a stable sentinel).
        filled._analyzer = data.source ?? (filled.type ?? null)
        stamped.push(filled)
      }
      groups.push(stamped)
    }
    if (dupeCount > 0) console.log(`${name}: skipped ${dupeCount} duplicate finding${dupeCount === 1 ? '' : 's'}`)
    state.reports.push({
      type: data.type || 'analysis',
      // `source` is set by the markdown parser ('claude-security')
      // and absent on JSON dumps — render.js uses it to swap the
      // header title for an all-MD report.
      source: data.source ?? null,
      fileName: name,
      groups,
      // Per-file imports / exports / hashes from the analyzer dump
      // (stamped at JSON-export time). The renderer surfaces this as
      // a separate "Tree" tab when more than one file is present.
      tree: data.tree ?? null,
      bundleHashes: data.bundleHashes ?? [],
    })
    // Pre-parse bundles the analyzer ran against so the
    // finding-card's "Code →" shortcut resolves without the
    // user having to manually open every bundle first. Only
    // bundles we actually have stored locally get prefetched
    // (mismatched integrities just no-op inside
    // prefetchBundleHashes). Fire-and-forget — the buttons
    // surface progressively as each bundle's hash compute
    // completes; no need to block render on it.
    if (Array.isArray(data.bundleHashes) && data.bundleHashes.length > 0) {
      const stored = new Set((state.bundles ?? []).map((b) => b.integrity))
      for (const integrity of data.bundleHashes) {
        if (stored.has(integrity)) prefetchBundleHashes(integrity).catch(() => {})
      }
    }
    if (isFirst) {
      resetFilters()
      // Auto-tune the confidence floor so the initial view fits
      // roughly 25 groups. Step up from 6 → 7 → 8 until the visible
      // count is within budget; cap at 8 (the previous static
      // default). Skip the auto-tune entirely when no finding in
      // this report carries a confidence — without that guard,
      // countAtMin(6) returns 0 ≤ 25 and the floor lands at 6,
      // which then excludes every finding (since f.confidence is
      // undefined for all). Clear the floor instead so the filter
      // becomes a no-op; the toolbar hides the control too (see
      // toolbarHtml in render.js).
      //
      // After picking the base, walk DOWN while each lower step
      // would not surface any new groups — i.e. there's a "gap"
      // in the confidence distribution between the chosen floor
      // and the next observed bucket below it. Lowering the floor
      // for free puts the slider at the natural break in the
      // data: e.g. picked 8, no findings at 7 or 6 but some at
      // 5 → settle at 6 (the lowest step that doesn't reveal
      // anything new). Same idea applies down to 0 (= no floor).
      const hasAnyConfidence = groups.some((g) => g.some((f) => f.confidence !== undefined))
      if (hasAnyConfidence) {
        const countAtMin = (min) => groups.reduce((n, g) =>
          n + (g.some((f) => f.confidence !== undefined && f.confidence >= min) ? 1 : 0), 0)
        let base
        if (countAtMin(6) <= 25) base = 6
        else if (countAtMin(7) <= 25) base = 7
        else base = 8
        while (base > 0 && countAtMin(base - 1) === countAtMin(base)) base--
        state.filterConfMin = base
      } else {
        state.filterConfMin = 0
      }
    }
    render()
  } catch (err) {
    alert(`Failed to parse ${name}: ${err.message}`)
  }
}

// Headless / automated entry point — parses + renders a JSON report
// in-process, no OPFS, no sidebar swap. Returned promise resolves when
// this file's render has run, so callers (the `print` command in
// src/print.js) can await loading of every input before triggering
// print. Repeated calls accumulate (the print pipeline still merges
// multiple inputs that way).
window.__loadFile = (name, content) => ingestReport(name, content)

// Headless filter override — used by the `print` command to apply
// CLI-supplied --severity / --confidence values AFTER all reports are
// loaded (the auto-tuned confidence floor from addReport's first-load
// heuristic gets overridden here when present). `severities` may be an
// array (or null/undefined to leave unchanged); empty array clears the
// filter so all severities show.
window.__setFilters = ({ severities, confMin } = {}) => {
  if (severities !== undefined && severities !== null) state.filterSeverities = new Set(severities)
  if (confMin !== undefined) state.filterConfMin = confMin
  render()
}

// Prevent default drag behavior everywhere. Drops anywhere on the page
// route through addFiles → OPFS save → switch view to the last dropped.
// The drop zone keeps its hover affordance for the empty-state case.
// Global Esc → exit fullscreen mode (mirrors what the toolbar's
// fullscreen-button toggle does, so the user has the canonical browser
// gesture for "give me my chrome back").
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('report-fullscreen')) {
    document.body.classList.remove('report-fullscreen')
  }
})

document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  if (e.target.closest('#drop-zone')) return // dropZone handler owns this
  addFiles(e.dataTransfer.files)
})

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('hover') })
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('hover'))
dropZone.addEventListener('drop', (e) => {
  e.preventDefault()
  dropZone.classList.remove('hover')
  addFiles(e.dataTransfer.files)
})

// Click-to-browse: clicking anywhere on the drop zone (or
// activating it with Enter / Space when it's keyboard-focused —
// the host element carries `role="button" tabindex="0"`) opens
// a native file picker. Routes the chosen files through the same
// `addFiles` pipeline as a drop, so the JSON / markdown / CSV /
// .gz / bundle classification all reuses the existing routing.
//
// The `<input type="file">` is created lazily on first activation
// and parked on document.body — keeping it out of index.html
// means the static markup stays focused on the visible chrome,
// and the `hidden` attribute keeps it off the layout. Resetting
// `.value = ''` after each change lets the user re-pick the same
// file on a subsequent click (browsers suppress the change event
// otherwise).
let filePickerInput = null
function openFilePicker() {
  if (!filePickerInput) {
    filePickerInput = document.createElement('input')
    filePickerInput.type = 'file'
    filePickerInput.multiple = true
    filePickerInput.hidden = true
    filePickerInput.addEventListener('change', () => {
      const files = filePickerInput.files
      if (files && files.length > 0) addFiles(files)
      filePickerInput.value = ''
    })
    document.body.append(filePickerInput)
  }
  filePickerInput.click()
}
dropZone.addEventListener('click', openFilePicker)
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    openFilePicker()
  }
})
