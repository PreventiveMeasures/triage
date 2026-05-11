// Shared helper: given a parsed bundle `details` object, return a
// Map<file, content-string> of its source files. Stasis bundles
// ship sources as a flat `{file: content}` object; sourcemaps
// split them across parallel `sources` / `sourcesContent` arrays.
// Non-string content is skipped, so a mixed binary+text source
// map yields the text-only view.
//
// Lives in its own module so both `render-bundle.js` (Code tab,
// finding tree, graph data) and `terminal-attach.js` (in-shell
// FS) read from one definition — a new bundle kind or field
// handled here is automatically visible to both.

export function bundleSourcesAsMap(details) {
  const result = new Map()
  if (!details || !details.json) return result
  if (details.kind === 'stasis') {
    for (const [file, content] of Object.entries(details.json.sources ?? {})) {
      if (typeof content === 'string') result.set(file, content)
    }
  } else if (details.kind === 'sourcemap') {
    const srcs = details.json.sources ?? []
    const contents = details.json.sourcesContent ?? []
    for (let i = 0; i < srcs.length; i++) {
      if (typeof contents[i] === 'string') result.set(srcs[i], contents[i])
    }
  }
  return result
}
