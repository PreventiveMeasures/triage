// npm's provenance for a public version (npm-packages.ts npmManifest marks
// one that has it): the SLSA statement npm's registry keeps beside it,
// saying where the version was built: from which repository and commit, by
// which workflow, on which builder, in which run, with its entry in
// Sigstore's transparency log. Only a statement naming this version's
// tarball (its name, version and sha512 digest) is read; its signature isn't
// checked here, as npm checks it when the version is published. npm is asked
// without the server's token, and only about a version it answers for
// without one (http.ts), each answer kept as npm-insights.ts keeps its own.
import { Buffer } from 'node:buffer'
import { kept } from './kept.ts'
import { NpmPackageError, plainObject, readLimited } from './npm-packages.ts'

const ATTESTATIONS_API = 'https://registry.npmjs.org/-/npm/v1/attestations'
const ATTESTATIONS_BYTES = 1024 * 1024
const API_TIMEOUT_MS = 30_000
// SLSA's v1 statement, as npm writes it now, and v0.2, as it first did.
const SLSA = /^https:\/\/slsa\.dev\/provenance\/v(?:1|0\.2)$/u
const COMMIT = /^[0-9a-f]{40}$/u
const GITHUB_REPOSITORY = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/u

// Where a version was built: its source `repository` (an https URL) and
// `commit`, the `workflow` file and the `ref` it ran on, the `builder` and
// the `run` (an https URL), its transparency log entry (`logIndex`), and
// whose runner built it (`runner`: `github-hosted`, `gitlab-hosted` or
// `self-hosted`, as its signing certificate says); each null where they
// don't say.
export interface NpmProvenance {
  repository: string; commit: string | null; workflow: string | null; ref: string | null
  builder: string | null; run: string | null; logIndex: number | null; runner: string | null
}

const text = (value: unknown) => typeof value === 'string' && value !== '' && value.length <= 2048 ? value : null
const https = (value: unknown) => {
  const url = text(value)
  try { return url && new URL(url).protocol === 'https:' ? url : null } catch { return null }
}
// `git+https://github.com/org/repo@refs/heads/main` → the repository and
// ref; GitLab's names no ref (`git+https://gitlab.com/group/project`).
function sourceOf(uri: unknown) {
  const match = /^git\+(https:\/\/[^@\s]+?)(?:\.git)?(?:@(.+))?$/u.exec(text(uri) ?? '')
  return match ? { repository: https(match[1]), ref: match[2] ?? null } : { repository: null, ref: null }
}
// What `keys` lead to in `value`, through objects and arrays.
const field = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((at, key) => plainObject(at) || Array.isArray(at) ? (at as Record<string, unknown>)[key] : undefined, value)

// What a statement says of the build, as v1 or v0.2 says it; null where it
// names no source repository.
function readStatement(predicateType: string, predicate: unknown): NpmProvenance | null {
  if (predicateType.endsWith('v1')) {
    const workflow = field(predicate, 'buildDefinition', 'externalParameters', 'workflow')
    const source = field(predicate, 'buildDefinition', 'resolvedDependencies', '0')
    const repository = https(field(workflow, 'repository')) ?? sourceOf(field(source, 'uri')).repository
    if (!repository) return null
    const commit = text(field(source, 'digest', 'gitCommit'))
    return {
      repository, commit: commit && COMMIT.test(commit) ? commit : null, workflow: text(field(workflow, 'path')),
      ref: text(field(workflow, 'ref')) ?? sourceOf(field(source, 'uri')).ref, builder: https(field(predicate, 'runDetails', 'builder', 'id')),
      run: https(field(predicate, 'runDetails', 'metadata', 'invocationId')), logIndex: null, runner: null,
    }
  }
  const config = field(predicate, 'invocation', 'configSource')
  const { repository, ref } = sourceOf(field(config, 'uri'))
  if (!repository) return null
  const commit = text(field(config, 'digest', 'sha1'))
  // Its run: GitLab's job URL, or GitHub's as `<run id>-<attempt>`.
  const invocation = field(predicate, 'metadata', 'buildInvocationId')
  const run = /^(\d+)-(\d+)$/u.exec(text(invocation) ?? '')
  const github = GITHUB_REPOSITORY.exec(repository)?.[1]
  return {
    repository, commit: commit && COMMIT.test(commit) ? commit : null, workflow: text(field(config, 'entryPoint')), ref,
    builder: https(field(predicate, 'builder', 'id')),
    run: https(invocation) ?? (run && github ? `https://github.com/${github}/actions/runs/${run[1]}/attempts/${run[2]}` : null), logIndex: null, runner: null,
  }
}

