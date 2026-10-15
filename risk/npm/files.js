// What risk reads of each file of a version, once a version (stamps.js
// npmFileRisk), and every host its scripts name: for compare.js's findings
// and held.js's, and for the viewer, which reads its files' tags from it.
import { bundleFileSizes, bundleFilesAsMap } from '../../common/bundle-sources.js'
import { NPM_PROSE } from '../files/readability.js'
import { npmIsScript } from '../files/script.js'
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

// Each string a text writes out that may name a file of its package, its
// value starting `.`, with an escape, or with `first` (its name's first
// character): from any quote no backslash escapes (an even run of them
// before it, or none) to the next of its kind none escapes, a template's
// across lines, the others' within their line, a line continuation aside.
// Tried from every such quote, not only where code's tokens say a string
// starts, which code can be written to have read wrong (a regular
// expression, a comment or a template's text taken for another): so one in
// a comment, or in another string, is read too. Linear on any text, each
// quote's string read to the next quote of its kind.
function quoted(first) {
  const starts = String.raw`(?=[.\\${first === null ? '' : String.raw`\u{${first.codePointAt(0).toString(16)}}`}])`
  const line = quote => String.raw`${quote}(?=${starts}((?:[^${quote}\\\n]|\\(?:\r\n|[\s\S]))*)${quote})`
  return new RegExp(String.raw`(?<=(?:^|[^\\])(?:\\\\)*)(?:${line('"')}|${line("'")}|\x60(?=${starts}((?:[^\x60\\]|\\[\s\S])*)\x60))`, 'gu')
}

// A string's value, from its quote and what it holds: null for a template
// with something put in it.
const valueOf = (quote, body) => quote === '`' && body.includes('${') ? null : body.includes('\\') ? unescaped(body) : body

