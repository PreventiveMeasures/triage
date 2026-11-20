// Package classifier for bundle paths. Pulled out of
// `render-bundle.js` (which drags in lit + the source-viewer + a
// circular `render.js` import, none of which this pure string logic
// needs) so it's a DOM-free leaf the bundle graph / treemap / compare
// views — and the test suite — can import on its own, and the server pair a
// comparison's files as Compare does (server-managed/rename-diff.ts).

// Bucket a bundle source path into a "package":
//   - files under `node_modules/<pkg>/...` return `<pkg>` (scoped names
//     included), as do Solidity files under Soldeer's
//     `dependencies/<pkg>/...`, the one ecosystem installing there;
//   - own (first-party) source returns the single `__own__` bucket: an
//     ordinary `dependencies/` folder of anything else is own code.
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
    const re = /\.sol$/iu.test(path)
      ? /(?:^|\/)(?:node_modules\/(@[^/]+\/[^/]+|[^/]+)|dependencies\/(@[^/]+\/[^/]+|[^/]+)\/)/gu
      : /(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^/]+)/gu
    let m
    while ((m = re.exec(path)) !== null) {
      const name = m[1] ?? m[2]
      if (name !== '.pnpm') return name
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

// Strip the longest common DIRECTORY prefix shared by every path
// in `paths`. Mirrors the analyzer-side path normalisation so the
// UI matches what it produces:
//
//   * Segment-level (only whole directory segments are stripped).
//   * Caps the prefix so it never ends in a `@scope` segment or
//     a `node_modules` segment — those identify the package each
//     listed file belongs to and should stay visible in the
//     stripped output. So
//     `node_modules/foo/{a,b}.js` strips to `node_modules/foo/{a,b}.js`
//     (prefix '') rather than to `{a,b}.js`.
//
// Returns `{ prefix, stripped }`. `prefix` ends with `/` (or is
// empty); `stripped` is a parallel array. With ≤1 path the result
// is a no-op pass-through.
export function stripCommonPathPrefix(paths) {
  if (paths.length <= 1) return { prefix: '', stripped: [...paths] }
  const split = paths.map((p) => p.split('/'))
  const minLen = Math.min(...split.map((s) => s.length))
  let prefixLen = 0
  for (let i = 0; i < minLen - 1; i++) {
    if (split.every((s) => s[i] === split[0][i])) prefixLen = i + 1
    else break
  }
  // Back off the prefix when its last segment is part of the
  // package's identity (scope `@org` or the `node_modules` marker).
  if (prefixLen > 0 && split[0][prefixLen - 1].startsWith('@')) prefixLen--
  if (prefixLen > 0 && split[0][prefixLen - 1] === 'node_modules') prefixLen--
  if (prefixLen === 0) return { prefix: '', stripped: [...paths] }
  const prefix = `${split[0].slice(0, prefixLen).join('/')}/`
  const stripped = split.map((s) => s.slice(prefixLen).join('/'))
  return { prefix, stripped }
}
