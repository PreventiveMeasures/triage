// What calls for a look among the dependencies a package version names: one
// npm fetches from elsewhere than its registry, and one nothing of the
// version imports, which npm installs all the same, running its install
// scripts, as a dependency added to run them alone would be.
import { isNpmPackageName } from '../../common/managed/npm-packages.js'
import { NPM_PROSE } from '../files/readability.js'
import { npmAlias, npmDependencySource, npmRegistrySpec } from './specs.js'
import { npmInstallScripts } from './install-scripts.js'

// The kinds of dependency a manifest names, by its field (npmDependencies).
const NPM_DEPENDENCY_KINDS = [['dependencies', null], ['peerDependencies', 'peer'], ['optionalDependencies', 'optional']]

// A version's dependencies, each `{ name, range, kind, opens }`, in name
// order: `kind` null for a plain dependency, else 'peer' or 'optional';
// `opens` the package the viewer opens for it, the one an `npm:` alias
// names, or null when it names none, or where npm doesn't install it from
// its registry (specs.js npmRegistrySpec: a path, a repository, a URL),
// whose package of that name isn't what it installs.
export function npmDependencies(manifest) {
  const rows = []
  for (const [field, kind] of NPM_DEPENDENCY_KINDS) {
    for (const [name, range] of Object.entries(manifest?.[field] ?? {})) {
      const opens = npmAlias(range)?.name ?? name
      rows.push({ name, range, kind, opens: isNpmPackageName(opens) && npmRegistrySpec(range) ? opens : null })
    }
  }
  return rows.toSorted((a, b) => a.name.localeCompare(b.name) || (a.kind ?? '').localeCompare(b.kind ?? ''))
}

// What two versions' dependencies differ in, by name and kind: those only
// `base` has, those only `other` has, and those whose range changed.
export function npmDependencyChanges(base, other) {
  const index = manifest => new Map(npmDependencies(manifest).map(row => [`${row.kind ?? ''}\0${row.name}`, row]))
  const after = index(other), before = index(base)
  const added = [], changed = [], removed = []
  for (const [key, { name, kind, range, opens }] of before) {
    const next = after.get(key)
    if (!next) removed.push({ key, name, kind, range, opens })
    else if (next.range !== range) changed.push({ key, name, kind, from: range, to: next.range, opens: next.opens })
  }
  for (const [key, { name, kind, range, opens }] of after) if (!before.has(key)) added.push({ key, name, kind, range, opens })
  return { removed, added, changed }
}

// Files no import is read from: prose, as the Overview tells it
// (readability.js NPM_PROSE; not code named alike, as
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

// DefinitelyTyped's stub of a package's types, once the package has types
// of its own (`@types/mkdirp` 2.0.0), depending on that package, the
// registry's by its name (`spec`, no `npm:` alias of another, no repository,
// URL or path): named as DefinitelyTyped publishes the package's types
// (`@types/name`, a scoped one's `@types/scope__name`), with nothing but
// prose beside its package.json, no declarations of its own.
const typesOf = name => `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`
const typesStubOf = ({ json, npm }, name, spec) => npm?.name === typesOf(name) && npmRegistrySpec(spec) && (npmAlias(spec)?.name ?? name) === name
  && (json.sources ?? []).every(path => path === 'package.json' || (NPM_PROSE.test(path) && !MDX.test(path)))

// Whether nothing of a version (`details`, its files and manifest) imports
// a dependency it names (`{ name, kind, range }`, or a changed one's `to`,
// npm-package.js npmDependencies): no code file names it as an import
// would, whole or by a part of it, nor does an install script npm runs
// (importsOf); never where its files aren't read. Not a peer dependency,
// which the package expects whoever installs it to provide, nor types from
// DefinitelyTyped (`@types/`), imported by another name, where no one else
// publishes; nor the package a stub of DefinitelyTyped's types of it
// depends on (typesStubOf), with no code to import it.
export function npmDependencyUnimported(details, { name, kind, range, to }) {
  if (!details?.json || kind === 'peer' || name.startsWith('@types/') || typesStubOf(details, name, to ?? range)) return false
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
// (npmDependencyFlags) against the one compared with (`base`), or alone,
// none given.
export function npmFlagDependencyChanges({ removed, added, changed }, base, other) {
  const was = base ? npmDependencySpecs(base.npm?.manifest) : null
  const flag = row => ({ ...row, flags: npmDependencyFlags(other, row, was) })
  return { removed, added: added.map(flag), changed: changed.map(flag) }
}
