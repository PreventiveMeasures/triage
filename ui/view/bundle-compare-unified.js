// A comparison whole as one unified diff, for Review's Files rail to copy
// (npm-review-view.js): what `diff -ruN` prints of the two versions' trees,
// which `git apply` and `patch -p1` both take. Each file's hunks
// (@preventive/diff, as GNU diff -u has them) under `--- a/<path>` and
// `+++ b/<path>`, `/dev/null` for the side a file is missing from, a tab
// ending a path with a space in it, as git ends one, for patch to read it
// whole. The format has no renames, and git's rename headers would need a
// mode for each file added, which these files don't carry: a file at
// another path in the base is removed there and added here. An empty file
// added or removed is its two header lines alone, which neither tool
// applies, as diff -N prints nothing for one.
//
// Only of text: a file not text on a side it is on (not UTF-8, or holding a
// NUL: a digest in its place, npm-packages.ts npmFileText), or holding a
// character the viewer boxes (control-chars.js), or a path a header can't
// hold (a control character, or one boxed), leaves none, as its copy would
// carry what the page never shows.
import { diff } from '@preventive/diff'
import { hasShownControls } from './control-chars.js'

const CONTROL = /\p{Cc}/u

// A side's path as its header names it.
const named = (prefix, path) => (path === null ? '/dev/null' : `${prefix}/${path}${path.includes(' ') ? '\t' : ''}`)

// A row of comparisonFileList (bundle-compare-files.js) as the diff's
// sections: `{ from, to, before, after }`, `from` or `to` null where the file
// is not on that side; none for one whose contents read the same.
function sectionsOf({ path, kind, basePath = path, modified, before, after }) {
  const added = { from: null, to: path, before: '', after }, removed = { from: basePath, to: null, before, after: '' }
  if (kind === 'added') return [added]
  if (kind === 'removed') return [removed]
  if (basePath !== path) return [removed, added]
  return kind === 'repointed' || modified === false || before === after ? [] : [{ from: path, to: path, before, after }]
}

const textual = text => typeof text === 'string' && !hasShownControls(text)
const headed = path => path === null || (!CONTROL.test(path) && !hasShownControls(path))

// The sections of the diff of `rows` (comparisonFileList's, in the order to
// write them), or null where it isn't of text alone.
export function unifiedSections(rows) {
  const sections = rows.flatMap(sectionsOf)
  return sections.every(({ from, to, before, after }) => headed(from) && headed(to) && textual(before) && textual(after)) ? sections : null
}

// The diff `sections` (unifiedSections) make.
export function unifiedDiff(sections) {
  return sections.map(({ from, to, before, after }) => `--- ${named('a', from)}\n+++ ${named('b', to)}\n${diff(before, after)}`).join('')
}
