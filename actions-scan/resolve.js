// A reference to an action or a reusable workflow on GitHub (uses.js),
// resolved: the repository it names as GitHub has it now, the commit its ref
// is, and its own code at that commit, read as a workflow's is
// (findings.js), each `{ id, severity, … }`:
//
// - The repository: `repo-missing`, none GitHub has, red, as anyone who
//   takes its owner's name can publish one, yellow for the same owner's,
//   which may only be one this access can't read; `repo-moved`, renamed or
//   transferred, orange, as GitHub redirects the old name until someone
//   takes it; `repo-fork`, a fork, and `repo-archived`, low.
// - A ref not a commit: `branch-ref`, a branch, which moves with every
//   push, orange; `ambiguous-ref`, a tag and a branch of one name, orange;
//   `ref-missing`, neither, yellow, as GitHub runs whichever is pushed
//   first; `not-version`, a tag that is no version (`latest`), yellow;
//   `tag-off-release`, a major or minor tag (`v4`) on a commit no release of
//   its line is on, orange, as a tag moved by whoever took the repository
//   is; `tag-off-branch`, a tag's commit on none of its branches, low, as a
//   release's built files may be; `outdated`, a major line older than the
//   latest, low.
// - A commit: `imposter-commit`, in the history of none of the repository's
//   branches and releases, red: GitHub serves a fork's commit under the
//   name of the repository it forked; `unverified-commit`, where more
//   branches are than were looked at, orange; `commit-missing`, none GitHub
//   has, orange; `untagged-commit`, one no tag names, no release, yellow;
//   `comment-mismatch`, a version the comment beside it names (`# v4.1.1`)
//   that isn't the commit's, orange.
// - Its code: `action-missing`, no action.yml where it names, yellow; and
//   each finding of its action.yml, its Dockerfile, or the reusable
//   workflow, with the `file` it is in.
//
// `source` reads GitHub (index.d.ts ActionsSource). What it throws is thrown
// as it is.
import { ActionsScanError, readWorkflow } from './workflow.js'
import { workflowFindings, workflowUses } from './findings.js'
import { dockerfileFindings } from './dockerfile.js'
import { ownerKind, readUses, usesKey } from './uses.js'
import { latestOf, newestOfLines, ofLine, tagVersion, versionsOf } from './versions.js'

// How many of a repository's other branches, and releases' major lines, a
// commit is looked for in the history of.
const MAX_BRANCHES = 10
const MAX_LINES = 10

async function repositoryOf(uses, source, owner) {
  const info = await source.repo(uses.repo)
  if (!info) return { info: null, findings: [{ id: 'repo-missing', severity: ownerKind(uses.repo, owner) === 'own' ? 'moderate' : 'critical' }] }
  const findings = []
  if (info.fullName.toLowerCase() !== uses.repo.toLowerCase()) findings.push({ id: 'repo-moved', severity: 'high', to: info.fullName })
  if (info.fork) findings.push({ id: 'repo-fork', severity: 'low', parent: info.fork })
  if (info.archived) findings.push({ id: 'repo-archived', severity: 'low' })
  return { info, findings }
}

// Where `sha` is in the repository's history: on its default branch
// (`default`), in a release's (`release`), on another branch (`branch`); in
// none (`none`), or none of those looked at where more are (`unknown`); or
// `missing`, a commit GitHub hasn't.
async function reachable(source, info, sha, tags) {
  const name = info.fullName
  const onDefault = await source.contains(name, info.defaultBranch, sha)
  if (onDefault === null) return 'missing'
  if (onDefault) return 'default'
  for (const { oid } of newestOfLines(tags ?? []).slice(0, MAX_LINES)) if (oid === sha || await source.contains(name, oid, sha)) return 'release'
  const { branches, complete } = await source.branches(name)
  const others = branches.filter(({ branch }) => branch !== info.defaultBranch)
  for (const { oid } of others.slice(0, MAX_BRANCHES)) if (oid === sha || await source.contains(name, oid, sha)) return 'branch'
  return complete && others.length <= MAX_BRANCHES && tags !== null ? 'none' : 'unknown'
}