// Fulcio's Runner Environment extension (1.3.6.1.4.1.57264.1.11) in the
// certificate that signed it: its OID, then its value, a short UTF8String
// in an OCTET STRING, as the CI's token gave it. A builder's id doesn't
// tell GitLab's own runners from a project's.
const RUNNER_ENVIRONMENT = Buffer.from('060a2b0601040183bf30010b', 'hex')
function runnerOf(bundle: unknown): string | null {
  const raw = field(bundle, 'verificationMaterial', 'certificate', 'rawBytes') ?? field(bundle, 'verificationMaterial', 'x509CertificateChain', 'certificates', '0', 'rawBytes')
  if (typeof raw !== 'string') return null
  const der = Buffer.from(raw, 'base64')
  const at = der.indexOf(RUNNER_ENVIRONMENT) + RUNNER_ENVIRONMENT.length
  if (at < RUNNER_ENVIRONMENT.length || der[at] !== 0x04 || der[at + 2] !== 0x0c || der[at + 1] !== der[at + 3]! + 2) return null
  return text(der.subarray(at + 4, at + 4 + der[at + 3]!).toString('utf8'))
}

async function askProvenance(name: string, version: string, integrity: string): Promise<NpmProvenance | null> {
  let res: Response
  try {
    res = await fetch(`${ATTESTATIONS_API}/${name.replace('/', '%2f')}@${encodeURIComponent(version)}`,
      { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT_MS) })
  } catch { throw new NpmPackageError(502, 'upstream-unavailable') }
  if (res.status === 404) { await res.body?.cancel(); return null }
  if (!res.ok) { await res.body?.cancel(); throw new NpmPackageError(502, 'upstream-unavailable') }
  let json: unknown
  try { json = JSON.parse((await readLimited(res, ATTESTATIONS_BYTES)).toString('utf8')) } catch { throw new NpmPackageError(502, 'upstream-invalid') }
  const attestations: unknown[] = Array.isArray(field(json, 'attestations')) ? field(json, 'attestations') as unknown[] : []
  const slsa = attestations.find(item => SLSA.test(text(field(item, 'predicateType')) ?? ''))
  if (!slsa) return null
  // The statement, whatever its length (the answer is bounded as a whole),
  // unlike the fields read out of it.
  const payload = field(slsa, 'bundle', 'dsseEnvelope', 'payload')
  let statement: unknown
  try { statement = JSON.parse(Buffer.from(typeof payload === 'string' ? payload : '', 'base64').toString('utf8')) } catch { return null }
  // Only one naming this version's tarball: its purl, and its digest as the
  // version's integrity has it.
  const purl = `pkg:npm/${name.replace(/^@/u, '%40')}@${version}`
  const digest = /^sha512-(.+)$/u.exec(integrity)?.[1]
  const subjects: unknown[] = Array.isArray(field(statement, 'subject')) ? field(statement, 'subject') as unknown[] : []
  if (!digest || !subjects.some(subject => field(subject, 'name') === purl && field(subject, 'digest', 'sha512') === Buffer.from(digest, 'base64').toString('hex'))) return null
  const provenance = readStatement(text(field(slsa, 'predicateType'))!, field(statement, 'predicate'))
  const logIndex = Number(field(slsa, 'bundle', 'verificationMaterial', 'tlogEntries', '0', 'logIndex'))
  return provenance && { ...provenance, logIndex: Number.isSafeInteger(logIndex) && logIndex >= 0 ? logIndex : null, runner: runnerOf(field(slsa, 'bundle')) }
}

const provenances = kept<NpmProvenance | null>(1000)

// npm's provenance for a version of a public package, its tarball's
// `integrity` as the registry has it; null where npm keeps none for it.
export function npmProvenance(name: string, version: string, integrity: string): Promise<NpmProvenance | null> {
  return provenances(`${name}@${version}`, () => askProvenance(name, version, integrity))
}

// One kept, asking for nothing; undefined where none is.
export const keptNpmProvenance = (name: string, version: string) => provenances.peek(`${name}@${version}`)
