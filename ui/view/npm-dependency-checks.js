// What calls for a look among the dependencies a package version names: one
// npm fetches from elsewhere than its registry, and one nothing of the
// version imports, which npm installs all the same, running its install
// scripts, as a dependency added to run them alone would be. The Overview's
// Dependencies column (npm-package.js), Compare's chips (npm-overview.js)
// and the dependencies over its package.json (bundle-compare-code.js) flag
// them.
import { html } from 'lit'
import { npmProse } from './file-readability.js'
import { installScripts } from './install-scripts.js'

// The hosts npm takes a repository on by name (`github:owner/repo`), as
// hosted-git-info, which reads them for it, has them.
const HOSTS = new Map([['github', 'GitHub'], ['gitlab', 'GitLab'], ['bitbucket', 'Bitbucket'], ['gist', 'Gist'], ['sourcehut', 'SourceHut']])

// GitHub's `owner/repo` shorthand, at a commit, branch or tag (`#v1.0.0`) or
// not, as hosted-git-info tells it: one slash, neither first nor last, and
// no space, `@`, `:` or second slash, before any `#`.
function githubShorthand(spec) {
  const head = spec.split('#', 1)[0], slash = head.indexOf('/')
  return slash > 0 && !head.endsWith('/') && head.indexOf('/', slash + 1) === -1 && !/[\s@:]/u.test(head)
}

// Where a dependency's spec has npm fetch it from, where that isn't its
// registry, as npm reads a spec (npm-package-arg), in its order: not a path
// (`./x`, `~/x`, `/x`, `c:\x`, `file:`), nor an `npm:` alias of a registry
// package; a host npm takes a repository on by name (`github:`, `gitlab:`,
// `bitbucket:`, `gist:`, `sourcehut:`); `git`, a repository's (`git:`,
// `git+https:`, `git+ssh:`, `ssh:`, `git@host:path`); `URL`, a tarball's
// (`https:`, `http:`, with its `//` or without); GitHub, for its
// `owner/repo` shorthand. Null for the registry's ranges and tags, and for
// any other scheme (`workspace:`), which npm doesn't install.
export function npmDependencySource(spec) {
  const value = String(spec ?? '').trim()
  if (/^(?:[.]|~\/|\/|[a-z]:|file:|npm:)/iu.test(value)) return null
  const scheme = /^(git\+)?([a-z]+):/iu.exec(value)
  if (scheme && !scheme[1] && HOSTS.has(scheme[2].toLowerCase())) return HOSTS.get(scheme[2].toLowerCase())
  if (scheme?.[1] || /^(?:git|ssh):/iu.test(value) || /^[^@]+@[^:.]+\.[^:]+:.+$/iu.test(value)) return 'git'
  if (scheme) return /^https?$/iu.test(scheme[2]) ? 'URL' : null
  return githubShorthand(value) ? 'GitHub' : null
}

