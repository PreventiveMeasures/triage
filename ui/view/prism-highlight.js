// Lazy loader for prismjs syntax highlighting. Mirrors the brotli
// pattern: a runtime-string dynamic import keeps `prism.js` (and the
// grammar packs) out of the main view.js bundle. First call kicks
// the import; subsequent calls share the promise so prism downloads
// + parses once per session.
//
// Languages are detected from file extension (`langForPath`, for the
// source viewers) or from a fence's info string (`langForTag`, for the
// code blocks in finding descriptions). Unknown ones resolve to null
// so the caller falls back to plain text without paying the import
// cost.

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
  php: 'php', phtml: 'php',
  rs: 'rust',
}

export function langForPath(path) {
  if (typeof path !== 'string') return null
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  return EXT_TO_LANG[path.slice(dot + 1).toLowerCase()] ?? null
}

// Fence info string → prism language, for the ```ts blocks a finding
// description carries (format.js codeBlockSegments reads the tag off
// the fence; render-finding.js asks for a colour by it).
//
// A HARD allowlist, not a lookup that falls through to the tag itself.
// It names exactly the grammars `ui/prism.js` bundles, so an unlisted
// tag renders as plain monospace rather than paying a ~50KB download
// to find out Prism can't colour it either — and a report can't get
// the app to try loading a grammar by writing a tag. Adding a language
// means adding BOTH its `prismjs/components/…` import over there and
// its tags here; the two lists are meant to be read together.
//
// Aliases are the ones a report actually writes: the extensions (a
// `ts` / `sh` fence), the full names (```typescript), and the shell
// synonyms. Null-prototype so a tag like `constructor` can't alias an
// inherited key.
const TAG_TO_LANG = {
  __proto__: null,
  js: 'javascript', javascript: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  jsx: 'jsx',
  ts: 'typescript', typescript: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  css: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', markup: 'markup',
  yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  md: 'markdown', markdown: 'markdown',
  sol: 'solidity', solidity: 'solidity',
  rs: 'rust', rust: 'rust',
  php: 'php', phtml: 'php',
}

export function langForTag(tag) {
  if (typeof tag !== 'string') return null
  return TAG_TO_LANG[tag.toLowerCase()] ?? null
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
