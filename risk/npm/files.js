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
// reads it), a line continuation for nothing, any other for itself: `\X2E`
// and `\U002E` too, their letters in lowercase alone introducing a code.
const ESCAPE = /\\(?:x([\dA-Fa-f]{2})|u([\dA-Fa-f]{4})|u\{([\dA-Fa-f]{1,6})\}|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\s\S]))/gu
const CONTROLS = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }
const unescaped = body => body.replaceAll(ESCAPE, (escape, x, u, braced, octal, other) => {
  if (octal !== undefined) return String.fromCodePoint(Number.parseInt(octal, 8))
  if (other !== undefined) return /^(?:\r\n|[\n\r\u2028\u2029])$/u.test(other) ? '' : CONTROLS[other] ?? other
  const code = Number.parseInt(x ?? u ?? braced, 16)
  return code <= 0x10FFFF ? String.fromCodePoint(code) : escape
})

// The characters a filesystem telling neither case apart (folded) takes for
// one of a package's name, which npm keeps to ASCII: its cases, and those
// Unicode cases into it (`ı`, `ſ`, the Kelvin sign).
const FOLDING_INTO = { i: '\u0131', k: '\u212A', s: '\u017F' }
const foldsInto = char => new Set([char, char.toLowerCase(), char.toUpperCase(), ...FOLDING_INTO[char.toLowerCase()] ?? ''])

// Each string a text writes out that may name a file of its package, its
// value starting `.`, with an escape, or with one of `firsts` (its name's
// first character, foldsInto, and `#` where its package.json files map
// specifiers of its own): from any quote no backslash escapes (an even run of them
// before it, or none) to the next of its kind none escapes, a template's
// across lines, the others' within their line, a line continuation aside.
// Tried from every such quote, not only where code's tokens say a string
// starts, which code can be written to have read wrong (a regular
// expression, a comment or a template's text taken for another): so one in
// a comment, or in another string, is read too. Linear on any text, each
// quote's string read to the next quote of its kind.
function quoted(firsts) {
  const starts = String.raw`(?=[.\\${[...firsts].map(char => String.raw`\u{${char.codePointAt(0).toString(16)}}`).join('')}])`
  const line = quote => String.raw`${quote}(?=${starts}((?:[^${quote}\\\n]|\\(?:\r\n|[\s\S]))*)${quote})`
  return new RegExp(String.raw`(?<=(?:^|[^\\])(?:\\\\)*)(?:${line('"')}|${line("'")}|\x60(?=${starts}((?:[^\x60\\]|\\[\s\S])*)\x60))`, 'gu')
}

// A string's values, from its quote and what it holds: as JavaScript reads
// its escapes (unescaped), and a template's as written too, as a tag reads it
// (`String.raw`); none for a template with something put in it, a `${` no
// backslash escapes (`\${` its text).
function valuesOf(quote, body) {
  if (!body.includes('\\')) return quote === '`' && body.includes('${') ? [] : [body]
  if (quote !== '`') return [unescaped(body)]
  return body.replaceAll(/\\[\s\S]/gu, '').includes('${') ? [] : [unescaped(body), body]
}

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
// The extensions `require` tries a path with that names no file.
const TRIED = ['.js', '.json', '.node']
// A path `require` takes as a directory's alone, never a file's: one ending
// in `/`, or in `.` or `..` after one, or either alone, as node tells it, by
// `/` alone, on Windows too (`./payload/`, not `.\payload\`).
const DIRECTORY = /(?:^|\/)\.{0,2}$/u
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
// directory's parts, `node_modules/<name>`), told as a filesystem telling
// neither case nor Unicode's normalization apart tells them (folded,
// `../LOADS/x` for `loads`): null for one outside it.
const within = (root, parts) => parts !== null && root.every((part, index) => index < parts.length && (parts[index] === part || folded(parts[index]) === part)) ? parts.slice(root.length).join('/') : null
// `spec` from the directory `dir` ('' for the package's top) as a path in the
// package, one leading out of it and back in by its name too
// (`../<name>/x`); null for one leading elsewhere.
const joined = (root, dir, spec) => within(root, resolved([...root, ...dir === '' ? [] : dir.split('/')], spec))
// A path as `require` takes it: its `\` a separator on Windows, a name's
// character elsewhere, so read both ways.
const separated = spec => new Set([spec, spec.replaceAll('\\', '/')])
// Each relative one of those (RELATIVE), from `dir`, as a path in the package
// (joined).
const requiredPaths = (root, dir, spec) => [...separated(spec)].filter(path => RELATIVE.test(path)).map(path => joined(root, dir, path))
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

