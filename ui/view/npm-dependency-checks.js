// What calls for a look among the dependencies a package version names: one
// npm fetches from elsewhere than its registry, and one nothing of the
// version imports, which npm installs all the same, running its install
// scripts, as a dependency added to run them alone would be. The Overview's
// Dependencies column (npm-package.js), Compare's chips (npm-overview.js)
// and the dependencies over its package.json (bundle-compare-code.js) flag
// them.
import { html } from 'lit'
import { installScripts } from './install-scripts.js'

// The kinds of dependency a manifest names, by its field
// (npm-package.js npmDependencies).
export const NPM_DEPENDENCY_KINDS = [['dependencies', null], ['peerDependencies', 'peer'], ['optionalDependencies', 'optional']]

// The hosts npm takes a repository on by name (`github:owner/repo`), as
// hosted-git-info, which reads them for it, has them; their domains, on
// which it takes one as `git@host:path` too, and over `ssh:`
// (`ssh://git@github.com/org/repo`) but SourceHut's.
const HOSTS = new Map([['github', 'GitHub'], ['gitlab', 'GitLab'], ['bitbucket', 'Bitbucket'], ['gist', 'Gist'], ['sourcehut', 'SourceHut']])
const SSH_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'gist.github.com'])
const GIT_HOSTS = new Set([...SSH_HOSTS, 'git.sr.ht'])
// GitHub's `owner/repo` shorthand, before a commit, branch or tag
// (`#v1.0.0`) or not, as hosted-git-info tells it: one slash, neither first
// nor last, and no space, `@` or `:`.
const GITHUB_SHORTHAND = /^[^/\s@:]+\/[^/\s@:]+$/u

// Where a dependency's spec has npm fetch it from, where that isn't its
// registry, as npm reads a spec (npm-package-arg's resolve): a host npm
// takes a repository on by name (`github:`, `gitlab:`, `bitbucket:`, `gist:`,
// `sourcehut:`); `git`, a repository's (`git:`, `git+https:`, `git+http:`,
// `git+ssh:`, `git+rsync:`, `git+ftp:`, `git+file:`, and over `ssh:` or as
// `git@host:path` on a host it knows, as on another it installs nothing);
// `URL`, a tarball's (`https:`, `http:`, with its `//` or without); GitHub,
// for its `owner/repo` shorthand. Null for the registry's ranges, tags and
// `npm:` aliases, for a path (`./x`, `~/x`, `/x`, `file:`), and for what npm
// doesn't install (`workspace:`, `git+foo:`), or reads as a path
// (`git@example.com:x/y`).
export function npmDependencySource(spec) {
  const value = String(spec ?? '').trim()
  if (/^(?:\.|~?\/)/u.test(value)) return null
  const scheme = /^(git\+)?([a-z]+):/iu.exec(value)
  const named = scheme && !scheme[1] && HOSTS.get(scheme[2].toLowerCase())
  if (named) return named
  if (/^(?:git|git\+(?:https?|ssh|rsync|ftp|file)):/iu.test(value)) return 'git'
  if (/^https?:/iu.test(value)) return 'URL'
  // As hosted-git-info reads them: `ssh:` and the host as spelled, `www.` aside.
  const host = (scheme ? /^ssh:\/\/(?:[^@/]*@)?([^:/#]+)/u : /^[^@\s]+@([^:/\s]+):/u).exec(value)?.[1].replace(/^www\./u, '')
  if ((scheme ? SSH_HOSTS : GIT_HOSTS).has(host)) return 'git'
  return !scheme && GITHUB_SHORTHAND.test(value.split('#', 1)[0]) ? 'GitHub' : null
}

// Files no import is read from: prose, by its extension (Markdown, text) or
// its name alone (`LICENSE-MIT`, `CHANGES`; not code named alike, as
// `lib/history.js`), source maps, which quote whatever their sources import,
// and lockfiles, which name every package installed; nor the package's own
// package.json, which names them all.
const NO_IMPORTS = /(?:\.(?:md|markdown|txt|rst|adoc|asciidoc|textile|map)|(?:^|\/)(?:(?:licen[cs]e|copying|notice|authors|contributors|readme|changelog|changes|history)(?:-[^/.]*)?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml))$/iu
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
  found = { whole: new Set(), parts: new Set(), commands: installScripts(npm?.manifest?.installScripts, sources.includes('binding.gyp')).map(([, command]) => command) }
  for (const [i, path] of sources.entries()) {
    if (typeof texts[i] !== 'string' || path === 'package.json' || NO_IMPORTS.test(path)) continue
    for (const [, run, end] of texts[i].matchAll(QUOTED)) {
      if (end && '-/'.includes(run.at(-1))) found.parts.add(run)
      if (end && end !== '${') found.whole.add(run)
      for (let at = run.indexOf('/'); at !== -1; at = run.indexOf('/', at + 1)) found.whole.add(run.slice(0, at))
    }
  }
  importsByVersion.set(json, found)
  return found
}

// Whether a command names `name` as a word (`prebuild-install || node-gyp
// rebuild`, `node node_modules/name/setup.js`).
function commandNames(command, name) {
  for (let at = command.indexOf(name); at !== -1; at = command.indexOf(name, at + 1)) {
    if (!/[\w@.-]/u.test(command[at - 1] ?? '') && !/[\w-]/u.test(command[at + name.length] ?? '')) return true
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
