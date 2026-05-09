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
import { listWorkspaces, setReportWorkspace } from './workspaces.js'
import { loadRepoUrlFor, saveRepoUrlFor } from './state.js'
import { loadPromise as triageLoadPromise } from './triage.js'

// Inlined to avoid the circular import sidebar.js → migrate-legacy.js
// → ingest.js → sidebar.js. The constant is also exported from
// ingest.js for the rest of the codebase; the two MUST stay in sync.
const LAST_FILE_KEY = 'deepview.lastFile'

let migrationPromise = null

export function migrateLegacyFilenames() {
  if (!migrationPromise) migrationPromise = run()
  return migrationPromise
}

async function run() {
  // Wait for triage to finish loading before mutating workspace
  // membership. The migration's `await setReportWorkspace(...)` calls fire
  // `onReportMembershipChanged`, which the sync layer's hydration
  // path treats as "newly attached" — `hydrateStateFromBaseState`
  // would gap-fill from chain baseState BEFORE state.* loaded the
  // user's persisted local triage, silently overriding it on the
  // local-wins resolution. Awaiting `triageLoadPromise` here closes
  // that boot-time race. Audit round-8 H4.
  try { await triageLoadPromise } catch {}
  let names
  try { names = await listFiles() } catch { return }
  const nameSet = new Set(names)
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.deepseek')) continue
    const target = name.slice(0, -'.deepseek'.length) + '.md'
    // Collision: a `.md` already exists at the target name. Leave the
    // legacy entry alone rather than overwriting user data; the
    // sidebar will show it in the default bucket until the user
    // resolves the conflict by deleting one side.
    if (nameSet.has(target)) continue
    // `content` is read inside the try (so a failed read short-circuits
    // the rename) but ALSO referenced below in the count-cache carry-over
    // path. Declare it outside so it survives the try block scope.
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

    // Last-viewed-file pointer — update so the next reload restores
    // the renamed entry rather than failing to find it.
    try {
      if (localStorage.getItem(LAST_FILE_KEY) === name) {
        localStorage.setItem(LAST_FILE_KEY, target)
      }
    } catch {}
  }

  // Workspace memberships keyed by filename — rewrite every
  // `.deepseek`-suffixed entry to its `.md` counterpart, regardless
  // of whether the corresponding OPFS file was renamed by the loop
  // above. That catches orphan references the user can't otherwise
  // shake (e.g. the `.deepseek` file is gone but the workspace JSON
  // still pins the old name), and is a no-op when the workspace
  // list is already clean. Done in one batch via the workspaces
  // module's setReportWorkspace API so persistence stays in one
  // code path.
  for (const w of listWorkspaces()) {
    for (const r of w.reports) {
      if (!r.toLowerCase().endsWith('.deepseek')) continue
      const renamed = r.slice(0, -'.deepseek'.length) + '.md'
      await setReportWorkspace(r, null)
      await setReportWorkspace(renamed, w.id)
    }
  }
}
