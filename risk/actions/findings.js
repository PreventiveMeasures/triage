// What a workflow, or an action's metadata, calls for by its own text (README.md).
import { YamlError } from '@preventive/lockfile/yaml.js'
import { readWorkflow } from './workflow.js'
import { installsOf } from './scripts/commands.js'
import { imageFinding, lockedName, namesPullHead, scriptFindings, scriptInjections } from './scripts/grade.js'
import { ownerKind, usesKey } from './uses.js'

// What a `uses:` calls for by its pin, a reference's with its `key`.
function usesFinding(uses, owner) {
  if (uses.kind === 'invalid') return { id: 'invalid-uses', severity: 'low', uses: uses.uses }
  if (uses.kind === 'docker') return uses.digest ? null : imageFinding(uses.uses, uses)
  if ((uses.kind !== 'action' && uses.kind !== 'workflow') || uses.pin === 'sha') return null
  const at = { uses: uses.uses, key: usesKey(uses) }
  return uses.pin === 'short-sha' ? { id: 'short-sha', severity: 'high', ...at } : { id: 'unpinned', severity: ownerKind(uses.repo, owner) === 'third-party' ? 'high' : 'moderate', ...at, ref: uses.ref }
}

// An action that installs a project's npm packages, by its name: npm's,
// Yarn's, pnpm's or Bun's install of dependencies (`bahmutov/npm-install`),
// not another tool's (`cachix/install-nix-action`).
const INSTALLER = /(?:npm|yarn|pnpm|bun|node[-_]?modules)[-_]?(?:ci|install)|install[-_]?(?:npm|yarn|pnpm|bun|node[-_]?modules|dep(?:endencie)?s|packages)/iu

// Where a step installs a project's packages, each `{ at, prod }`: a
// script's install's directory or the one it names, and whether it leaves
// devDependencies out (`--omit=dev`); where an action of its own does, by
// `installers` (ScanOptions), anywhere (null) where none are told; and
// anywhere for an action that installs them (cypress-io/github-action's
// unless `install: false`, pnpm/action-setup's with `run_install`).
const ANYWHERE = [{ at: null, prod: false }]
function installs(step, installers) {
  if (step.uses?.kind === 'local') return installers ? installers.get(step.uses.path) ?? [] : ANYWHERE
  const repo = step.uses?.repo?.toLowerCase()
  if (repo && (INSTALLER.test(repo) || (repo === 'cypress-io/github-action' && String(step.with?.install) !== 'false'))) return ANYWHERE
  if (repo === 'pnpm/action-setup' && /^(?:true|\[|\{|-)/u.test(String(step.with?.run_install ?? '').trim())) return ANYWHERE
  return step.run ? installsOf(step.run.script, step.run.production).map(({ into, prod }) => ({ at: directoryOf(step.run.workingDirectory, into), prod })) : []
}

// Whether `dir` is `directory` or above it, as node finds a package there;
// null for anywhere.
const within = (dir, directory) => dir === null || dir === '' || directory === dir || directory.startsWith(`${dir}/`)

// A step's directory, and a path from it (`into`), from the repository's
// root, '' for it; as written where an expression or a variable names it, or
// it is out of the repository, so that it is within the same alone.
function directoryOf(workingDirectory, into = null) {
  const path = into?.startsWith('/') ? into : [workingDirectory, into].filter(Boolean).join('/')
  if (/\$|^\//u.test(path)) return path
  const parts = []
  for (const part of path.split('/')) {
    if (part === '..') { if (parts.pop() === undefined) return path } else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

// Whether a lockfile at or above `directory`, any for one an expression
// names, locks what npx runs by `name`: `dev` where only devDependencies
// need it in each that does.
function lockedIn(lockfiles, directory) {
  const applies = directory.includes('$') ? lockfiles : lockfiles.filter(({ path }) => within(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', directory))
  return name => {
    const locking = applies.filter(({ names }) => lockedName(names, name))
    return locking.length > 0 && (locking.every(({ dev }) => dev && lockedName(dev, name)) ? 'dev' : true)
  }
}

// github-script's injections, and a fork's code or artifacts taken where the
// workflow runs with its secrets.
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

// A job's findings, each script graded by the installs before it and its lockfiles.
function jobFindings(job, triggers, { owner, lockfiles, external, installers }) {
  const found = []
  if (job.uses) {
    const finding = usesFinding(job.uses, owner)
    if (finding) found.push({ ...finding, line: job.uses.line })
    if (job.secrets === 'inherit' && job.uses.repo && ownerKind(job.uses.repo, owner) === 'third-party') found.push({ id: 'secrets-inherited', severity: 'high', uses: job.uses.uses, key: usesKey(job.uses), line: job.uses.line })
  }
  for (const image of job.images) if (!image.read?.digest && !image.text.includes('${{')) found.push({ ...imageFinding(image.text, image.read), line: image.line })
  const installed = []
  for (const step of job.steps) {
    const finding = step.uses && usesFinding(step.uses, owner)
    if (finding) found.push({ ...finding, line: step.uses.line })
    if (step.run) {
      const directory = directoryOf(step.run.workingDirectory)
      const locked = external ? () => false : lockedIn(lockfiles, directory)
      const before = dev => installed.some(({ at, prod }) => within(at, directory) && !(prod && dev))
      found.push(...scriptFindings(step.run, { locked, installed: before, external, triggers }))
    }
    found.push(...stepFindings(step, triggers))
    installed.push(...installs(step, installers))
  }
  return found
}

// Every finding of a workflow read (readWorkflow), in its lines' order, by
// index.d.ts ScanOptions.
export function workflowFindings(read, { owner = null, lockfiles = [], external = false, installers = null } = {}) {
  const found = read.jobs.flatMap(job => jobFindings(job, read.triggers, { owner, lockfiles, external, installers }))
  if (/^node(?:12|16)$/u.test(read.using ?? '')) found.push({ id: 'deprecated-runtime', severity: 'low', using: read.using, line: read.usingLine })
  return found.toSorted((a, b) => (a.line ?? 0) - (b.line ?? 0))
}

// The references a workflow read makes: of GitHub's, each with its `key`, and
// of its own (`local`).
export function workflowUses(read) {
  return read.jobs.flatMap(job => [job.uses, ...job.steps.map(step => step.uses)]).flatMap(uses => {
    if (uses?.kind === 'local') return [uses]
    return uses?.kind === 'action' || uses?.kind === 'workflow' ? [{ ...uses, key: usesKey(uses) }] : []
  })
}

// Where an action's metadata installs a project's packages, as a step using
// it does, by `installers` (ScanOptions) where it uses an action of its own:
// each install's `{ at, prod }` (installs); none for one GitHub can't run.
export function actionInstalls(text, installers) {
  try {
    return readWorkflow('action', text).jobs.flatMap(job => job.steps.flatMap(step => installs(step, installers)))
  } catch (error) {
    if (error instanceof YamlError) return []
    throw error
  }
}

// A workflow's or an action's metadata's (`kind`) references and findings;
// a YamlError for one GitHub can't run.
export function scanWorkflow(kind, text, options = {}) {
  const read = readWorkflow(kind, text)
  return { uses: workflowUses(read), findings: workflowFindings(read, options) }
}
