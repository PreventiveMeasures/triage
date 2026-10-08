// Package classifier for bundle paths. Pulled out of
// `render-bundle.js` (which drags in lit + the source-viewer + a
// circular `render.js` import, none of which this pure string logic
// needs) so it's a DOM-free leaf the bundle graph / treemap / compare
// views — and the test suite — can import on its own.

// Bucket a bundle source path into a "package":
//   - files under `node_modules/<pkg>/...` or `dependencies/<pkg>/...`
//     return `<pkg>` (scoped names included);
//   - own (first-party) source returns the single `__own__` bucket.
//
// pnpm wraps each install in
// `node_modules/.pnpm/<name>@<version>/node_modules/<name>/...` —
// matching the first occurrence would bucket every dep under `.pnpm`,
// so when we hit that synthetic dir we walk past it to the inner
// `node_modules/<pkg>` segment that names the actual package.
//
// `packageDir` is this path's authoritative stasis package directory
// (from `bundlePackageDirs` in bundle-sources.js), when one is known.
// It takes precedence over path heuristics: a module can contain its own
// `dependencies/` directory without those files becoming new packages.
// Recorded `node_modules/<pkg>` directories use the bare package name;
// other named module directories stay separate under their full dir, and
// `.` identifies own source. Only bundles without this metadata use
// the path heuristic.
//
// The result is the package's identity — what files, sizes and edges are
// grouped by — so a vendored package keeps its dir here: Cargo's
// `vendor/log` is not npm's `log`, and one bundle can carry both. It is
// `pkgLabel` that shows it by name.
export function bundlePkgOf(path, { packageDir = null } = {}) {
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
  return '__own__'
}

// First-party code: own source, and named workspace modules (a recorded
// package dir outside `node_modules/`, `dependencies/` and `vendor/`).
// Workspace modules stay separate packages in `bundlePkgOf`, but are
// own code even when another workspace imports them.
export function isOwnSourcePath(path, packageDir = null) {
  return bundlePkgOf(path, { packageDir }) === '__own__'
    || Boolean(packageDir) && !/(?:^|\/)(?:node_modules|dependencies|vendor)(?:\/|$)/u.test(packageDir)
}

// Search order for the bundle Code rail and Search tab: own code
// first, then dependencies, each keeping the order `paths` came in.
// Matches in the bundle's own code are usually what a search is after,
// and package code shouldn't push them past the result caps.
// `packageDirs` is `bundlePackageDirs` output, or null for the path
// heuristic alone.
export function ownSourceFirst(paths, packageDirs = null) {
  const own = []
  const deps = []
  for (const path of paths) (isOwnSourcePath(path, packageDirs?.get(path)) ? own : deps).push(path)
  return [...own, ...deps]
}

// Display label for a package bucket: `__own__` is the sentinel for
// own-source (non-dependency) files, spelled out as "Own source" in
// package lists and tooltips.
//
// A vendored package is shown by the path after the (last) `vendor/`,
// which in each vendoring layout is what the package is called: `cargo
// vendor` puts a crate at `vendor/<crate>`, Composer a package at
// `vendor/<vendor>/<pkg>`, Go a module at `vendor/<module path>`. Only
// the label is shortened; the bucket keeps the dir (see `bundlePkgOf`).
// Anything but a package key (the graph asks with no package focused)
// passes through as it came.
export function pkgLabel(pkg) {
  if (pkg === '__own__') return 'Own source'
  if (typeof pkg !== 'string') return pkg
  return pkg.match(/^(?:.*\/)?vendor\/(.+)$/u)?.[1] ?? pkg
}
