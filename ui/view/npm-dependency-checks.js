// What calls for a look among the dependencies a package version names: one
// npm fetches from elsewhere than its registry, and one nothing of the
// version imports, which npm installs all the same, running its install
// scripts, as a dependency added to run them alone would be. The Overview's
// Dependencies column (npm-package.js), Compare's chips (npm-overview.js)
// and the dependencies over its package.json (bundle-compare-code.js) flag
// them.
import { html } from 'lit'
import { NPM_PROSE } from './file-readability.js'
import { npmInstallScripts } from './install-scripts.js'

// The kinds of dependency a manifest names, by its field
// (npm-package.js npmDependencies).
export const NPM_DEPENDENCY_KINDS = [['dependencies', null], ['peerDependencies', 'peer'], ['optionalDependencies', 'optional']]

// The hosts npm takes a repository on (hosted-git-info, which npm-package-arg
// reads a spec with): by name (`github:owner/repo`), or by its domain over
// the protocols each takes, where its path names a repository, `[user,
// project, committish]`, and not a tarball or a file.
const trim = project => project?.replace(/\.git$/u, '')
const GIT_HOSTS = new Map([
  ['github', { label: 'GitHub', domain: 'github.com', protocols: ['git:', 'http:', 'git+ssh:', 'git+https:', 'ssh:', 'https:'], repo({ pathname, hash }) {
    const [, user, project, type, committish] = pathname.split('/', 5)
    return (!type || type === 'tree') && user && trim(project) ? [user, trim(project), type ? committish : hash.slice(1)] : null
  } }],
  ['bitbucket', { label: 'Bitbucket', domain: 'bitbucket.org', protocols: ['git+ssh:', 'git+https:', 'ssh:', 'https:'], repo({ pathname, hash }) {
    const [, user, project, aux] = pathname.split('/', 4)
    return aux !== 'get' && user && trim(project) ? [user, trim(project), hash.slice(1)] : null
  } }],
  ['gitlab', { label: 'GitLab', domain: 'gitlab.com', protocols: ['git+ssh:', 'git+https:', 'ssh:', 'https:'], repo({ pathname, hash }) {
    const path = pathname.slice(1)
    const at = path.lastIndexOf('/')
    if (path.includes('/-/') || path.includes('/archive.tar.gz')) return null
    return path.slice(0, Math.max(at, 0)) && trim(path.slice(at + 1)) ? [path.slice(0, at), trim(path.slice(at + 1)), hash.slice(1)] : null
  } }],
  ['gist', { label: 'Gist', domain: 'gist.github.com', protocols: ['git:', 'git+ssh:', 'git+https:', 'ssh:', 'https:'], repo({ pathname, hash }) {
    const [, user, project, aux] = pathname.split('/', 4)
    return aux !== 'raw' && (user || project) ? [project ? user : null, trim(project || user), hash.slice(1)] : null
  } }],
  ['sourcehut', { label: 'SourceHut', domain: 'git.sr.ht', protocols: ['git+ssh:', 'https:'], repo({ pathname, hash }) {
    const [, user, project, aux] = pathname.split('/', 4)
    return aux !== 'archive' && user && trim(project) ? [user, trim(project), hash.slice(1)] : null
  } }],
])
const BY_DOMAIN = new Map([...GIT_HOSTS.values()].map(host => [host.domain, host]))
// The protocols hosted-git-info reads a URL by as it is, the hosts' names too.
const PROTOCOLS = new Set(['git+ssh:', 'ssh:', 'git+https:', 'git:', 'http:', 'https:', 'git+http:', ...[...GIT_HOSTS.keys()].map(name => `${name}:`)])

