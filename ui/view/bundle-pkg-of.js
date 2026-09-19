// Package classifier for bundle paths. Pulled out of
// `render-bundle.js` (which drags in lit + the source-viewer + a
// circular `render.js` import, none of which this pure string logic
// needs) so it's a DOM-free leaf the bundle graph / treemap / compare
// views — and the test suite — can import on its own.

// Bucket a bundle source path into a "package":
//   - files under `node_modules/<pkg>/...` or `dependencies/<pkg>/...`
//     return `<pkg>` (scoped names included);
//   - own (first-party) source returns either its top-level directory
//     or the single `__own__` bucket, per `splitOwnDirs`.
//
// pnpm wraps each install in
// `node_modules/.pnpm/<name>@<version>/node_modules/<name>/...` —
// matching the first occurrence would bucket every dep under `.pnpm`,
// so when we hit that synthetic dir we walk past it to the inner
// `node_modules/<pkg>` segment that names the actual package.
//
// `splitOwnDirs` (default true — what the size chart, treemap, and
// compare views want) controls own-source bucketing: on, the first
// path segment becomes the group so `src/foo/a.js` buckets under `src`
// and `lib/...` under `lib` (distinct groups + colors); off, every
// first-party file collapses into the single `__own__` group the graph
// labels "own source". The bundle Graph tab passes this through from
// its "Split dirs" topbar toggle.
//
// `packageDir` is this path's authoritative stasis package directory
// (from `bundlePackageDirs` in bundle-sources.js), when one is known.
// It takes precedence over path heuristics: a module can contain its own
// `dependencies/` directory without those files becoming new packages.
// Recorded `node_modules/<pkg>` directories use the bare package name;
// other named module directories stay separate, and `.` uses own-source
// bucketing. Only bundles without this metadata use the path heuristic.
export function bundlePkgOf(path, { splitOwnDirs = true, packageDir = null } = {}) {
  if (packageDir) {
    if (packageDir !== '.') {
      const npm = packageDir.match(/(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^/]+)$/u)
      return npm && npm[1] !== '.pnpm' ? npm[1] : packageDir
    }
  } else {
    const re = /(?:^|\/)(?:node_modules|dependencies)\/(@[^/]+\/[^/]+|[^/]+)/gu
    let m
    while ((m = re.exec(path)) !== null) {
      if (m[1] !== '.pnpm') return m[1]
    }
  }
  if (splitOwnDirs) {
    const slash = path.indexOf('/')
    if (slash > 0) return path.slice(0, slash)
  }
  return '__own__'
}

// Whether splitting own source by top-level dir would actually divide
// it — i.e. the own (non-dependency) files fall into more than one
// bucket once split (multiple top-level dirs, or a top-level dir
// alongside repo-root files). False when every own file shares a
// single bucket, or there's no own source at all. The bundle Graph
// tab uses this to hide its "Split dirs" toggle when flipping it would
// be a no-op. Stops at the second distinct bucket — no need to walk
// the whole bundle once the answer is settled.
//
// `packageDirOf(path)` (optional) supplies each path's stasis package
// dir so workspace packages (PHP `vendor/<vendor>/<pkg>`, monorepo
// `packages/<name>`) are recognized as their own packages and excluded
// from the own-source tally — flipping "Split dirs" doesn't move them,
// so they must not be what makes own source look splittable.
export function ownSourceSplittable(paths, packageDirOf = null) {
  const buckets = new Set()
  for (const p of paths) {
    const packageDir = packageDirOf?.(p) ?? null
    // Dependency + workspace-package files (resolve to a package either
    // way) never move when own-source splitting toggles — skip them.
    if (bundlePkgOf(p, { splitOwnDirs: false, packageDir }) !== '__own__') continue
    buckets.add(bundlePkgOf(p, { splitOwnDirs: true, packageDir }))
    if (buckets.size > 1) return true
  }
  return false
}

// Display label for a package bucket: `__own__` is the sentinel for
// own-source (non-dependency) files, spelled out as "own source" in
// package lists and tooltips.
export function pkgLabel(pkg) {
  return pkg === '__own__' ? 'own source' : pkg
}
