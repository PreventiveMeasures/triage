// What a workflow, or an action's metadata, calls for by its own text (README.md).
import { YamlError } from '@preventive/lockfile/yaml.js'
import { readWorkflow } from './workflow.js'
import { installsOf } from './scripts/commands.js'
import { dotted, imageFinding, lockedName, namesPullHead, scriptFindings, scriptInjections, within } from './scripts/grade.js'
import { ownerKind, usesKey } from './uses.js'
import { resolved } from '../npm/files.js'

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
// devDependencies out; an action of its own's, by its metadata (ScanOptions
// `actions`), anywhere (null) where none is told; and anywhere for an action
// that installs them (cypress-io/github-action's unless `install: false`,
// pnpm/action-setup's with `run_install`).
const ANYWHERE = [{ at: null, prod: false }]
function installs(step, actions, seen = new Set()) {
  if (step.uses?.kind === 'local') return actions ? ownInstalls(actions, step.uses.path, seen) : ANYWHERE
  const repo = step.uses?.repo?.toLowerCase()
  if (repo && (INSTALLER.test(repo) || (repo === 'cypress-io/github-action' && String(step.with?.install) !== 'false'))) return ANYWHERE
  if (repo === 'pnpm/action-setup' && /^(?:true|\[|\{|-)/u.test(String(step.with?.run_install ?? '').trim())) return ANYWHERE
  return step.run ? installsOf(step.run.script, step.run.production).map(({ into, prod }) => ({ at: directoryOf(step.run.workingDirectory, into), prod })) : []
}

// Where the repository's own action at `dir` installs, by its steps, each
// action of its own once.
function ownInstalls(actions, dir, seen) {
  const read = actions.has(dir) && !seen.has(dir) && seen.add(dir) ? readWorkflow('action', actions.get(dir)) : null
  return read && !(read instanceof YamlError) ? read.jobs.flatMap(job => job.steps.flatMap(step => installs(step, actions, seen))) : []
}

// A step's directory, and a path from it (`into`), from the repository's
// root, '' for it; as written where an expression or a variable names it, or
// it is out of the repository, so that it is within the same alone.
function directoryOf(workingDirectory, into = null) {
  const path = into?.startsWith('/') ? into : [workingDirectory, into].filter(Boolean).join('/')
  return /\$|^\//u.test(path) ? path : resolved([], path)?.join('/') ?? path
}

// Whether the nearest lockfiles at or above `directory`, its project's, lock
// what npx runs by `name`: `dev` where only devDependencies need it in each
// that does.
const lockDir = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
function lockedIn(lockfiles, directory, name) {
  const above = lockfiles.filter(({ path }) => within(lockDir(path), directory))
  const nearest = Math.max(...above.map(({ path }) => lockDir(path).length))
  const locking = above.filter(({ path, names }) => lockDir(path).length === nearest && lockedName(names, name))
  return locking.length > 0 && (locking.every(({ dev }) => dev && lockedName(dev, name)) ? 'dev' : true)
}

// The inputs a text names (`${{ inputs.title }}`).
const inputsIn = text => typeof text === 'string' ? [...dotted(text).matchAll(/\$\{\{[^}]*?\binputs\s*\.\s*([\w-]+)/gu)].map(match => match[1]) : []

// The inputs a step's action writes into a script: github-script's
// `script`, and those an action of the repository's own (ScanOptions
// `actions`) names in its `run:`s or hands to such an input of a step's.
function scriptInputs(step, actions, seen = new Set()) {
  if (step.uses?.repo?.toLowerCase() === 'actions/github-script') return ['script']
  const dir = step.uses?.kind === 'local' && actions?.has(step.uses.path) && !seen.has(step.uses.path) ? step.uses.path : null
  const read = dir === null ? null : readWorkflow('action', actions.get(dir))
  if (!read || read instanceof YamlError) return []
  return [...new Set(read.jobs.flatMap(job => job.steps.flatMap(each => [...inputsIn(each.run?.script),
    ...scriptInputs(each, actions, new Set(seen).add(dir)).flatMap(input => inputsIn(each.with?.[input]))])))]
}

// Injections through the inputs an action writes into its scripts, and a
// fork's code or artifacts taken where the workflow runs with its secrets.
function stepFindings(step, triggers, actions) {
  const repo = step.uses?.repo?.toLowerCase()
  const found = scriptInputs(step, actions).flatMap(input => scriptInjections(step.with?.[input], triggers).map(({ index: _index, ...finding }) => ({ ...finding, line: step.withLines[input] })))
  const forks = triggers.includes('pull_request_target') || triggers.includes('workflow_run')
  if (forks && repo === 'actions/checkout' && (namesPullHead(step.with?.ref) || namesPullHead(step.with?.repository))) {
    found.push({ id: 'pwn-request', severity: 'critical', ref: String(step.with.ref ?? step.with.repository), line: step.withLines.ref ?? step.withLines.repository ?? step.line })
  }
  if (forks && step.run && /\bgh\s+pr\s+checkout\b/u.test(step.run.script)) found.push({ id: 'pwn-request', severity: 'critical', ref: 'gh pr checkout', line: step.run.line })
  if (triggers.includes('workflow_run') && ((repo === 'actions/download-artifact' && (step.with?.['run-id'] !== undefined || step.with?.['github-token'] !== undefined))
    || repo === 'dawidd6/action-download-artifact' || /\bgh\s+run\s+download\b/u.test(step.run?.script ?? ''))) found.push({ id: 'untrusted-artifact', severity: 'high', line: step.uses?.line ?? step.run.line })
  return found
}

// A job's findings, each script graded by the installs before it and its lockfiles.
function jobFindings(job, triggers, { owner, lockfiles, external, actions }) {
  const found = []
  if (job.uses) {
    const finding = usesFinding(job.uses, owner)
    if (finding) found.push({ ...finding, line: job.uses.line })
    if (job.secrets === 'inherit' && job.uses.repo && ownerKind(job.uses.repo, owner) === 'third-party') found.push({ id: 'secrets-inherited', severity: 'high', uses: job.uses.uses, key: usesKey(job.uses), line: job.uses.line })
    // An input of a reusable workflow, which one writes into its scripts.
    for (const [input, value] of Object.entries(job.with ?? {})) for (const { index: _index, ...injected } of scriptInjections(value, triggers)) found.push({ ...injected, line: job.withLines[input] })
  }
  for (const image of job.images) if (!image.read?.digest && !image.text.includes('${{')) found.push({ ...imageFinding(image.text, image.read), line: image.line })
  const installed = []
  for (const step of job.steps) {
    const finding = step.uses && usesFinding(step.uses, owner)
    if (finding) found.push({ ...finding, line: step.uses.line })
    if (step.run) {
      const directory = dir => directoryOf(step.run.workingDirectory, dir)
      const locked = (name, dir) => !external && lockedIn(lockfiles, directory(dir), name)
      const before = (dev, dir) => installed.some(({ at, prod }) => within(at, directory(dir)) && !(prod && dev))
      found.push(...scriptFindings(step.run, { locked, installed: before, external, triggers }))
    }
    found.push(...stepFindings(step, triggers, actions))
    installed.push(...installs(step, actions))
  }
  return found
}

// Every finding of a workflow read (readWorkflow), in its lines' order, by
// index.d.ts ScanOptions.
export function workflowFindings(read, { owner = null, lockfiles = [], external = false, actions = null } = {}) {
  const found = read.jobs.flatMap(job => jobFindings(job, read.triggers, { owner, lockfiles, external, actions }))
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

// The actions of the repository's own a workflow or an action uses, by
// their directories, and a Docker action's Dockerfile; none for one GitHub
// can't run.
export function ownFilesOf(kind, text) {
  const read = readWorkflow(kind, text)
  if (read instanceof YamlError) return { actions: [], dockerfile: null }
  return { actions: workflowUses(read).flatMap(uses => uses.kind === 'local' && !uses.job ? [uses.path] : []), dockerfile: read.dockerfile?.path ?? null }
}

// A workflow's or an action's metadata's (`kind`) references and findings;
// why not (`workflow-unreadable`) for one GitHub can't run.
export function scanWorkflow(kind, text, options = {}) {
  const read = readWorkflow(kind, text)
  if (read instanceof YamlError) return { error: 'workflow-unreadable', detail: read.message.slice(0, 500) }
  return { uses: workflowUses(read), findings: workflowFindings(read, options) }
}
