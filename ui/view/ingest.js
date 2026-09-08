import { render as litRender, nothing } from 'lit'
import { analyzeContent, computeLinkHint, deleteBundle, deleteFile, deleteWorkspace, dropBundleFromHashIndex, getSecureItem, listBundles, listFiles, listWorkspaces, loadRepoUrlFor, parseLinkedFindings, pruneOrphanTriage, readFile, readFileBytes, removeCount, removeSecureItem, saveBundle, saveFile, saveRepoUrlFor, setBundleWorkspace, setCount, setReportWorkspace, setSecureItem, state, triageLoadPromise } from '#client/index.js'
import { closeWorkspace as closePresence, deleteBundleFromRemote, deleteFromRemote as deletePresence, isInRemoteOrCached, openWorkspace as openPresence, putFile, triageSync } from './client-sync.js'
import { openImportConflictDialog } from './dialogs/import-conflict-dialog.js'
import { dropZone, report } from './dom.js'
import { getShownGroups, mergeDuplicateFields, toGroup } from './group.js'
import { effectiveSeverity } from './format.js'
import { applyOpeningFilters, resetFilters } from './filters.js'
import { render } from './render.js'
import { renderSidebar } from './sidebar.js'
import { cleanupGraph2, graph2 } from './graph/state.js'
import { openBundle, prefetchBundleHashes, selectBundle } from './bundle-load.js'
import { backfillFindingIds, detectFormat, inheritReportMeta, parseCodexCsvToScans, readReport, reportEntries, reportRepoGithub } from '../../report/index.js'
import { importWorkspaceFromGzip } from './workspace-import.js'
import { maybePromptFirstUse } from './first-import-prompt.js'
import { openPasskeyUnlockDialog } from './dialogs/passkey-unlock-dialog.js'
import { openSyncDownloadDialog } from './dialogs/sync-download-dialog.js'

// localStorage key for the last-viewed file — restored on page load so
// the user picks back up where they left off. The stored value is the
// OPFS filename for a single-file view; prefixed with `ws:` for a
// workspace view; or prefixed with `b:` followed by the SRI-shaped
// integrity for a bundle view, optionally followed by a space and the
// active sub-tab (`b:<integrity> <tab>`). Mutually exclusive — one
// current selection at a time, last-clicked wins.
export const LAST_FILE_KEY = 'deepview.lastFile'
// Tabs in the bundle view's tab strip — `renderBundleSlide`
// (render-bundle.js), the data-bundle-tab click handler (events.js),
// and the boot-time restore (view.js) all key off this list.
// 'overview' is the default and is omitted from the LAST_FILE_KEY
// suffix; an unrecognised value on restore falls back to 'overview'.
// That fallback also covers old persisted suffixes naming removed
// values ('packages' / 'files' / 'reports') — no migration needed,
// they just miss the set.
export const BUNDLE_TABS = new Set(['overview', 'graph', 'treemap', 'compare', 'advisories', 'issues', 'code', 'search', 'terminal'])

// Persist a bundle selection to LAST_FILE_KEY as `b:<integrity> <tab>`.
// The default 'overview' tab is dropped from the suffix so the
// round-trip lands on a clean `b:<integrity>`.
export function persistLastBundle(integrity, tab = 'overview') {
  const suffix = tab && tab !== 'overview' && BUNDLE_TABS.has(tab) ? ` ${tab}` : ''
  setSecureItem(LAST_FILE_KEY, `b:${integrity}${suffix}`).catch(() => {})
}

// Generation token shared by every async load path
// (switchToFile / switchToWorkspace / deleteCurrent). Bumped at the
// entry of each; in-flight loads from a previous generation see their
// captured token go stale and bail before touching state.reports.
// Without this, a quick second sidebar click could interleave two
// concurrent reads' pushes — the array would briefly hold the previous
// file's data merged with the new. The headless `window.__loadFile`
// path stays unguarded (doesn't touch loadGen) so the print flow's
// repeated-ingest accumulation still works.
let loadGen = 0
const isStaleLoad = (captured) => captured !== loadGen

// Reset graph v2 so a new report / workspace doesn't open with the
// previous file's selection / hidden / soloed pkg. Layout cache also
// invalidates (new tree → re-layout). Shared by switchToFile,
// switchToWorkspace and clearActiveView.
function resetGraph2() {
  graph2.selected = null
  graph2.focusedPkg = null
  graph2.layoutCache = null
  graph2.solo = null
  graph2.hidden.clear()
  graph2.pathFilter = ''
  cleanupGraph2()
}

// Close the triage-sync session AND its presence session for every
// open workspace not in `keepIds`. Both planes go in lockstep — a
// presence session must never outlive its sync subscription (it
// rides `workspace-subscribe`), so presence ⊆ sync always holds.
function closeSessionsExcept(keepIds) {
  for (const info of triageSync.openSessions) {
    if (info && !keepIds.has(info.workspaceId)) {
      triageSync.closeSession(info.workspaceId)
      closePresence(info.workspaceId)
    }
  }
}

// Put the main pane back to the welcome surface without touching any
// selection state — what a load that ended up with nothing to show
// has to do, or the previous view stays up while the sidebar says the
// user moved. `clearActiveView` below is the bigger hammer (it drops
// the selection too) and paints through here.
//
// Findings go via Lit rather than `report.innerHTML = ''` so the
// cached parts on `#report` (slot reuse holds them across renders)
// get cleaned up with the DOM — a bare innerHTML wipe would leave the
// next render() walking a stale part-cache.
function showEmptyMainPane() {
  report.classList.remove('active')
  litRender(nothing, report)
  dropZone.classList.remove('hidden')
}

// OPFS `NotFoundError` (from `getFileHandle`) or the storage.js
// localStorage fallback's `File not found:` Error — the two shapes a
// genuinely absent file surfaces as. Shared by the import-conflict
// read and switchToFile's read so both classify "gone" identically.
function isMissingFileError(err) {
  return (err instanceof DOMException && err.name === 'NotFoundError')
    || (typeof err?.message === 'string' && err.message.startsWith('File not found:'))
}

// Bundle classifier — sourcemap (.map) or stasis (`.stasis.code.br`
// or the bare `stasis.code.br` filename for top-level drops).
// Returns the kind, or null when the file isn't a bundle. The stasis
// marker is the full `stasis.code.br` suffix (brotli-compressed JSON
// snapshot, see src/loaders/stasis.js); a plain `.br` could be any
// brotli payload, so we don't accept that. Both markers are
// filename-based; ingest doesn't validate the shape — bundles are
// archived as-is for the analyzer pipeline to consume later.
export function bundleKind(name) {
  const lower = stripDownloadDup(name.toLowerCase())
  if (lower.endsWith('.map')) return 'sourcemap'
  if (lower === 'stasis.code.br' || lower.endsWith('.stasis.code.br')) return 'stasis'
  return null
}

// Browsers (Chrome / Firefox / Safari) insert ` (N)` before the LAST
// `.ext` when re-downloading a duplicate — `bar.stasis.code.br`
// becomes `bar.stasis.code (1).br`. Strip a single trailing ` (\d+)`
// immediately before the final extension so drop-routing matches the
// canonical filename. Conservative: only the rightmost occurrence
// (lookahead pins it to the last `.foo`) and only bare digits, so a
// legitimate `foo (final).enc` is left alone.
function stripDownloadDup(name) {
  return name.replace(/ \(\d+\)(?=\.[^.]*$)/u, '')
}

