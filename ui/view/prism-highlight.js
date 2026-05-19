// Lazy loader for prismjs syntax highlighting. Mirrors the brotli
// pattern: a runtime-string dynamic import keeps `prism.js`
// (and the prismjs grammar packs) out of the main view.js bundle.
// First call kicks the import; subsequent calls share the same
// promise so prism only downloads + parses once per session.
//
// Languages are detected from file path extension. Unknown
// extensions resolve to null so the source viewer falls back to
// plain text without paying the import cost.

let loadPromise = null

function loadPrism() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    // Path held in a variable so esbuild can't statically resolve
    // it — keeps prismjs out of the main bundle. The browser
    // resolves the URL relative to the page; works at any deploy
    // path (root or subdirectory).
    const path = './prism.js'
    return await import(path)
  })()
  return loadPromise
}

const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  css: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  yml: 'yaml', yaml: 'yaml',
  sh: 'bash', bash: 'bash',
  md: 'markdown', markdown: 'markdown',
  sol: 'solidity',
}

export function langForPath(path) {
  if (typeof path !== 'string') return null
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  return EXT_TO_LANG[path.slice(dot + 1).toLowerCase()] ?? null
}

// Returns highlighted HTML string when prismjs supports the
// language; null otherwise (caller renders plain text). Async
// because the first call may need to download the prism bundle.
export async function highlight(code, lang) {
  if (!lang) return null
  try {
    const mod = await loadPrism()
    return mod.highlight(code, lang)
  } catch {
    return null
  }
}