// GitHub's `owner/repo` shorthand, before a commit, branch or tag
// (`#v1.0.0`) or not, as hosted-git-info tells it: a slash, not first, nor
// last before any `#`; no `.` first; and no space, `@`, `:` or second slash
// before any `#`.
function githubShorthand(spec) {
  const hash = spec.indexOf('#'), slash = spec.indexOf('/')
  const beforeHash = at => at > -1 && !(hash > -1 && at > hash)
  return slash > 0 && !spec.startsWith('.') && (hash > -1 ? spec[hash - 1] !== '/' : !spec.endsWith('/'))
    && ![/\s/u.exec(spec)?.index ?? -1, spec.indexOf('@'), spec.indexOf(':'), spec.indexOf('/', slash + 1)].some(beforeHash)
}

// A URL as hosted-git-info parses one: a protocol it doesn't know put
// before a `git@host:path` (as `git+ssh://`) or given its `//`, and else
// `host:path` read as `host/path`.
const safeUrl = text => { try { return new URL(text) } catch { return null } }
function hostedUrl(spec) {
  const at = spec.indexOf('@'), colon = spec.indexOf(':')
  const corrected = PROTOCOLS.has(spec.slice(0, colon + 1)) || at > -1 && at < colon ? spec : at > -1 ? `git+ssh://${spec}`
    : spec.indexOf('//') === colon + 1 ? spec : `${spec.slice(0, colon + 1)}//${spec.slice(colon + 1)}`
  if (safeUrl(corrected)) return safeUrl(corrected)
  const before = char => { const hash = corrected.indexOf('#'); return corrected.lastIndexOf(char, hash > -1 ? hash : Infinity) }
  let scp = before(':') > before('@') ? `${corrected.slice(0, before(':'))}/${corrected.slice(before(':') + 1)}` : corrected
  if (scp.lastIndexOf(':', scp.indexOf('#') > -1 ? scp.indexOf('#') : Infinity) === -1 && !scp.includes('//')) scp = `git+ssh://${scp}`
  return safeUrl(scp)
}

