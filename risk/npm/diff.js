// How two versions' files differ, as Compare's diff has them
// (ui/view/bundle-compare-diff.js computeBundleDiff), for risk's findings
// (compare.js): the files the open version adds, and those it changes, a
// build's content-hashed file paired with the one it replaces by its name
// (hashedKey), and a file moved to another path with its old one by content,
// as git diff -M pairs them (@preventive/compare compareTrees).
import { compareTrees } from '@preventive/compare'
import { bundleFilesAsMap } from '../../common/bundle-sources.js'

// git's diff.renameLimit for a package's renames: past this many removed files
// by added ones, squared, no pair is scored, and only identical content pairs
// them.
const RENAME_LIMIT = 250

// Whether two sides hold the same file: text as text, one that isn't by its
// digest (bundle-compare-diff.js sameContent).
const same = (a, b) => a === b || (a?.format === 'digest' && b?.format === 'digest' && a.digest === b.digest)

// A file's content as compareTrees reads it to find renames: its text, its
// digest for one that isn't, or else its place in its list, so that only its
// path pairs it (bundle-compare-diff.js treeData).
const treeData = (content, at) => typeof content === 'string' ? `\0text\0${content.toWellFormed()}`
  : content?.format === 'digest' ? `\0digest\0${content.digest}` : `\0none\0${at}`

// A build's content-hashed file (`assets/index-CyWAfh-p.js`, Vite's and
// Rollup's `[name]-[hash]`, webpack's `[name].[contenthash].js`) by its name
// but its hash, `assets/index\0.js`: a release renames it as its content
// changes, the same file. Null for a name whose last part before its
// extension is no hash: 8 to 32 of base64url's characters with a digit or a
// capital, as a lowercase word (`index-client.js`, `lodash.debounce.js`) has
// neither. Its hash the last 8 or more characters (`vendor-react-DQ4mN2sx`'s
// stem `vendor-react`), or, `whole`, all from its first separator on, as a
// longer hash may hold a `-` (`index-AbCdEf12-GhIjKl34`'s stem `index`): 16
// or more characters, as only a longer hash is, none of its parts a
// lowercase word, as a chunk's name is (`vendor-react-DQ4mN2sx`'s `react`),
// its length in its key, as a build writes its hashes alike.
const HASHED_NAME = /^(.+)[-.]([\w-]{8,32})((?:\.[A-Za-z\d]+)+)$/u
const WHOLE_HASHED_NAME = /^(.+?)[-.]([\w-]{8,32})((?:\.[A-Za-z\d]+)+)$/u
const WORD_PART = /(?:^|-)[a-z]{3,}(?=-|$)/u
function hashedKey(path, whole = false) {
  const at = path.lastIndexOf('/') + 1
  const [, stem, hash, extension] = (whole ? WHOLE_HASHED_NAME : HASHED_NAME).exec(path.slice(at)) ?? []
  if (!hash || !/[\dA-Z]/u.test(hash) || (whole && (hash.length < 16 || WORD_PART.test(hash)))) return null
  return `${path.slice(0, at)}${stem}\0${whole ? hash.length : ''}\0${extension}`
}

// `onlyOther`, the files the open version (`other`) adds, `{ path }` each, and
// `changed`, those it changes, `{ path, modified }`, or moves, `{ path,
// renamedFrom, modified }`, `modified` whether its content changed too; each
// version as compare.js takes one. A file that isn't text is
// told by its digest (npmBinaries), as the viewer's Compare tells it.
export function npmFilesDiff(base, other) {
  const after = bundleFilesAsMap(other), before = bundleFilesAsMap(base)
  const changed = [], onlyBase = [], onlyOther = []
  for (const [path, text] of after) {
    if (!before.has(path)) onlyOther.push(path)
    else if (!same(before.get(path), text)) changed.push({ path, modified: true })
  }
  for (const path of before.keys()) if (!after.has(path)) onlyBase.push(path)
  // A content-hashed file added where one by the same name but its hash
  // (hashedKey) is removed, one each, is that file changed, as a build
  // renames it: what it runs, how it reads and how large it is told against
  // it, not all of it new. Those its last characters don't pair, by all
  // from its first separator on.
  const moved = new Set(), named = new Set()
  for (const whole of [false, true]) {
    const hashed = paths => Map.groupBy(paths.filter(path => hashedKey(path, whole)), path => hashedKey(path, whole))
    const removed = hashed(onlyBase.filter(path => !named.has(path)))
    for (const [key, paths] of hashed(onlyOther.filter(path => !moved.has(path)))) {
      const was = removed.get(key)
      if (paths.length !== 1 || was?.length !== 1) continue
      changed.push({ path: paths[0], renamedFrom: was[0], modified: !same(before.get(was[0]), after.get(paths[0])) })
      moved.add(paths[0])
      named.add(was[0])
    }
  }
  // The rest by content, against every file removed: one paired by its name
  // may be another's too, a build's copy of it elsewhere.
  const entries = (paths, files, side) => paths.filter(path => path.isWellFormed()).map((path, at) => ({ name: path, data: treeData(files.get(path), `${side}${at}`) }))
  const renames = compareTrees(entries(onlyBase, before, 'a'), entries(onlyOther.filter(path => !moved.has(path)), after, 'b'), { paths: 'keys', renameLimit: RENAME_LIMIT, lines: false })
    .filter(change => change.status === 'renamed')
  for (const change of renames) {
    changed.push({ path: change.new.path, renamedFrom: change.old.path, modified: change.similarity !== 100 })
    moved.add(change.new.path)
  }
  return { onlyOther: onlyOther.filter(path => !moved.has(path)).map(path => ({ path })), changed }
}
