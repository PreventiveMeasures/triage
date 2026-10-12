// How two versions' files differ, as Compare's diff has them
// (ui/view/bundle-compare-diff.js computeBundleDiff), for risk's findings
// (compare.js): the files the open version adds, and those it changes, a file
// moved to another path paired with its old one by content, as git diff -M
// pairs them (@preventive/compare compareTrees).
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
  const entries = (paths, files, side) => paths.filter(path => path.isWellFormed()).map((path, at) => ({ name: path, data: treeData(files.get(path), `${side}${at}`) }))
  const renames = compareTrees(entries(onlyBase, before, 'a'), entries(onlyOther, after, 'b'), { paths: 'keys', renameLimit: RENAME_LIMIT, lines: false })
    .filter(change => change.status === 'renamed')
  const moved = new Set(renames.map(change => change.new.path))
  for (const change of renames) changed.push({ path: change.new.path, renamedFrom: change.old.path, modified: change.similarity !== 100 })
  return { onlyOther: onlyOther.filter(path => !moved.has(path)).map(path => ({ path })), changed }
}
