// Display paths may omit a common prefix; leaf values always retain the
// original bundle key used to open the source and look up findings.
import { bundleSourcePackageInfo } from './bundle-source-package.js'

const vendoredEcosystems = new Set(['cargo', 'composer', 'soldeer'])

export function moduleEcosystem(dir, info, sourcePaths) {
  if (info?.ecosystem !== undefined) return info.ecosystem
  // Older PHP bundles omit the ecosystem. Infer Composer only for a matching
  // vendor/name/package identity containing at least one source, all PHP.
  if (!info?.name || /(?:^|\/)vendor\/([^/]+\/[^/]+)$/u.exec(dir)?.[1] !== info.name) return undefined
  const sources = Object.entries(info.files ?? {}).filter(([path, content]) => typeof content === 'string' && (!sourcePaths || sourcePaths.has(`${dir}/${path}`)))
  return sources.length > 0 && sources.every(([path]) => /\.(?:php|phtml)$/iu.test(path)) ? 'composer' : undefined
}

export function buildBundleSourceTree(paths, originals = paths, modules = null) {
  const root = { path: '', files: new Map(), dirs: new Map() }
  for (let index = 0; index < paths.length; index++) {
    const parts = paths[index].split('/')
    let node = root
    const originalParts = originals[index].split('/')
    for (const [partIndex, name] of parts.slice(0, -1).entries()) {
      if (!node.dirs.has(name)) {
        node.dirs.set(name, {
          path: parts.slice(0, partIndex + 1).join('/'),
          sourcePath: originalParts.slice(0, -(parts.length - partIndex - 1)).join('/'),
          files: new Map(),
          dirs: new Map(),
        })
      }
      node = node.dirs.get(name)
    }
    node.files.set(parts.at(-1), originals[index])
  }
  presentDependencyDirectories(root, modules, modules ? new Set(originals) : null)
  const describe = node => {
    if (node.package) node.packageInfo = bundleSourcePackageInfo(node.package, modules?.get(node.sourcePath), node.fileCount)
    for (const child of node.dirs.values()) describe(child)
  }
  describe(root)
  return root
}

