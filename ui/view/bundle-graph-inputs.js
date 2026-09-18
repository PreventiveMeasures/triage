import { bundlePkgOf } from './bundle-pkg-of.js'

// Reason metadata attributes files to consumers (run, build plugins, etc.).
// It is informational and can be absent on older/single-consumer bundles.
export function bundleGraphReasons(details, sourcePaths) {
  const reasons = new Map()
  const raw = details?.kind === 'stasis' ? details.bundle?.reason : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reasons
  const paths = new Set(sourcePaths)
  for (const [reason, files] of Object.entries(raw).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!reason || !Array.isArray(files)) continue
    const present = new Set(files.filter((file) => typeof file === 'string' && paths.has(file)))
    if (present.size > 0) reasons.set(reason, present)
  }
  return reasons
}

export function filterBundleGraphReason(tree, origToStripped, reasons, requested) {
  // A hidden selector must never keep filtering after switching bundles.
  const selected = reasons.has(requested) ? requested : null
  if (selected === null) return { tree, origToStripped, selected }
  const paths = new Map([...origToStripped].filter(([orig]) => reasons.get(selected).has(orig)))
  const files = new Set(paths.values())
  const filtered = Object.fromEntries([...files].map((file) => [file, {
    ...tree[file], imports: (tree[file].imports ?? []).filter((target) => files.has(target)),
  }]))
  return { tree: filtered, origToStripped: paths, selected }
}

// Prefix stripping is for display only: removing node_modules/ must not turn
// dependencies into own source. Own-source directory splitting still uses
// the compact display path, preserving the ordinary graph's grouping.
export function bundleGraphPackageOf(path, originalPath, { splitOwnDirs = false, packageDir } = {}) {
  const pkg = bundlePkgOf(originalPath, { splitOwnDirs: false, packageDir })
  return pkg === '__own__' ? bundlePkgOf(path, { splitOwnDirs, packageDir }) : pkg
}

// Include every recorded platform/condition variant; a Metro resolution can
// be a platform -> file map instead of a single resolved path.
export function bundleImportsAsMap(details) {
  const result = new Map()
  if (details?.kind !== 'stasis' || !details.bundle) return result
  for (const byParent of details.bundle.imports.values()) {
    for (const [parent, specMap] of byParent) {
      if (!result.has(parent)) result.set(parent, new Set())
      for (const resolved of specMap.values()) {
        const targets = typeof resolved === 'string' ? [resolved] : resolved instanceof Map ? resolved.values() : []
        for (const target of targets) if (typeof target === 'string') result.get(parent).add(target)
      }
    }
  }
  return result
}

// App identity comes from bundle entries, not a directory spelling. Some
// bundles omit app source but retain imports from it; keep those connections
// as a virtual App root instead of discarding them with out-of-bundle files.
export function bundleLayerRoots(details, origToStripped, pkgOf, packageDirs, fullOrigToStripped = origToStripped) {
  const imports = bundleImportsAsMap(details)
  const roots = new Set()
  // Split dirs changes the app's display buckets, not its dependency depth.
  // Identify own source before splitting so every app directory stays at 0,
  // even when only one directory contains an entry or imports another one.
  for (const [orig, path] of origToStripped) {
    if (bundlePkgOf(orig, { splitOwnDirs: false, packageDir: packageDirs?.get(orig) }) === '__own__') roots.add(pkgOf(path))
  }
  for (const entry of details?.bundle?.entries ?? []) {
    const path = origToStripped.get(entry)
    if (path !== undefined) roots.add(pkgOf(path))
  }
  // Older/custom bundles may have no entry metadata and store app/ as a
  // named source module. Infer source roots from their directed imports,
  // never from dependency packages that merely happen to have no importers.
  if (roots.size === 0) {
    const sourcePackages = new Set()
    for (const [orig, path] of origToStripped) {
      const dir = packageDirs?.get(orig)
      if (dir && dir !== '.' && !/(?:^|\/)(?:node_modules|dependencies|vendor)(?:\/|$)/u.test(dir)) sourcePackages.add(pkgOf(path))
    }
    const importedSources = new Set()
    for (const [parent, targets] of imports) {
      const path = origToStripped.get(parent)
      if (path === undefined || !sourcePackages.has(pkgOf(path))) continue
      for (const target of targets) {
        const depPath = origToStripped.get(target)
        if (depPath !== undefined && pkgOf(path) !== pkgOf(depPath)) importedSources.add(pkgOf(depPath))
      }
    }
    for (const id of sourcePackages) if (!importedSources.has(id)) roots.add(id)
  }
  const appImports = new Set()
  for (const [parent, targets] of imports) {
    // Filtered-out bundled files must not regain their edges through a
    // virtual App node. Only genuinely unbundled source qualifies here.
    if (fullOrigToStripped.has(parent)) continue
    if (bundlePkgOf(parent, { splitOwnDirs: false, packageDir: packageDirs?.get(parent) }) !== '__own__') continue
    for (const target of targets) {
      const path = origToStripped.get(target)
      if (path !== undefined) appImports.add(pkgOf(path))
    }
  }
  if (appImports.size > 0) roots.add('__own__')
  return { roots: [...roots], appImports: [...appImports] }
}