// Persist a single dropped report's content to OPFS, asking the user
// what to do on a same-name collision. Callers (`addFiles` directly +
// its CSV branch) loop over every drop through here so the conflict
// dialog runs uniformly for JSON / markdown drops and CSV-derived
// `.codex` scans.
//
// Conflict resolution rules (the user-visible spec):
//   1. name doesn't exist locally → save it, navigate to it.
//   2. name exists, content byte-identical → skip the save, just
//      navigate (no spurious OPFS write, cloud re-upload, or reflow).
//   3. name exists, DIFFERENT content → open the conflict dialog:
//        - Replace: overwrite locally, and push the new bytes to
//          every workspace whose remote inventory ALREADY carries
//          this report (live session or persisted presence cache) so
//          the cloud copy tracks. Workspaces that list it locally but
//          never uploaded it are left alone — re-uploading would open
//          a presence session to a maybe-never-authenticated server,
//          surfacing a password prompt for a report the user thinks
//          of as local-only.
//        - Rename: save under a different name (the dialog
//          live-validates against `existingNames` so the rename can't
//          loop into another collision).
//        - Cancel: skip — returns null so the caller doesn't navigate
//          or stamp a count.
//
// Returns `{ name, content }` of the report that landed (renamed name,
// or original on replace / no-op), or null on cancel. `existingNames`
// is updated in place so a follow-up file in the same drop sees the
// just-imported names without re-listing OPFS.
async function importReportContent({ name, content, existingNames }) {
  if (!existingNames.has(name)) {
    await saveFile(name, content)
    existingNames.add(name)
    return { name, content }
  }
  // Read existing bytes through the regular text path so the compare
  // is on the LOGICAL content (decompressed, envelope-peeled), not the
  // on-disk gzipped form.
  //
  // Three failure modes:
  //  - sibling-tab delete (file vanished between snapshot and read)
  //    → treat as "no collision", save under the now-free name.
  //    Detected as OPFS `NotFoundError` or the storage.js localStorage
  //    fallback's `File not found:` Error.
  //  - vault locked at rest — readFile throws `storage: vault locked,
  //    cannot decrypt ...`. MUST NOT collapse to "no collision" and
  //    overwrite an existing encrypted file with dropped plaintext
  //    (that replaces real content the user can't currently see).
  //    Propagate so addFiles' catch hits the standard alert; the user
  //    can unlock and re-drop.
  //  - any other read failure — propagate too; don't pretend it's gone.
  let existing
  try { existing = await readFile(name) }
  catch (err) {
    if (!isMissingFileError(err)) throw err
    await saveFile(name, content)
    existingNames.add(name)
    return { name, content }
  }
  if (existing === content) return { name, content }
  // Workspace context for the dialog's upload warning. A report can
  // sit in multiple workspaces (additive membership); collect every
  // one listing this name, then narrow to those whose remote already
  // holds it (live session or persisted cache). One that lists it
  // locally but never uploaded is ineligible — uploading would open a
  // presence session to a maybe-never-authenticated relay, surfacing
  // an unwanted password prompt. The dialog copy keys off this
  // filtered list, so the warning names only workspaces an upload
  // would touch.
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
  // Replace: write the new bytes first so the upload reads the
  // freshly-saved on-disk form. Re-uploading the same name replaces
  // the workspace objstore's encrypted blob; putFile's retryOnConflict
  // handles the optimistic-concurrency dance. Sync is best-effort —
  // the local replace already happened, so a transient network failure
  // (logged) shouldn't undo it.
  await saveFile(name, content)
  if (uploadableWorkspaces.length > 0) {
    await uploadReportToWorkspaces(name, uploadableWorkspaces)
  }
  return { name, content }
}

// Best-effort push of a freshly-replaced report to every workspace
// whose remote already carries it. Callers (Replace branch) pre-filter
// via `isInRemoteOrCached` so a never-uploaded workspace never reaches
// this loop — opening a presence session would trip the relay's
// first-touch auth gate and surface an unwanted password prompt. Each
// session is opened on demand (mirrors `deleteFromRemote`'s lazy-open:
// the user may not have visited these workspaces this session, but the
// cloud copies still need to track the replace).
//
// Both `openPresence` and `putFile` route through client-sync.js's
// lazy wrapper sharing a memoised chunk load, so MUST `await
// openPresence` before `putFile` — putFile reads
// `sessions.get(workspaceId)` and throws "Workspace … is not open"
// if openPresence's `sessions.set` hasn't run yet. Awaiting also
// catches a chunk-load rejection so it doesn't bubble unhandled.
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

