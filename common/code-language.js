const EXT_TO_LANG = {
  __proto__: null,
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
  rb: 'ruby',
  py: 'python', pyw: 'python', pyi: 'python',
  java: 'java',
  // .h is claimed by C, C++ and Objective-C alike. The C++ grammar
  // extends the C one, so it is the superset that colours a header
  // from any of the three; the C grammar would leave a C++ header's
  // class/template/namespace keywords plain.
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp',
  hpp: 'cpp', hh: 'cpp', hxx: 'cpp', 'h++': 'cpp', h: 'cpp',
  c: 'c',
  m: 'objectivec', mm: 'objectivec',
}

// Stasis records loader formats as well as language names. Resolve those to
// the grammars we ship before consulting the filename.
const FORMAT_TO_LANG = {
  __proto__: null,
  module: 'javascript', commonjs: 'javascript',
  'module-typescript': 'typescript', 'commonjs-typescript': 'typescript',
  json: 'json', solidity: 'solidity', php: 'php', shell: 'bash', rust: 'rust',
  java: 'java', objc: 'objectivec', objcpp: 'objectivec',
  c: 'c', 'c-header': 'c', cpp: 'cpp', 'cpp-header': 'cpp',
  ruby: 'ruby', podspec: 'ruby', podfile: 'ruby', fastlane: 'ruby',
  'podfile-lock': 'yaml', xml: 'markup',
}

// Whether a text is a JSON object by its ends: `{` first and `}` last,
// whitespace aside. Read from both ends, never the whole of a large file.
function objectText(content) {
  if (typeof content !== 'string') return false
  let end = content.length - 1, start = 0
  while (start < end && /\s/u.test(content[start])) start++
  while (end > start && /\s/u.test(content[end])) end--
  return start < end && content[start] === '{' && content[end] === '}'
}

// `content`, where the caller has it, settles what the name alone cannot: a
// `.map` file is a source map, JSON, when its text is an object.
export function langForPath(path, format, content) {
  if (typeof format === 'string' && FORMAT_TO_LANG[format]) return FORMAT_TO_LANG[format]
  if (typeof path !== 'string') return null
  // Only the filename can contribute an extension. A dotted directory such
  // as `.abc/edf` is a path segment, not an extension on `edf`.
  const basename = path.slice(path.lastIndexOf('/') + 1)
  const dot = basename.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = basename.slice(dot + 1).toLowerCase()
  if (ext === 'map') return objectText(content) ? 'json' : null
  return EXT_TO_LANG[ext] ?? null
}