// Where a package is installed (`node_modules/<name>`), as parts, folded
// (within); none for one with no name, or one no directory could be.
const NAME = /^(?:@[^/]+\/)?[^/@.][^/]*$/u
const rootOf = name => typeof name === 'string' && NAME.test(name) && name.split('/').every(part => part !== '.' && part !== '..') ? ['node_modules', ...name.split('/')].map(folded) : []

// A path as a filesystem telling neither case nor Unicode's normalization
// apart takes it, as Windows' and macOS's do by default: `Payload.txt` for
// `payload.txt`; a lone surrogate the U+FFFD node writes a name with for it.
const folded = path => path.toWellFormed().normalize('NFC').toUpperCase().toLowerCase()
// The files a path names once installed, as a filesystem tells them
// (folded): its own, and for a .npmignore, a .gitignore npm installs as that;
// and the filesystems node may find them on, each telling the files a path
// names (`named`) by the path as it takes it (`fold`): one telling case
// apart (`cased`), as Linux's does, and one telling neither case nor
// Unicode's normalization apart (`folding`, folded), a path folded naming
// those with what follows it in ASCII (`.json`, `/index`), which folds as
// it is, every file the other names among them.
function installedOf(files) {
  const exact = new Map(), index = new Map()
  const put = (map, key, path) => map.has(key) ? map.get(key).push(path) : map.set(key, [path])
  for (const path of files.keys()) {
    const aliases = /(?:^|\/)\.gitignore$/u.test(path) ? [path, path.replace(/\.gitignore$/u, '.npmignore')] : [path]
    for (const alias of aliases) {
      put(index, folded(alias), path)
      put(exact, alias, path)
    }
  }
  const keyed = key => index.get(key) ?? []
  return { installed: path => path === null ? [] : keyed(folded(path)), cased: { named: key => exact.get(key) ?? [], fold: path => path }, folding: { named: keyed, fold: folded } }
}

// Every string a JSON value holds, however deep it nests them, read
// without recursing, which nesting deeper than a call stack would end.
function leaves(value) {
  const found = [], pending = [value]
  while (pending.length > 0) {
    const item = pending.pop()
    if (typeof item === 'string') found.push(item)
    else if (item && typeof item === 'object') for (const each of Object.values(item)) pending.push(each)
  }
  return found
}

// The targets an `exports` or `imports` map holds (leaves), by its keys
// (those `subpaths` tells, `./x`, `#x`), each a pattern's where its key is
// one (`./lib/*`), as node puts what a consumer asks for in a target's `*`
// only then; a map with none of those keys its `.`'s whole (`"exports":
// "./x"`, or conditions alone).
function mapped(map, subpaths) {
  const keyed = map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).some(subpaths) ? Object.entries(map) : [['.', map]]
  return keyed.flatMap(([key, value]) => leaves(value).map(target => ({ key, pattern: key.includes('*'), target })))
}

// A package.json's `name`, `main`, and the paths its `exports` and `imports`
// name (`./x`, mapped); and its maps by their keys (`./x`, `#x`), its
// `imports` to the package's own name too (`<name>/x`), read past a byte
// order mark as node reads it; none where it is no JSON object.
function entriesOf(text) {
  const none = { name: null, main: null, targets: [], exports: [], hasExports: false, imports: [] }
  if (typeof text !== 'string') return none
  try {
    const { name, main, exports, imports } = JSON.parse(text.replace(/^\uFEFF/u, ''))
    const subpaths = mapped(exports, key => key.startsWith('.')).filter(({ key, target }) => key.startsWith('.') && target.startsWith('./'))
    const own = mapped(imports, key => key.startsWith('#')).filter(({ key }) => key.startsWith('#'))
    const targets = [...subpaths, ...own.filter(({ target }) => target.startsWith('./'))]
    return { name, main: typeof main === 'string' && main !== '' ? main : null, targets, exports: subpaths, hasExports: exports !== undefined && exports !== null, imports: own }
  } catch {
    return none
  }
}