// The tags of `tags` on `commit`, by name.
const tagsOn = (tags, commit) => tags?.filter(({ oid }) => oid === commit).map(({ tag }) => tag) ?? []

// A tag's findings, as a version: none where it is no version; one a major
// or minor tag where no release of its line is, of an older line than the
// latest.
function tagFindings(ref, commit, tags) {
  const version = tagVersion(ref)
  if (!version) return [{ id: 'not-version', severity: 'moderate' }]
  if (!tags) return []
  const findings = []
  const releases = versionsOf(tags).filter(other => ofLine(version, other.version))
  if (version[2] === null && releases.length > 0 && !releases.some(({ oid }) => oid === commit)) findings.push({ id: 'tag-off-release', severity: 'high', release: releases[0].tag })
  const latest = latestOf(tags)
  if (latest && tagVersion(latest)[0] > version[0]) findings.push({ id: 'outdated', severity: 'low', latest })
  return findings
}

// A ref not a commit, resolved as GitHub resolves it, a tag before a branch.
async function refOf(uses, info, source, tags) {
  const name = info.fullName
  const [tagged, branched] = await Promise.all([tags ? tags.find(({ tag }) => tag === uses.ref)?.oid ?? null : source.tag(name, uses.ref), source.branch(name, uses.ref)])
  if (!tagged && !branched) return { commit: null, at: null, findings: [{ id: 'ref-missing', severity: 'moderate' }] }
  if (!tagged) return { commit: branched, at: 'branch', findings: [{ id: 'branch-ref', severity: 'high' }] }
  const findings = branched ? [{ id: 'ambiguous-ref', severity: 'high', branch: branched }] : []
  findings.push(...tagFindings(uses.ref, tagged, tags))
  const where = await reachable(source, info, tagged, tags)
  if (where === 'none') findings.push({ id: 'tag-off-branch', severity: 'low' })
  return { commit: tagged, at: 'tag', findings }
}

// Whether a version a comment names is one of the tags on the commit, or
// the line of one, `v` or none before it.
function commentHolds(comment, named) {
  const version = tagVersion(comment)
  return named.some(tag => tag === comment || tag.replace(/^v/u, '') === comment.replace(/^v/u, '') || (version && version[2] === null && ofLine(version, tagVersion(tag))))
}

// A commit, looked for in the repository's history where no tag names it,
// and held to the version a comment beside it names.
async function pinnedOf(uses, info, source, tags) {
  const commit = uses.ref
  let named = tagsOn(tags, commit)
  if (!tags && uses.comment && await source.tag(info.fullName, uses.comment) === commit) named = [uses.comment]
  const findings = []
  if (named.length === 0) {
    const where = await reachable(source, info, commit, tags)
    if (where === 'missing') findings.push({ id: 'commit-missing', severity: 'high' })
    else if (where === 'none') findings.push({ id: 'imposter-commit', severity: 'critical' })
    else if (where === 'unknown') findings.push({ id: 'unverified-commit', severity: 'high' })
    else if (tags) findings.push({ id: 'untagged-commit', severity: 'moderate', on: where })
  }
  if (uses.comment && !commentHolds(uses.comment, named)) findings.push({ id: 'comment-mismatch', severity: 'high', comment: uses.comment, tags: named })
  return { commit, at: 'sha', findings }
}

// A reference's own `$/path` (the repository's own, at the commit running)
// as one to its repository at the commit read.
const selfRef = (uses, info, commit) => readUses(`${info.fullName}/${uses.path}@${commit}`, { job: /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(uses.path) })

