import { render as litRender, nothing } from 'lit'
import { analyzeContent, deleteBundle, deleteFile, deleteWorkspace, dropBundleFromHashIndex, getSecureItem, listBundles, listFiles, listWorkspaces, loadRepoUrlFor, pruneOrphanTriage, readFile, readFileBytes, removeCount, removeSecureItem, saveBundle, saveFile, saveRepoUrlFor, setBundleWorkspace, setCount, setReportWorkspace, setSecureItem, state, triageLoadPromise } from '#client/index.js'
import { closeWorkspace as closePresence, deleteBundleFromRemote, deleteFromRemote as deletePresence, isInRemoteOrCached, openWorkspace as openPresence, putFile, triageSync } from './client-sync.js'
import { openImportConflictDialog } from './dialogs/import-conflict-dialog.js'
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
// Tabs in the bundle view's tab strip — the strip rendered by
// `renderBundleSlide` in render-bundle.js, the data-bundle-tab click
// handler in events.js, and the boot-time restore in view.js all key
// off this list. 'overview' is the default and is omitted from the
// LAST_FILE_KEY suffix; an unrecognised value on restore falls back
// to 'overview', which gives a clean restore for older persisted
// suffixes that named the long-removed nested-overview values
// 'packages' / 'files' / 'reports' (no migration needed — they
// just miss the set and fall back).
export const BUNDLE_TABS = new Set(['overview', 'graph', 'treemap', 'advisories', 'issues', 'code', 'terminal'])

