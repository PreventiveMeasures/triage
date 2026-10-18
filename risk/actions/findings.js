// What a workflow, or an action's metadata, calls for a look at by its own
// text (workflow.js), before any reference is resolved on GitHub
// (resolve.js), each `{ id, severity, line, … }`, as README.md tells them.
import { namesPullHead, scriptInjections } from './expressions.js'
import { readWorkflow } from './workflow.js'
import { installLine } from './scripts/commands.js'
import { imageFinding, lockedName, scriptFindings } from './scripts/grade.js'
import { ownerKind, usesKey } from './uses.js'

// What a `uses:` calls for, by how it pins what it names; of a reference,
// with its `key`.
function usesFinding(uses, owner) {
  if (uses.kind === 'invalid') return { id: 'invalid-uses', severity: 'low', uses: uses.uses }
  if (uses.kind === 'docker') return uses.digest ? null : imageFinding(uses.uses, uses, 'uses')
  if ((uses.kind !== 'action' && uses.kind !== 'workflow') || uses.pin === 'sha') return null
  const at = { uses: uses.uses, key: usesKey(uses) }
  return uses.pin === 'short-sha' ? { id: 'short-sha', severity: 'high', ...at } : { id: 'unpinned', severity: ownerKind(uses.repo, owner) === 'third-party' ? 'high' : 'moderate', ...at, ref: uses.ref }
}

// Where a step installs a project's packages: a script that runs an install,
// in the directory it runs in; an action of the repository's own or named
// for installing, as a setup action of a project's own is, anywhere (null);
// undefined where it doesn't.
function installs(step) {
  if (step.uses?.kind === 'local' || (step.uses?.repo && /install/iu.test(step.uses.repo))) return null
  if (step.uses?.repo?.toLowerCase() === 'pnpm/action-setup' && /^(?:true|\[|\{|-)/u.test(String(step.with?.run_install ?? '').trim())) return null
  return step.run && installLine(step.run.script) !== null ? directoryOf(step.run.workingDirectory) : undefined
}

// Whether an install in `at` (null for anywhere) is one a step in
// `directory` runs the packages of, as node finds them in its directory or
// one above.
const installedFor = (at, directory) => at === null || directory === null || at === '' || directory === at || directory.startsWith(`${at}/`)

// The directory a step runs in, from the repository's root: '' for its
// root, null where an expression names it.
function directoryOf(workingDirectory) {
  if (workingDirectory === null) return ''
  if (workingDirectory.includes('${{')) return null
  return workingDirectory.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '').replace(/^\.$/u, '')
}

// Whether a lockfile at or above `directory` (any, where it isn't told)
// locks a package npx would run by `name`.
function lockedIn(lockfiles, directory) {
  const applies = lockfiles.filter(({ path }) => {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    return directory === null || dir === '' || directory === dir || directory.startsWith(`${dir}/`)
  })
  return name => applies.some(({ names }) => lockedName(names, name))
}

// github-script's `script:` with an expression anyone can write in it, and
// a pull request's code checked out, or artifacts taken from another run,
// where the workflow runs with its secrets for anyone.
function stepFindings(step, triggers) {
  const repo = step.uses?.repo?.toLowerCase()
  const found = repo === 'actions/github-script' ? scriptInjections(step.with?.script, triggers).map(({ index: _index, ...finding }) => ({ ...finding, line: step.withLines.script })) : []
  const forks = triggers.includes('pull_request_target') || triggers.includes('workflow_run')
  if (forks && repo === 'actions/checkout' && (namesPullHead(step.with?.ref) || namesPullHead(step.with?.repository))) {
    found.push({ id: 'pwn-request', severity: 'critical', ref: String(step.with.ref ?? step.with.repository), line: step.withLines.ref ?? step.withLines.repository ?? step.line })
  }
  if (forks && step.run && /\bgh\s+pr\s+checkout\b/u.test(step.run.script)) found.push({ id: 'pwn-request', severity: 'critical', ref: 'gh pr checkout', line: step.run.line })
  if (triggers.includes('workflow_run') && ((repo === 'actions/download-artifact' && (step.with?.['run-id'] !== undefined || step.with?.['github-token'] !== undefined))
    || repo === 'dawidd6/action-download-artifact')) found.push({ id: 'untrusted-artifact', severity: 'high', line: step.uses.line })
  return found
}

// A job's findings: its reusable workflow's and its steps', each script's
// graded with what was installed before it and the lockfiles that apply.
function jobFindings(job, triggers, { owner, lockfiles, external }) {
  const found = []
  if (job.uses) {
    const finding = usesFinding(job.uses, owner)
    if (finding) found.push({ ...finding, line: job.uses.line })
    if (job.secrets === 'inherit' && job.uses.repo && ownerKind(job.uses.repo, owner) === 'third-party') found.push({ id: 'secrets-inherited', severity: 'high', uses: job.uses.uses, key: usesKey(job.uses), line: job.uses.line })
  }
  for (const image of job.images) if (!image.read?.digest && !image.text.includes('${{')) found.push({ ...imageFinding(image.text, image.read, image.via), line: image.line })
  const installed = []
  for (const step of job.steps) {
    const finding = step.uses && usesFinding(step.uses, owner)
    if (finding) found.push({ ...finding, line: step.uses.line })
    if (step.run) {
      const directory = directoryOf(step.run.workingDirectory)
      const locked = external ? () => false : lockedIn(lockfiles, directory)
      found.push(...scriptFindings(step.run, { locked, installed: installed.some(at => installedFor(at, directory)), external, triggers }))
    }
    found.push(...stepFindings(step, triggers))
    const at = installs(step)
    if (at !== undefined) installed.push(at)
  }
  return found
}

// Every finding of a workflow or an action's metadata read (workflow.js
// readWorkflow), by its own text, in its lines' order. `owner`, whose
// repository it is; `lockfiles`, its repository's, each `{ path, names }`,
// the names of the packages it locks, a script's npx told locked by those at
// or above where it runs; `external`, another repository's action, run in
// a workspace it can't tell.
export function workflowFindings(read, { owner = null, lockfiles = [], external = false } = {}) {
  const found = read.jobs.flatMap(job => jobFindings(job, read.triggers, { owner, lockfiles, external }))
  if (/^node(?:12|16)$/u.test(read.using ?? '')) found.push({ id: 'deprecated-runtime', severity: 'low', using: read.using, line: read.usingLine })
  return found.toSorted((a, b) => (a.line ?? 0) - (b.line ?? 0))
}

// What a workflow or an action's metadata names to resolve, in the file's
// order: its actions and reusable workflows on GitHub (`action`, `workflow`),
// each with its `key`, and the repository's own (`local`), each with its line.
export function workflowUses(read) {
  return read.jobs.flatMap(job => [job.uses, ...job.steps.map(step => step.uses)]).flatMap(uses => {
    if (uses?.kind === 'local') return [uses]
    return uses?.kind === 'action' || uses?.kind === 'workflow' ? [{ ...uses, key: usesKey(uses) }] : []
  })
}

// A workflow's (`kind` 'workflow') or an action's metadata's ('action') text
// read for what it calls for by itself, and what it names to resolve, each
// with its line. Throws an ActionsScanError (`workflow-unreadable`) for one
// that isn't YAML, or isn't shaped as GitHub runs one.
export function scanWorkflow(kind, text, options = {}) {
  const read = readWorkflow(kind, text)
  return { triggers: read.triggers, using: read.using, uses: workflowUses(read), findings: workflowFindings(read, options) }
}