// The file a reference runs, at `commit`: an action's action.yml or
// action.yaml, a reusable workflow's own, and a Docker action's
// Dockerfile, read for their findings and the references they make, each
// with the file and line it is on.
async function codeOf(uses, info, commit, source) {
  const dir = uses.path ? `${uses.path}/` : '', name = info.fullName
  const candidates = uses.kind === 'workflow' ? [uses.path] : [`${dir}action.yml`, `${dir}action.yaml`]
  let file = null, text = null
  for (const path of candidates) {
    text = await source.file(name, path, commit)
    if (text !== null) { file = path; break }
  }
  if (text === null) return { file: null, using: null, findings: [{ id: 'action-missing', severity: 'moderate' }], uses: [] }
  let read
  try { read = readWorkflow(uses.kind === 'workflow' ? 'workflow' : 'action', text) } catch (error) {
    if (!(error instanceof ActionsScanError)) throw error
    return { file, using: null, findings: [{ id: 'unreadable', severity: 'moderate', file, detail: error.message }], uses: [] }
  }
  const findings = workflowFindings(read, { owner: name.split('/')[0], external: true }).map(finding => ({ ...finding, file }))
  const dockerfile = read.dockerfile && `${dir}${read.dockerfile.path.replace(/^\.\//u, '')}`
  const docker = dockerfile && !dockerfile.split('/').includes('..') ? await source.file(name, dockerfile, commit) : null
  if (docker !== null) findings.push(...dockerfileFindings(docker).map(finding => ({ ...finding, file: dockerfile })))
  const nested = workflowUses(read).flatMap(each => {
    if (each.kind !== 'local') return [each]
    return each.self ? [{ ...selfRef(each, info, commit), line: each.line }] : []
  })
  return { file, using: read.using, findings, uses: nested.filter(each => each.kind === 'action' || each.kind === 'workflow').map(each => ({ key: usesKey(each), line: each.line, file })) }
}

// A reference resolved (`uses`, uses.js readUses's, an action's or a
// reusable workflow's): `{ key, kind, repo, path, ref, pin, owner,
// repository, commit, at, tags, latest, using, file, findings, uses }`,
// `repository` as GitHub has it now (null for none), `commit` its ref's,
// `at` what its ref is (`sha`, `tag`, `branch`, null for none), `tags` those
// on the commit, `latest` the repository's latest release, `using` an
// action's runtime, `file` the one read, and `uses` the references it makes
// in turn, by key, each with its `file` and `line`. `owner`, whose
// repository the workflow making it is.
export async function resolveAction(uses, source, { owner = null } = {}) {
  const at = { key: usesKey(uses), kind: uses.kind, repo: uses.repo, path: uses.path, ref: uses.ref, pin: uses.pin, owner: ownerKind(uses.repo, owner) }
  const { info, findings } = await repositoryOf(uses, source, owner)
  if (!info) return { ...at, repository: null, commit: null, at: null, tags: [], latest: null, using: null, file: null, findings, uses: [] }
  const tags = await source.tags(info.fullName)
  const ref = uses.pin === 'sha' ? await pinnedOf(uses, info, source, tags) : await refOf(uses, info, source, tags)
  const code = ref.commit && !ref.findings.some(({ id }) => id === 'commit-missing') ? await codeOf(uses, info, ref.commit, source) : null
  return { ...at, repository: { fullName: info.fullName, fork: info.fork ?? null, archived: Boolean(info.archived), private: Boolean(info.private) },
    commit: ref.commit, at: ref.at, tags: tagsOn(tags, ref.commit), latest: tags ? latestOf(tags) : null, using: code?.using ?? null, file: code?.file ?? null,
    findings: [...findings, ...ref.findings, ...code?.findings ?? []], uses: code?.uses ?? [] }
}

// `source` with what it answers kept, each by what it was asked, for as
// long as it is held: one scan's, as a repository's tags and branches are
// asked of each of its references.
export function keptSource(source) {
  const kept = new Map()
  const keep = method => (...args) => {
    const key = `${method}\0${JSON.stringify(args)}`
    if (!kept.has(key)) kept.set(key, source[method](...args).catch(error => { kept.delete(key); throw error }))
    return kept.get(key)
  }
  return Object.fromEntries(['repo', 'tags', 'tag', 'branch', 'branches', 'contains', 'file'].map(method => [method, keep(method)]))
}
