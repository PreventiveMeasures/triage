// Display paths may omit a common prefix; leaf values always retain the
// original bundle key used to open the source and look up findings.
const vendoredEcosystems = new Set(['cargo', 'composer'])

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
  return presentDependencyDirectories(root, modules)
}

// Keep dependency/package boundaries in the tree, even when every captured
// file shares them. Only the checkout prefix belongs above the rail.
export function bundleSourceTreePrefix(prefix, modules = null) {
  const match = /(?:^|\/)node_modules\//u.exec(prefix)
  let end = match ? match.index + (match[0].startsWith('/') ? 1 : 0) : prefix.length
  for (const [dir, info] of modules ?? []) {
    if (!vendoredEcosystems.has(info.ecosystem) || !info.name || dir === '.' || !prefix.startsWith(`${dir}/`)) continue
    const vendor = /(?:^|\/)vendor\//u.exec(`${dir}/`)
    const boundary = vendor ? vendor.index + (vendor[0].startsWith('/') ? 1 : 0) : dir.lastIndexOf('/') + 1
    end = Math.min(end, boundary)
  }
  return prefix.slice(0, end)
}

function presentDependencyDirectories(node, packageModules) {
  for (const child of node.dirs.values()) presentDependencyDirectories(child, packageModules)
  const info = packageModules?.get(node.sourcePath)
  if (vendoredEcosystems.has(info?.ecosystem) && info.name) {
    node.boundary = true
    node.package = { name: info.name, version: info.version, ecosystem: info.ecosystem }
    // Decide before search filtering, so a matching subset cannot hide a
    // directory that has siblings in the complete captured package.
    node.hideSrc = node.dirs.size === 1 && node.dirs.has('src')
    if (node.hideSrc) node.srcNameConflicts = new Set([...node.dirs.get('src').files.keys()].filter(name => node.files.has(name)))
  }
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
  return node
}

export function sourceDirectoryLabel(name, node) {
  const pkg = node.package
  return pkg ? `${pkg.name}${pkg.version ? `${vendoredEcosystems.has(pkg.ecosystem) ? ' - ' : '@'}${pkg.version}` : ''}` : name
}

// Filter the presentation built from ALL files: a search must not make an
// unsafe pnpm wrapper look safe or renumber variants as siblings disappear.
// Match both the original path and the package name/version shown in the rail.
export function filterBundleSourceTree(tree, query, prefix = '') {
  const q = query.toLowerCase()
  const filter = (node, displayPath, hiddenSrcParent = null) => {
    const files = new Map([...node.files].filter(([name, full]) => {
      const path = prefix && full.startsWith(prefix) ? full.slice(prefix.length) : full
      const displayedName = hiddenSrcParent?.srcNameConflicts.has(name) ? `src/${name}` : name
      return path.toLowerCase().includes(q) || `${displayPath}/${displayedName}`.toLowerCase().includes(q)
    }))
    const dirs = new Map()
    for (const [name, child] of node.dirs) {
      const hiddenSrc = node.hideSrc && name === 'src'
      const filtered = filter(child, hiddenSrc ? displayPath : `${displayPath}/${sourceDirectoryLabel(name, child)}`, hiddenSrc ? node : null)
      if (filtered) dirs.set(name, filtered)
    }
    return files.size > 0 || dirs.size > 0 ? { ...node, files, dirs } : null
  }
  return q ? filter(tree, '') : tree
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
