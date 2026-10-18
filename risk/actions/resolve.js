// A reference resolved on GitHub (`source`, index.d.ts ActionsSource): its
// repository, its ref's commit and its own code's findings (README.md).
import { YamlError } from '@preventive/lockfile/yaml.js'
import { readWorkflow } from './workflow.js'
import { workflowFindings, workflowUses } from './findings.js'
import { imageFinding, scriptFindings } from './scripts/grade.js'
import { isWorkflowPath, ownerKind, readImage, readUses, usesKey } from './uses.js'

// An action's tags as versions: a release's (`v4.2.1`), and a major (`v4`) or
// minor one (`v4.2`) moved to its line's latest. `[major, minor, patch]`,
// null for a part a tag hasn't; null for no version.
export function tagVersion(tag) {
  const m = typeof tag === 'string' ? /^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?$/u.exec(tag) : null
  return m && [Number(m[1]), m[2] === undefined ? null : Number(m[2]), m[3] === undefined ? null : Number(m[3])]
}

const isRelease = version => version !== null && version[2] !== null

const byVersion = (a, b) => (b[0] - a[0]) || ((b[1] ?? -1) - (a[1] ?? -1)) || ((b[2] ?? -1) - (a[2] ?? -1))

// Whether a release is of a major or minor tag's line: `v4`'s `4.x.y`.
const ofLine = (version, other) => isRelease(other) && other[0] === version[0] && (version[1] === null || other[1] === version[1])

// The versions of `tags` (`{ tag, oid }` each), the highest first.
const versionsOf = tags => tags.flatMap(({ tag, oid }) => { const version = tagVersion(tag); return version ? [{ tag, oid, version }] : [] })
  .toSorted((a, b) => byVersion(a.version, b.version))

// The latest release's tag of `tags`, else the highest version's; null where
// none is one.
export function latestOf(tags) {
  const versions = versionsOf(tags)
  return (versions.find(({ version }) => isRelease(version)) ?? versions[0])?.tag ?? null
}

// The highest release of each major line, the latest line first: where a
// commit is most likely in a release's history.
export function newestOfLines(tags) {
  const seen = new Set()
  return versionsOf(tags).filter(({ version }) => isRelease(version) && !seen.has(version[0]) && seen.add(version[0]))
}

