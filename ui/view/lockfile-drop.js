// A lockfile dropped in local or e2e mode (ingest.js addFiles), shown and
// never saved: it opens alone in an editor of its own, the Code tab's pane
// with no file tree (render-bundle.js renderDroppedLockfile), on its packages
// in the lockfile viewer, as View lockfile shows them. It is kept in memory
// only, while its view is up (state.droppedLockfile); the next lockfile
// dropped, or Home, replaces it.
import { lockfileFormat, lockfileManifest } from './lockfile-view.js'
import { beginViewNavigation, currentViewGeneration } from './view-navigation.js'

// Each drop's bundle of its own, so a lockfile read or highlighted for an
// earlier drop is never taken for this one's (lockfile-view.js reads, keyed
// by bundle and path).
let drops = 0

// The lockfiles among a drop's files, which no report reader takes: the one
// to show is the last, with the manifest dropped beside it that names its
// project's dependencies where the lockfile doesn't, a yarn.lock's
// package.json or a composer.lock's composer.json (lockfileManifest). Null
// when the drop has none. `nameOf` names a file as it was saved, a
// download's ` (1)` left out; `taken` holds every file this answers for.
export function droppedLockfile(files, nameOf) {
  const lockfiles = files.filter(file => lockfileFormat(nameOf(file)) !== null)
  const lockfile = lockfiles.at(-1)
  if (!lockfile) return null
  const manifestName = lockfileManifest(lockfileFormat(nameOf(lockfile)))
  const manifest = manifestName === null ? null : files.findLast(file => nameOf(file) === manifestName) ?? null
  return { lockfile, manifest, taken: new Set(manifest ? [...lockfiles, manifest] : lockfiles) }
}

// Read a dropped lockfile and `show` it, as the page's latest navigation from
// the drop on: whatever the page goes to while it is read (Home, the sidebar,
// a later drop, however soon its own read ends) keeps the screen, and `fail`
// tells of a read that failed only while the drop is still the latest.
export async function openDroppedLockfile(dropped, nameOf, show, fail) {
  const navigation = beginViewNavigation()
  const latest = () => navigation === currentViewGeneration()
  let lockfile
  try {
    lockfile = await readDroppedLockfile(dropped, nameOf)
  } catch (err) {
    if (latest()) fail(err)
    return false
  }
  if (!latest()) return false
  await show(lockfile)
  return true
}

// The dropped lockfile as the Code tab's pane takes a bundle's file: a bundle
// of it alone, holding beside it the manifest its reader takes.
export async function readDroppedLockfile({ lockfile, manifest }, nameOf) {
  const name = nameOf(lockfile)
  const sources = [[name, await lockfile.text()]]
  if (manifest) sources.push([lockfileManifest(lockfileFormat(name)), await manifest.text()])
  return {
    name,
    details: {
      kind: 'sourcemap', integrity: `dropped-lockfile:${++drops}`, size: lockfile.size,
      json: { version: 3, sources: sources.map(([path]) => path), sourcesContent: sources.map(([, text]) => text) },
    },
  }
}
