// What a workflow, or an action's metadata, calls for a look at by its own
// text (workflow.js), before any reference is resolved on GitHub
// (resolve.js), each `{ id, severity, line, … }`, in the file's order:
//
// - `unpinned`: a `uses:` by a tag or a branch, which its repository's owner
//   can point anywhere, not a full commit sha: orange, yellow for GitHub's
//   own (`actions/…`, `github/…`) and the same owner's; `short-sha`, one by a
//   short sha, orange, as GitHub reads a branch or tag named so too.
// - `unpinned-image`: an image by a tag (`docker://`, `container:`,
//   `services:`, a Docker action's), not a digest (scripts/grade.js).
// - what a script runs past a pin, the services it names and the
//   expressions anyone can write in it (scripts/grade.js); and
//   github-script's `script:` holding one (`script-injection`).
// - `pwn-request`: a workflow that runs with the base repository's secrets
//   for a fork's pull request (`pull_request_target`, `workflow_run`)
//   checking out the pull request's own code, red, as building it runs it.
// - `untrusted-artifact`: such a workflow taking another run's artifacts,
//   which a fork's pull request writes, orange.
// - `secrets-inherited`: another owner's reusable workflow handed every
//   secret (`secrets: inherit`), orange.
// - `invalid-uses`: a `uses:` GitHub can't read, low.
// - `deprecated-runtime`: an action on a Node.js GitHub no longer runs it
//   on, low.
import { PRIVILEGED_TRIGGERS, namesPullHead, untrustedExpressions } from './expressions.js'
import { installLine } from './scripts/commands.js'
import { imageFinding, lockedName, scriptFindings } from './scripts/grade.js'
import { ownerKind } from './uses.js'

// What a `uses:` calls for, by how it pins what it names.
function usesFinding(uses, owner) {
  if (uses.kind === 'invalid') return { id: 'invalid-uses', severity: 'low', uses: uses.uses }
  if (uses.kind === 'docker') return uses.digest ? null : imageFinding(uses.uses, uses, 'uses')
  if (uses.kind !== 'action' && uses.kind !== 'workflow') return null
  if (uses.pin === 'short-sha') return { id: 'short-sha', severity: 'high', uses: uses.uses }
  if (uses.pin === 'sha') return null
  return { id: 'unpinned', severity: ownerKind(uses.repo, owner) === 'third-party' ? 'high' : 'moderate', uses: uses.uses, ref: uses.ref }
}

// Whether a step installs a project's packages: a script that runs an
// install, or an action of the repository's own or named for installing,
// as a setup action of a project's own is.
function installs(step) {
  if (step.uses?.kind === 'local' || (step.uses?.repo && /install/iu.test(step.uses.repo))) return true
  if (step.uses?.repo?.toLowerCase() === 'pnpm/action-setup' && /^(?:true|\[|\{|-)/u.test(String(step.with?.run_install ?? '').trim())) return true
  return Boolean(step.run) && installLine(step.run.script) !== null
}

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
  const found = []
  const repo = step.uses?.repo?.toLowerCase()
  const privileged = triggers.some(event => PRIVILEGED_TRIGGERS.has(event))
  if (repo === 'actions/github-script' && typeof step.with?.script === 'string') {
    for (const { expression } of untrustedExpressions(step.with.script)) found.push({ id: 'script-injection', severity: privileged ? 'critical' : 'high', expression, line: step.withLines.script })
  }
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
function jobFindings(job, read, { owner, lockfiles, external }) {
  const found = []
  if (job.uses) {
    const finding = usesFinding(job.uses, owner)
    if (finding) found.push({ ...finding, line: job.uses.line })
    if (job.secrets === 'inherit' && job.uses.repo && ownerKind(job.uses.repo, owner) === 'third-party') found.push({ id: 'secrets-inherited', severity: 'high', uses: job.uses.uses, line: job.uses.line })
  }
  for (const image of job.images) if (!image.read?.digest && !image.text.includes('${{')) found.push({ ...imageFinding(image.text, image.read, image.via), line: image.line })
  let installed = false
  for (const step of job.steps) {
    const finding = step.uses && usesFinding(step.uses, owner)
    if (finding) found.push({ ...finding, line: step.uses.line })
    if (step.run) {
      const locked = external ? () => false : lockedIn(lockfiles, directoryOf(step.run.workingDirectory))
      found.push(...scriptFindings(step.run, { locked, installed, external, triggers: read.triggers }))
    }
    found.push(...stepFindings(step, read.triggers))
    installed ||= installs(step)
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
  const found = read.jobs.flatMap(job => jobFindings(job, read, { owner, lockfiles, external }))
  if (/^node(?:12|16)$/u.test(read.using ?? '')) found.push({ id: 'deprecated-runtime', severity: 'low', using: read.using, line: read.usingLine })
  return found.toSorted((a, b) => (a.line ?? 0) - (b.line ?? 0))
}

// What a workflow or an action's metadata names to resolve, each once, in
// the file's order: its actions and reusable workflows on GitHub (`action`,
// `workflow`) and the repository's own (`local`), each with its line.
export function workflowUses(read) {
  return read.jobs.flatMap(job => [job.uses, ...job.steps.map(step => step.uses)])
    .filter(uses => uses && (uses.kind === 'action' || uses.kind === 'workflow' || uses.kind === 'local'))
}
