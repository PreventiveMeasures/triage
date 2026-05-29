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
