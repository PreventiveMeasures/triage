// A lockfile's text as the lockfile viewer takes it (lockfile-graph-inputs.js),
// read by @preventive/lockfile's reader of its format, as the server reads one
// for its packages (server-managed/locked-packages.ts). Loaded the first time a
// lockfile is viewed (lockfile-view.js): the readers are most of its weight.
import { parseNpmLockfile } from '@preventive/lockfile/npm.js'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'

const mapValues = (record, map) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]))
const targets = (...lists) => lists.flatMap(list => Object.values(list))

// Versions go unchecked against ranges, as only what is locked is drawn. A
// yarn.lock's importers come from the project's package.json (`manifest`,
// its text), which alone says what the project asks for; without one, or of
// a project with workspaces, whose package.json files aren't looked for, it
// has none.
export function readLockfile(format, text, { manifest } = {}) {
  if (format === 'npm') {
    // A dependency npm finds nowhere, or one a package bundles, has no target.
    const dependencies = holder => Object.values(holder.edges).map(edge => edge.target).filter(target => target !== undefined)
    const { importers, packages } = parseNpmLockfile(text, { checkVersions: false })
    return {
      importers: mapValues(importers, importer => ({ version: importer.version, dependencies: dependencies(importer) })),
      packages: mapValues(packages, pkg => ({ name: pkg.name, version: pkg.version, dependencies: dependencies(pkg) })),
    }
  }
  if (format === 'pnpm') {
    // The env document, pnpm 11's config dependencies and package manager,
    // is no part of the project's graph.
    const { lockfile } = parsePnpmLockfile(text)
    return {
      importers: mapValues(lockfile?.importers ?? {}, importer => ({
        dependencies: targets(importer.dependencies, importer.devDependencies, importer.optionalDependencies),
      })),
      packages: mapValues(lockfile?.packages ?? {}, pkg => ({
        name: pkg.name, version: pkg.version, dependencies: targets(pkg.dependencies, pkg.optionalDependencies),
      })),
    }
  }
  if (format !== 'yarn') throw new TypeError(`readLockfile: ${format} lockfiles are not read`)
  // Yarn 2 and later write another format, which only the text tells apart.
  if (/^__metadata:/mu.test(text)) throw new Error('a yarn.lock of Yarn 2 or later, which is not read')
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
}

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
