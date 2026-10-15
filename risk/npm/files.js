// What risk reads of each file of a version, once a version (stamps.js
// npmFileRisk), and every host its scripts name: for compare.js's findings
// and held.js's, and for the viewer, which reads its files' tags from it.
import { bundleFileSizes, bundleFilesAsMap } from '../../common/bundle-sources.js'
import { NPM_PROSE } from '../files/readability.js'
import { JS_STRING_OR_COMMENT, npmIsScript } from '../files/script.js'
import { npmFileRisk } from '../files/stamps.js'

// What a version's files are kept by: its bundle where it is one, else its
// files' list, else itself.
const keyOf = version => version.bundle ?? version.json ?? version

// A string's escapes as JavaScript reads them (`\x2e`, `\u002e`, `\u{2e}`, a
// control's letter, and an octal's, `\056`, as code outside strict mode
// reads it), a line continuation for nothing, any other for itself.
const ESCAPE = /\\(?:x([\da-f]{2})|u([\da-f]{4})|u\{([\da-f]{1,6})\}|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\s\S]))/giu
const CONTROLS = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }
const unescaped = body => body.replaceAll(ESCAPE, (escape, x, u, braced, octal, other) => {
  if (octal !== undefined) return String.fromCodePoint(Number.parseInt(octal, 8))
  if (other !== undefined) return /^(?:\r\n|[\n\r\u2028\u2029])$/u.test(other) ? '' : CONTROLS[other] ?? other
  const code = Number.parseInt(x ?? u ?? braced, 16)
  return code <= 0x10FFFF ? String.fromCodePoint(code) : escape
})

// A string token's value: null for a regular expression, one left open, or
// a template with something put in it.
function valueOf(token) {
  const quote = token[0]
  if (quote === '/' || token.length < 2 || token.at(-1) !== quote || (quote === '`' && token.includes('${'))) return null
  const body = token.slice(1, -1)
  return body.includes('\\') ? unescaped(body) : body
}

// Where a quoted string from `at` in a template's code ends: its quote, or
// its line's end.
function quoteEnd(body, at) {
  const quote = body[at]
  for (at++; at < body.length && body[at] !== quote && body[at] !== '\n'; at++) if (body[at] === '\\') at++
  return at
}

// Where the code of a `${…}` from `start` ends: the brace that closes it as
// braces nest, past a quoted string's (quoteEnd); else the body's end.
function closing(body, start) {
  let depth = 1
  for (let at = start; at < body.length; at++) {
    const char = body[at]
    if (char === '"' || char === "'") at = quoteEnd(body, at)
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return at
  }
  return body.length
}

// What a template's body puts in it: each `${…}`'s code (closing); not an
// escaped `\${`, nor the template's own text. Linear on any body.
function interpolated(body) {
  const parts = []
  for (let at = 0; at < body.length; at++) {
    if (body[at] === '\\') at++
    else if (body[at] === '$' && body[at + 1] === '{') {
      const end = closing(body, at + 2)
      parts.push(body.slice(at + 2, end))
      at = end
    }
  }
  return parts.join('\n')
}

// A script's code as JS_STRING_OR_COMMENT tells it apart, linear on any
// text: its comments dropped, each string or regular expression `0`, but a
// relative path's (RELATIVE), a mark (`\0<index>\0`, which no text read has)
// with its value kept (valueOf); and what a template puts in it
// (interpolated), read as code the same, once: not a template's in that.
function codeOf(text, outer = true) {
  const inner = [], paths = [], pieces = []
  let last = 0
  for (const { 0: match, 1: token, index } of text.matchAll(JS_STRING_OR_COMMENT)) {
    if (index > last) pieces.push(text.slice(last, index))
    last = index + match.length
    if (token === undefined) {
      pieces.push(' ')
      continue
    }
    if (outer && token[0] === '`' && token.includes('${')) inner.push(interpolated(token.slice(1, token.length > 1 && token.at(-1) === '`' ? -1 : undefined)))
    const value = token[1] === '.' || token[1] === '\\' ? valueOf(token) : null
    pieces.push(value !== null && RELATIVE.test(value) ? ` \0${paths.push(value) - 1}\0 ` : ' 0 ')
  }
  pieces.push(text.slice(last))
  return [{ code: pieces.join(''), paths }, ...inner.flatMap(body => codeOf(body, false))]
}

// A loader given a string first, more arguments after it or none:
// `require(…)` (`module.require` too, not `require.resolve`) and `import(…)`;
// and an `import` or `export`'s `from`, or a bare `import`.
const MARK = String.raw`\0(\d+)\0`
const REQUIRED = new RegExp(String.raw`(?:(?<![\w$.])module\s*\.\s*|(?<![\w$.]))require\s*\(\s*${MARK}\s*[,)]`, 'gu')
const IMPORTED = new RegExp(String.raw`(?<![\w$.])(?:import\s*\(\s*${MARK}\s*[,)]|(?:import|from)\s*${MARK})`, 'gu')
// A relative path: from `./` or `../`, or `.` or `..` alone.
const RELATIVE = /^\.\.?(?:\/|$)/u
// What `require` doesn't run as JavaScript: JSON, and a native addon, by
// their names as it knows them, in lowercase: `.JSON` it runs.
const NOT_RUN = /\.(?:json|node)$/u
// A name with an extension, which `import` runs only where it knows it: not
// `.npmignore`, nor `payload`.
const EXTENSION = /[^/.][^/]*\.[^/]*$/u

