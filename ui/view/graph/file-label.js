// How the graph names a file: by where it sits in its package. A DOM-free
// leaf, so the matrix model (which the Why dialog loads outside the graph)
// can name its rows without the rest of data.js.
import { pkgLabel } from '../bundle-pkg-of.js'
import { depsDirName } from '../format.js'

// Strip a file path's package anchor so callers can show
// "index.js" instead of "node_modules/foo/index.js" (npm) or
// "foo/bar.js" instead of "packages/app/foo/bar.js" (workspace package).
// Mirrors packageOf / bundlePkgOf: packages anchor on either
// `node_modules/<pkg>/` or `dependencies/<pkg>/` — try both
// regardless of the report-driven depsDirName, since the bundle
// graph runs without a report (depsDirName falls back to
// 'dependencies' even when the bundle paths use node_modules).
// For own source in the synthetic '__own__' bucket the file is
// returned as-is — there's no meaningful prefix to strip and
// consumers should fall back to the full path.
export function pkgRelative(file, pkg) {
  if (!pkg || pkg === '/' || pkg === '__own__') return file
  for (const dep of ['node_modules', 'dependencies', depsDirName()]) {
    const anchor = dep + '/' + pkg + '/'
    const idx = file.indexOf(anchor)
    if (idx >= 0) return file.slice(idx + anchor.length)
  }
  if (file.startsWith(pkg + '/')) return file.slice(pkg.length + 1)
  return file
}

// A graph node's file as views that list files by name show it: a
// dependency's by its package and its path in the package —
// `knex/lib/index.js` — however deep the install that holds it
// (`node_modules/.pnpm/knex@2.5.1_pg@8.6.0/node_modules/knex/lib/index.js`).
// Own source and workspace modules, named by their path already, keep the
// graph's own (prefix-stripped) one. The package anchors in the bundle's
// original path (`origFile`), which display stripping may have cut into.
export function fileLabelOf(node) {
  const path = node.origFile ?? node.file
  const relative = pkgRelative(path, node.pkg)
  const label = relative === path ? path : `${pkgLabel(node.pkg)}/${relative}`
  return label === path ? node.file : label
}