// Persist a bundle selection to LAST_FILE_KEY, encoding the active
// tab as `b:<integrity> <tab>`. The default 'overview' tab is dropped
// from the suffix so the round-trip lands on a clean `b:<integrity>`
// when nothing further is meaningful.
export function persistLastBundle(integrity, tab = 'overview') {
  const suffix = tab && tab !== 'overview' && BUNDLE_TABS.has(tab) ? ` ${tab}` : ''
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
export function bundleKind(name) {
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

// Persist a single dropped report's content to OPFS, asking the user
// what to do when a file of the same name already exists. The
// callers (`addFiles` directly + its CSV branch) loop over every
// drop and feed the per-report bytes through here so the conflict
// dialog runs uniformly for both JSON / markdown drops and the
// CSV-derived `.codex` scans.
//
// Conflict resolution rules (the user-visible spec):
//   1. name doesn't exist locally → save it, navigate to it.
//   2. name exists AND content is byte-identical to the existing
//      file → skip the save entirely, just navigate (no spurious
//      OPFS write, no cloud re-upload, no sidebar reflow).
//   3. name exists with DIFFERENT content → open the conflict
//      dialog. The user picks:
//        - Replace: overwrite the local file. Push the new bytes to
//          every workspace whose remote inventory ALREADY carries
//          this report (live session or persisted presence cache),
//          so the cloud copy tracks the local one. Workspaces that
//          list the report locally but never uploaded it are left
//          alone — re-uploading would open a presence session to a
//          server we may never have authenticated against, which
//          would surprise the user with a password prompt for what
//          they think of as a local-only report.
//        - Rename: save under a different name (the dialog
//          live-validates the candidate against `existingNames` so
//          the rename can't loop into another collision).
//        - Cancel: skip this report — returns null so the caller
//          doesn't navigate to it or stamp a count for it.
//
// Returns `{ name, content }` of the report that landed (which may
// be the renamed name, or the original name on a replace / no-op),
// or `null` when the user cancelled. `existingNames` is updated in
// place so a follow-up file in the same drop sees the just-imported
// names without re-listing OPFS.
async function importReportContent({ name, content, existingNames }) {
  if (!existingNames.has(name)) {
    await saveFile(name, content)
    existingNames.add(name)
    return { name, content }
  }
  // Read the existing bytes through the regular text path so the
  // comparison is on the LOGICAL report content (decompressed,
  // envelope-peeled) — not the on-disk gzipped representation.
  //
  // Distinguish three failure modes:
  //  - sibling-tab delete (file vanished between snapshot and read)
  //    → treat as "no collision": save the new bytes under the now-
  //    free name. Detected as either OPFS `NotFoundError` or the
  //    storage.js localStorage fallback's `File not found:` Error.
  //  - vault locked at rest — readFile throws `storage: vault
  //    locked, cannot decrypt ...`. We MUST NOT collapse this to
  //    "no collision" and silently overwrite an existing encrypted
  //    file with the dropped plaintext bytes (that would replace
  //    real content the user can't currently see). Propagate so
  //    addFiles' catch surfaces the error in the standard alert
  //    path; the user can unlock and re-drop.
  //  - any other unexpected read failure — same propagation as
  //    vault-locked: don't pretend the file is gone.
  let existing
  try { existing = await readFile(name) }
  catch (err) {
    const missing = (err instanceof DOMException && err.name === 'NotFoundError')
      || (typeof err?.message === 'string' && err.message.startsWith('File not found:'))
    if (!missing) throw err
    await saveFile(name, content)
    existingNames.add(name)
    return { name, content }
  }
  if (existing === content) return { name, content }
  // Build the workspace context for the dialog's upload warning.
  // A report can sit in multiple workspaces (additive membership),
  // so collect every workspace that lists this name, then narrow
  // to those whose remote inventory ALREADY holds it (live session
  // or persisted presence cache). A workspace that lists the
  // report locally but has never uploaded it is not eligible — the
  // upload below would otherwise open a presence session to that
  // workspace's server, which on a never-authenticated relay would
  // surface as a password prompt the user didn't ask for. The
  // dialog copy keys off this filtered list, so the warning only
  // mentions workspaces an upload would actually touch.
  const workspaces = listWorkspaces().filter(
    (w) => Array.isArray(w.reports) && w.reports.includes(name),
  )
  const uploadableWorkspaces = workspaces.filter(
    (w) => isInRemoteOrCached(w.id, name),
  )
  const decision = await openImportConflictDialog({
    name,
    workspaceNames: uploadableWorkspaces.map((w) => w.name),
    existingNames,
  })
  if (decision.action === 'cancel') return null
  if (decision.action === 'rename') {
    const newName = decision.newName
    await saveFile(newName, content)
    existingNames.add(newName)
    return { name: newName, content }
  }
  // Replace: write the new bytes first so the cloud-side upload
  // reads the freshly-saved on-disk form. Re-uploading the same
  // name to the workspace's objstore replaces the encrypted blob
  // there; the put goes through the unified retryOnConflict helper
  // inside putFile, so the optimistic-concurrency dance is handled
  // for us. Failures land in the console — sync is best-effort here
  // (the dialog already warned that this would touch remote, but
  // the local replace already happened and a transient network
  // failure shouldn't undo it).
  await saveFile(name, content)
  if (uploadableWorkspaces.length > 0) {
    await uploadReportToWorkspaces(name, uploadableWorkspaces)
  }
  return { name, content }
}

// Best-effort push of a freshly-replaced report to every workspace
// whose remote inventory already carries it. Callers (the conflict-
// resolution Replace branch) pre-filter via `isInRemoteOrCached` so
// a workspace that lists the report locally but has never uploaded
// it never reaches this loop — opening a presence session to such
// a workspace would trigger the relay's first-touch auth gate and
// surface as a password prompt for an upload the user didn't
// intend. Each workspace gets its presence session opened on
// demand (mirrors `deleteFromRemote`'s lazy-open pattern: the user
// may not have navigated to all of these workspaces this session,
// but the cloud copies still need to track the local replace).
// Both `openPresence` and `putFile` route through the lazy sync
// wrapper in `client-sync.js`; the wrappers share a memoised chunk
// load, so we MUST `await openPresence` before `putFile` — the
// underlying `putFile` reads `sessions.get(workspaceId)` and
// throws "Workspace … is not open" if the openPresence-side
// `sessions.set` hasn't run yet. Awaiting also catches a chunk-
// load rejection here so it doesn't bubble as an unhandled
// promise rejection.
async function uploadReportToWorkspaces(name, workspaces) {
  let bytes
  try {
    bytes = await readFileBytes(name)
  } catch (err) {
    console.warn(`Import: failed to read freshly-saved "${name}" for cloud sync:`, err)
    return
  }
  for (const ws of workspaces) {
    try {
      await openPresence(ws.id)
      const result = await putFile(ws.id, name, bytes)
      if (result && result.ok === false) {
        console.warn(`Import: failed to upload "${name}" to workspace "${ws.name}" (${ws.id}): ${result.reason ?? 'unknown'}`)
      }
    } catch (err) {
      console.warn(`Import: failed to upload "${name}" to workspace "${ws.name}" (${ws.id}):`, err)
    }
  }
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
  // Snapshot of OPFS report names taken once per drop, then kept in
  // lock-step as `importReportContent` saves new files. Drives the
  // conflict check inside `importReportContent` so back-to-back
  // dropped files within ONE addFiles call see each other (e.g. a
  // CSV that derives two .codex files with the same name as an
  // existing entry would otherwise miss the second collision).
  // Re-listed after `importWorkspaceFromGzip` below since that
  // branch saves bundled reports through `applyWorkspaceImport`
  // (which we can't reach into to update `existingNames`) — without
  // the re-list, a workspace import dropped alongside a regular
  // report of the same name would let the second drop silently
  // overwrite the workspace-import's just-saved copy.
  const existingNames = new Set(await listFiles())
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
        // Workspace import persists every bundled report via
        // `saveFile` inside `applyWorkspaceImport`. Refresh the
        // existing-names set so a later file in this same drop
        // (regular report whose name happens to match one of the
        // imported workspace's reports) hits the conflict path
        // instead of silently overwriting.
        try {
          const refreshed = await listFiles()
          existingNames.clear()
          for (const n of refreshed) existingNames.add(n)
        } catch (err) {
          console.warn('Import: failed to refresh existingNames after workspace import:', err)
        }
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
          const { count, source } = analyzeContent(json)
          const imported = await importReportContent({ name: codexName, content: json, existingNames })
          if (!imported) continue
          setCount(imported.name, count, source)
          last = { name: imported.name, content: imported.content }
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
        const imported = await importReportContent({ name: file.name, content, existingNames })
        if (!imported) continue
        setCount(imported.name, result.count, result.source)
        last = { name: imported.name, content: imported.content }
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
    state.bundleDetailsTab = 'overview'
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
  state.workspaceMerges = []
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
  state.workspaceMerges = []
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
//
// `deleteFromRemoteWorkspaceIds` — every workspace whose remote
// inventory holds the report. The sidebar gathers all owning
// workspaces (a report can be attached to many under the multi-
// workspace membership model) and filters by `isInRemoteOrCached`,
// which checks both live sessions AND the persisted cache. Fan
// the per-workspace `deletePresence` calls out; each is wrapped in
// try/catch so a network blip on workspace N doesn't strand local
// bytes + the trailing workspaces' remote tags in a half-deleted
// state. Conflict/error is logged but never aborts the local
// cleanup — leaving local bytes intact while peers carry partial
// remote state is worse than "remote not fully cleaned, retry
// later by re-deleting".
export async function deleteCurrent({ triage = 'keep', deleteFromRemoteWorkspaceIds = [] } = {}) {
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
  // Fan the remote delete out across every owning workspace's
  // remote. Doing the remote deletes BEFORE the local one closes
  // the window where the next `openWorkspace(W)` auto-download
  // could re-pull the report through that workspace's tag.
  // Each call is wrapped — `not-found` is fine (idempotent on a
  // workspace whose tag was already dropped by a peer), other
  // errors get a console.warn but don't abort the loop or block
  // the local delete.
  for (const wsId of deleteFromRemoteWorkspaceIds) {
    try {
      const remoteResult = await deletePresence(wsId, name)
      if (isStaleLoad(gen)) return
      if (remoteResult && remoteResult.ok === false && remoteResult.reason !== 'not-found') {
        console.warn(`Failed to delete '${name}' from workspace ${wsId} remote: ${remoteResult.reason}`)
      }
    } catch (err) {
      console.warn(`Failed to delete '${name}' from workspace ${wsId} remote:`, err)
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
  // Pre-fix `clearActiveView()` ran whenever the previous
  // gate passed, even though no await separates them — but a
  // switchTo*'s `++loadGen` is synchronous and can happen between
  // any two JS statements. Re-check here so a brand-new view
  // doesn't have its `state.reports` cleared / `graph2` torn down
  // out from under it. Audit follow-up: PR-73 cross-module review.
  if (isStaleLoad(gen)) return
  clearActiveView()
  await renderSidebar()
}

// Shared empty-state reset — clears every piece of in-memory
// view state (selections, reports, graph2, repo-url) and repaints
// `#report` / `#drop-zone` / `<title>` so the user lands on the
// empty welcome surface. The `<print-button>` and `<download-button>`
// hosts hide themselves reactively via their StateElement autoruns
// (see view/print-button.js / view/download-button.js) when the
// state predicates fail, so no manual visibility reset is needed
// here. `goHome`, `deleteCurrent`'s tail, and `leaveWorkspace`'s
// active-view branch all go through here so the three paths can't
// drift apart.
//
// Does NOT bump `loadGen` or close sync sessions — those are
// caller concerns (each path has its own ordering constraints
// with the OPFS / triage / remote operations that surround the
// reset).
function clearActiveView() {
  state.currentFile = null
  state.currentWorkspace = null
  state.selectedBundle = null
  state.bundleDetails = null
  state.bundleSourceFile = null
  state.bundleSourceFindingIdx = null
  state.reports = []
  state.workspaceMerges = []
  state.repoUrl = ''
  state.repoEditing = false
  state.shownTriage = null
  state.currentView = 'findings'
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
  document.title = 'DeepView'
}

// Drop back to the empty drop-zone screen without touching any
// stored data — non-destructive counterpart to `deleteCurrent`'s
// tail. The DeepView brand in the sidebar header routes here so
// clicking the wordmark always lands the user on the supported-
// formats welcome surface, regardless of which report / workspace
// / bundle is currently open. Skips OPFS / remote / triage GC —
// the file the user came from stays exactly as it was so they
// can pick it back up from the sidebar.
export async function goHome() {
  // Bump the load generation so any in-flight switchTo* /
  // ingestReport bails before pushing into the cleared state.
  // Mirrors the guard pattern in `deleteCurrent` / `leaveWorkspace`.
  ++loadGen
  // Close any open per-workspace sync sessions tied to the active
  // view — a single-file view of a workspace member or a
  // merged-workspace view both open sessions in `switchToFile` /
  // `switchToWorkspace`; without closing them here, returning home
  // would leave triage-sync echoing edits to a chain that no view
  // is consuming.
  for (const info of triageSync.openSessions) {
    if (info) {
      triageSync.closeSession(info.workspaceId)
      closePresence(info.workspaceId)
    }
  }
  clearActiveView()
  await renderSidebar()
}

// Bundle counterpart of `deleteCurrent` — drives the sidebar's
// "Delete current" button when the bundles view's `selectedBundle`
// is what's active. Removes the OPFS bytes (via `deleteBundle`),
// detaches the integrity from every workspace's `bundles` list
// (via `setBundleWorkspace(integrity, null)`), prunes the
// cross-bundle SHA-512 hash index so the finding-card "Code →"
// lookup stops surfacing the gone bundle, drops the panel
// selection + persisted last-view pointer, refreshes
// `state.bundles`, and repaints both the main view and the sidebar.
//
// `deleteFromRemoteWorkspaceIds` — array of workspace ids whose
// remote objstore inventory should also drop this bundle. The
// sidebar caller gathers every owning workspace whose remote
// holds the integrity (live session OR persisted cache, via
// `isBundleInRemoteOrCached`). Each per-workspace
// `deleteBundleFromRemote` runs FIRST so the bundle's tag is
// dropped from remote before we clear the local bytes; each call
// is wrapped so a network blip on one workspace doesn't strand
// local bytes + the trailing workspaces' tags in a half-deleted
// state. Same shape + rationale as `deleteCurrent` for reports.
//
// Concurrency: `++loadGen` + `isStaleLoad(gen)` mirrors
// `deleteCurrent` — a switchToWorkspace landing during one of the
// awaits below would otherwise clobber the freshly-built view via
// the trailing `state.bundles = await listBundles()` + `render()`.
export async function deleteCurrentBundle({ deleteFromRemoteWorkspaceIds = [] } = {}) {
  if (!state.selectedBundle) return
  const gen = ++loadGen
  const integrity = state.selectedBundle
  for (const wsId of deleteFromRemoteWorkspaceIds) {
    try {
      const result = await deleteBundleFromRemote(wsId, integrity)
      if (isStaleLoad(gen)) return
      if (result && result.ok === false && result.reason !== 'not-found') {
        console.warn(`Failed to delete bundle from workspace ${wsId} remote: ${result.reason}`)
      }
    } catch (err) {
      console.warn(`Failed to delete bundle from workspace ${wsId} remote:`, err)
    }
  }
  await deleteBundle(integrity)
  if (isStaleLoad(gen)) return
  await setBundleWorkspace(integrity, null)
  if (isStaleLoad(gen)) return
  state.selectedBundle = null
  state.bundleDetails = null
  state.bundleSourceFile = null
  state.bundleSourceFindingIdx = null
  // Only clear LAST_FILE_KEY when it actually pointed at this
  // bundle — workspace pointers (`ws:<id>`) and report filenames
  // share the same slot, so an unconditional clear would dump the
  // user back to the empty drop zone on reload after deleting a
  // bundle from a workspace view. `persistLastBundle` writes
  // `b:<integrity>` (optionally suffixed with ` <tab>`); match the
  // prefix to keep unrelated pointers intact.
  const lastFile = getSecureItem(LAST_FILE_KEY)
  if (typeof lastFile === 'string'
      && (lastFile === `b:${integrity}` || lastFile.startsWith(`b:${integrity} `))) {
    removeSecureItem(LAST_FILE_KEY)
  }
  dropBundleFromHashIndex(integrity)
  state.bundles = await listBundles()
  if (isStaleLoad(gen)) return
  render()
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
  if (wasActiveWorkspace || wasActiveFile) clearActiveView()
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
    // `idToGroupKey` lets the dupe branch tell apart "the same group
    // already loaded" (single key matched) from "this entry binds
    // multiple existing groups together as one finding" (>1 keys
    // matched) — the latter is recorded as a workspace-level merge so
    // the dedup hint isn't lost when we drop the entry.
    const seenIds = new Set()
    const idToGroupKey = new Map()
    for (let ri = 0; ri < state.reports.length; ri++) {
      const r = state.reports[ri]
      for (let gi = 0; gi < r.groups.length; gi++) {
        const g = r.groups[gi]
        const key = `${ri}:${gi}`
        for (const f of g) {
          if (f.id) { seenIds.add(f.id); idToGroupKey.set(f.id, key) }
        }
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
      // Partition members by whether their id was already seen across
      // prior reports + earlier entries in this one. Three branches:
      //   1. all-new       → push as a fresh group (no merge)
      //   2. all-seen      → drop the entry; record a cross-report merge
      //                      when it binds >1 distinct existing groups,
      //                      so the dedup hint isn't lost with the drop
      //   3. partial-seen  → stamp the new members as a fresh group AND
      //                      record a merge with all member ids, so the
      //                      load-order case (combined entry arrives
      //                      between the two singletons it merges) still
      //                      collapses to one super-group in the view
      // Recorded merges always carry every id from the entry in source-
      // array order; `getMergedGroups` uses that to order the merged
      // super-group, so the combined entry's [A, B] beats any incidental
      // load-order [B, A].
      const seenMembers = members.filter((f) => f.id && seenIds.has(f.id))
      const newMembers = members.filter((f) => !f.id || !seenIds.has(f.id))
      const matchedGroupKeys = new Set()
      for (const f of seenMembers) {
        const k = idToGroupKey.get(f.id)
        if (k !== undefined) matchedGroupKeys.add(k)
      }
      const entryMergeIds = members.filter((f) => f.id).map((f) => f.id)
      if (newMembers.length === 0) {
        if (matchedGroupKeys.size > 1) {
          state.workspaceMerges.push(new Set(entryMergeIds))
        }
        dupeCount += seenMembers.length; continue
      }
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
      for (const f of newMembers) {
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
      // Stamp the new members' group key so a later partial-dupe entry
      // in this same report sees them as a distinct group from any
      // previously-loaded one. Reads `groups.length` BEFORE the push so
      // the key matches the slot the array is about to receive. The
      // `state.reports.length` prefix is the eventual index of THIS
      // report once it's pushed at the end of the function — this
      // works only because the seed loop above (idToGroupKey
      // population) walks `ri < state.reports.length` against the
      // pre-push length, so this report's own index can't already
      // collide in the map. If a future refactor pushes the report
      // shell early (e.g. for streaming), snapshot the index once
      // before this entry loop instead of re-reading per iteration.
      if (seenMembers.length > 0) {
        // Partial-dupe: count the seen members as dropped duplicates
        // (we only stamp the new ones below) and tie the freshly-
        // stamped new group to the existing groups holding the seen
        // members via a workspace merge.
        dupeCount += seenMembers.length
        state.workspaceMerges.push(new Set(entryMergeIds))
      }
      const newGroupKey = `${state.reports.length}:${groups.length}`
      for (const f of newMembers) {
        if (f.id) idToGroupKey.set(f.id, newGroupKey)
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

// Click-to-browse: only the inline `<button class="drop-prompt-action">`
// inside the prompt copy opens the native file picker — clicking on
// the empty surface around the prompt no longer triggers anything
// (which lets WCO mode pick the surrounding space up as a window
// drag handle via body's `app-region: drag` baseline, and avoids the
// "huge button, tiny visual affordance" feel the previous
// role="button" drop-zone had). The button gets the affordance and
// keyboard handling for free; routes the chosen files through the
// same `addFiles` pipeline as a drop.
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
// Event-delegate via the drop-zone so the listener survives Lit
// re-renders if the prompt template ever moves into a component.
dropZone.addEventListener('click', (e) => {
  if (e.target.closest('.drop-prompt-action')) openFilePicker()
})
