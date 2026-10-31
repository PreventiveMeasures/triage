// A lockfile dropped in local or e2e mode (ingest.js addFiles), shown and
// never saved: it opens alone in an editor of its own, the Code tab's pane
// with no file tree (render-bundle.js renderDroppedLockfile), on its packages
// in the lockfile viewer, as View lockfile shows them. It is kept in memory
// only, while its view is up (state.droppedLockfile); the next lockfile
// dropped, or Home, replaces it.
import { lockfileFormat } from './lockfile-view.js'

// Each drop's bundle of its own, so a lockfile read or highlighted for an
// earlier drop is never taken for this one's (lockfile-view.js reads, keyed
// by bundle and path).
let drops = 0

// The lockfiles among a drop's files, which no report reader takes: the one
// to show is the last, with the package.json dropped beside a yarn.lock, as
// only that names a Yarn 1 project's importers (lockfile-read.js). Null when
// the drop has none. `nameOf` names a file as it was saved, a download's
// ` (1)` left out; `taken` holds every file this answers for.
export function droppedLockfile(files, nameOf) {
  const lockfiles = files.filter(file => lockfileFormat(nameOf(file)) !== null)
  const lockfile = lockfiles.at(-1)
  if (!lockfile) return null
  const manifest = lockfileFormat(nameOf(lockfile)) === 'yarn' ? files.findLast(file => nameOf(file) === 'package.json') ?? null : null
  return { lockfile, manifest, taken: new Set(manifest ? [...lockfiles, manifest] : lockfiles) }
}

// The dropped lockfile as the Code tab's pane takes a bundle's file: a bundle
// of it alone, holding beside it the package.json a yarn.lock reads.
export async function readDroppedLockfile({ lockfile, manifest }, nameOf) {
  const name = nameOf(lockfile)
  const sources = [[name, await lockfile.text()]]
  if (manifest) sources.push(['package.json', await manifest.text()])
  return {
    name,
    details: {
      kind: 'sourcemap', integrity: `dropped-lockfile:${++drops}`, size: lockfile.size,
      json: { version: 3, sources: sources.map(([path]) => path), sourcesContent: sources.map(([, text]) => text) },
    },
  }
}
