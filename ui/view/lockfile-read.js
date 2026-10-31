// A lockfile's text as the lockfile viewer takes it (lockfile-graph-inputs.js),
// read by @preventive/lockfile's reader of its format, as the server reads an
// npm one for its packages (server-managed/locked-packages.ts). Loaded the
// first time a lockfile is viewed (lockfile-view.js); each format's reader,
// most of the weight, the first time a lockfile of that format is.
//
// What the viewer takes: `importers`, the project and its workspaces by
// directory, `.` for the project, each { version?, dependencies }; and
// `packages`, each copy installed by a key, { name, version?, dependencies }.
// A dependency is a key of `packages`, or `link:` and an importer's directory.

const mapValues = (record, map) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]))
const targets = (...lists) => lists.flatMap(list => Object.values(list))
const unique = list => [...new Set(list)]

// The project, where a lockfile names nothing it asks for itself: it asks for
// what nothing else does.
function inferredProject(packages) {
  const asked = new Set()
  for (const [key, pkg] of Object.entries(packages)) for (const dep of pkg.dependencies) if (dep !== key) asked.add(dep)
  return { '.': { dependencies: Object.keys(packages).filter(key => !asked.has(key)) } }
}

// What each package depends on where extras turn on more of it: the extras
// every edge to it asks for, settled through the edges those add in turn.
// `edgesOf(key, extras)` gives a package's edges with those of its extras on,
// each { to: [keys], extras }.
function settledDependencies(keys, edgesOf) {
  const asked = new Map(keys.map(key => [key, new Set()]))
  for (let changed = true; changed;) {
    changed = false
    for (const key of keys) {
      for (const { to, extras } of edgesOf(key, asked.get(key))) {
        for (const target of to) {
          for (const extra of extras) {
            const set = asked.get(target)
            if (set && !set.has(extra)) { set.add(extra); changed = true }
          }
        }
      }
    }
  }
  return new Map(keys.map(key => [key, unique(edgesOf(key, asked.get(key)).flatMap(edge => edge.to)).filter(to => to !== key)]))
}

// Python's lockfiles may list a name more than once, each copy for its own
// markers: each goes by `name==version`, and by its place where that repeats.
function pythonKeys(packages) {
  const used = new Set()
  return packages.map((pkg, i) => {
    const key = pkg.version === undefined ? pkg.name : `${pkg.name}==${pkg.version}`
    const unused = used.has(key) ? `${key} (${i})` : key
    used.add(unused)
    return unused
  })
}
// A Python package's name as PEP 503 holds names alike.
const pythonName = name => name.toLowerCase().replaceAll(/[-_.]+/gu, '-')

// The project's package.json, where it reads as one of no workspaces.
function yarnProject(manifest) {
  if (typeof manifest !== 'string') return null
  try {
    const project = JSON.parse(manifest)
    return project && typeof project === 'object' && !Array.isArray(project) && project.workspaces === undefined ? project : null
  } catch {
    return null
  }
}

// What composer.json requires, dev included, of the packages locked, by the
// lowercase names Composer goes by; null without one that reads.
function composerRequires(manifest, packages) {
  if (typeof manifest !== 'string') return null
  try {
    const json = JSON.parse(manifest)
    const names = [json?.require, json?.['require-dev']].flatMap(requires =>
      requires && typeof requires === 'object' && !Array.isArray(requires) ? Object.keys(requires) : [])
    return unique(names.map(name => name.toLowerCase()).filter(name => Object.hasOwn(packages, name)))
  } catch {
    return null
  }
}