// Files no import is read from: prose (file-readability.js), source maps,
// which quote whatever their sources import, and lockfiles, which name every
// package installed; nor the package's own package.json, which names them all.
const NO_IMPORTS = /(?:\.map|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml))$/iu
// A quote, then a run of the characters names and paths are made of (after
// webpack's `~` too), and what ends it: a quote, escaped too, as a quote in
// a quoted command is in binding.gyp (`require(\'nan\')`), or a template's `${`.
const QUOTED = /["'`]~?([\w@./-]+)(\\?["'`]|\$\{)?/gu

// What a version's code files name as an import would, once a version, in
// one pass over them, however many names are asked about: `whole` each name
// quoted alone or before a path in it (`'name'`, `"name/sub"`), and `parts`
// what a quote or a template's `${` ends, as a package builds a name from a
// part of it to pick the build for the platform it runs on
// (`` `@rollup/rollup-${platform}` ``, `"@typescript/" + name`).
const quotedByVersion = new WeakMap()
function quotedNames({ json }) {
  let quoted = quotedByVersion.get(json)
  if (quoted) return quoted
  quoted = { whole: new Set(), parts: new Set() }
  const texts = json.sourcesContent ?? []
  for (const [i, path] of (json.sources ?? []).entries()) {
    if (typeof texts[i] !== 'string' || path === 'package.json' || NO_IMPORTS.test(path) || npmProse(path)) continue
    for (const [, run, end] of texts[i].matchAll(QUOTED)) {
      if (end) quoted.parts.add(run)
      if (end && end !== '${') quoted.whole.add(run)
      for (let at = run.indexOf('/'); at !== -1; at = run.indexOf('/', at + 1)) quoted.whole.add(run.slice(0, at))
    }
  }
  quotedByVersion.set(json, quoted)
  return quoted
}

// Whether a version's code files name `name` as an import would
// (quotedNames): whole, or built from a part of it up to a `-` or `/`.
function quotes(details, name) {
  const { whole, parts } = quotedNames(details)
  return whole.has(name) || [...name.slice(1).matchAll(/[-/]/gu)].some(({ index }) => parts.has(name.slice(0, index + 2)))
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
// no code file names it as an import would (quotes), nor does an install
// script npm runs; never where its files aren't read. Not a peer dependency,
// which the package expects whoever installs it to provide, nor types from
// DefinitelyTyped (`@types/`), imported by another name, where no one else
// publishes.
export function npmDependencyUnimported(details, { name, kind }) {
  const json = details?.json
  if (!json || kind === 'peer' || name.startsWith('@types/')) return false
  const scripts = installScripts(details.npm?.manifest?.installScripts, json.sources?.includes('binding.gyp'))
  return !scripts.some(([, command]) => commandNames(command, name)) && !quotes(details, name)
}

// Where a source takes a dependency from, in a sentence.
const SOURCE_NAMES = new Map([['URL', 'a URL'], ['git', 'a git repository']])

// What calls for a look at a dependency a version (`details`) names
// (`{ name, kind, range }`), as tags (`{ check, label, tooltip }`):
// `source` where npm fetches it from elsewhere than its registry
// (npmDependencySource), its spec in the tooltip, and `unimported` where
// nothing of the version imports it (npmDependencyUnimported). Against the
// specs another version named its dependencies by (`was`, by name, whatever
// their kind), only where it named this one by another spec, or, imported
// by nothing, not at all.
export function npmDependencyFlags(details, row, { spec = row.range, was = null } = {}) {
  const source = npmDependencySource(spec)
  const fresh = was !== null && !was.has(row.name), version = details?.npm?.version
  return [
    ...source && was?.get(row.name) !== spec ? [{ check: 'source', label: 'non-registry', tooltip: `From ${SOURCE_NAMES.get(source) ?? source}, not npm's registry: ${spec}` }] : [],
    ...(was === null || fresh) && npmDependencyUnimported(details, row) ? [{ check: 'unimported', label: 'unimported',
      tooltip: `${fresh ? `New in ${version}, and nothing of it` : `Nothing of ${version}`} imports it: no code file names it as an import would, nor does an install script` }] : [],
  ]
}

// The specs a manifest names its dependencies by, by name, whatever their
// kind.
const specsOf = manifest => new Map(['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap(field => Object.entries(manifest?.[field] ?? {})))

// Two versions' dependency changes (npm-package.js npmDependencyChanges),
// each the open version (`other`) adds or changes with its `flags`
// (npmDependencyFlags) against the one compared with (`base`).
export function npmFlagDependencyChanges({ removed, added, changed }, base, other) {
  const was = specsOf(base?.npm?.manifest)
  const flag = (row, spec) => ({ ...row, flags: npmDependencyFlags(other, row, { spec, was }) })
  return { removed, added: added.map(row => flag(row, row.range)), changed: changed.map(row => flag(row, row.to)) }
}

// A dependency's flags, as tags in its warning's color, each saying why in
// its tooltip: in the Overview's Dependencies column (npm-package.js), and
// in Compare's and over its package.json (bundle-compare.js,
// bundle-compare-code.js).
export const npmDependencyFlagTags = (flags = []) => flags.map(({ check, label, tooltip }) => html`<span class=${`npm-dependency-flag is-${check}`} data-tooltip=${tooltip}>${label}</span>`)