// An instruction's lines, its continuations (`\` at a line's end) joined,
// and each heredoc's (`<<EOF`) through its delimiter, as BuildKit reads one.
function instructions(text) {
  const lines = text.split('\n').map(line => line.replace(/\r$/u, ''))
  const found = []
  for (let at = 0; at < lines.length; at++) {
    const start = at
    while (lines[at].endsWith('\\') && at + 1 < lines.length) at++
    for (const { 1: delimiter } of lines.slice(start, at + 1).join('\n').matchAll(/(?<!<)<<-?\s*["']?(\w+)["']?/gu)) {
      do at++
      while (at < lines.length - 1 && lines[at].trim() !== delimiter)
    }
    found.push({ start, lines: lines.slice(start, Math.min(at, lines.length - 1) + 1) })
    at = Math.min(at, lines.length - 1)
  }
  return found
}

// A `RUN`'s command, its exec form (`RUN ["sh", "-c", "…"]`) as words.
function runCommand(text) {
  if (!text.trimStart().startsWith('[')) return text
  try {
    const words = JSON.parse(text)
    return Array.isArray(words) ? words.map(word => /[\s'"]/u.test(String(word)) ? `'${String(word).replaceAll("'", "'\\''")}'` : String(word)).join(' ') : text
  } catch { return text }
}

// A Docker action's Dockerfile: each `FROM` by a tag, a build argument's
// yellow, and each `RUN` read as a script's (scripts/grade.js).
export function dockerfileFindings(text) {
  const findings = [], script = [], stages = new Set()
  for (const { start, lines } of instructions(text)) {
    const first = /^\s*(FROM|RUN)\s+(.*)$/iu.exec(lines[0])
    // A RUN's options (`--mount=…`, `--network=…`) aren't its command.
    if (first?.[1].toUpperCase() === 'RUN') { script.push(runCommand(first[2].replace(/^(?:--[a-z-]+(?:=\S*)?\s+)*/iu, '')), ...lines.slice(1)); continue }
    script.push(...lines.map(() => ''))
    if (!first) continue
    const words = lines.join(' ').replaceAll('\\', ' ').trim().split(/\s+/u).slice(1).filter(word => !word.startsWith('--'))
    const [image, as, stage] = words
    const built = image && stages.has(image.toLowerCase())
    if (as?.toLowerCase() === 'as' && stage) stages.add(stage.toLowerCase())
    if (!image || image === 'scratch' || built) continue
    const read = readImage(image)
    if (image.includes('$')) findings.push({ id: 'unpinned-image', severity: 'moderate', image, line: start + 1 })
    else if (!read?.digest) findings.push({ ...imageFinding(image, read), line: start + 1 })
  }
  const run = { script: script.join('\n'), line: 1, start: 1 }
  findings.push(...scriptFindings(run, { locked: () => false, installed: () => false, external: true, triggers: [] }))
  return findings.toSorted((a, b) => a.line - b.line)
}

// How many major lines' releases a commit is looked for in.
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

// Where `sha` is in the history (`default`, `release`, `branch`), `none`,
// `unknown` where not all could be looked in, or `missing`: each branch and
// release looked in once, from its commit.
async function reachable(source, info, sha, tags) {
  const name = info.fullName, releases = newestOfLines(tags ?? []).slice(0, MAX_LINES)
  if (releases.some(({ oid }) => oid === sha)) return 'release'
  const head = await source.branch(name, info.defaultBranch)
  const onDefault = await source.contains(name, head ?? info.defaultBranch, sha)
  if (onDefault === null) return 'missing'
  if (onDefault) return 'default'
  const looked = new Set([head])
  const contains = oid => !looked.has(oid) && looked.add(oid) && source.contains(name, oid, sha)
  for (const { oid } of releases) if (await contains(oid)) return 'release'
  const { branches, complete } = await source.branches(name)
  for (const { oid } of branches) if (oid === sha || await contains(oid)) return 'branch'
  return complete && tags !== null ? 'none' : 'unknown'
}

const tagsOn = (tags, commit) => tags?.filter(({ oid }) => oid === commit).map(({ tag }) => tag) ?? []

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

// Whether a version a comment names is a tag on the commit, or one's line.
function commentHolds(comment, named) {
  const version = tagVersion(comment)
  return named.some(tag => tag === comment || tag.replace(/^v/u, '') === comment.replace(/^v/u, '') || (version && version[2] === null && ofLine(version, tagVersion(tag))))
}

// A commit, looked for in the history where no tag names it, held to its comment.
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

// A `$/path` (the repository's own at the commit running) as a reference.
const selfRef = (uses, info, commit) => readUses(`${info.fullName}/${uses.path}@${commit}`, { job: isWorkflowPath(uses.path) })

// What a reference runs at `commit` (action.yml, a reusable workflow, a
// Dockerfile): its findings, each with its file, and the references it makes.
async function codeOf(uses, info, commit, source) {
  const dir = uses.path ? `${uses.path}/` : '', name = info.fullName
  const candidates = uses.kind === 'workflow' ? [uses.path] : [`${dir}action.yml`, `${dir}action.yaml`]
  let file = null, text = null
  for (const path of candidates) {
    text = await source.file(name, path, commit)
    if (text !== null) { file = path; break }
  }
  if (text === null) return { findings: [{ id: 'action-missing', severity: 'moderate' }], uses: [] }
  const read = readWorkflow(uses.kind === 'workflow' ? 'workflow' : 'action', text)
  if (read instanceof YamlError) return { findings: [{ id: 'unreadable', severity: 'moderate', file, detail: read.message }], uses: [] }
  const findings = workflowFindings(read, { owner: name.split('/')[0], external: true }).map(finding => ({ ...finding, file }))
  const dockerfile = read.dockerfile && `${dir}${read.dockerfile.path}`
  const docker = dockerfile && !dockerfile.split('/').includes('..') ? await source.file(name, dockerfile, commit) : null
  if (docker !== null) findings.push(...dockerfileFindings(docker).map(finding => ({ ...finding, file: dockerfile })))
  const nested = workflowUses(read).map(each => each.kind === 'local' ? (each.self || each.job) && selfRef(each, info, commit) : each)
  return { findings, uses: nested.filter(each => each?.kind === 'action' || each?.kind === 'workflow').map(usesKey) }
}

// A reference resolved (index.d.ts ResolvedAction); `owner`, whose workflow names it.
export async function resolveAction(uses, source, { owner = null } = {}) {
  const at = { key: usesKey(uses), kind: uses.kind, repo: uses.repo, path: uses.path, ref: uses.ref }
  const { info, findings } = await repositoryOf(uses, source, owner)
  if (!info) return { ...at, repository: null, commit: null, at: null, tags: [], findings, uses: [] }
  const tags = await source.tags(info.fullName)
  const ref = uses.pin === 'sha' ? await pinnedOf(uses, info, source, tags) : await refOf(uses, info, source, tags)
  const code = ref.commit && !ref.findings.some(({ id }) => id === 'commit-missing') ? await codeOf(uses, info, ref.commit, source) : null
  return { ...at, repository: { fullName: info.fullName, private: Boolean(info.private) }, commit: ref.commit, at: ref.at, tags: tagsOn(tags, ref.commit),
    findings: [...findings, ...ref.findings, ...code?.findings ?? []], uses: code?.uses ?? [] }
}

// `source` with its answers kept, by what was asked, while held: a scan's.
export function keptSource(source) {
  const kept = new Map()
  const keep = method => (...args) => {
    const key = `${method}\0${JSON.stringify(args)}`
    if (!kept.has(key)) kept.set(key, source[method](...args).catch(error => { kept.delete(key); throw error }))
    return kept.get(key)
  }
  return Object.fromEntries(['repo', 'tags', 'tag', 'branch', 'branches', 'contains', 'file'].map(method => [method, keep(method)]))
}
