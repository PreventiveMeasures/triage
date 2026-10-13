// Hand-written against index.js; a change to either belongs with the other.
import type { CacheStore } from '@preventive/upstream/npm.js'

// How severe a stamp or a finding is, the most first: `critical` red, `high`
// a warning's orange, `moderate` yellow, `low`, and a `notice`.
export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'notice'

// The severities, the most severe first.
export const SEVERITIES: readonly Severity[]

// How old a version must be to be trusted unless said: two weeks, in ms.
export const DEFAULT_MINIMUM_RELEASE_AGE: number

// npm has no such package or version (`package-not-found`,
// `version-not-found`), a tarball unpacks past risk's bounds
// (`package-too-large`), npm asked to be asked later (`upstream-busy`, a 429,
// for a caller to wait on and ask again), or npm couldn't be asked
// (`upstream-unavailable`), answered past them (`upstream-too-large`) or
// answered what can't be read (`upstream-invalid`). `message` tells which
// request and why.
export class NpmRiskError extends Error {
  code: string
}

export interface AssessNpmOptions {
  // The version to compare with; without one, everything of the version is new.
  oldVersion?: string | null
  // Younger than this, in ms, a version is `too-new`; 0 for none, as a
  // caller's own scopes take. Two weeks unless given.
  minimumReleaseAge?: number
  // Whether the package is flagged as few download it (`popularity`); false
  // for none, as a caller's own scopes take, its downloads then not asked.
  // True unless given.
  popularity?: boolean
  // Where what is read is kept, by type (risk/npm/registry.js and assess.js
  // name each): `npm/tarballs`, `risk/npm/versions`, `risk/npm/packages`,
  // `risk/npm/public`, `risk/npm/downloads` and `risk/npm/assessments`.
  cache?: CacheStore | false
  // Asks for a package's whole document in risk's stead, as the managed
  // server does within its bounds: null where npm has none for this asker.
  // `authorized` whether it may be asked with the caller's npm token: the
  // package assessed, not its dependencies.
  packument?: (name: string, options: { authorized: boolean; signal: AbortSignal | undefined }) => Promise<Record<string, unknown> | null>
  // Reads a version's tarball, gzipped, in place of upstream's getTarball, as
  // the managed server does within its bounds: `version` the one assessed or
  // `oldVersion`, that one only where its files could change what is found.
  // What it throws is thrown as it is.
  tarball?: (name: string, version: string, options: { signal: AbortSignal | undefined }) => Promise<Uint8Array>
  now?: number
  signal?: AbortSignal
  // Whether npm's downloads are asked for: the package's popularity, and its
  // new dependencies' tiers and ages. True unless given.
  downloads?: boolean
  // Whether its new dependencies' tiers and ages are asked for, a request or
  // two of npm each, where `downloads` is. True unless given.
  dependencies?: boolean
  // Whether a package is the caller's own, as its own scopes take: a new
  // dependency on one is told no tier nor age, nor is npm asked of it. None
  // unless given.
  owned?: (name: string) => boolean | Promise<boolean>
}

// What calls for a look, by `id`, with what it found beside.
export interface Finding {
  id: string
  severity: Severity
  [found: string]: unknown
}

// A stamp on a file, as a list of files tags it.
export interface Stamp {
  name: string
  severity: Severity
}

export interface FileRisk {
  stamps: Stamp[]
  readability: Record<string, unknown>
  runsCode: Record<string, number[]> | null
  exfiltration: Record<string, number[]> | null
  hosts: Record<string, number> | null
}

export interface DependencyRisk {
  key: string
  name: string
  kind: 'peer' | 'optional' | null
  range?: string
  from?: string
  to?: string
  opens: string | null
  flags: { check: string; label: string; tooltip: string }[]
  tier?: number | null
  level?: string
  // Its last whole month's downloads, by what its tier goes by: none where
  // npm counts none of them.
  month?: { total: number; from: string }
  // Whether npm counts none of its downloads, as of a package published
  // the day before; unpopular all the same.
  uncounted?: true
  created?: string
  gap?: number
}

export interface NpmAssessment {
  name: string
  version: string
  oldVersion: string | null
  published: string | null
  findings: Finding[]
  files: Record<string, FileRisk>
  dependencies: { added: DependencyRisk[]; changed: DependencyRisk[] }
}

export function assessNpm(name: string, version: string, options?: AssessNpmOptions): Promise<NpmAssessment>

export function npmFileRisk(path: string, text: string | null, bytes?: number): unknown