// The host npm takes a spec's repository on (hosted-git-info's fromUrl), or
// null: one by its name, whatever its path, or by its domain over a protocol
// it takes, where its path names a repository; none whose parts don't
// decode.
function gitHost(spec) {
  if (!spec) return null
  const url = hostedUrl(githubShorthand(spec) ? `github:${spec}` : spec)
  if (!url) return null
  const named = GIT_HOSTS.get(url.protocol.slice(0, -1))
  const host = named ?? BY_DOMAIN.get(url.hostname.replace(/^www\./u, ''))
  const parts = named ? [url.pathname.replace(/^\/?[^@]*@|^\//u, ''), url.hash.slice(1)] : host?.protocols.includes(url.protocol) && host.repo(url)
  try { return parts ? (parts.forEach(part => part && decodeURIComponent(part)), host) : null } catch { return null }
}

// Where npm installs a dependency's spec from, read once in
// npm-package-arg's resolve order: `path` for a path (`./x`, `~/x`, `/x`,
// `c:/x`, `file:`); `registry` for an `npm:` alias of a registry package,
// or a spec with no `/` or `:` that names no tarball, which no later step
// takes; a repository on a host npm knows (gitHost), named for it
// (`GitHub`); for a URL, `git` for a repository's (`git:`, `git+https:`,
// `git+ssh:`, `git+http:`, `git+rsync:`, `git+ftp:`, `git+file:`, and
// `git+ssh://` to `user@host:path`), `URL` for a tarball's (`https:`,
// `http:`), and null for one npm doesn't install (`workspace:`, `ssh:` on
// another host); then `path` again for one with a `/` or a tarball's name
// (`a/b/c`, `x.tgz`, `git@example.com:x/y`), and else `registry`: a
// version, a range or a tag.
function specFrom(spec) {
  const value = String(spec ?? '').trim()
  if (/^(?:[.]|~\/|\/|[a-z]:|file:)/iu.test(value)) return 'path'
  if (/^npm:/iu.test(value) || !/[/:]|[.](?:tgz|tar\.gz|tar)$/iu.test(value)) return 'registry'
  const host = gitHost(value)
  if (host) return host.label
  if (/^(?:git\+)?[a-z]+:/iu.test(value)) {
    const scp = /^git\+ssh:\/\/([^:#]+:[^#]+(?:\.git)?)(?:#.*)?$/iu.exec(value)
    if (value.startsWith('git+ssh:') && scp && !/:\d+(?:\/|$)/u.test(scp[1])) return 'git'
    const protocol = safeUrl(value)?.protocol
    return /^(?:git|git\+(?:https?|rsync|ftp|file|ssh)):$/u.test(protocol) ? 'git' : /^https?:$/u.test(protocol) ? 'URL' : null
  }
  return /\/|[.](?:tgz|tar\.gz|tar)$/iu.test(value) ? 'path' : 'registry'
}

// Where a dependency's spec has npm fetch it from, where that isn't its
// registry (specFrom): a host's name (`GitHub`), `git` or `URL`. Null for
// the registry's ranges and tags, a path, and what npm doesn't install.
export function npmDependencySource(spec) {
  const from = specFrom(spec)
  return from === 'registry' || from === 'path' ? null : from
}

// The package and spec an `npm:` alias names (`npm:pkg@^1.2.3`), as
// specFrom reads one; null for a spec that isn't one.
export function npmAlias(spec) {
  const [, name, range = ''] = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@(.*))?$/iu.exec(String(spec ?? '').trim()) ?? []
  return name ? { name, spec: range } : null
}

// Whether npm installs a dependency's spec from its registry (specFrom):
// not from a path, a repository or a URL, nor a scheme npm doesn't install
// (`workspace:`), the registry's package of that name being what npm
// installs for none of those.
export const npmRegistrySpec = spec => specFrom(spec) === 'registry'

// Files no import is read from: prose, as the Overview tells it
// (file-readability.js NPM_PROSE; not code named alike, as
// `lib/history.js`), but MDX, which imports what it renders; source maps,
// which quote whatever their sources import, and lockfiles, which name every
// package installed; nor the package's own package.json, which names them all.
const MDX = /\.mdx$/iu
const NO_IMPORTS = /(?:\.map|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml))$/iu
// A quote, then a run of the characters names and paths are made of (after
// webpack's `~` too), and what ends it: a quote, escaped too, as a quote in
// a quoted command is in binding.gyp (`require(\'nan\')`), or a template's `${`.
const QUOTED = /["'`]~?([\w@./-]+)(\\?["'`]|\$\{)?/gu

// What of a version names a package as an import would, once a version, in
// one pass over its code files however many names are asked about: `whole`,
// each name quoted alone or before a path in it (`'name'`, `"name/sub"`);
// `parts`, each part of a name up to a `-` or `/` that a quote or a
// template's `${` ends, as a package builds a name from one to pick the
// build for the platform it runs on (`` `@rollup/rollup-${platform}` ``,
// `"@typescript/" + name`); and `commands`, the install scripts npm runs.
const importsByVersion = new WeakMap()
function importsOf({ json, npm }) {
  let found = importsByVersion.get(json)
  if (found) return found
  const sources = json.sources ?? [], texts = json.sourcesContent ?? []
  found = { whole: new Set(), parts: new Set(), commands: npmInstallScripts(npm?.manifest, sources).map(([, command]) => command) }
  for (const [i, path] of sources.entries()) {
    if (typeof texts[i] !== 'string' || path === 'package.json' || (NPM_PROSE.test(path) && !MDX.test(path)) || NO_IMPORTS.test(path)) continue
    for (const [, run, end] of texts[i].matchAll(QUOTED)) {
      if (end && '-/'.includes(run.at(-1))) found.parts.add(run)
      if (end && end !== '${') found.whole.add(run)
      for (let at = run.indexOf('/'); at !== -1; at = run.indexOf('/', at + 1)) found.whole.add(run.slice(0, at))
    }
  }
  importsByVersion.set(json, found)
  return found
}

// Whether a command names `name`: as a word (`prebuild-install || node-gyp
// rebuild`), or as the package installed in `node_modules` that a path
// leads into (`node node_modules/name/setup.js`); not as part of another
// path (`node scripts/name.js`, `node_modules/@scope/name`).
function commandNames(command, name) {
  for (let at = command.indexOf(name); at !== -1; at = command.indexOf(name, at + 1)) {
    const before = command.slice(0, at)
    if ((!/[\w@./-]$/u.test(before) || /node_modules\/(?:\.bin\/)?$/u.test(before)) && !/^[\w.-]/u.test(command.slice(at + name.length))) return true
  }
  return false
}

// Whether nothing of a version (`details`, its files and manifest) imports
// a dependency it names (`{ name, kind }`, npm-package.js npmDependencies):
// no code file names it as an import would, whole or by a part of it, nor
// does an install script npm runs (importsOf); never where its files aren't
// read. Not a peer dependency, which the package expects whoever installs it
// to provide, nor types from DefinitelyTyped (`@types/`), imported by
// another name, where no one else publishes.
export function npmDependencyUnimported(details, { name, kind }) {
  if (!details?.json || kind === 'peer' || name.startsWith('@types/')) return false
  const { whole, parts, commands } = importsOf(details)
  return !whole.has(name) && ![...name.slice(1).matchAll(/[-/]/gu)].some(({ index }) => parts.has(name.slice(0, index + 2)))
    && !commands.some(command => commandNames(command, name))
}

// Where a source takes a dependency from, in a sentence.
const SOURCE_NAMES = new Map([['URL', 'a URL'], ['git', 'a git repository']])

// What calls for a look at a dependency a version (`details`) names
// (`{ name, kind, range }`, or a changed one's `to`), as tags
// (`{ check, label, tooltip }`): `source` where npm fetches it from
// elsewhere than its registry (npmDependencySource), its spec in the
// tooltip, and `unimported` where nothing of the version imports it
// (npmDependencyUnimported). Against the specs another version named its
// dependencies by (`was`, npmDependencySpecs), only where it named this one
// by another spec, or, imported by nothing, not at all.
export function npmDependencyFlags(details, row, was = null) {
  const spec = row.to ?? row.range
  const source = npmDependencySource(spec)
  return [
    ...source && was?.get(row.name) !== spec ? [{ check: 'source', label: 'non-registry', tooltip: `From ${SOURCE_NAMES.get(source) ?? source}, not npm's registry: ${spec}` }] : [],
    ...!was?.has(row.name) && npmDependencyUnimported(details, row) ? [{ check: 'unimported', label: 'unimported',
      tooltip: `${was ? `New in ${details.npm?.version}, and nothing of it` : `Nothing of ${details.npm?.version}`} imports it: no code file names it as an import would, nor does an install script` }] : [],
  ]
}

// The specs a manifest names its dependencies by, by name, whatever their
// kind.
export const npmDependencySpecs = manifest => new Map(NPM_DEPENDENCY_KINDS.flatMap(([field]) => Object.entries(manifest?.[field] ?? {})))

// Two versions' dependency changes (npm-package.js npmDependencyChanges),
// each the open version (`other`) adds or changes with its `flags`
// (npmDependencyFlags) against the one compared with (`base`).
export function npmFlagDependencyChanges({ removed, added, changed }, base, other) {
  const was = npmDependencySpecs(base?.npm?.manifest)
  const flag = row => ({ ...row, flags: npmDependencyFlags(other, row, was) })
  return { removed, added: added.map(flag), changed: changed.map(flag) }
}

// A dependency's flags, as tags in its warning's color, each saying why in
// its tooltip: in the Overview's Dependencies column (npm-package.js), and
// in Compare's and over its package.json (bundle-compare.js,
// bundle-compare-code.js).
export const npmDependencyFlagTags = (flags = []) => flags.map(({ check, label, tooltip }) => html`<span class=${`npm-dependency-flag is-${check}`} data-tooltip=${tooltip}>${label}</span>`)
