// Shared helper: given a parsed bundle `details`, return a
// Map<file, content-string> of its source files. Stasis bundles
// expose sources via `@exodus/stasis`'s `Bundle.sources` getter
// (flat Map<projectRelPath, content> from `.modules`); sourcemaps
// split them across parallel `sources` / `sourcesContent` arrays on
// the raw .map JSON. Non-string content is skipped — for stasis that
// drops resource (base64) entries; for sourcemaps, sources where
// `sourcesContent[i]` was omitted.
//
// Own module so `render-bundle.js` (Code tab, finding tree, graph
// data) and `terminal-attach.js` (in-shell FS) read one definition —
// a new bundle kind or field handled here is visible to both.

export function bundleSourcesAsMap(details) {
  const result = new Map()
  if (!details) return result
  if (details.kind === 'stasis') {
    if (!details.bundle) return result
    for (const [file, content] of details.bundle.sources) {
      if (typeof content === 'string') result.set(file, content)
    }
  } else if (details.kind === 'sourcemap') {
    if (!details.json) return result
    const srcs = details.json.sources ?? []
    const contents = details.json.sourcesContent ?? []
    for (let i = 0; i < srcs.length; i++) {
      if (typeof contents[i] === 'string') result.set(srcs[i], contents[i])
    }
  }
  return result
}

// Map each stasis bundle source path to the package directory that
// owns it. A stasis `Bundle` already records authoritative package
// boundaries in `.modules` (a `Map<dir, { name, version, files }>`
// covering both `node_modules` deps and workspace packages — the
// PHP `vendor/<vendor>/<pkg>` case, monorepo workspaces, etc.); this
// mirrors the `Bundle.sources` getter's path construction (`dir/rel`,
// or just `rel` for the `.` root) so the returned keys line up exactly
// with `bundleSourcesAsMap`'s.
//
// The package views (overview, treemap, graph) otherwise classify
// paths with `bundlePkgOf`'s string heuristic, which only knows
// `node_modules/`/`dependencies/` and buckets everything else by
// top-level dir — collapsing sibling workspace packages under their
// shared parent (`vendor/aws/aws-crt-php` + `vendor/aws/aws-sdk-php`
// both fall under `vendor`). Feeding each path's dir into
// `bundlePkgOf` (`packageDir` option) keeps those packages separate.
//
// Returns null for sourcemap bundles (and anything without parsed
// modules) — they carry no package metadata, so callers fall back to
// the path heuristic alone.
export function bundlePackageDirs(details) {
  if (details?.kind !== 'stasis' || !details.bundle?.modules) return null
  const map = new Map()
  for (const [dir, info] of details.bundle.modules) {
    for (const rel of Object.keys(info.files)) {
      map.set(dir === '.' ? rel : `${dir}/${rel}`, dir)
    }
  }
  return map
}
