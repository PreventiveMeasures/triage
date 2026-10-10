import { bundleSourcemapEdges } from '../../common/bundle-sourcemap.js'
import { bundlePkgOf, isOwnSourcePath } from './bundle-pkg-of.js'

export { bundleReasons as bundleGraphReasons } from '../../common/bundle-reasons.js'

// Named workspace modules are own code too, even when another workspace
// imports them. Use recorded directories before display-prefix stripping;
// entry points alone can also identify third-party packages.
export function bundleOwnSourcePackages(origToStripped, pkgOf, packageDirs) {
  const packages = new Set()
  for (const [orig, path] of origToStripped) {
    if (isOwnSourcePath(orig, packageDirs?.get(orig))) packages.add(pkgOf(path))
  }
  return packages
}

export function bundleEntryPackages(details, origToStripped, pkgOf) {
  const packages = new Set()
  for (const entry of details?.bundle?.entries ?? []) {
    const path = origToStripped.get(entry)
    if (path !== undefined) packages.add(pkgOf(path))
  }
  return packages
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

// Include every recorded platform/condition variant; a Metro resolution can
// be a platform -> file map instead of a single resolved path. A sourcemap
// records no imports: its edges are what bundle-sourcemap.js reads of it.
export function bundleImportsAsMap(details) {
  if (details?.kind === 'sourcemap') return bundleSourcemapEdges(details)
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

// Keep actual entry files, including entries whose source was not bundled.
// Reason-filtered bundled entries must not return as virtual roots.
export function bundleFlowEntries(details, paths, fullPaths = paths, packageDirs) {
  const imports = bundleImportsAsMap(details)
  const entries = new Set(details?.bundle?.entries ?? []), result = [], seen = new Set()
  const queue = [...entries]
  for (const orig of queue) {
    if (seen.has(orig)) continue
    seen.add(orig)
    if (paths.has(orig)) { if (entries.has(orig)) result.push({ file: paths.get(orig) }); continue }
    if (fullPaths.has(orig)) continue
    const targets = []
    for (const target of imports.get(orig) ?? []) {
      if (paths.has(target)) targets.push(paths.get(target))
      else if (!fullPaths.has(target) && imports.has(target)) { targets.push(target); queue.push(target) }
    }
    result.push({ file: orig, origFile: orig, virtual: true,
      ...(entries.has(orig) ? {} : { entry: false }),
      pkg: bundlePkgOf(orig, { packageDir: packageDirs?.get(orig) }), imports: targets })
  }
  return result
}

// App identity comes from bundle entries, not a directory spelling. Some
// bundles omit app source but retain imports from it; keep those connections
// as a virtual App root instead of discarding them with out-of-bundle files.
export function bundleLayerRoots(details, origToStripped, pkgOf, packageDirs, fullOrigToStripped = origToStripped) {
  const imports = bundleImportsAsMap(details)
  const roots = new Set()
  // Own source is a root even when entry metadata is absent.
  for (const [orig, path] of origToStripped) {
    if (bundlePkgOf(orig, { packageDir: packageDirs?.get(orig) }) === '__own__') roots.add(pkgOf(path))
  }
  for (const pkg of bundleEntryPackages(details, origToStripped, pkgOf)) roots.add(pkg)
  // Older/custom bundles may have no entry metadata and store app/ as a
  // named source module. Infer source roots from their directed imports,
  // never from dependency packages that merely happen to have no importers.
  if (roots.size === 0) {
    const sourcePackages = bundleOwnSourcePackages(origToStripped, pkgOf, packageDirs)
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
    if (bundlePkgOf(parent, { packageDir: packageDirs?.get(parent) }) !== '__own__') continue
    for (const target of targets) {
      const path = origToStripped.get(target)
      if (path !== undefined) appImports.add(pkgOf(path))
    }
  }
  if (appImports.size > 0) roots.add('__own__')
  return { roots: [...roots], appImports: [...appImports] }
}
