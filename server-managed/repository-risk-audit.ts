// A lockfile's advisories, as a repository risk scan asks them
// (repository-risk.ts): npm's registry's of its packages of the registry or
// a mirror, asked at once, as `npm audit` asks, each told with whether it is
// of malware (risk's npmMalwareAdvisory); kept by the lockfile's blob, in the
// instance's memory and the source's `audits`, for RISK_KEPT_MS, as npm
// publishes advisories, or why they couldn't be had for AUDIT_FAILED_KEPT_MS.
import type { Advisory } from '@preventive/upstream/advisories.js'
import { isExactVersion } from '@preventive/upstream/semver.js'
import { npmMalwareAdvisory } from '../risk/index.js'
import { isNpmPackageName } from '../common/managed/npm-packages.js'
import type { LockedPackage } from './locked-packages.ts'
import type { Lru } from './lru.ts'
import type { KeptStore } from './npm-kept.ts'
import { RISK_KEPT_MS, type RiskFailure, failureOf } from './repository-risk-assess.ts'

export type AdvisoryRow = Advisory & { malware: boolean }
// A lockfile's advisories, or why they couldn't be had.
export type Audit = AdvisoryRow[] | RiskFailure

export interface AuditSource {
  // npm's registry's advisories of these packages' versions, asked at once.
  advisories(packages: { name: string; versions: string[] }[], signal: AbortSignal): Promise<Advisory[]>
  // Where audits are kept beyond this instance, by the lockfile's blob.
  audits?: KeptStore<Audit>
}

// How long a lockfile's advisories that couldn't be had are told so, rather
// than asked again: a scan's next parts don't wait on an audit that failed,
// as by timing out, again and again.
const AUDIT_FAILED_KEPT_MS = 10 * 60_000

// Whether an audit kept `at` is told as it is: its advisories within
// RISK_KEPT_MS, why they couldn't be had within AUDIT_FAILED_KEPT_MS.
const isFresh = ({ at, audit }: { at: number; audit: Audit }) => Date.now() - at < (Array.isArray(audit) ? RISK_KEPT_MS : AUDIT_FAILED_KEPT_MS)

// The audits of lockfiles, each of its `packages` by its `key` (auditLockfile),
// `inTurn` with others, asked at once: each null where it has none to ask
// of, or once `signal` aborts. Each is the caller's to tell once it may.
export function auditLockfiles(source: AuditSource, memory: Lru<{ at: number; audit: Audit }>, signal: AbortSignal,
  lockfiles: { key: string; packages: readonly LockedPackage[] | null }[], inTurn: <T>(work: () => Promise<T>) => Promise<T>): Promise<Audit | null>[] {
  return lockfiles.map(({ key, packages }) => {
    const audit = packages ? inTurn(() => (signal.aborted ? Promise.resolve(null) : auditLockfile(source, memory, signal, key, packages))) : Promise.resolve(null)
    // One no longer waited on, as the scan stopped, fails alone.
    audit.catch(() => {})
    return audit
  })
}

// The audit of a lockfile's `packages`, by its `key` as kept (`memory`, then
// the source's), else asked and kept; null where it locks none to ask of, or
// once `signal` aborts.
export async function auditLockfile(source: AuditSource, memory: Lru<{ at: number; audit: Audit }>, signal: AbortSignal, key: string,
  packages: readonly LockedPackage[]): Promise<Audit | null> {
  let kept = memory.get(key)
  if (!kept || !isFresh(kept)) {
    const stored = await source.audits?.read(key)
    kept = stored ? { at: stored.at, audit: stored.value } : undefined
  }
  if (kept && isFresh(kept)) { memory.set(key, kept); return kept.audit }
  const asked = new Map<string, Set<string>>()
  for (const { name, version, source: from } of packages) {
    if ((from !== 'registry' && from !== 'mirror') || !isNpmPackageName(name) || !isExactVersion(version)) continue
    if (!asked.has(name)) asked.set(name, new Set())
    asked.get(name)!.add(version)
  }
  if (asked.size === 0) return null
  let audit: Audit
  try {
    audit = (await source.advisories([...asked].map(([name, versions]) => ({ name, versions: [...versions] })), signal))
      .map(advisory => ({ ...advisory, malware: npmMalwareAdvisory(advisory) }))
  } catch (error) {
    if (signal.aborted) return null
    audit = failureOf(error)
  }
  const now = Date.now()
  memory.set(key, { at: now, audit })
  await source.audits?.write(key, audit, now)
  return audit
}
