import type { Package } from '@preventive/upstream/advisories.js'
import { satisfies, valid } from '@preventive/upstream/semver.js'
import type { BundleDetails } from '../common/bundle-metadata.js'

export interface SkippedAdvisoryPackage {
  ecosystem: string
  name: string
  version: string
  because: string
}
export interface BundleAdvisoryInventory { packages: Package[]; skipped: SkippedAdvisoryPackage[] }
interface BundleModule { ecosystem?: string; name?: string; version?: string; repo?: { github?: Package['github'] }; files: Record<string, unknown> }

// Match Stasis's audit evidence rules, including their verified version bounds:
// https://github.com/PreventiveMeasures/stasis/blob/2bd4c14354da9888c00ab45fa89740413099b5dc/stasis/src/audit-corrections.js
// Keep this on the server: upstream's semver implementation uses Node's npm.
const cargoManifests = ['Cargo.toml', 'Cargo.lock', '.cargo-checksum.json']
const solidityManifests = ['package.json', 'foundry.toml', 'remappings.txt', 'soldeer.toml']
const manifests = new Map([
  ['npm', ['package.json']],
  ['cargo', cargoManifests], ['cargo-git', cargoManifests], ['cargo-unknown', cargoManifests],
  ['composer', ['composer.json', 'composer.lock']],
  ['soldeer', solidityManifests], ['github', solidityManifests],
])
const browserStubRanges = new Map([['ws', '<=8.21.1'], ['node-fetch', '<=2.7.0']])

function isEvidence(ecosystem: string, name: string, version: string, file: string): boolean {
  if (manifests.get(ecosystem)?.includes(file.slice(file.lastIndexOf('/') + 1))) return false
  const stubRange = ecosystem === 'npm' && file === 'browser.js' ? browserStubRanges.get(name) : undefined
  return !stubRange || !valid(version) || !satisfies(version, stubRange)
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

// Package and reason presence both require a recorded evidence file. Entry and
// manually added files count even when they have no incoming import edge.
export function bundleAdvisoryInventory(details: BundleDetails, paths: Iterable<string> | null = null): BundleAdvisoryInventory {
  const modules = (details.bundle as { modules?: ReadonlyMap<string, BundleModule> } | undefined)?.modules
  if (details.kind !== 'stasis' || !modules) return { packages: [], skipped: [] }
  const selected = paths === null ? null : new Set(paths)
  const packages = new Map<string, { ecosystem: Package['ecosystem']; name: string; versions: Set<string>; github?: Package['github'] | null }>()
  const skipped = new Map<string, SkippedAdvisoryPackage>()
  for (const [dir, info] of modules) {
    if (dir === '.') continue
    const ecosystem = info.ecosystem ?? (/(?:^|\/)node_modules\//u.test(dir) ? 'npm' : undefined)
    const { name, version } = info
    if (ecosystem === undefined || typeof name !== 'string' || !name || typeof version !== 'string' || !version) continue
    if (!Object.keys(info.files).some(file => (!selected || selected.has(`${dir}/${file}`)) && isEvidence(ecosystem, name, version, file))) continue
    const because = skipReason(ecosystem, version)
    if (!supported(ecosystem) || because !== undefined) {
      skipped.set(JSON.stringify([ecosystem, name, version]), { ecosystem, name, version, because: because ?? `No advisory source is supported for ${ecosystem}.` })
      continue
    }
    // Foundry's branch '.' means the superproject's branch. As in Stasis,
    // 0.0.0 tells upstream its actual version is unknown, so every range covers it.
    const auditedVersion = ecosystem === 'github' && version === '.' ? '0.0.0' : version
    const key = JSON.stringify([ecosystem, ecosystem === 'github' ? name.toLowerCase() : name])
    if (!packages.has(key)) packages.set(key, { ecosystem, name, versions: new Set() })
    const pkg = packages.get(key)!
    pkg.versions.add(auditedVersion)
    const github = ecosystem === 'github' ? undefined : info.repo?.github
    if (github !== undefined) {
      // Upstream accepts one repository per package. Conflicting hints (for
      // example, versions from before and after a move) use registry discovery.
      if (pkg.github === undefined) pkg.github = github
      else if (pkg.github !== null && pkg.github.toLowerCase() !== github.toLowerCase()) pkg.github = null
    }
  }
  const byPackage = (a: { ecosystem: string; name: string }, b: { ecosystem: string; name: string }) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name)
  return {
    packages: [...packages.values()].map(({ github, ...pkg }) => ({ ...pkg, versions: [...pkg.versions].toSorted(), ...(github ? { github } : {}) })).toSorted(byPackage),
    skipped: [...skipped.values()].toSorted((a, b) => byPackage(a, b) || a.version.localeCompare(b.version)),
  }
}
