import { Buffer } from 'node:buffer'
import { isEvidenceFile } from '@exodus/stasis/audit-corrections'
import { packageRepo } from '@exodus/stasis-core/bundle-util'
import type { Package } from '@preventive/upstream/advisories.js'
import type { BundleDetails } from '../common/bundle-metadata.js'

interface SkippedAdvisoryPackage {
  ecosystem: string
  name: string
  version: string
  because: string
}
export interface BundleAdvisoryInventory { packages: Package[]; skipped: SkippedAdvisoryPackage[] }
interface BundleModule { ecosystem?: string; name?: string; version?: string; repo?: { github?: Package['github'] }; files: Record<string, unknown> }

// The GitHub repository a bundled package.json's text names, read as Stasis
// records a dependency's (packageRepo) and as Node reads the file, past a byte
// order mark the bundle keeps. Undefined where it names none or doesn't parse.
function manifestRepo(text: unknown): Package['github'] {
  if (typeof text !== 'string') return undefined
  try { return packageRepo(JSON.parse(text.replace(/^\uFEFF/u, '')))?.github } catch { return undefined }
}

function supported(ecosystem: string): ecosystem is Package['ecosystem'] {
  return ['npm', 'cargo', 'composer', 'soldeer', 'github'].includes(ecosystem)
}