// Where a string is what `import` takes, rather than what `require` may: a
// declaration's (`import './x'`, `from './x'`), on the keyword's line with
// blanks alone between, as a line break could begin another statement
// there (`from\n'./x'.split(',').forEach(require)`), and not a template,
// which `from` would be called with as a tag; or the whole first argument of
// `import(…)`, on its line too.
const DECLARED = /(?<=(?<![\p{ID_Continue}$.#])(?:import|from)[ \t]*)/uy
const CALLED = /(?<=(?<![\p{ID_Continue}$.#])import[ \t]*\([ \t]*)/uy
const ARGUMENT_END = /[ \t]*[,)]/uy
const matchesAt = (regex, text, index) => {
  regex.lastIndex = index
  return regex.test(text)
}
const imported = (text, quote, start, end) => (quote !== '`' && matchesAt(DECLARED, text, start)) || (matchesAt(CALLED, text, start) && matchesAt(ARGUMENT_END, text, end))

// A relative path: from `./` or `../`, or `.` or `..` alone.
const RELATIVE = /^\.\.?(?:\/|$)/u
// What `require` doesn't run as JavaScript: JSON, and a native addon, by
// their names as it knows them, in lowercase: `.JSON` it runs.
const NOT_RUN = /\.(?:json|node)$/u
// A name with an extension, which `import` runs only where it knows it: not
// `.npmignore`, nor `payload`.
const EXTENSION = /[^/.][^/]*\.[^/]*$/u

// A path's parts, `spec`'s from `parts`, each `..` a directory up; null for
// one leading past the top.
function resolved(parts, spec) {
  const all = [...parts]
  for (const part of spec.split('/')) {
    if (part === '..' && all.pop() === undefined) return null
    if (part !== '..' && part !== '.' && part !== '') all.push(part)
  }
  return all
}
// Those parts as a path in the package where it is installed (`root`, its
// directory's parts, `node_modules/<name>`): null for one outside it.
const within = (root, parts) => parts !== null && root.every((part, index) => parts[index] === part) ? parts.slice(root.length).join('/') : null
// `spec` from the directory `dir` ('' for the package's top) as a path in the
// package, one leading out of it and back in by its name too
// (`../<name>/x`); null for one leading elsewhere.
const joined = (root, dir, spec) => within(root, resolved([...root, ...dir === '' ? [] : dir.split('/')], spec))
// A path as `require` takes it: its `\` a separator too, as on Windows; null
// for one not relative (RELATIVE).
function requiredPath(root, dir, spec) {
  const path = spec.replaceAll('\\', '/')
  return RELATIVE.test(path) ? joined(root, dir, path) : null
}
// What a URL reads otherwise than a path: an escape, a query, a fragment, a
// `\`, a tab or a line break, or a blank or a control at its end, which it
// drops.
const URL_READ = /[%?#\\\t\n\r]|[\0- ]$/u
// A relative path as `import` takes it, and `exports` and `imports` targets,
// a URL's: its query and fragment dropped, tabs and line breaks too, `\` a
// separator, its escapes read (`%2E`); null for one escaping a separator
// (`%2F`), as node refuses, or leading out of the package (joined).
function urlJoined(root, dir, spec) {
  if (!RELATIVE.test(spec)) return null
  if (!URL_READ.test(spec)) return joined(root, dir, spec)
  try {
    const base = [...root, ...dir === '' ? [] : dir.split('/')].map(part => `${encodeURIComponent(part)}/`).join('')
    const { pathname } = new URL(spec, `file:///${base}`)
    return /%(?:2f|5c)/iu.test(pathname) ? null : within(root, resolved([], decodeURIComponent(pathname)))
  } catch {
    return null
  }
}

// Where a package is installed (`node_modules/<name>`), as parts; none for
// one with no name, or one no directory could be.
const NAME = /^(?:@[^/]+\/)?[^/@.][^/]*$/u
const rootOf = name => typeof name === 'string' && NAME.test(name) && name.split('/').every(part => part !== '.' && part !== '..') ? ['node_modules', ...name.split('/')] : []

// The file a path is once installed: its own, or for a .npmignore, the
// .gitignore beside it where it has none, as npm installs it so.
function installedAs(files, path) {
  if (path === null || files.has(path)) return path
  const gitignore = path.replace(/(?<=^|\/)\.npmignore$/u, '.gitignore')
  return gitignore !== path && files.has(gitignore) ? gitignore : null
}

// A package.json's `name`, `main`, and the paths its `exports` and `imports`
// name (`./x`), read past a byte order mark as node reads it; none where it
// is no JSON object.
function entriesOf(text) {
  const leaves = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : []
  if (typeof text !== 'string') return { name: null, main: null, targets: [] }
  try {
    const { name, main, exports, imports } = JSON.parse(text.replace(/^\uFEFF/u, ''))
    return { name, main: typeof main === 'string' && main !== '' ? main : null, targets: [...leaves(exports), ...leaves(imports)].filter(target => target.startsWith('./')) }
  } catch {
    return { name: null, main: null, targets: [] }
  }
}

// The files an `exports` or `imports` target names, from the directory of the
// package.json naming it, read as a URL (urlJoined): its own, or each a
// pattern's `*` matches where the pattern names what follows it
// (`./lib/*.txt`), as a consumer asking for a module (`pkg/x`) runs that;
// where it names nothing (`./*`), only one with no extension that isn't prose
// by its name (not `LICENSE`), the rest a consumer reaches only asking for
// them by their names.
function exported(files, root, dir, target) {
  const path = urlJoined(root, dir, target)
  if (path === null || !path.includes('*')) return [installedAs(files, path)]
  const [first, ...rest] = path.split('*'), last = rest.pop()
  return [...files.keys()].filter(file => {
    if (!file.startsWith(first) || !file.endsWith(last) || file.length < first.length + last.length || (last === '' && (EXTENSION.test(file) || NPM_PROSE.test(file)))) return false
    let index = first.length
    for (const part of rest) {
      index = file.indexOf(part, index)
      if (index === -1) return false
      index += part.length
    }
    return index <= file.length - last.length
  })
}

// How many `exports` and `imports` patterns a package's package.json files
// have each matched against its files (exported): more than a package names
// (4 at most of popular ones). One naming more has every file read as one it
// may load.
const MAX_PATTERNS = 64

// The files of a version node runs as JavaScript though their names say
// otherwise (script.js npmIsScript), read as scripts all the same
// (stamps.js npmFileRisk's `script`): any a script of it, or a file read so,
// names by a relative path written out whole as a string (quoted), anywhere
// in its text, whatever takes it, or by the package's own name
// (`'<name>/x.txt'`); as `require` runs any but JSON and a native addon
// (`require('./data.txt')`, `require('./.npmignore')`, the .gitignore npm
// installs as that), and the `main` of a directory's package.json; and as
// `import` runs one whose name has no extension (`import('./payload')`), as a
// URL (urlJoined), a string an import declaration or `import(…)` takes whole
// read as it alone (imported). And the package's own `main`, and what the
// `exports` and `imports` of its package.json files name, their patterns'
// too, which a `require` reaching them runs whatever their names. A path a
// script builds is not followed (`'./x' + '.txt'`, a template with something
// put in it), nor one written in a string run as code, which runs-code.js
// tells.
const loadedByVersion = new WeakMap()
export function npmLoadedScripts(version) {
  let loaded = loadedByVersion.get(keyOf(version))
  if (loaded) return loaded
  loaded = new Set()
  const files = bundleFilesAsMap(version), queue = []
  const top = entriesOf(files.get('package.json'))
  const root = rootOf(top.name)
  const add = (path, by) => {
    const text = path === null ? null : files.get(path)
    if (typeof text !== 'string' || loaded.has(path) || npmIsScript(path, text) || (by === 'require' ? NOT_RUN.test(path) : EXTENSION.test(path))) return
    loaded.add(path)
    queue.push(path)
  }
  // A path `require` takes: its file, else a directory's package.json `main`.
  const requires = path => {
    const file = installedAs(files, path)
    if (file !== null || path === null) return add(file, 'require')
    const { main } = entriesOf(files.get(path === '' ? 'package.json' : `${path}/package.json`))
    if (main !== null) add(installedAs(files, joined(root, path, main)), 'require')
  }
  requires('')
  const targets = [...files].filter(([path]) => /(?:^|\/)package\.json$/u.test(path))
    .flatMap(([path, text]) => entriesOf(text).targets.map(target => [path.slice(0, -'package.json'.length - 1), target]))
  if (targets.filter(([, target]) => target.includes('*')).length > MAX_PATTERNS) for (const path of files.keys()) add(path, 'require')
  else for (const [dir, target] of targets) for (const file of exported(files, root, dir, target)) add(file, 'require')
  for (const [path, text] of files) if (npmIsScript(path, text)) queue.push(path)
  const own = root.length > 0 ? `${top.name}/` : null, seen = new Set(), strings = quoted(root.length > 0 ? top.name : null)
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index], text = files.get(path)
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    for (const { 1: double, 2: single, 3: template, index: start } of text.matchAll(strings)) {
      const body = double ?? single ?? template, quote = text[start], value = valueOf(quote, body)
      if (value === null) continue
      const [from, spec] = own !== null && value.startsWith(own) ? ['', `./${value.slice(own.length)}`] : [dir, value]
      if (!RELATIVE.test(spec.replaceAll('\\', '/'))) continue
      const by = imported(text, quote, start, start + body.length + 2) ? 'import' : 'require', key = `${by}\0${from}\0${spec}`
      if (seen.has(key)) continue
      seen.add(key)
      const named = requiredPath(root, from, spec)
      if (by === 'require') requires(named)
      add(URL_READ.test(spec) ? urlJoined(root, from, spec) : named, 'import')
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