async function addFiles(files) {
  // On a managed server the local (OPFS / "local storage") ingest path is
  // disabled: uploads belong server-side, via the admin "Manage reports" /
  // "Manage bundles" pages. So a drop / file-pick anywhere in the app chrome
  // here must NOT write to disk — bail before any of the pipeline runs. This is
  // the single choke point for every entry (document drop, the empty-screen
  // drop-zone, and the file picker).
  if (state.serverMode === 'managed') return
  // First-import nudge: ask once whether to enable passkey encryption
  // before this drop's files hit disk, so an accepted enable seals the
  // very first write rather than landing plaintext then re-writing the
  // migration. Skipped silently when the vault is already enabled, the
  // browser lacks WebAuthn, or the user already chose.
  await maybePromptFirstUse()
  let last = null
  let lastBundleIntegrity = null
  // Track newly-saved bundle integrities so we can prefetch their
  // per-file hashes after `renderSidebar()` refreshes `state.bundles`
  // (the prefetch helper looks the entry up there). Lets existing
  // reports' "Code →" buttons surface as soon as the matching bundle
  // lands, without the user manually opening it.
  const newBundleIntegrities = new Set()
  // Snapshot of OPFS report names, taken once per drop and kept in
  // lock-step as `importReportContent` saves. Drives its conflict
  // check so back-to-back files within ONE addFiles call see each
  // other (e.g. a CSV deriving two same-named .codex files would else
  // miss the second collision). Re-listed after
  // `importWorkspaceFromGzip` below: that branch saves bundled reports
  // via `applyWorkspaceImport` (which we can't reach to update
  // `existingNames`), so without the re-list a regular report dropped
  // alongside a same-named workspace import would silently overwrite
  // the import's just-saved copy.
  const existingNames = new Set(await listFiles())
  // Reports inside a raw reports export that no parser recognises.
  // Collected rather than alerted per entry: a hand-edited export
  // could hold many, and one dialog per name is not a report on the
  // drop, it is a punishment for it.
  const unreadable = []
  for (const file of files) {
    try {
      // Route plaintext gzip and encrypted bundles to workspace import
      // BEFORE the file.text() read — UTF-8 decoding would mangle the
      // binary bytes. importWorkspaceFromGzip throws on a non-export
      // shape. `stripDownloadDup` normalises browser ` (N)` suffixes so
      // a redownloaded `foo.deepview-workspace (1).enc` still routes here.
      const lower = stripDownloadDup(file.name.toLowerCase())
      if (lower.endsWith('.gz') || lower.endsWith('.deepview-workspace.enc')) {
        const imported = await importWorkspaceFromGzip(file)
        // The raw reports export is not an import of its own — it is a
        // drop of the reports that were in it. So they land here,
        // through the same path a dragged-in report takes: recognised
        // before anything is written, the rename / replace prompt on a
        // name already taken, the count and source stamped for the
        // sidebar, and the last one navigated to. `importReportContent`
        // keeps `existingNames` current as it saves, so two entries of
        // the same name inside one file see each other.
        if (imported?.kind === 'reports') {
          for (const r of imported.reports) {
            if (typeof r?.name !== 'string' || !r.name || typeof r?.content !== 'string') continue
            const result = analyzeContent(r.content)
            // A report the viewer can't parse doesn't reach OPFS — the
            // same gate a dragged-in file passes. One bad entry is not
            // the file's fault, though, so the rest still land and the
            // skipped names are named once at the end.
            if (!result.recognized) { unreadable.push(r.name); continue }
            const saved = await importReportContent({ name: r.name, content: r.content, existingNames })
            if (!saved) continue
            setCount(saved.name, result.count, result.source)
            last = { name: saved.name, content: saved.content }
          }
        }
        // Refresh existing-names after the import's internal saveFiles
        // so a later same-named file in this drop hits the conflict
        // path instead of silently overwriting (see snapshot note above).
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
      // OPFS dir, skip the report-ingest pipeline. Name preserved
      // verbatim so the bundles list shows what was dropped. Content is
      // binary (stasis is brotli); read as ArrayBuffer, not text.
      const kind = bundleKind(file.name)
      if (kind) {
        const buf = new Uint8Array(await file.arrayBuffer())
        const { integrity } = await saveBundle(file.name, buf)
        lastBundleIntegrity = integrity
        newBundleIntegrities.add(integrity)
        continue
      }
      const content = await file.text()
      // Codex is named by the file, not its content (see report/index.js);
      // `lower` has the download-duplicate suffix stripped already.
      if (detectFormat(content, lower) === 'codex') {
        const scans = parseCodexCsvToScans(content)
        for (const { displayName, data } of scans) {
          // '/' → '__': OPFS filenames can't contain '/'; file-display.js
          // maps it back for the visible label.
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
        // analyzer-native JSON, DeepSec, Piolium, and Claude / Codex /
        // markdown imports, plus the links file (which is not a report:
        // see client/linked-findings.js). Anything else is rejected so
        // we don't litter OPFS with files nothing here can read.
        //
        // A links file needs no branch of its own on the way in: it is
        // saved, conflict-resolved and counted through the same path a
        // report takes, and it's `result.source` — cached by setCount,
        // read back by `getKind` — that keeps the two apart afterwards,
        // in the sidebar's bucket and in `switchToFile` below.
        const result = analyzeContent(content)
        if (!result.recognized) {
          throw new Error('not a recognized DeepView, DeepSec, Piolium, Claude Security, or Codex report, and not a links file')
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
  if (unreadable.length > 0) {
    const n = unreadable.length
    alert(`Skipped ${n} report${n === 1 ? '' : 's'} no parser recognised: ${unreadable.join(', ')}`)
  }
  // renderSidebar refreshes state.bundles from OPFS so a just-imported
  // bundle is visible to the bundles view path below.
  await renderSidebar()
  // state.bundles is now fresh — kick a background hash pre-parse for
  // every bundle this drop saved. The hash index populates the
  // cross-bundle map the finding-card's "Code →" button consults, so
  // existing reports' findings resolve matches without the user
  // manually opening every bundle.
  for (const integrity of newBundleIntegrities) {
    prefetchBundleHashes(integrity).catch(() => {})
  }
  if (last) {
    // Single-report drop wins over a bundle when both happen in
    // the same drop — the user's primary intent was the report.
    await switchToFile(last.name, last.content)
  } else if (lastBundleIntegrity) {
    // Bundle-only drop: switch to the bundles view AND open the
    // dropped bundle's details panel. `selectBundle` clears stale
    // source-viewer state and resets search (the same setup as the
    // sidebar's bundle-row click), then hand off to the shared
    // open-bundle pipeline so the panel populates without a second
    // click.
    selectBundle(lastBundleIntegrity)
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
  // member should still ride the workspace's chain, so the user sees
  // peer edits and pushes their own without switching to the workspace
  // tab first. A report can sit in more than one workspace
  // (cross-workspace finding share); open a session for each. Sessions
  // for OTHER workspaces close — intersecting (rather than close-all-
  // then-open) keeps same-workspace sessions warm across file switches
  // so we don't re-pay key derivation.
  const desiredWorkspaceIds = new Set(
    listWorkspaces()
      .filter((w) => Array.isArray(w.reports) && w.reports.includes(name))
      .map((w) => w.id),
  )
  // Close BOTH planes in lockstep. A presence session must never
  // outlive its sync subscription: the objstore client rides
  // triage-sync's `workspace-subscribe` (carrying the inventory
  // snapshot and registering the socket for objstore-put/-deleted
  // broadcasts), so a presence session kept past its sync session
  // would, on the next reconnect, have no subscribe to seed its
  // inventory or deliver broadcasts. Keeping presence ⊆ sync (at the
  // cost of a cold cache on return visits) makes that impossible.
  closeSessionsExcept(desiredWorkspaceIds)
  state.reports = []
  state.workspaceMerges = []
  state.revalidateConflict = false
  state.currentFile = name
  state.currentWorkspace = null
  state.currentLinks = null
  // Switching to a regular report drops out of the bundles / packages
  // / links view — the user clicked a file row to see its findings.
  // (A links file lands back on 'links' below, once the read confirms
  // that's what it is; going through 'findings' first means a report
  // never inherits the previous file's view.)
  if (state.currentView === 'bundles' || state.currentView === 'packages'
      || state.currentView === 'repositories' || state.currentView === 'links') {
    state.currentView = 'findings'
  }
  // Per-report repo URL (see state.js / saveRepoUrlFor): the user's
  // last-typed URL for THIS file lights up the header repo chip, unseen
  // file starts empty. Reset before ingest so a stale URL from the
  // previous file doesn't briefly drive the chip.
  state.repoUrl = loadRepoUrlFor(name)
  state.repoEditing = false
  resetGraph2()
  setSecureItem(LAST_FILE_KEY, name).catch(() => {})
  if (content === undefined) {
    try {
      content = await readFile(name)
    } catch (err) {
      // Skip the alert / state-reset when a newer switch already took
      // over — its setup replaced what we'd clear, and an error from
      // the dead load would just confuse the user.
      if (isStaleLoad(gen)) return
      // "vault locked" is actionable: prompt to unlock, retry on
      // success. Mirrors the boot-time prompt for users who dismissed
      // it earlier this session.
      if (err && err.message?.includes('vault locked')) {
        const ok = await openPasskeyUnlockDialog()
        if (ok && !isStaleLoad(gen)) {
          await switchToFile(name)
          return
        }
        // User dismissed the dialog (or a newer switch took over).
        // Clear the about-to-be-current file so the sidebar doesn't
        // leave the row highlighted with no content loaded.
        if (!isStaleLoad(gen)) {
          state.currentFile = null
          await renderSidebar()
        }
        return
      }
      // A missing file — including a corrupt/empty entry that storage
      // just quarantined (readFile surfaces both as the same
      // not-found shape) — is not worth an alert: the bytes are gone
      // either way. When a workspace's cloud copy still holds the
      // report, offer to re-download it through the same dialog the
      // sync badge uses; on success re-enter switchToFile with the
      // restored bytes. Otherwise (no cloud copy, or the user
      // declined) just clear the selection like the vault-dismiss
      // branch above — the quarantine already dropped the sidebar row.
      if (isMissingFileError(err)) {
        // Same eligibility rule as the Replace-upload flow: only a
        // workspace whose remote ALREADY carries this report (live
        // session or persisted presence cache) — opening a session to
        // a never-uploaded workspace would surface an unwanted
        // password prompt for a local-only report.
        const cloudWs = listWorkspaces().find(
          (w) => Array.isArray(w.reports) && w.reports.includes(name) && isInRemoteOrCached(w.id, name),
        )
        if (cloudWs) {
          try {
            // The dialog's fetchFile needs an open presence session;
            // lazy-open mirrors uploadReportToWorkspaces (the user may
            // not have visited this workspace this session).
            await openPresence(cloudWs.id)
            if (isStaleLoad(gen)) return
            const result = await openSyncDownloadDialog({
              workspaceId: cloudWs.id,
              items: [{ kind: 'report', identifier: name }],
            })
            if (isStaleLoad(gen)) return
            if (result?.downloaded?.some((d) => d.kind === 'report' && d.identifier === name)) {
              await switchToFile(name)
              return
            }
          } catch (redownloadErr) {
            // Session open / dialog failure — fall through to the
            // quiet missing-file teardown; the report stays available
            // through the sync badge's recovery flow.
            console.warn(`Re-download prompt for missing "${name}" failed:`, redownloadErr)
            if (isStaleLoad(gen)) return
          }
        }
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
  // A links file declares which findings are the same finding; it
  // carries none of its own, so it never goes through `ingestReport`
  // and `state.reports` stays empty. Its view (render-links.js) points
  // at the findings in the reports that DO carry them.
  const linked = parseLinkedFindings(content)
  if (linked) {
    state.currentLinks = { name, ...linked }
    state.currentView = 'links'
    render()
  } else {
    await ingestReport(name, content, gen)
  }
  if (isStaleLoad(gen)) return
  // Open the session(s) AFTER ingest so buildWorkspaceIds sees the
  // freshly-loaded findings — otherwise it runs against the empty
  // state.reports reset above and the id-set stays empty until the
  // next save. openSession is idempotent on already-open ids, so
  // follow with `refreshSession` to pick up newly-in-scope ids: without
  // it, a report dragged into the workspace while a different file was
  // focused would never propagate its triage when finally loaded (the
  // session was open with stale ids and openSession's idempotence skips
  // the rebuild).
  for (const id of desiredWorkspaceIds) {
    triageSync.openSession(id)
    triageSync.refreshSession(id)
    openPresence(id)
  }
  await renderSidebar()
}

// Replace the active view with the merged contents of an entire
// workspace — every assigned report loaded via `ingestReport`,
// accumulating in `state.reports`. `state.currentFile` is cleared
// (workspace mode is mutually exclusive with single-file);
// `state.currentWorkspace` carries the id. Per-report repo URLs
// round-trip via each finding's `_repoFallback` stamp (see
// ingestReport), so the global `state.repoUrl` is empty here and the
// editable header chip is omitted. Reports the workspace references
// but that no longer exist in OPFS are skipped silently.
export async function switchToWorkspace(workspaceId) {
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) return
  const gen = ++loadGen
  // Close triage-sync sessions for OTHER workspaces, keeping the
  // target's alive to avoid a close + open + re-subscribe round-trip on
  // every click of the workspace title (the ingest loop's trailing
  // `refreshSession` brings its id-set up to date). Close each other's
  // presence session in lockstep — presence must never outlive its
  // sync subscription (rides `workspace-subscribe`), so presence ⊆ sync.
  closeSessionsExcept(new Set([workspaceId]))
  // Same drop-out as switchToFile — opening a workspace lands in
  // findings, not the bundles / packages / links list.
  if (state.currentView === 'bundles' || state.currentView === 'packages'
      || state.currentView === 'repositories' || state.currentView === 'links') {
    state.currentView = 'findings'
  }
  // Same fire-and-forget prime as ingestReport, for the workspace half
  // of a deep link's location hint.
  void computeLinkHint('workspace', workspaceId)
  state.reports = []
  state.workspaceMerges = []
  state.revalidateConflict = false
  state.currentFile = null
  state.currentWorkspace = workspaceId
  state.currentLinks = null
  state.repoUrl = ''
  state.repoEditing = false
  resetGraph2()
  setSecureItem(LAST_FILE_KEY, `ws:${workspaceId}`).catch(() => {})
  // Empty workspace — the readFile loop below is a no-op, so without
  // clearing the report pane the user sees whatever was last rendered
  // (stale finding, bundle, …) while the sidebar marks this workspace
  // current: a "dead click". Mirror leaveWorkspace's empty-state
  // teardown so the drop zone re-appears. Bundle-only workspaces (no
  // reports, some bundles) get the same treatment — bundles render in
  // the sidebar; the workspace row itself is a no-op for the main pane
  // until reports land.
  if (ws.reports.length === 0) showEmptyMainPane()
  // Kick off every readFile concurrently up front, then ingest in
  // workspace order. The await inside the loop only blocks on each
  // report's bytes — slower reads continue in the background while
  // earlier ones parse + render, so the first findings show as soon as
  // their read finishes, not after the slowest in the batch. Ingest
  // order is preserved because the awaits walk the promise array in
  // workspace.reports order. Per-read failures resolve to `null`
  // (caught at the promise) so one bad file doesn't reject the batch.
  const reads = ws.reports.map((name) => readFile(name).catch(() => null))
  let ingested = 0
  for (let i = 0; i < ws.reports.length; i++) {
    const content = await reads[i]
    if (isStaleLoad(gen)) return
    if (content === null) continue
    // A workspace holds whatever the user dragged into it, and a links
    // file is a member like any other — but it carries no findings, so
    // there is nothing to merge into the view and `ingestReport` would
    // reject it as an unreadable report. Skip it here; its sidebar row
    // under this workspace still opens it in its own view.
    if (parseLinkedFindings(content)) continue
    await ingestReport(ws.reports[i], content, gen)
    ingested++
    if (isStaleLoad(gen)) return
  }
  // Nothing painted the main pane: every member was a links file, or
  // unreadable. Same teardown as the empty workspace above — otherwise
  // the previous view stays up while the sidebar says we moved.
  if (ingested === 0 && ws.reports.length > 0) showEmptyMainPane()
  // What the WORKSPACE opens on. The loop above asked this of its
  // FIRST member (ingestReport's isFirst branch), which is the answer
  // for a single file and the wrong one for a set: a revalidated
  // report sitting behind an imported one leaves the whole workspace
  // on the confidence range, and a floor tuned to one member's
  // findings gets applied to everyone's. A workspace is one view over
  // its reports, so ask once more now that they are all in — nothing
  // has touched the filters since that first member's resetFilters,
  // so this is still what a fresh load would set, not a user's
  // selection being overwritten. Re-render: the last ingest painted
  // with the interim answer.
  if (ingested > 0) {
    applyOpeningFilters(getShownGroups())
    render()
  }
  // Open the per-workspace sync session AFTER every report is ingested
  // — it needs a complete view of state.reports to build its
  // workspace-id set. No-op when sync is disabled (no server URL).
  triageSync.openSession(workspaceId)
  // Refresh the id-set: if the session was already open (intersection-
  // close preserved it), its `ids` still reflect the OLD state.reports,
  // so newly-in-scope ids get their triage propagated to the chain.
  // Also covers a report dragged into this workspace while another file
  // was focused — its finding-ids are visible to triage-sync only once
  // state.reports carries the report.
  triageSync.refreshSession(workspaceId)
  openPresence(workspaceId)
  await renderSidebar()
}

// Remove the current file from OPFS and close the view. Doesn't
// auto-switch — the user picks from the sidebar.
//
// Also strips the name from any workspace's `reports` array — the
// canonical "prune at write time" point. Without it a deleted file
// stays listed in any workspace it was moved into; render skips
// ghosts, but `workspace-export` would log skip-warnings forever and
// the next import on another machine would resurrect the stale entry.
//
// `triage` ('keep' | 'wipe', default 'keep') controls whether
// `pruneOrphanTriage` runs after the removal. The sidebar precomputes
// the orphan count via `analyzeTriageImpact` and surfaces the action
// through `<delete-report-dialog>`, whose triage section adapts to it
// (terse note when nothing's attached or everything's also reachable
// from a kept report; keep-vs-wipe radio when orphans exist). 'keep'
// is the no-op path the dialog resolves with when there's nothing to
// ask about.
//
// `deleteFromRemoteWorkspaceIds` — every workspace whose remote holds
// the report. The sidebar gathers all owning workspaces (multi-
// workspace membership) and filters by `isInRemoteOrCached` (live
// sessions AND persisted cache). Fan the per-workspace `deletePresence`
// calls out, each try/catch-wrapped so a network blip on workspace N
// doesn't strand local bytes + later workspaces' remote tags half-
// deleted. Errors are logged but never abort the local cleanup —
// intact local bytes alongside peers' partial remote state is worse
// than "remote not fully cleaned, retry by re-deleting".
export async function deleteCurrent({ triage = 'keep', deleteFromRemoteWorkspaceIds = [] } = {}) {
  if (!state.currentFile) return
  // Bump the load generation AND capture it. The bump alone gates
  // other in-flight switchTo*/ingestReport from clobbering
  // state.reports, but deleteCurrent's own tail (state.currentFile =
  // null; state.reports = []; ...) would still run even if a new
  // switchTo* landed during one of the awaits below (deletePresence,
  // deleteFile, setReportWorkspace, pruneOrphanTriage), clobbering the
  // freshly-built view. So mirror switchToFile: capture gen, re-check
  // `isStaleLoad(gen)` at every await checkpoint, bail before the state
  // mutations if a newer load superseded us. Concurrency audit
  // `ui/view/ingest.js:366`.
  const gen = ++loadGen
  const name = state.currentFile
  // Drop name-scoped cache + localStorage entries up-front, BEFORE any
  // await. removeCount + saveRepoUrlFor are synchronous and scoped to
  // the captured `name`, so they can't clobber the active file's state
  // even if a switchTo* races in. Deferring them past the awaits would
  // let an early stale-bail leave a stale repoUrl that resurrects on a
  // future same-name re-import. Audit follow-up: PR-73 cross-module
  // review.
  removeCount(name)
  saveRepoUrlFor(name, '')
  // Remote deletes BEFORE the local one close the window where the
  // next `openWorkspace(W)` auto-download could re-pull the report
  // through that workspace's tag. Each call is wrapped — `not-found`
  // is fine (idempotent when a peer already dropped the tag); other
  // errors warn but don't abort the loop or block the local delete.
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
  // GC orphan triage only on "wipe". Default ('keep') leaves them in
  // localStorage so a future re-import of the same report resurfaces
  // the triage. A GC error (round-1 review #1: now propagated, not
  // silently wiping everything) is warned and swallowed — the OPFS
  // removal already landed; orphans stay until the next clean prune.
  if (triage === 'wipe') {
    try { await pruneOrphanTriage() }
    catch (err) { console.warn('Skipped orphan-triage GC:', err) }
    if (isStaleLoad(gen)) return
  }
  // Final stale-check before the tail mutation block: a switchTo*'s
  // `++loadGen` is synchronous and can land between any two statements,
  // so re-check here even with no await separating them, lest a brand-
  // new view have its `state.reports` cleared / `graph2` torn down out
  // from under it. Audit follow-up: PR-73 cross-module review.
  if (isStaleLoad(gen)) return
  clearActiveView()
  await renderSidebar()
}

// Shared empty-state reset — clears all in-memory view state
// (selections, reports, graph2, repo-url) and repaints `#report` /
// `#drop-zone` / `<title>` to the empty welcome surface. The
// `<print-button>` / `<download-button>` hosts hide themselves
// reactively via their StateElement autoruns (see
// view/print-button.js / download-button.js) when the predicates fail,
// so no manual visibility reset here. `goHome`, `deleteCurrent`'s tail,
// and `leaveWorkspace`'s active-view branch all route through here so
// the three paths can't drift.
//
// Does NOT bump `loadGen` or close sync sessions — those are caller
// concerns (each path has its own ordering constraints with the
// surrounding OPFS / triage / remote operations).
function clearActiveView() {
  state.currentFile = null
  state.currentWorkspace = null
  state.currentLinks = null
  state.selectedBundle = null
  state.bundleDetails = null
  state.bundleSourceFile = null
  state.bundleSourceFindingIdx = null
  state.reports = []
  state.workspaceMerges = []
  state.revalidateConflict = false
  state.repoUrl = ''
  state.repoEditing = false
  state.shownTriage = null
  state.currentView = 'findings'
  resetGraph2()
  removeSecureItem(LAST_FILE_KEY)
  showEmptyMainPane()
  document.title = 'DeepView'
}

// Drop back to the empty drop-zone screen without touching stored
// data — non-destructive counterpart to `deleteCurrent`'s tail. The
// DeepView wordmark in the sidebar header routes here, so clicking it
// always lands on the supported-formats welcome surface regardless of
// what's open. Skips OPFS / remote / triage GC — the file the user
// came from stays as-is for them to pick back up from the sidebar.
export async function goHome() {
  // Bump the load generation so any in-flight switchTo* / ingestReport
  // bails before pushing into the cleared state. Mirrors the guard in
  // `deleteCurrent` / `leaveWorkspace`.
  ++loadGen
  // Close any per-workspace sync sessions tied to the active view —
  // both single-file-member and merged-workspace views open sessions
  // (in switchToFile / switchToWorkspace); without closing them,
  // returning home would leave triage-sync echoing edits to a chain no
  // view consumes.
  closeSessionsExcept(new Set())
  clearActiveView()
  await renderSidebar()
}

// Bundle counterpart of `deleteCurrent` — drives the sidebar's
// "Delete current" button when the bundles view's `selectedBundle` is
// active. Removes the OPFS bytes, detaches the integrity from every
// workspace's `bundles` list, prunes the cross-bundle SHA-512 hash
// index (so the finding-card "Code →" lookup stops surfacing the gone
// bundle), drops the panel selection + persisted last-view pointer,
// refreshes `state.bundles`, repaints view + sidebar.
//
// `deleteFromRemoteWorkspaceIds` — workspace ids whose remote objstore
// should also drop this bundle. The sidebar gathers every owning
// workspace whose remote holds the integrity (live session OR cache,
// via `isBundleInRemoteOrCached`). Each `deleteBundleFromRemote` runs
// FIRST so the tag drops before we clear the local bytes; each is
// wrapped so a network blip doesn't strand local bytes + later
// workspaces' tags half-deleted. Same shape + rationale as
// `deleteCurrent`.
//
// Concurrency: `++loadGen` + `isStaleLoad(gen)` mirrors
// `deleteCurrent` — a switchToWorkspace landing during an await below
// would otherwise clobber the freshly-built view via the trailing
// `listBundles()` + `render()`.
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
  // Only clear LAST_FILE_KEY when it pointed at THIS bundle —
  // workspace pointers (`ws:<id>`) and report filenames share the slot,
  // so an unconditional clear would dump the user to the empty drop
  // zone on reload after deleting a bundle from a workspace view.
  // `persistLastBundle` writes `b:<integrity>` (optional ` <tab>`
  // suffix); match the prefix to keep unrelated pointers intact.
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
// entry in localStorage and the persisted triage base (latter via
// triage-sync's `onWorkspaceDeleted`); attached reports depend on
// `mode`:
//   - 'detach' (default): OPFS bytes stay — reports reappear in the
//     sidebar's unattached bucket; cached counts + repo URLs survive.
//   - 'delete': OPFS bytes go too, alongside counts + repo URLs.
// `triage` controls the persisted-triage GC (only meaningful in
// delete mode):
//   - 'keep' (default): orphaned triage stays in localStorage so a
//     future re-import of a matching report can resurface it.
//   - 'wipe': run `pruneOrphanTriage` after the removal so any triage
//     entry whose finding-id isn't reachable from a remaining report
//     is dropped.
// Both modes leave the server's workspace chain untouched — subscribed
// peers keep their copy, and a future re-import of the same workspace
// bundle resumes against the same chain. UI responsibility: if the
// active view was this workspace (merged-mode) — or, in delete mode,
// one of its reports — clear `state.currentFile` /
// `state.currentWorkspace` and drop to the drop zone so the renderer
// doesn't trip over a reference to gone data.
export async function leaveWorkspace(workspaceId, mode = 'detach', { triage = 'keep' } = {}) {
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) return
  // Bump the load generation so any in-flight switchTo* / ingestReport
  // (e.g. a workspace click that started a merged-view load) bails
  // before pushing into the cleared state.reports — mirrors
  // `deleteCurrent`.
  ++loadGen
  const reports = Array.isArray(ws.reports) ? [...ws.reports] : []
  // Tear down the live sync session BEFORE touching the workspace
  // entry. `deleteWorkspace`'s listener does the same teardown (and
  // drops the persisted base), but a manual `closeSession` here also
  // stops the in-flight save loop from picking up a mid-deletion view
  // of state.reports and emitting a doomed save against a chain whose
  // identity is about to vanish.
  triageSync.closeSession(workspaceId)
  closePresence(workspaceId)
  if (mode === 'delete') {
    // Drop each report's OPFS bytes + localStorage sidekicks (counts,
    // repo URL). A report can sit in more than one workspace (additive
    // membership), so a copy another workspace still lists loses its
    // bytes too — that workspace's merged view skips the missing file
    // (`readFile` → null in switchToWorkspace) until it is re-imported
    // or re-downloaded from the workspace's remote.
    for (const name of reports) {
      try { await deleteFile(name) } catch {}
      removeCount(name)
      saveRepoUrlFor(name, '')
    }
    // GC orphan triage only on "wipe". Default ('keep') leaves orphans
    // so a future re-import of a matching report can resurface them.
    // Same single-source-of-truth as `deleteCurrent`: any marker /
    // triage / comment / fix / per-report ignore whose finding-id no
    // longer matches a finding in any remaining report is dropped;
    // triage still reachable from a report we keep (cross-workspace or
    // unattached) survives either way. A GC error (round-1 review #1:
    // now propagated, not silently wiping) is warned and swallowed —
    // the reports are already gone; orphans stay until the next prune.
    if (triage === 'wipe') {
      try { await pruneOrphanTriage() }
      catch (err) { console.warn('Skipped orphan-triage GC:', err) }
    }
  }
  // Detach mode needs no per-report mutation: `deleteWorkspace` below
  // drops the whole entry (with its `reports` array), the OPFS bytes
  // stay, and the sidebar's unfiled bucket re-claims them next render.
  //
  // Reset the active view if it pointed at the leaving workspace
  // (merged-mode) or — delete mode only — one of its reports. In
  // detach mode the files survive, so a single-file view of one is
  // still valid: leaving the user on the same report under the unfiled
  // bucket is less disruptive than slamming them to the drop zone.
  const wasActiveWorkspace = state.currentWorkspace === workspaceId
  const wasActiveFile = mode === 'delete'
    && state.currentFile != null
    && reports.includes(state.currentFile)
  if (wasActiveWorkspace || wasActiveFile) clearActiveView()
  // Finally drop the workspace entry. Fires `onWorkspaceDeleted`, which
  // wipes this workspace's persisted triage base (see triage-sync.ts).
  // No server message — the relay retains the chain until a future
  // operator-side delete (not exposed yet).
  await deleteWorkspace(workspaceId)
  await renderSidebar()
}

// Pure parse + render path — no FileReader, no OPFS. Used by
// switchToFile (after content is materialized) and the headless print
// flow (`window.__loadFile`), so that flow can merge multiple inputs
// by calling repeatedly.
//
// `gen` is the optional load-generation token captured by the caller
// (switchToFile / switchToWorkspace). When set, every await inside
// re-checks it on resume and bails before mutating state.reports — how
// a stale load from a superseded sidebar click avoids interleaving its
// push. The headless `window.__loadFile` path passes nothing, staying
// unguarded so it keeps accumulating across calls (the print pipeline
// relies on that).
async function ingestReport(name, content, gen = null) {
  const stale = () => gen !== null && isStaleLoad(gen)
  // Prime the deep-link hint for this report's name. Fire-and-forget:
  // the Link button reads the memo synchronously (it copies inside a
  // click handler, where an await would cost the clipboard grant), so
  // the hash has to be computed ahead of the click rather than at it.
  // Nothing downstream waits on this — a link built before it lands
  // just omits the hint.
  void computeLinkHint('report', name)
  try {
    // Persistent triage (markers/deletedIds keyed by uuid) loads once
    // at module init; await it before rendering so the first drop
    // already shows stored marks/deletions for matching findings.
    await triageLoadPromise
    if (stale()) return
    // Format dispatch lives in the report library (report/index.js),
    // which also words the failure — usually a malformed dump rather
    // than an unknown format.
    const { data, reason } = readReport(content)
    if (!data) throw new Error(reason)
    // First report in the current view (state.reports cleared on
    // switchToFile / deleteCurrent, accumulating in the headless print
    // flow). Gates both the filter reset and the auto-tune below.
    const isFirst = state.reports.length === 0
    // Dedup by exporter-provided uuid id across ALL loaded reports.
    // Entries are a single Finding or a Finding[] (an upstream dedup
    // group). A new group is dropped if ANY member's id matches a
    // seen id — one overlap means "already loaded" (groups don't
    // split / reshape across reloads). Id-less findings (legacy /
    // pre-uuid JSON) can't be deduped and always pass through.
    // `idToGroupKey` lets the dupe branch distinguish "same group
    // already loaded" (one key matched) from "this entry binds >1
    // existing groups into one finding" (>1 keys) — the latter is
    // recorded as a workspace-level merge so the dedup hint survives
    // dropping the entry.
    const seenIds = new Set()
    const idToGroupKey = new Map()
    // id → the SURVIVING finding object for that id (first occurrence
    // wins, matching the dedup below). Lets the dedup branches keep
    // what the dropped copy knew: its per-report effective severity,
    // so an application-specific correction that DIFFERS across
    // reports stays visible in the merged view (recordCorrectedVariant
    // + format.js correctedVariants), and every other field the
    // survivor has no answer for — the revalidation pass's verdict
    // above all (group.js mergeDuplicateFields). The dropped object
    // itself is discarded as before.
    const idToFinding = new Map()
    for (let ri = 0; ri < state.reports.length; ri++) {
      const r = state.reports[ri]
      for (let gi = 0; gi < r.groups.length; gi++) {
        const g = r.groups[gi]
        const key = `${ri}:${gi}`
        for (const f of g) {
          if (f.id) {
            seenIds.add(f.id); idToGroupKey.set(f.id, key)
            if (!idToFinding.has(f.id)) idToFinding.set(f.id, f)
          }
        }
      }
    }
    // Record a deduped duplicate's effective severity onto the survivor,
    // keyed by report name. Only builds the `_correctedByReport` map when
    // a correction is actually present on either side — same id implies an
    // identical INTRINSIC severity (it's in the id fingerprint), so two
    // occurrences can only diverge via a correction. Seeds the survivor's
    // own entry on first divergence so the map fully describes every
    // report's value. Defined outside the entry loop (no per-iteration
    // closure) so oxlint's no-loop-func stays happy.
    const recordCorrectedVariant = (survivor, dupReportName, dup) => {
      if (!survivor || (!dup.correctedSeverity && !survivor.correctedSeverity)) return
      if (!survivor._correctedByReport) {
        survivor._correctedByReport = {
          [survivor._reportName ?? '']: {
            severity: effectiveSeverity(survivor),
            reason: survivor.correctedSeverityReason,
          },
        }
      }
      survivor._correctedByReport[dupReportName ?? ''] = {
        severity: effectiveSeverity(dup),
        reason: dup.correctedSeverityReason,
      }
    }
    // Record a deduped duplicate's APP on the survivor. The dropped
    // occurrence belonged to THIS report — a second app's copy of the
    // same dependency finding, which is precisely the case the per-app
    // triage track exists for — and the survivor is now the only card
    // the workspace shows for both. So it has to be able to answer for
    // both: `setTabTriage` writes every app in `_appKeys`, and
    // `tabTriage` shows a bucket only where they agree. Without this
    // the load order would decide which app owned the card and the
    // other one could never be recorded at all.
    //
    // Absent until a duplicate actually arrives, so the overwhelmingly
    // common single-app finding carries nothing extra and `findingApp`
    // keeps reading `_appKey`.
    const recordAppKey = (survivor, appKey) => {
      if (!survivor || !appKey) return
      const list = survivor._appKeys ?? [survivor._appKey ?? survivor._reportName ?? '']
      if (list.includes(appKey)) return
      survivor._appKeys = [...list, appKey]
    }
    // The report's entries, under whichever of the two names it files
    // them (report/index.js reportEntries): `findings`, or `groups`
    // for a report that arrives already deduplicated — a native dump
    // that merged its runs, and every markdown export of a view that
    // showed a finding as one card with several cases. Read as
    // `data.findings` alone, those come out EMPTY, so a workspace
    // export re-imported here would render as a report with nothing
    // in it.
    //
    // Derive deterministic ids for findings lacking one — must run
    // BEFORE the dedup loop so MD-imported (and id-less JSON) findings
    // dedupe by content like exporter-id'd ones, and so triage
    // (markers / deletions) persists across reloads of the same source.
    // Mutates the finding objects in place; `toGroup` returns them by
    // reference, so the ids are visible to the loop below.
    const rawEntries = reportEntries(data) ?? []
    await backfillFindingIds(rawEntries.flatMap(toGroup))
    if (stale()) return
    // Per-report repo URL stamped on each finding so format.js's
    // fileUrl / lineLink resolves the right fallback in workspace mode
    // (where state.repoUrl can't represent N reports at once). Empty
    // string for headless / print ingests with no OPFS-backed URL.
    //
    // A report-level `repo.github` declaration outranks that typed URL
    // — it's the analyzer naming what the run covered, and the header
    // shows it INSTEAD of the editable chip (see repoChipTemplate), so
    // links have to resolve against the repo the chip names. Stamped in
    // slug form: `repoBaseUrl` expands it for links, and it buckets
    // with analyzer-stamped `repo.github` values in the Repositories
    // view rather than splitting the same repo across two keys.
    const declaredRepo = reportRepoGithub(data)
    const repoFallback = declaredRepo ?? loadRepoUrlFor(name)
    const groups = []
    let dupeCount = 0
    for (const entry of rawEntries) {
      const members = toGroup(entry)
      if (members.length === 0) continue
      // Partition members by whether their id was already seen across
      // prior reports + earlier entries here. Three branches:
      //   1. all-new      → push as a fresh group (no merge)
      //   2. all-seen     → drop the entry; record a cross-report merge
      //                     when it binds >1 distinct existing groups,
      //                     so the dedup hint survives the drop
      //   3. partial-seen → stamp the new members as a fresh group AND
      //                     record a merge with all member ids, so the
      //                     load-order case (combined entry arrives
      //                     between the two singletons it merges) still
      //                     collapses to one super-group
      // Recorded merges carry every entry id in source-array order;
      // `getMergedGroups` orders the merged super-group from that, so
      // the combined entry's [A, B] beats any incidental load-order
      // [B, A].
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
        // Preserve each dropped duplicate's corrected severity on its
        // survivor before discarding the entry.
        for (const m of seenMembers) {
          const survivor = idToFinding.get(m.id)
          recordCorrectedVariant(survivor, name, m)
          // The app the dropped copy belonged to — the one `_`-prefixed
          // field that has to cross. `mergeDuplicateFields` leaves
          // those alone by design (they say where a copy came from,
          // and the survivor keeps its own), but this card is now the
          // only one EITHER app has, so it has to be able to answer
          // for both: see `recordAppKey` and `scopedApps` in group.js.
          recordAppKey(survivor, declaredRepo ?? name)
          // …and anything else this copy knew that the survivor
          // doesn't — the pass's verdict above all. A disagreement
          // about that verdict is reported rather than settled: the
          // layer comes off the whole set (group.js
          // mergeDuplicateFields, render.js).
          if (mergeDuplicateFields(survivor, m)) state.revalidateConflict = true
        }
        dupeCount += seenMembers.length; continue
      }
      // Stamp a session-local `_id` on each member as a fallback key
      // for findings lacking the exporter uuid `id` — `tabKey(f)`
      // prefers `f.id` (persistent), falls back to `String(f._id)`.
      // Register ids as we stamp so duplicate entries WITHIN this drop
      // are caught too.
      //
      // Inherit run-level meta (type / model / think / effort /
      // exportsMode) from the header onto each finding, field by field —
      // see inheritReportMeta. A finding out of the deduplicate command
      // carries its own `model` (one per source run) while the rest of
      // the run meta stays in the header, so filling gaps individually
      // is what keeps such a finding's analyzer from reading as "none".
      //
      // Plain for-loop rather than .map — the callback would close over
      // the outer loop's `data` / `name` / `repoFallback`, which
      // oxlint's no-loop-func flags. The closure is invoked
      // synchronously this iteration so the capture is safe; the
      // for-loop sidesteps the lint without changing semantics.
      const stamped = []
      for (const f of newMembers) {
        if (f.id) seenIds.add(f.id)
        // `_bundleHashes`: the report-level integrities the analyzer
        // ran against, stamped per-finding so the finding-card's
        // "Code →" lookup constrains its search to bundles this report
        // is about. Empty array when the report lacked the field.
        // `_appKey`: which APP this occurrence belongs to, the key the
        // per-app triage track is stored under (see `findingApp` in
        // group.js and the `apps` field on TriageEntry). The report's
        // own `repo.github` declaration when it makes one — so a
        // re-run of the same project keeps the fixes recorded against
        // its earlier reports — and the report's filename otherwise,
        // which is as much identity as an undeclared report has.
        // Deliberately NOT `repoFallback`: that folds in the repo URL
        // the user typed into the header chip, and re-keying an app
        // because someone edited a URL would strand every fix stored
        // under the old key.
        const filled = {
          ...f,
          _id: state.nextFindingId++,
          _repoFallback: repoFallback,
          _reportName: name,
          _appKey: declaredRepo ?? name,
          _bundleHashes: data.bundleHashes ?? [],
        }
        inheritReportMeta(filled, data)
        // Which PRODUCER this finding came from — a `source` marker
        // (deepsec / codex-security / claude-security / piolium), or
        // null for the analyzer's own dump, which is DeepView's
        // (file-display.js PRODUCER_LABELS names that bucket). Its own
        // marker when it carries one — a re-imported markdown export
        // that mixed a product's findings with the analyzer's own runs
        // stamps them per finding (report/src/parse-deepview-md.js),
        // and such a finding is that product's whatever report it now
        // sits in — else its report's. The same answer the markdown
        // writer's `sourceReader` gives (report/src/write-md.js), read
        // off the finding so the filters don't have to find its report.
        filled._source = filled.source ?? data.source ?? null
        // Effective analyzer string for the toolbar's analyzer filter:
        // the producer when there is one, else the per-finding `type`
        // of a native dump (undefined → null, a stable sentinel for
        // the "no analyzer" bucket).
        filled._analyzer = filled._source ?? (filled.type ?? null)
        if (filled.id && !idToFinding.has(filled.id)) idToFinding.set(filled.id, filled)
        stamped.push(filled)
      }
      // Stamp the new members' group key so a later partial-dupe entry
      // in this report sees them as distinct from any previously-loaded
      // group. Reads `groups.length` BEFORE the push so the key matches
      // the slot about to be filled. The `state.reports.length` prefix
      // is THIS report's eventual index (pushed at function end) — safe
      // only because the seed loop above walks `ri <
      // state.reports.length` against the pre-push length, so this
      // report's index can't already be in the map. If a future
      // refactor pushes the report shell early (e.g. streaming),
      // snapshot the index once before this loop instead of re-reading
      // per iteration.
      if (seenMembers.length > 0) {
        // Partial-dupe: count seen members as dropped dupes (only the
        // new ones are stamped) and tie the fresh group to the existing
        // groups holding the seen members via a workspace merge.
        dupeCount += seenMembers.length
        state.workspaceMerges.push(new Set(entryMergeIds))
        for (const m of seenMembers) {
          const survivor = idToFinding.get(m.id)
          recordCorrectedVariant(survivor, name, m)
          // The app the dropped copy belonged to — the one `_`-prefixed
          // field that has to cross. `mergeDuplicateFields` leaves
          // those alone by design (they say where a copy came from,
          // and the survivor keeps its own), but this card is now the
          // only one EITHER app has, so it has to be able to answer
          // for both: see `recordAppKey` and `scopedApps` in group.js.
          recordAppKey(survivor, declaredRepo ?? name)
          // …and anything else this copy knew that the survivor
          // doesn't — the pass's verdict above all. A disagreement
          // about that verdict is reported rather than settled: the
          // layer comes off the whole set (group.js
          // mergeDuplicateFields, render.js).
          if (mergeDuplicateFields(survivor, m)) state.revalidateConflict = true
        }
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
      // `source` is set by the markdown parser ('claude-security'),
      // absent on JSON dumps — render.js uses it to swap the header
      // title for an all-MD report.
      source: data.source ?? null,
      fileName: name,
      groups,
      // Report-level repo declaration, normalised to an `owner/name`
      // slug (null when the dump names none). The header prefers it
      // over the repo its findings agree on — see headerTemplate.
      repo: declaredRepo,
      // Per-file imports / exports / hashes from the analyzer dump
      // (stamped at JSON-export time). The renderer surfaces this as a
      // separate "Tree" tab when more than one file is present.
      tree: data.tree ?? null,
      bundleHashes: data.bundleHashes ?? [],
    })
    // Pre-parse bundles the analyzer ran against so the finding-card's
    // "Code →" shortcut resolves without manually opening each bundle.
    // Only locally-stored bundles are prefetched (mismatched
    // integrities no-op inside prefetchBundleHashes). Fire-and-forget —
    // buttons surface progressively as each hash compute completes; no
    // need to block render.
    if (Array.isArray(data.bundleHashes) && data.bundleHashes.length > 0) {
      const stored = new Set((state.bundles ?? []).map((b) => b.integrity))
      for (const integrity of data.bundleHashes) {
        if (stored.has(integrity)) prefetchBundleHashes(integrity).catch(() => {})
      }
    }
    if (isFirst) {
      resetFilters()
      // What this set opens on: an auto-tuned confidence floor, and
      // then — for a REVALIDATION report, one where every group that
      // floor leaves on screen carries a row the second pass stamped —
      // Confirmed instead of the range. Over the rows the view SHOWS
      // (getShownGroups) — merged, so a partial dupe inside the report
      // counts once, and in the reader's triage bucket, since a row
      // filed away is not on screen for either face of the block. A
      // workspace asks again over all of its members once they are in
      // (switchToWorkspace).
      applyOpeningFilters(getShownGroups())
    }
    render()
  } catch (err) {
    alert(`Failed to parse ${name}: ${err.message}`)
  }
}

// Headless / automated entry point — parses + renders a JSON report
// in-process, no OPFS, no sidebar swap. The returned promise resolves
// when this file's render has run, so the `print` command (src/print.js)
// can await every input before printing. Repeated calls accumulate.
window.__loadFile = (name, content) => ingestReport(name, content)

// Headless filter override — the `print` command applies CLI
// --severity / --confidence AFTER all reports load (overriding the
// first-load auto-tuned floor when present). `severities` may be an
// array (or null/undefined to leave unchanged); empty array clears the
// filter so all severities show.
window.__setFilters = ({ severities, confMin } = {}) => {
  if (severities !== undefined && severities !== null) state.filterSeverities = new Set(severities)
  if (confMin !== undefined) state.filterConfMin = confMin
  render()
}

// Prevent default drag behavior everywhere. Drops anywhere on the page
// route through addFiles → OPFS save → switch to the last dropped; the
// drop zone keeps its hover affordance for the empty-state case.
// Global Esc → exit fullscreen (mirrors the toolbar's fullscreen-button
// toggle, giving the canonical browser "give me my chrome back" gesture).
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
// opens the native file picker — the empty surface around the prompt
// triggers nothing, so WCO mode can use it as a window drag handle (via
// body's `app-region: drag` baseline). The button gets affordance +
// keyboard handling for free; chosen files route through the same
// `addFiles` pipeline as a drop.
//
// The `<input type="file">` is created lazily on first activation and
// parked on document.body — keeping it out of index.html leaves the
// static markup focused on visible chrome, and `hidden` keeps it off
// layout. Resetting `.value = ''` after each change lets the user
// re-pick the same file (browsers suppress the change event otherwise).
let filePickerInput = null
function openFilePicker() {
  if (!filePickerInput) {
    filePickerInput = document.createElement('input')
    filePickerInput.type = 'file'
    filePickerInput.multiple = true
    filePickerInput.hidden = true
    filePickerInput.addEventListener('change', () => {
      // Snapshot BEFORE the reset. `input.files` is a live FileList —
      // the same object on every read — and `.value = ''` empties it
      // ("empty the list of selected files"). `addFiles` is async: it
      // suspends on its first await and returns a pending promise, so
      // the reset below runs before it ever reaches its loop. Handing
      // it the live list left it iterating an emptied one, and every
      // picked file was silently dropped. An array serves it just as
      // well — it only iterates the argument and reads each File.
      const files = [...filePickerInput.files]
      if (files.length > 0) addFiles(files)
      filePickerInput.value = ''
    })
    document.body.append(filePickerInput)
  }
  filePickerInput.click()
}
// Event-delegate via the drop-zone so the listener survives Lit
// re-renders if the prompt template ever becomes a component.
dropZone.addEventListener('click', (e) => {
  if (e.target.closest('.drop-prompt-action')) openFilePicker()
})