// Each format's reading, by lockfileFormat's names. Versions go unchecked
// against ranges, as only what is locked is drawn.
const READERS = {
  // A dependency npm finds nowhere, or one a package bundles, has no target.
  async npm(text) {
    const { parseNpmLockfile } = await import('@preventive/lockfile/npm.js')
    const dependencies = holder => Object.values(holder.edges).map(edge => edge.target).filter(target => target !== undefined)
    const { importers, packages } = parseNpmLockfile(text, { checkVersions: false })
    return {
      importers: mapValues(importers, importer => ({ version: importer.version, dependencies: dependencies(importer) })),
      packages: mapValues(packages, pkg => ({ name: pkg.name, version: pkg.version, dependencies: dependencies(pkg) })),
    }
  },

  // The env document, pnpm 11's config dependencies and package manager, is
  // no part of the project's graph.
  async pnpm(text) {
    const { parsePnpmLockfile } = await import('@preventive/lockfile/pnpm.js')
    const { lockfile } = parsePnpmLockfile(text)
    return {
      importers: mapValues(lockfile?.importers ?? {}, importer => ({
        dependencies: targets(importer.dependencies, importer.devDependencies, importer.optionalDependencies),
      })),
      packages: mapValues(lockfile?.packages ?? {}, pkg => ({
        name: pkg.name, version: pkg.version, dependencies: targets(pkg.dependencies, pkg.optionalDependencies),
      })),
    }
  },

  // A yarn.lock's importers come from the project's package.json (`manifest`,
  // its text), which alone says what the project asks for; without one, or of
  // a project with workspaces, whose package.json files aren't looked for, it
  // has none.
  async yarn(text, manifest) {
    // Yarn 2 and later write another format, which only the text tells apart.
    if (/^__metadata:/mu.test(text)) throw new Error('a yarn.lock of Yarn 2 or later, which is not read')
    const { parseYarn1Lockfile } = await import('@preventive/lockfile/yarn1.js')
    const project = yarnProject(manifest)
    const { importers, packages } = parseYarn1Lockfile(text, { checkVersions: false, ...project && { manifests: { '.': project } } })
    // The patterns of one entry share its object: one node each, by its first.
    const keys = new Map()
    for (const [pattern, pkg] of Object.entries(packages)) if (!keys.has(pkg)) keys.set(pkg, pattern)
    const nodeOf = target => target.startsWith('link:') ? target : keys.get(packages[target])
    return {
      importers: mapValues(importers ?? {}, importer => ({ version: project.version,
        dependencies: targets(importer.dependencies, importer.devDependencies, importer.optionalDependencies).map(nodeOf) })),
      packages: Object.fromEntries([...keys].map(([pkg, key]) => [key, {
        // Yarn 1 names an alias, `my-q@npm:q@^1.5.1`, by its own name.
        name: /@npm:((?:@[^/@]+\/)?[^/@]+)/u.exec(pkg.patterns[0] ?? '')?.[1] ?? pkg.name,
        version: pkg.version,
        dependencies: targets(pkg.dependencies, pkg.optionalDependencies).map(nodeOf),
      }])),
    }
  },

  // The Gemfile asks for gems by name, as gems ask for each other: each is
  // locked once for every platform Bundler locked it for, a copy each, at its
  // version and platform as RubyGems names it. Bundler itself is locked as
  // no gem, nor is a gem for a platform that isn't.
  async bundler(text) {
    const { parseGemfileLock } = await import('@preventive/lockfile/bundler.js')
    const { specs, gems, dependencies } = parseGemfileLock(text)
    const locked = name => Object.hasOwn(gems, name) ? gems[name] : []
    return {
      importers: { '.': { dependencies: Object.keys(dependencies).flatMap(locked) } },
      packages: mapValues(specs, spec => ({ name: spec.name, version: spec.platform === 'ruby' ? spec.version : `${spec.version}-${spec.platform}`,
        dependencies: Object.keys(spec.dependencies).flatMap(locked) })),
    }
  },

  // A crate of no source is the workspace's own, or a path dependency of it:
  // an importer, by its name, which a Cargo.lock names no directory of, or
  // its key where two share one. Every dependency kind counts.
  async cargo(text) {
    const { parseCargoLock } = await import('@preventive/lockfile/cargo.js')
    const entries = Object.entries(parseCargoLock(text).packages)
    const local = entries.filter(([, pkg]) => pkg.source === undefined)
    const named = new Map()
    for (const [, pkg] of local) named.set(pkg.name, (named.get(pkg.name) ?? 0) + 1)
    const dirs = new Map(local.map(([key, pkg]) => [key, named.get(pkg.name) > 1 ? key : pkg.name]))
    const target = key => dirs.has(key) ? `link:${dirs.get(key)}` : key
    return {
      importers: Object.fromEntries(local.map(([key, pkg]) => [dirs.get(key), { version: pkg.version, dependencies: pkg.dependencies.map(target) }])),
      packages: Object.fromEntries(entries.filter(([key]) => !dirs.has(key)).map(([key, pkg]) =>
        [key, { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies.map(target) }])),
    }
  },

  // The Podfile asks for pods, a subspec (`Firebase/Core`) a copy of its
  // root's package. A podspec lists what it depends on for every platform,
  // and may name a pod not installed for this one, which is left out.
  async cocoapods(text) {
    const { parsePodfileLock } = await import('@preventive/lockfile/cocoapods.js')
    const { pods, dependencies } = parsePodfileLock(text)
    const installed = ({ name }) => Object.hasOwn(pods, name) ? [name] : []
    return {
      importers: { '.': { dependencies: unique(dependencies.flatMap(installed)) } },
      packages: mapValues(pods, pod => ({ name: pod.root, version: pod.version, dependencies: unique(pod.dependencies.flatMap(installed)) })),
    }
  },

  // What the project requires is in its composer.json (`manifest`), not the
  // lockfile; without one, it requires what nothing else does. A platform
  // requirement (PHP, an extension) is met by no package.
  async composer(text, manifest) {
    const { parseComposerLock } = await import('@preventive/lockfile/composer.js')
    const packages = mapValues(parseComposerLock(text).packages, pkg => ({ name: pkg.name, version: pkg.version,
      dependencies: unique(Object.values(pkg.require).flatMap(require => require.targets)) }))
    const required = composerRequires(manifest, packages)
    return { importers: required ? { '.': { dependencies: required } } : inferredProject(packages), packages }
  },

  // What the project asks for is in its pyproject.toml, not the lockfile: it
  // asks for what nothing else does. A dependency marked optional is one only
  // an extra a dependent asks for turns on.
  async poetry(text) {
    const { parsePoetryLock } = await import('@preventive/lockfile/poetry.js')
    const list = parsePoetryLock(text).packages
    const keys = pythonKeys(list)
    const byName = Map.groupBy(keys, (key, i) => pythonName(list[i].name))
    const index = new Map(keys.map((key, i) => [key, list[i]]))
    const dependencies = settledDependencies(keys, (key, extras) => {
      const pkg = index.get(key)
      // An extra lists requirements in PEP 508's text, its name first.
      const turnedOn = new Set([...extras].flatMap(extra => (pkg.extras[extra] ?? []).map(req => pythonName(/^[\w.-]+/u.exec(req)?.[0] ?? ''))))
      return Object.entries(pkg.dependencies).filter(([name, deps]) => deps.some(dep => !dep.optional) || turnedOn.has(pythonName(name)))
        .map(([name, deps]) => ({ to: byName.get(pythonName(name)) ?? [], extras: unique(deps.flatMap(dep => dep.extras)) }))
    })
    const packages = Object.fromEntries(keys.map((key, i) => [key, { name: list[i].name, version: list[i].version, dependencies: dependencies.get(key) }]))
    return { importers: inferredProject(packages), packages }
  },

  // The workspace's own packages are its importers, by the directory each is
  // in, `.` for the project at its root, and with every extra and group of
  // theirs on; another package's extras are those its dependents ask for.
  async uv(text) {
    const { parseUvLock } = await import('@preventive/lockfile/uv.js')
    const { packages: locked, members } = parseUvLock(text)
    const own = new Map(members.map(key => [key, locked[key].source.path ?? key]))
    const keys = Object.keys(locked)
    const dependencies = settledDependencies(keys, (key, extras) => {
      const pkg = locked[key]
      const extra = own.has(key) ? [...Object.values(pkg.optionalDependencies), ...Object.values(pkg.devDependencies)].flat()
        : [...extras].flatMap(name => pkg.optionalDependencies[name] ?? [])
      return [...pkg.dependencies, ...extra].map(dep => ({ to: [dep.package], extras: dep.extras }))
    })
    const target = key => own.has(key) ? `link:${own.get(key)}` : key
    const packages = Object.fromEntries(keys.filter(key => !own.has(key)).map(key =>
      [key, { name: locked[key].name, version: locked[key].version, dependencies: dependencies.get(key).map(target) }]))
    const importers = Object.fromEntries(members.map(key => [own.get(key), { version: locked[key].version, dependencies: dependencies.get(key).map(target) }]))
    return { importers: members.length > 0 ? importers : inferredProject(packages), packages }
  },

  // A pylock.toml may say what each package depends on, by its place; one
  // that doesn't, as uv's doesn't, draws the project asking for each.
  async pylock(text) {
    const { parsePylock } = await import('@preventive/lockfile/pylock.js')
    const list = parsePylock(text).packages
    const keys = pythonKeys(list)
    const packages = Object.fromEntries(keys.map((key, i) =>
      [key, { name: list[i].name, version: list[i].version, dependencies: unique(list[i].dependencies.map(at => keys[at])) }]))
    return { importers: inferredProject(packages), packages }
  },

  // Soldeer installs what the project asks for alone, none of their own.
  async soldeer(text) {
    const { parseSoldeerLockfile } = await import('@preventive/lockfile/soldeer.js')
    const packages = Object.fromEntries(Object.values(parseSoldeerLockfile(text).dependencies).map(dep =>
      [`${dep.name}@${dep.version}`, { name: dep.name, version: dep.version, dependencies: [] }]))
    return { importers: { '.': { dependencies: Object.keys(packages) } }, packages }
  },

  // forge's git submodules, by path, each named by its directory, at its tag,
  // its branch and commit, or its commit; their own aren't recorded.
  async foundry(text) {
    const { parseFoundryLockfile } = await import('@preventive/lockfile/foundry.js')
    const packages = Object.fromEntries(Object.entries(parseFoundryLockfile(text).dependencies).map(([path, dep]) => [path, {
      name: path.slice(path.lastIndexOf('/') + 1),
      version: dep.type === 'tag' ? dep.name : dep.type === 'branch' ? `${dep.name}@${dep.rev.slice(0, 7)}` : dep.rev.slice(0, 12),
      dependencies: [],
    }]))
    return { importers: { '.': { dependencies: Object.keys(packages) } }, packages }
  },
}

// A lockfile of `format` (lockfileFormat's), with the manifest beside it that
// the format's project is named by, its text, where it has one
// (lockfileManifest). A format not read rejects, as a lockfile not read does.
export async function readLockfile(format, text, { manifest } = {}) {
  if (!Object.hasOwn(READERS, format)) throw new TypeError(`readLockfile: ${format} lockfiles are not read`)
  return await READERS[format](text, manifest)
}
