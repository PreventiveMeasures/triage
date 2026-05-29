// One-time migration of OPFS entries left behind by an earlier build.
// That build briefly renamed DeepSec markdown drops to `.deepseek` so
// the sidebar could bucket them by extension; the file itself is
// still plain `.md` content. We now keep the original extension and
// detect the source from content via the counts cache, which leaves
// pre-existing `.deepseek` entries stuck in the wrong bucket (and
// without their DeepSec icon, since `groupOf` no longer special-cases
// the extension). Walk OPFS once at sidebar boot and rename each
// such file back to `.md`, carrying the count cache, workspace
// membership, repo URL, and last-viewed-file pointer along with it.
//
// Idempotent: a second pass finds no `.deepseek` entries and does
// nothing. Wrapped in a module-level promise so concurrent
// `renderSidebar` calls share a single migration and downstream code
// only sees the post-migration filesystem.
import { deleteFile, listFiles, readFile, saveFile } from './storage.js'
import { analyzeContent, getCount, removeCount, setCount } from './counts.js'
import { addReportToWorkspace, listWorkspaces, removeReportFromWorkspace } from './workspaces.js'
import { loadRepoUrlFor, saveRepoUrlFor, state } from './state.ts'
import { saveTriage, loadPromise as triageLoadPromise } from './triage.js'
import { getItem as getSecureItem, setItem as setSecureItem } from './secure-storage.js'
import { setReportIgnored } from './triage-entry.ts'

// Inlined to avoid the circular import sidebar.js → migrate-legacy.js
// → ingest.js → sidebar.js. The constant is also exported from
// ingest.js for the rest of the codebase; the two MUST stay in sync.
const LAST_FILE_KEY = 'deepview.lastFile'

let migrationPromise = null

export function migrateLegacyFilenames() {
  if (!migrationPromise) {
    migrationPromise = run()
    // Clear the memo on rejection so transient OPFS failures don't
    // poison the page session — next call retries rather than
    // resolving immediately as "complete". Run() itself catches
    // expected per-file errors; only an unhandled throw (e.g.
    // listFiles failure on a flaky OPFS) reaches here. Audit
    // round-12 M-C.
    migrationPromise.catch(() => { migrationPromise = null })
  }
  return migrationPromise
}

