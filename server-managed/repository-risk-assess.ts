// A package's risk line, as a repository risk scan tells it
// (repository-risk.ts): its version's document read and assessed, as risk
// tells one npm removed where npm has none; and how a failure is told.
import { setTimeout as delay } from 'node:timers/promises'
import { NpmRiskError, SEVERITIES, type Severity } from '../risk/index.js'
import { GithubApiError } from './github-errors.ts'
import { NpmPackageError, type NpmVersionDocument } from './npm-packages.ts'
import type { RepositoryRiskLine } from './repository-risk.ts'

// An assessment refused as busy (`npm-busy`, by npm-risk.ts or the npm reads
// beneath it), or that npm asked to ask later (risk's `upstream-busy`, as its
// downloads API answers past a burst of requests), is asked again after a
// wait, up to this many times.
export const BUSY_RETRIES = 20
export const BUSY_WAIT_MS = 1000

// The most severe of `findings`, or null for none.
export function highestSeverity(findings: readonly { severity: Severity }[]): Severity | null {
  return SEVERITIES.find(severity => findings.some(finding => finding.severity === severity)) ?? null
}

// Why a step failed, as a line says it: an error's code, and for a lockfile
// refused, what of it its reader refused.
export type RiskFailure = { error: string; detail?: string }
type RiskLine = Extract<RepositoryRiskLine, { type: 'risk' }>

// What an error is known by: a GitHub or npm failure's code, or `failed`;
// GitHub not reached with what failed (githubUnreachable), while `doing` what
// of a repository, and risk's with what it asked of npm and how that failed,
// where they say.
export function failureOf(error: unknown, doing?: string): RiskFailure {
  if (error instanceof GithubApiError && error.detail) return { error: error.message, detail: doing ? `${doing}: ${error.detail}` : error.detail }
  if (error instanceof GithubApiError || error instanceof NpmPackageError) return { error: error.message }
  if (!(error instanceof NpmRiskError)) return { error: 'failed' }
  return error.message === error.code ? { error: error.code } : { error: error.code, detail: error.message }
}

export const isBusy = (error: unknown) => (error instanceof NpmPackageError && error.status === 429) || (error instanceof NpmRiskError && error.code === 'upstream-busy')

// A package to assess: npm's of its name and version, or, with an
// `integrity`, a mirror's held to it.
export interface AssessedPackage { name: string; version: string; integrity?: string }

export type Assessment = { published: string | null; findings: { id: string; severity: Severity; takenDown?: unknown }[]; score: { score: number } }

// What of a scan's source assessing a package asks (RepositoryRiskSource).
export interface AssessingSource {
  version(name: string, version: string, signal: AbortSignal): Promise<NpmVersionDocument>
  assess(doc: NpmVersionDocument, teamScoped: boolean, signal: AbortSignal): Promise<Assessment>
  removed(name: string, version: string, teamScoped: boolean, signal: AbortSignal): Promise<Assessment>
}

// A package's risk line, its version's document kept and the assessment asked
// again after a wait while the server is busy; null once the scan stops. A
// version npm has no document of is told as risk tells one npm removed
// (removedOf), its malware keeping whether its package was taken down.
export async function assessPackage(source: AssessingSource, signal: AbortSignal, pkg: AssessedPackage, teamScoped: boolean): Promise<RiskLine | null> {
  const at = { type: 'risk', ...pkg } as const
  let doc: NpmVersionDocument | NpmPackageError | undefined
  for (let attempt = 0; ; attempt++) {
    try {
      const read = doc ??= await documentOf(source, pkg, signal)
      if (!(read instanceof NpmPackageError) && pkg.integrity !== undefined && !pkg.integrity.split(/\s+/u).includes(read.dist.integrity)) return { ...at, error: 'integrity-mismatch' }
      const { published, findings, score } = read instanceof NpmPackageError ? await removedOf(source, pkg, teamScoped, signal, read) : await assessedOf(source, pkg, teamScoped, signal, read)
      const told = findings.map(({ id, severity, takenDown }) => ({ id, severity, ...takenDown === true ? { takenDown: true as const } : {} }))
      return { ...at, published, severity: highestSeverity(told), score: score.score, findings: told }
    } catch (error) {
      if (signal.aborted) return null
      if (!isBusy(error) || attempt >= BUSY_RETRIES) return { ...at, ...failureOf(error) }
      try { await delay(BUSY_WAIT_MS * Math.min(attempt + 1, 5), undefined, { signal }) } catch { return null }
    }
  }
}

// npm's document of a version, or its answer that it has none (a 404).
async function documentOf(source: AssessingSource, pkg: AssessedPackage, signal: AbortSignal): Promise<NpmVersionDocument | NpmPackageError> {
  try { return await source.version(pkg.name, pkg.version, signal) } catch (error) {
    if (error instanceof NpmPackageError && error.status === 404) return error
    throw error
  }
}

// A version's assessment; where risk finds npm no longer has it, as a document
// read from where versions' are kept doesn't tell, as one npm removed.
async function assessedOf(source: AssessingSource, pkg: AssessedPackage, teamScoped: boolean, signal: AbortSignal, doc: NpmVersionDocument): Promise<Assessment> {
  try { return await source.assess(doc, teamScoped, signal) } catch (error) {
    if (!(error instanceof NpmRiskError && error.code === 'version-not-found')) throw error
    return removedOf(source, pkg, teamScoped, signal, new NpmPackageError(404, 'package-not-found'))
  }
}

// A version npm has no document of, as risk tells one npm removed, as it
// removes every one it finds malware in (`removed`): `gone`, npm's answer of
// none, thrown where nothing tells of it.
async function removedOf(source: AssessingSource, pkg: AssessedPackage, teamScoped: boolean, signal: AbortSignal, gone: NpmPackageError): Promise<Assessment> {
  try { return await source.removed(pkg.name, pkg.version, teamScoped, signal) } catch (error) {
    throw error instanceof NpmRiskError && (error.code === 'version-not-found' || error.code === 'package-not-found') ? gone : error
  }
}