// `spec` from the directory `dir` ('' for the package's top), as a path in
// the package; null for one leading out of it.
function joined(dir, spec) {
  const parts = dir === '' ? [] : dir.split('/')
  for (const part of spec.split('/')) {
    if (part === '..' && parts.pop() === undefined) return null
    if (part !== '..' && part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('/')
}

// The file a path is once installed: its own, or for a .npmignore, the
// .gitignore beside it where it has none, as npm installs it so.
function installedAs(files, path) {
  if (path === null || files.has(path)) return path
  const gitignore = path.replace(/(?<=^|\/)\.npmignore$/u, '.gitignore')
  return gitignore !== path && files.has(gitignore) ? gitignore : null
}

// A package.json's `main`, and the paths its `exports` name; none where it
// is no JSON object.
function entriesOf(text) {
  const leaves = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : []
  try {
    const { main, exports } = JSON.parse(text)
    return { main: typeof main === 'string' && main !== '' ? main : null, exports: leaves(exports).filter(target => target.startsWith('./')) }
  } catch {
    return { main: null, exports: [] }
  }
}

// The files an `exports` target names: its own, or each a pattern's `*`
// matches where the pattern names what follows it (`./lib/*.txt`), as a
// consumer asking for a module (`pkg/x`) runs that; where it names nothing
// (`./*`), only one with no extension that isn't prose by its name (not
// `LICENSE`), the rest a consumer reaches only asking for them by their names.
function exported(files, target) {
  const path = joined('', target)
  if (path === null || !path.includes('*')) return [installedAs(files, path)]
  const [first, ...rest] = path.split('*'), last = rest.pop()
  return [...files.keys()].filter(file => {
    if (!file.startsWith(first) || !file.endsWith(last) || file.length < first.length + last.length || (last === '' && (EXTENSION.test(file) || NPM_PROSE.test(file)))) return false
    let at = first.length
    for (const part of rest) {
      at = file.indexOf(part, at)
      if (at === -1) return false
      at += part.length
    }
    return at <= file.length - last.length
  })
}

// How many of a package's `exports` patterns are each matched against its
// files (exported): more than a package names (4 at most of popular ones).
// One naming more has every file read as one it may load.
const MAX_PATTERNS = 64

// The files of a version node runs as JavaScript though their names say
// otherwise (script.js npmIsScript), read as scripts all the same
// (stamps.js npmFileRisk's `script`): text a script of it, or a file read so,
// loads by a path it quotes whole, `require` running any but JSON and a
// native addon
// (`require('./data.txt')`, `require('./.npmignore')`, the .gitignore npm
// installs as that) and `import` one whose name has no extension
// (`import('./payload')`); the `main` of a directory's package.json where a
// script requires the directory; and the package's own `main` and what its
// `exports` name, its patterns' too, which a `require` of it runs whatever
// their names. Only a
// path given whole as a string, read in code (codeOf), not in a comment or
// another string: one a script builds, or calls a loader by another name to
// load, is not followed.
const loadedByVersion = new WeakMap()
export function npmLoadedScripts(version) {
  let loaded = loadedByVersion.get(keyOf(version))
  if (loaded) return loaded
  loaded = new Set()
  const files = bundleFilesAsMap(version), queue = []
  const add = (path, by) => {
    const text = path === null ? null : files.get(path)
    if (typeof text !== 'string' || loaded.has(path) || npmIsScript(path, text) || (by === 'require' ? NOT_RUN.test(path) : EXTENSION.test(path))) return
    loaded.add(path)
    queue.push(path)
  }
  // A path `require` takes: its file, else a directory's package.json `main`.
  const required = at => {
    const file = installedAs(files, at)
    if (file !== null || at === null) return add(file, 'require')
    const { main } = entriesOf(files.get(at === '' ? 'package.json' : `${at}/package.json`))
    if (main !== null) add(installedAs(files, joined(at, main)), 'require')
  }
  required('')
  const targets = new Set(entriesOf(files.get('package.json')).exports)
  if ([...targets].filter(target => target.includes('*')).length > MAX_PATTERNS) for (const path of files.keys()) add(path, 'require')
  else for (const target of targets) for (const file of exported(files, target)) add(file, 'require')
  for (const [path, text] of files) if (npmIsScript(path, text)) queue.push(path)
  for (let at = 0; at < queue.length; at++) {
    const path = queue[at]
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    for (const { code, paths } of codeOf(files.get(path))) {
      const pathOf = index => joined(dir, paths[index])
      for (const { 1: index } of code.matchAll(REQUIRED)) required(pathOf(index))
      for (const { 1: dynamic, 2: fixed } of code.matchAll(IMPORTED)) add(installedAs(files, pathOf(dynamic ?? fixed)), 'import')
    }
  }
  loadedByVersion.set(keyOf(version), loaded)
  return loaded
}

// What risk reads of each file of a version (stamps.js npmFileRisk), once a
// version and path: as a script too where node runs it as one though its name
// says otherwise (npmLoadedScripts).
const reads = new WeakMap()
export function npmVersionFileRisk(version, path) {
  let files = reads.get(keyOf(version))
  if (!files) reads.set(keyOf(version), files = new Map())
  if (!files.has(path)) {
    const text = bundleFilesAsMap(version).get(path)
    files.set(path, npmFileRisk(path, typeof text === 'string' ? text : null, bundleFileSizes(version).get(path), npmLoadedScripts(version).has(path)))
  }
  return files.get(path)
}

// Every host a version's scripts name (hosts.js npmHosts), once a version.
const versionHosts = new WeakMap()
export function npmVersionHosts(version) {
  let hosts = versionHosts.get(keyOf(version))
  if (!hosts) {
    hosts = new Set()
    for (const path of bundleFilesAsMap(version).keys()) for (const host of npmVersionFileRisk(version, path).hosts?.keys() ?? []) hosts.add(host)
    versionHosts.set(keyOf(version), hosts)
  }
  return hosts
}
