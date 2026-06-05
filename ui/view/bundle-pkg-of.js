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
export function bundlePkgOf(path, { splitOwnDirs = true } = {}) {
  const re = /(?:^|\/)(?:node_modules|dependencies)\/(@[^/]+\/[^/]+|[^/]+)/gu
  let m
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== '.pnpm') return m[1]
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
export function ownSourceSplittable(paths) {
  const buckets = new Set()
  for (const p of paths) {
    // Dependency files (resolve to a package name either way) never
    // move when own-source splitting toggles — skip them.
    if (bundlePkgOf(p, { splitOwnDirs: false }) !== '__own__') continue
    buckets.add(bundlePkgOf(p, { splitOwnDirs: true }))
    if (buckets.size > 1) return true
  }
  return false
}
