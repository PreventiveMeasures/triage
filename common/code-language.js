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
  rb: 'ruby',
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

export function langForPath(path) {
  if (typeof path !== 'string') return null
  // Only the filename can contribute an extension. A dotted directory such
  // as `.abc/edf` is a path segment, not an extension on `edf`.
  const basename = path.slice(path.lastIndexOf('/') + 1)
  const dot = basename.lastIndexOf('.')
  if (dot <= 0) return null
  return EXT_TO_LANG[basename.slice(dot + 1).toLowerCase()] ?? null
}