function skipReason(ecosystem: string, version: string): string | undefined {
  if (ecosystem === 'cargo-git') return 'Crate vendored from git; its identity is not a crates.io package.'
  if (ecosystem === 'cargo-unknown') return 'Crate source is unknown because .cargo-checksum.json is missing.'
  if (ecosystem === 'composer' && /^dev-|-dev$/iu.test(version.replace(/#.*$/su, ''))) return 'Composer dev versions cannot be matched against release advisories.'
  return undefined
}

// A dependency module as an inventory reads it: the package version it is of,
// or why none is audited (`because`), the repository it names, and the paths
// of its evidence files.
type AuditedModule = { name: string; version: string; evidence: string[] }
  & ({ ecosystem: Package['ecosystem']; github: Package['github'] } | { ecosystem: string; because: string })

const packageKey = (pkg: { ecosystem: string; name: string }) => JSON.stringify([pkg.ecosystem, pkg.ecosystem === 'github' ? pkg.name.toLowerCase() : pkg.name])
const skippedKey = (pkg: { ecosystem: string; name: string; version: string }) => JSON.stringify([pkg.ecosystem, pkg.name, pkg.version])

// A bundle's dependency modules, read once for the inventories of its scopes.
// Package and reason presence both require a recorded evidence file, by Stasis's
// audit rule (server-only, as its semver uses Node's npm): a module without
// one is none.
export function advisoryModules(details: BundleDetails): AuditedModule[] {
  const modules = (details.bundle as { modules?: ReadonlyMap<string, BundleModule> } | undefined)?.modules
  if (details.kind !== 'stasis' || !modules) return []
  const audited: AuditedModule[] = []
  for (const [dir, info] of modules) {
    if (dir === '.') continue
    const ecosystem = info.ecosystem ?? (/(?:^|\/)node_modules\//u.test(dir) ? 'npm' : undefined)
    const { name, version } = info
    if (ecosystem === undefined || typeof name !== 'string' || !name || typeof version !== 'string' || !version) continue
    const evidence = Object.keys(info.files).filter(file => isEvidenceFile(name, version, file, ecosystem)).map(file => `${dir}/${file}`)
    if (evidence.length === 0) continue
    const because = skipReason(ecosystem, version)
    if (!supported(ecosystem) || because !== undefined) {
      audited.push({ ecosystem, name, version, evidence, because: because ?? `No advisory source is supported for ${ecosystem}.` })
      continue
    }
    // A bundle from before Stasis recorded `repo` may still carry the npm
    // package's package.json; ask the repository it names, as Stasis does.
    let github = ecosystem === 'github' ? undefined : info.repo?.github
    if (github === undefined && ecosystem === 'npm') github = manifestRepo(info.files['package.json'])
    audited.push({ ecosystem, name, version, evidence, github })
  }
  return audited
}

// The inventory of the `modules` (advisoryModules) with an evidence file among
// `selected`: of them all for null. Entry and manually added files count even
// when they have no incoming import edge.
export function advisoryInventoryOf(modules: AuditedModule[], selected: ReadonlySet<string> | null): BundleAdvisoryInventory {
  const packages = new Map<string, { ecosystem: Package['ecosystem']; name: string; versions: Set<string>; github?: Package['github'] | null }>()
  const skipped = new Map<string, SkippedAdvisoryPackage>()
  for (const module of modules) {
    if (selected && !module.evidence.some(path => selected.has(path))) continue
    const { ecosystem, name, version } = module
    if ('because' in module) {
      skipped.set(skippedKey(module), { ecosystem, name, version, because: module.because })
      continue
    }
    // Foundry's branch '.' means the superproject's branch. As in Stasis,
    // 0.0.0 tells upstream its actual version is unknown, so every range covers it.
    const auditedVersion = module.ecosystem === 'github' && version === '.' ? '0.0.0' : version
    const key = packageKey(module)
    if (!packages.has(key)) packages.set(key, { ecosystem: module.ecosystem, name, versions: new Set() })
    const pkg = packages.get(key)!
    pkg.versions.add(auditedVersion)
    if (module.github !== undefined) {
      // Upstream accepts one repository per package. Conflicting hints (for
      // example, versions from before and after a move) use registry discovery.
      if (pkg.github === undefined) pkg.github = module.github
      else if (pkg.github !== null && pkg.github.toLowerCase() !== module.github.toLowerCase()) pkg.github = null
    }
  }
  const byPackage = (a: { ecosystem: string; name: string }, b: { ecosystem: string; name: string }) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name)
  return {
    packages: [...packages.values()].map(({ github, ...pkg }) => ({ ...pkg, versions: [...pkg.versions].toSorted(), ...(github ? { github } : {}) })).toSorted(byPackage),
    skipped: [...skipped.values()].toSorted((a, b) => byPackage(a, b) || a.version.localeCompare(b.version)),
  }
}

// The bundle's inventory, or that of its files among `paths`.
export function bundleAdvisoryInventory(details: BundleDetails, paths: Iterable<string> | null = null): BundleAdvisoryInventory {
  return advisoryInventoryOf(advisoryModules(details), paths === null ? null : new Set(paths))
}

// A scope's inventory as kept beside the bundle's own (`all`): the rows of it
// the scope holds, a bit each, a package's versions in order and then the
// skipped, in base64; and the repository of each package it names otherwise
// than the whole bundle does (null for none), by the package's place. A
// bundle's scopes are many, and most of it each.
export interface InventoryRows { rows: string; github?: Record<number, string | null> }
export function inventoryRows(all: BundleAdvisoryInventory, scoped: BundleAdvisoryInventory): InventoryRows {
  const packages = new Map(scoped.packages.map(pkg => [packageKey(pkg), pkg]))
  const skipped = new Set(scoped.skipped.map(skippedKey))
  const github: Record<number, string | null> = {}, kept: boolean[] = []
  for (const [at, pkg] of all.packages.entries()) {
    const own = packages.get(packageKey(pkg))
    for (const version of pkg.versions) kept.push(own?.versions.includes(version) ?? false)
    if (own && own.github !== pkg.github) github[at] = own.github ?? null
  }
  for (const pkg of all.skipped) kept.push(skipped.has(skippedKey(pkg)))
  const bits = Buffer.alloc(Math.ceil(kept.length / 8))
  for (const [row, held] of kept.entries()) if (held) bits[row >> 3]! |= 1 << (row & 7)
  return { rows: bits.toString('base64'), ...(Object.keys(github).length > 0 ? { github } : {}) }
}

// The inventory that `kept` (inventoryRows) holds of `all`.
export function inventoryOfRows(all: BundleAdvisoryInventory, kept: InventoryRows): BundleAdvisoryInventory {
  const bits = Buffer.from(kept.rows, 'base64'), named = kept.github ?? {}
  let row = 0
  const held = () => { const at = row++; return ((bits[at >> 3] ?? 0) & (1 << (at & 7))) !== 0 }
  const packages = all.packages.flatMap(({ github, ...pkg }, at) => {
    const versions = pkg.versions.filter(held)
    const repo = Object.hasOwn(named, at) ? named[at] : github
    return versions.length > 0 ? [{ ...pkg, versions, ...(repo ? { github: repo } : {}) }] : []
  })
  return { packages, skipped: all.skipped.filter(held) }
}
