// The graph a lockfile's packages make, as the bundle graph viewer takes one
// (buildGraphFromPrep in ui/graph.js): each installed copy a member node of
// its package, as a bundle's files are, so the viewer's package altitude
// shows the packages and what depends on what. Readers aside, a lockfile is
// taken as:
//
//   id        — which lockfile, at which revision: a kept pan and zoom never
//               carries over to another (graph.viewId)
//   importers — by directory from the lockfile's, `.` for its own: the
//               project and its workspaces, { version?, dependencies }
//   packages  — by key: each copy installed, { name, version?, dependencies }
//
// Dependencies are targets, as @preventive/lockfile's readers write them: a
// key of `packages`, or `link:` and a key of `importers` (now and then of
// `packages`). One leading nowhere, as a bundled one, is left out.

// The node of an importer is the target that links to it, which no key of
// `packages` is. Its package is its directory, as a bundle's workspace module
// is (bundlePkgOf), and the lockfile's own one is own source.
const importerNode = dir => `link:${dir}`
const importerPackage = dir => dir === '.' ? '__own__' : dir

export function lockfileGraphPrep(lockfile) {
  const importers = Object.entries(lockfile?.importers ?? {})
  const packages = Object.entries(lockfile?.packages ?? {})
  const pkgOf = new Map([...importers.map(([dir]) => [importerNode(dir), importerPackage(dir)]),
    ...packages.map(([key, pkg]) => [key, pkg.name])])
  const info = new Map([...importers.map(([dir, importer]) => [importerNode(dir), importer]), ...packages])
  const nodeOf = target => pkgOf.has(target) ? target : target.startsWith('link:') && pkgOf.has(target.slice(5)) ? target.slice(5) : null
  // Keys are the lockfile's, which no prototype's may shadow.
  const treeData = Object.create(null)
  for (const [file, { dependencies }] of info) {
    treeData[file] = { imports: [...new Set(dependencies.map(nodeOf).filter(target => target !== null && target !== file))] }
  }
  const files = [...info.keys()]
  if (files.length === 0) return null
  const roots = [...new Set(importers.map(([dir]) => importerPackage(dir)))]
  return {
    treeData, files, ownCounts: new Map(), transitiveCounts: null,
    severitySets: new Map(), colorSets: new Map(), fileFindings: new Map(),
    options: { pkgOf: file => pkgOf.get(file), packageInfoOf: file => ({ version: info.get(file).version }) },
    // No file altitude: the viewer stays at its package one, where a
    // package's members are its copies (see `packagesOnly` in graph.js).
    packagesOnly: true,
    // The bundle layouts, of which a lockfile's view offers those it can
    // fill (LOCKFILE_LAYOUTS). Its importers lead Dependencies and Matrix,
    // and Package flow flows from every one of them, depended on or not.
    supportsLayers: true,
    layerRoots: { roots, appImports: [] },
    flowEntries: importers.map(([dir]) => ({ file: importerNode(dir) })),
    ownSourcePackages: new Set(roots),
    entryPackages: new Set(roots),
    ownSourceFiles: new Set(importers.map(([dir]) => importerNode(dir))),
    hasIssues: false,
    issuesShown: false,
    viewId: lockfile.id ?? null,
  }
}