async function run() {
  // Wait for triage to finish loading before mutating workspace
  // membership. The migration's membership-mutation calls fire
  // `onReportMembershipChanged`, which the sync layer's hydration
  // path treats as "newly attached" — `hydrateStateFromBaseState`
  // would gap-fill from chain baseState BEFORE state.* loaded the
  // user's persisted local triage, silently overriding it on the
  // local-wins resolution. Awaiting `triageLoadPromise` here closes
  // that boot-time race. Audit round-8 H4.
  try { await triageLoadPromise } catch {}
  // Don't catch a `listFiles()` failure here — let it reject so the
  // wrapper's memo-clear (above) lets the next call retry. Catching
  // would memoize a "successful" no-op and strand the user with
  // stale .deepseek buckets for the page session. Audit round-12 M-C.
  const names = await listFiles()
  const nameSet = new Set(names)
  // Pre-rename snapshot of the OPFS file list. Used by the
  // workspace-membership rewrite at the end to distinguish
  // "rename succeeded" / "true orphan" (rewrite to .md) from
  // "collision" / "rename-fail" (leave membership pointed at the
  // still-extant .deepseek). Audit round-12 M-E.
  const filesOnDiskAtStart = new Set(names)
  // Tracks `.deepseek` names that the per-file loop successfully
  // renamed to .md. Same membership-rewrite predicate input.
  const renamed = new Set()
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.deepseek')) continue
    const target = name.slice(0, -'.deepseek'.length) + '.md'
    // Collision: a `.md` already exists at the target name. Leave the
    // legacy entry alone rather than overwriting user data; the
    // sidebar will show it in the default bucket until the user
    // resolves the conflict by deleting one side.
    if (nameSet.has(target)) continue
    // Declared outside the try so the count-cache carry-over below
    // can reuse it, while a failed read still short-circuits the rename.
    let content
    try {
      content = await readFile(name)
      await saveFile(target, content)
      await deleteFile(name)
    } catch (err) {
      console.warn(`migrate: failed to rename ${name} -> ${target}`, err)
      continue
    }
    nameSet.delete(name)
    nameSet.add(target)
    renamed.add(name)

    // Carry over the count cache. If nothing was cached, populate
    // the new entry from the file content so the sidebar bucket and
    // badge land immediately rather than waiting for the lazy
    // backfill.
    const oldCount = getCount(name)
    removeCount(name)
    if (oldCount === undefined) {
      const { count, source } = analyzeContent(content)
      setCount(target, count, source)
    } else {
      const { source } = analyzeContent(content)
      setCount(target, oldCount, source)
    }

    // Per-report repo URL is also keyed by filename.
    const repoUrl = loadRepoUrlFor(name)
    if (repoUrl) {
      saveRepoUrlFor(name, '')
      saveRepoUrlFor(target, repoUrl)
    }

    // Per-report ignore is also filename-keyed: each triage entry
    // carries an `ignoredReports: [reportName, ...]` list. Without
    // rewriting `name` → `target` across those lists (and re-persisting
    // via saveTriage), ignored findings reappear in the renamed report.
    // Audit round-12 M-D.
    let renamedIgnores = false
    for (const [id, entry] of [...state.triage]) {
      if (!entry.ignoredReports?.includes(name)) continue
      setReportIgnored(state.triage, id, name, false)
      setReportIgnored(state.triage, id, target, true)
      renamedIgnores = true
    }
    if (renamedIgnores) await saveTriage()

    // Last-viewed-file pointer — update so the next reload restores
    // the renamed entry rather than failing to find it. Goes through
    // secure-storage so the encrypted form is preserved.
    if (getSecureItem(LAST_FILE_KEY) === name) {
      try { await setSecureItem(LAST_FILE_KEY, target) } catch {}
    }
  }

  // Workspace memberships keyed by filename. Three cases for a
  // `.deepseek` entry in `w.reports`:
  //   (a) we renamed it just now             → rewrite to .md
  //   (b) it's NOT on disk (true orphan)     → rewrite to .md
  //   (c) collision / rename-fail (still on
  //       disk as .deepseek)                 → leave alone
  //
  // The pre-fix shape rewrote (c) too, silently moving membership
  // off the still-extant `.deepseek` and (in the collision case)
  // grafting it onto an unrelated existing `.md`, or (in the
  // rename-fail case) pointing the workspace at a `.md` that
  // doesn't exist on disk while the actual `.deepseek` becomes
  // workspace-orphaned. Audit round-12 M-E.
  // Per-workspace scoped detach + additive attach (NOT
  // `setReportWorkspace`, which is documented as a "single-owner move"
  // and strips the identifier from EVERY workspace before attaching).
  // The outer loop iterates a stale snapshot from `listWorkspaces()`,
  // so a `.deepseek` listed in multiple workspaces would lose every
  // claim except the last iterated workspace's — the prior iteration's
  // just-added `.md` reference gets stripped by the next iteration's
  // global detach. Audit round-12 M-E follow-up.
  for (const w of listWorkspaces()) {
    for (const r of w.reports) {
      if (!r.toLowerCase().endsWith('.deepseek')) continue
      // Skip case (c): still on disk as `.deepseek`, didn't rename.
      if (!renamed.has(r) && filesOnDiskAtStart.has(r)) continue
      const newName = r.slice(0, -'.deepseek'.length) + '.md'
      await removeReportFromWorkspace(r, w.id)
      await addReportToWorkspace(newName, w.id)
    }
  }
}