// Keep dependency/package boundaries in the tree, even when every captured
// file shares them. Only the checkout prefix belongs above the rail.
export function bundleSourceTreePrefix(prefix, modules = null, sources = null) {
  const match = /(?:^|\/)node_modules\//u.exec(prefix)
  let end = match ? match.index + (match[0].startsWith('/') ? 1 : 0) : prefix.length
  const sourcePaths = sources ? new Set(sources) : null
  for (const [dir, info] of modules ?? []) {
    const ecosystem = moduleEcosystem(dir, info, sourcePaths)
    if (!vendoredEcosystems.has(ecosystem) || !info.name || dir === '.') continue
    if (!prefix.startsWith(`${dir}/`) && !dir.startsWith(prefix)) continue
    const container = (ecosystem === 'soldeer' ? /(?:^|\/)dependencies\//u : /(?:^|\/)vendor\//u).exec(`${dir}/`)
    const boundary = container ? container.index + (container[0].startsWith('/') ? 1 : 0) : dir.lastIndexOf('/') + 1
    end = Math.min(end, boundary)
  }
  return prefix.slice(0, end)
}

function presentDependencyDirectories(node, packageModules, sourcePaths) {
  for (const child of node.dirs.values()) presentDependencyDirectories(child, packageModules, sourcePaths)
  // Count before filtering and folding so a package keeps its full source
  // count while a search shows only some of its files.
  node.fileCount = node.files.size + [...node.dirs.values()].reduce((sum, child) => sum + child.fileCount, 0)
  const info = packageModules?.get(node.sourcePath)
  const ecosystem = moduleEcosystem(node.sourcePath, info, sourcePaths)
  if (vendoredEcosystems.has(ecosystem) && info.name) {
    node.boundary = true
    node.package = { name: info.name, version: info.version, ecosystem }
    // Decide before search filtering, so a matching subset cannot hide a
    // directory that has siblings in the complete captured package.
    node.hideSrc = node.dirs.size === 1 && node.dirs.has('src')
    if (node.hideSrc) node.srcNameConflicts = new Set([...node.dirs.get('src').files.keys()].filter(name => node.files.has(name)))
  }
  if (/(?:^|\/)dependencies$/u.test(node.path) && [...node.dirs.values()].some(child => child.package?.ecosystem === 'soldeer')) node.boundary = true
  if (/(?:^|\/)vendor$/u.test(node.path)) {
    const dirs = new Map()
    for (const [name, child] of node.dirs) {
      // Composer's vendor/name wrapper is like an npm scope. Only skip a
      // namespace containing known packages, with no other files or dirs.
      if (!child.package && child.files.size === 0 && child.dirs.size > 0 && [...child.dirs.values()].every(pkg => pkg.package?.ecosystem === 'composer')) {
        node.boundary = true
        for (const [part, pkg] of child.dirs) dirs.set(`${name}/${part}`, pkg)
      } else {
        if (vendoredEcosystems.has(child.package?.ecosystem)) node.boundary = true
        dirs.set(name, child)
      }
    }
    node.dirs = dirs
  }
  if (/(?:^|\/)node_modules$/u.test(node.path)) {
    node.boundary = true
    const dirs = new Map()
    for (const [name, child] of node.dirs) {
      child.boundary = true
      if (name.startsWith('@') && child.files.size === 0 && [...child.dirs.keys()].every(part => !part.startsWith('.') && !part.startsWith('@'))) {
        for (const [part, pkg] of child.dirs) {
          pkg.boundary = true
          pkg.package ??= { name: `${name}/${part}` }
          dirs.set(`${name}/${part}`, pkg)
        }
      } else {
        if (!name.startsWith('.') && !name.startsWith('@')) child.package ??= { name }
        dirs.set(name, child)
      }
    }
    node.dirs = dirs
  }
  if (/(?:^|\/)node_modules\/\.pnpm$/u.test(node.path)) {
    node.boundary = true
    const variants = new Map()
    for (const [storeId, entry] of node.dirs) {
      entry.boundary = true
      // Fold only a complete, standard wrapper around exactly one package.
      // Sibling dependencies, patches, and unfamiliar store layouts stay real.
      if (entry.files.size > 0 || entry.dirs.size !== 1) continue
      const modules = entry.dirs.get('node_modules')
      if (!modules || modules.files.size > 0 || modules.dirs.size !== 1) continue
      const pkg = modules.dirs.values().next().value
      if (!pkg.package) continue
      const encoded = `${pkg.package.name.replace('/', '+')}@`
      if (!storeId.startsWith(encoded)) continue
      const match = /^(\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?)([_(].*)?$/iu.exec(storeId.slice(encoded.length))
      if (!match) continue
      pkg.package = { ...pkg.package, version: match[1] }
      node.dirs.set(storeId, pkg)
      const label = sourceDirectoryLabel(storeId, pkg)
      if (!variants.has(label)) variants.set(label, [])
      variants.get(label).push(pkg)
    }
    // Number equal name/version installs deterministically before filtering.
    // Their complete peer/hash contexts remain in the physical-path tooltip.
    for (const installs of variants.values()) {
      if (installs.length < 2) continue
      installs.sort((a, b) => a.path.localeCompare(b.path))
      for (const [index, pkg] of installs.entries()) pkg.package.variant = index + 1
    }
  }
  const installs = dependencyRootEcosystem(node)
  if (installs) node.dependencyRoot = installs
  return node
}

// The ecosystem a directory dependencies install in holds, for its icon:
// npm's for node_modules; for vendor or dependencies, the one its packages
// are all of (Composer's, Cargo's, Soldeer's), none where they are of none or
// several.
function dependencyRootEcosystem(node) {
  if (/(?:^|\/)node_modules$/u.test(node.path)) return 'npm'
  if (!/(?:^|\/)(?:vendor|dependencies)$/u.test(node.path)) return null
  const ecosystems = new Set([...node.dirs.values()].map(child => child.package?.ecosystem).filter(Boolean))
  return ecosystems.size === 1 ? [...ecosystems][0] : null
}

export function sourceDirectoryLabel(name, node) {
  const pkg = node.package
  return pkg ? `${pkg.name}${pkg.version ? `${vendoredEcosystems.has(pkg.ecosystem) ? ' - ' : '@'}${pkg.version}` : ''}` : name
}

// Filter the presentation built from ALL files: a search must not make an
// unsafe pnpm wrapper look safe or renumber variants as siblings disappear.
// Match both the original path and the package name/version shown in the rail.
export function filterBundleSourceTree(tree, query, prefix = '', accept = null) {
  const q = query.toLowerCase()
  const filter = (node, displayPath, hiddenSrcParent = null) => {
    const files = new Map([...node.files].filter(([name, full]) => {
      const path = prefix && full.startsWith(prefix) ? full.slice(prefix.length) : full
      const displayedName = hiddenSrcParent?.srcNameConflicts.has(name) ? `src/${name}` : name
      return (!accept || accept(full)) && (path.toLowerCase().includes(q) || `${displayPath}/${displayedName}`.toLowerCase().includes(q))
    }))
    const dirs = new Map()
    for (const [name, child] of node.dirs) {
      const hiddenSrc = node.hideSrc && name === 'src'
      const filtered = filter(child, hiddenSrc ? displayPath : `${displayPath}/${sourceDirectoryLabel(name, child)}`, hiddenSrc ? node : null)
      if (filtered) dirs.set(name, filtered)
    }
    return files.size > 0 || dirs.size > 0 ? { ...node, files, dirs } : null
  }
  return q || accept ? filter(tree, '') : tree
}

// Only fold unbranched, file-free directories. A conservative character
// budget leaves space for indentation and issue chips in the 320px rail;
// the three-segment limit keeps even very short paths easy to scan. Package
// roots are semantic boundaries; only node_modules/.pnpm shares a group row.
export function compactSourceDirectory(name, node, depth) {
  const names = [name]
  if (node.hideSrc && node.dirs.has('src')) {
    const src = node.dirs.get('src')
    const files = new Map(node.files)
    for (const [file, original] of src.files) files.set(node.srcNameConflicts.has(file) ? `src/${file}` : file, original)
    return { names, node: { ...node, sourcePath: src.sourcePath, files, dirs: src.dirs } }
  }
  if (name === 'node_modules' && node.files.size === 0 && node.dirs.size === 1 && node.dirs.has('.pnpm')) {
    return { names: ['node_modules', '.pnpm'], node: node.dirs.get('.pnpm') }
  }
  const limit = Math.max(12, 24 - Math.max(0, depth - 1) * 2)
  while (!node.boundary && node.files.size === 0 && node.dirs.size === 1 && names.length < 3) {
    const [nextName, nextNode] = node.dirs.entries().next().value
    if (nextNode.boundary || [...names, nextName].join('/').length > limit) break
    names.push(nextName)
    node = nextNode
  }
  return { names, node }
}

// The top-most package.json of `paths` outside node_modules, the first in
// path order among those as high: a project's own manifest, its app's or
// workspace's where its root holds none, as Code opens one by default. Null
// where there is none.
export function shallowestPackageJson(paths) {
  let depth = Infinity, found = null
  for (const path of paths) {
    if (!/(?:^|\/)package\.json$/u.test(path) || /(?:^|\/)node_modules\//u.test(path)) continue
    const at = path.split('/').length
    if (at < depth || (at === depth && path.localeCompare(found) < 0)) [depth, found] = [at, path]
  }
  return found
}

// Rows a file tree shows before its directories stop opening by default.
export const DEFAULT_OPEN_ROWS = 40
// Where dependencies install, as isOwnSourcePath (bundle-pkg-of.js) reads it.
const DEPENDENCY_ROOT = /^(?:node_modules|dependencies|vendor)$/u

// The directories a file tree (Code's, Compare's) opens by default, by path:
// from its root's rows, each next level of directories as long as the rows
// it shows then stay within `rows`. Where a level holds dependencies (under
// node_modules, dependencies or vendor) that would take it past them, its
// own directories alone open, the dependencies staying shut from then on.
// Rows are counted as the tree draws them, a compact row as one
// (compactSourceDirectory). The directories above the file shown open as
// well, whatever these are. Kept for the tree.
const defaultsByTree = new WeakMap()
export function defaultOpenDirectories(tree, rows = DEFAULT_OPEN_ROWS) {
  const kept = defaultsByTree.get(tree)
  if (kept?.rows === rows) return kept.open
  const open = new Set()
  const rowsOf = node => node.dirs.size + node.files.size
  const below = (node, depth, deps) => [...node.dirs].map(([name, child]) => ({ child, depth, deps: deps || DEPENDENCY_ROOT.test(name), name }))
  let level = below(tree, 0, false), shown = rowsOf(tree)
  while (level.length > 0) {
    const opened = level.map(entry => ({ ...entry, inner: compactSourceDirectory(entry.name, entry.child, entry.depth).node }))
    const cost = entries => entries.reduce((sum, { inner }) => sum + rowsOf(inner), 0)
    const own = opened.filter(entry => !entry.deps)
    const chosen = shown + cost(opened) <= rows ? opened : own.length < opened.length && shown + cost(own) <= rows ? own : null
    if (!chosen) break
    shown += cost(chosen)
    for (const { child } of chosen) open.add(child.path)
    level = chosen.flatMap(({ inner, depth, deps }) => below(inner, depth + 1, deps))
  }
  defaultsByTree.set(tree, { rows, open })
  return open
}

// Native summary/button semantics keep Enter, Space, and Tab working.
// Arrow keys navigate only visible rows; opening a file remains explicit.
export function navigateBundleSourceTree(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const tree = event.currentTarget
  const row = event.target.closest('summary, .bundle-code-tree-link')
  if (!row || !tree.contains(row)) return
  const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']
  if (!keys.includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  const rows = [...tree.querySelectorAll('summary, .bundle-code-tree-link')].filter(item => {
    let parent = item.parentElement
    if (item.tagName === 'SUMMARY') parent = parent.parentElement
    return !parent.closest('details:not([open])')
  })
  const index = rows.indexOf(row)
  const directory = row.tagName === 'SUMMARY' ? row.parentElement : null
  let next = row
  if (event.key === 'ArrowDown') next = rows[Math.min(index + 1, rows.length - 1)]
  if (event.key === 'ArrowUp') next = rows[Math.max(index - 1, 0)]
  if (event.key === 'Home') next = rows[0]
  if (event.key === 'End') next = rows.at(-1)
  if (event.key === 'ArrowRight' && directory) {
    if (directory.open) next = rows[index + 1] ?? row
    else row.click()
  }
  if (event.key === 'ArrowLeft') {
    if (directory?.open) row.click()
    else next = (directory ?? row).parentElement.closest('details')?.querySelector('summary') ?? row
  }
  next?.focus()
}

export function compareDirectoryOrder([a, an], [b, bn]) {
  return sourceDirectoryLabel(a, an).localeCompare(sourceDirectoryLabel(b, bn)) || an.path.localeCompare(bn.path)
}

// Files in the order the tree shows them, for the default pick and for
// stepping between files.
export function orderedComparisonFiles(node, depth = 0, out = []) {
  for (const [name, child] of [...node.dirs.entries()].toSorted(compareDirectoryOrder)) orderedComparisonFiles(compactSourceDirectory(name, child, depth).node, depth + 1, out)
  for (const [, full] of [...node.files.entries()].toSorted(([a], [b]) => a.localeCompare(b))) out.push(full)
  return out
}