// A path as a filesystem reads it, from the package's top: each run of `/`
// one, none leading.
const collapsed = path => path.replaceAll(/\/+/gu, '/').replace(/^\//u, '')

// The paths an `exports` or `imports` target names, from the directory of the
// package.json naming it, read as a URL (urlJoined): its own, `*` and all,
// or where its key is a pattern (`pattern`, mapped) each file it matches, as a filesystem tells them (folded, collapsed), each of
// its `*` the same text, as node puts what a consumer asks for (`pkg/x`) in
// every one, where the pattern names what follows the last (`./lib/*.txt`);
// where it names nothing (`./*`), only one with no extension that isn't prose
// by its name (not `LICENSE`), the rest a consumer reaches only asking for
// them by their names. What a `*` stands for may be text with a `/` before
// it, after it, both or neither, or a `/` alone, the filesystem folding it
// into a `/` beside it (`pkg//` reaching `lib/.txt` through `./lib/*.txt`):
// each such shape's length told by one `x`'s, a file of the pattern's is the
// pattern with its text in each; a `/` before or after it counted apart only
// where it folds into a `/` of the pattern's, or the top, beside one `*` and
// not another, else its text holds it, or it folds alike at every one.
function exported(names, root, dir, target, pattern) {
  const path = urlJoined(root, dir, target)
  if (path === null || !pattern || !path.includes('*')) return [path]
  const parts = folded(path).split('*'), stars = parts.length - 1
  const head = parts[0].replace(/\/+$/u, ''), slashes = collapsed(parts.join('/')), tail = parts.at(-1).replace(/^\/+/u, '')
  const both = sides => sides.includes(true) && sides.includes(false) ? ['', '/'] : ['']
  const afters = both(parts.slice(1).map(part => part.startsWith('/'))), befores = both(parts.slice(0, -1).map((part, index) => part.endsWith('/') || (index === 0 && part === '')))
  const shapes = befores.flatMap(before => afters.map(after => ({ after, at: collapsed(`${parts[0]}${before}x`).length - 1, before, length: collapsed(parts.join(`${before}x${after}`)).length })))
  return names.filter(([name, file]) => {
    if (!file.startsWith(head) || !file.endsWith(tail) || (parts.at(-1) === '' && (EXTENSION.test(name) || NPM_PROSE.test(name)))) return false
    return file === slashes || shapes.some(({ after, at, before, length }) => {
      const core = (file.length - length) / stars + 1
      if (!Number.isInteger(core) || core <= 0) return false
      const built = parts.join(`${before}${file.slice(at, at + core)}${after}`)
      return built === file || ((built.includes('//') || built.startsWith('/')) && collapsed(built) === file)
    })
  }).map(([name]) => name)
}

// What a map's entries (`{ dir, key, target }` each) take `value` to, as
// node maps a specifier through `exports` or `imports`: the target of a key
// that is it, or of a pattern's (`#lib/*`, `./lib/*`, one `*`) it matches,
// what it matches put in each of the target's `*`; EVERY for one that would
// put in more than MAX_EXPANSION characters, which only a package written to
// hold up its reading has (`*` thousands of times over a long specifier), and
// whose path a URL's reading could shorten again (tabs, a query, `//`).
const MAX_EXPANSION = 64 * 1024
const EVERY = Symbol('every file')
const mappedTo = (entries, value) => entries.flatMap(({ dir, key, target }) => {
  const star = key.indexOf('*')
  if (star === -1 ? key !== value : star !== key.lastIndexOf('*') || value.length < key.length || !value.startsWith(key.slice(0, star)) || !value.endsWith(key.slice(star + 1))) return []
  if (star === -1) return [{ dir, target }]
  const sub = value.slice(star, value.length - (key.length - star - 1))
  return [{ dir, target: (target.split('*').length - 1) * sub.length > MAX_EXPANSION ? EVERY : target.replaceAll('*', sub) }]
})

// A package's own subpath (`./x`, `.`) as its `exports` map it (mappedTo), as
// node resolves a specifier by its own name (`<name>/x`), read as URLs; with
// no `exports` at all, the path itself, as node finds the package where it
// is installed (`root`).
const selfResolved = (root, { exports, hasExports }, spec) => hasExports
  ? mappedTo(exports.map(entry => ({ ...entry, dir: '' })), spec).map(({ target }) => target === EVERY ? EVERY : urlJoined(root, '', target))
  : [urlJoined(root, '', spec)]

// The path of the first of `extensions` a path takes that names a file of a
// version's on a filesystem (`system`, installedOf's), each it tells for it
// its own: none at the package's top, which is no file.
function firstNamed({ named, fold }, path, extensions) {
  const key = path === '' ? null : fold(path)
  const extension = key === null ? undefined : extensions.find(each => named(`${key}${each}`).length > 0)
  return extension === undefined ? null : `${path}${extension}`
}
const indexFile = (system, path) => firstNamed(system, path === '' ? 'index' : `${path}/index`, TRIED)

// The files a path `require` takes finds, the first it tries that names a
// file: its own, one by its name and an extension (`.js`, `.json`, `.node`,
// `payload.JSON` as a filesystem folding case finds it), but where it takes
// it as a directory's (`directory`, DIRECTORY); else a directory's
// package.json `main`, found so or by its `index` and an extension; else the
// directory's `index` so, as node falls back to it; on a filesystem
// (`system`, installedOf's), as each finds its own first.
function requiredFiles(files, system, root, path, directory) {
  if (path === null) return []
  const file = directory ? null : firstNamed(system, path, ['', ...TRIED])
  if (file !== null) return [file]
  const mains = system.named(path === '' ? 'package.json' : `${system.fold(path)}/package.json`).map(manifest => entriesOf(files.get(manifest)).main).filter(main => main !== null)
    .flatMap(main => [...separated(main)].map(spec => joined(root, path, spec))).filter(at => at !== null)
    .map(at => firstNamed(system, at, ['', ...TRIED]) ?? indexFile(system, at)).filter(found => found !== null)
  return mains.length > 0 ? mains : [indexFile(system, path)].filter(found => found !== null)
}

// The `#` specifiers each package.json of a version's files maps
// (`imports`), each from its directory.
const specifiersOf = files => [...files].filter(([path]) => /(?:^|\/)package\.json$/iu.test(path))
  .flatMap(([path, text]) => entriesOf(text).imports.map(({ key, target }) => ({ dir: path.slice(0, -'package.json'.length - 1), key, target })))

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
// tells. Each path names the files a filesystem telling neither case nor
// Unicode's normalization apart finds by it (folded), as Windows' and
// macOS's do, a loader running one where its name or theirs says it does;
// one that isn't text among them too, which node runs decoded as UTF-8 and
// readability.js npmBinaryCode tells, though nothing it loads is read, but
// where it can't parse (tarball.js npmRunnable's `runnable`: an image).
const loadedByVersion = new WeakMap()
export function npmLoadedScripts(version) {
  let loaded = loadedByVersion.get(keyOf(version))
  if (loaded) return loaded
  loaded = new Set()
  const files = bundleFilesAsMap(version), { installed, cased, folding } = installedOf(files), queue = []
  const top = entriesOf(files.get(files.has('package.json') ? 'package.json' : installed('package.json')[0]))
  const root = rootOf(top.name)
  // What a loader takes (`by`) runs, as the name it is asked by tells, or
  // the name of the file it finds.
  const runs = (path, by) => !(by === 'require' ? NOT_RUN : EXTENSION).test(path)
  // Each path once a loader and whether its name runs: the files it names
  // are the same however else it is cased.
  const tried = new Set()
  const add = (path, by) => {
    const key = path === null ? null : `${by}\0${runs(path, by)}\0${folded(path)}`
    if (key === null || tried.has(key)) return
    tried.add(key)
    for (const file of installed(path)) {
      const text = files.get(file)
      if (loaded.has(file) || npmIsScript(file, text) || text?.runnable === false || (!runs(path, by) && !runs(file, by))) continue
      loaded.add(file)
      if (typeof text === 'string') queue.push(file)
    }
  }
  // On either filesystem: where one folding case finds none, neither does
  // one telling case apart, which finds fewer.
  const requires = (path, directory) => {
    const found = requiredFiles(files, folding, root, path, directory)
    if (found.length > 0) for (const file of [...found, ...requiredFiles(files, cased, root, path, directory)]) add(file, 'require')
  }
  requires('', true)
  const targets = [...files].filter(([path]) => /(?:^|\/)package\.json$/iu.test(path))
    .flatMap(([path, text]) => entriesOf(text).targets.map(({ pattern, target }) => [path.slice(0, -'package.json'.length - 1), target, pattern && target.includes('*')]))
  if (targets.filter(([, , pattern]) => pattern).length > MAX_PATTERNS) for (const path of files.keys()) add(path, 'require')
  else {
    // Each file's path and its path as a filesystem tells it (folded), for
    // the patterns to match.
    const names = targets.some(([, , pattern]) => pattern) ? [...files.keys()].map(name => [name, folded(name)]) : []
    for (const [dir, target, pattern] of targets) for (const file of exported(names, root, dir, target, pattern)) add(file, 'require')
  }
  for (const [path, text] of files) if (npmIsScript(path, text)) queue.push(path)
  const specifiers = specifiersOf(files)
  // The package's own name, as a filesystem tells it (rootOf), a path from
  // it after a `/`, or a `\\` as on Windows.
  const named = value => root.length > 0 && value.length > top.name.length && '/\\'.includes(value[top.name.length])
    && folded(value.slice(0, top.name.length)) === root.slice(1).join('/')
  const seen = new Set(), strings = quoted([...root.length > 0 ? foldsInto(top.name[0]) : [], ...specifiers.length > 0 ? ['#'] : []])
  const subpathsOf = spec => selfResolved(root, top, spec)
  // A path loaded, or for EVERY, every file, once (mappedTo).
  let every = false
  const reach = (path, by) => {
    if (path !== EVERY) return add(path, by)
    if (!every) for (const file of files.keys()) add(file, 'require')
    every = true
  }
  // A `#` specifier as the package's `imports` map it (mappedTo), to a path
  // of its own, read as a URL (urlJoined), or to its own name, as its
  // `exports` map that (subpathsOf), loaded as code takes it (`by`), once
  // each.
  const own = (value, by) => {
    if (seen.has(`${by}\0#\0${value}`)) return
    seen.add(`${by}\0#\0${value}`)
    for (const { dir, target } of mappedTo(specifiers, value)) {
      const paths = target === EVERY ? [EVERY] : target.startsWith('./') ? [urlJoined(root, dir, target)] : named(target) ? subpathsOf(`./${target.slice(top.name.length + 1)}`)
        : root.length > 0 && target === top.name ? subpathsOf('.') : []
      for (const path of paths) reach(path, by)
    }
  }
  // A string's value from the directory `dir`, a load `import` takes where
  // its place says so (`importing`), else one `require` may take, once each.
  const follow = (value, dir, importing) => {
    if (value.startsWith('#')) return own(value, importing() ? 'import' : 'require')
    const [from, spec] = named(value) ? ['', `./${value.slice(top.name.length + 1)}`] : [dir, value]
    if (!RELATIVE.test(spec.replaceAll('\\', '/'))) return
    const by = importing() ? 'import' : 'require', key = `${by}\0${from}\0${spec}`
    if (seen.has(key)) return
    seen.add(key)
    if (named(value)) for (const path of subpathsOf(spec)) reach(path, by)
    if (named(value) && top.hasExports) return
    if (by === 'require') for (const required of requiredPaths(root, from, spec)) requires(required, DIRECTORY.test(spec))
    add(urlJoined(root, from, spec), 'import')
  }
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index], text = files.get(path)
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    for (const { 1: double, 2: single, 3: template, index: start } of text.matchAll(strings)) {
      const body = double ?? single ?? template, quote = text[start]
      for (const value of valuesOf(quote, body)) follow(value, dir, () => imported(text, quote, start, start + body.length + 2))
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
