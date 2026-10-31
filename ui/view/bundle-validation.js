// A managed Stasis bundle's validation, as a line of its Overview's facts
// (render-bundle.js), with its Validate button: whether its own code is as
// GitHub has it at its commit and every dependency's file as upstream's
// package has it, those two covering every file it holds
// (server-managed/bundle-validation.ts); its last one, as the server keeps
// it, asked once its Overview shows and kept for the session that asked a
// while; Validate validates it anew. Where its own code wasn't checked, the
// line warns why. Its details, opened, list the files that differ, those
// unexpected (neither on GitHub nor in their package) and those left
// unverified, and the packages patched, failing or not checked.
import { html, nothing, svg } from 'lit'
import { state } from '#client/index.js'
import { fetchBundleValidation, runBundleValidation } from './client-managed.js'
import { icon } from './repository-tiles.js'

const KEEP_MS = 2 * 60_000
const RETRY_MS = 30_000

const held = new Map()
const opened = new Set()
let keptFor = null
let changed = () => {}

function sessionHeld() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    held.clear()
    opened.clear()
    keptFor = session
  }
  return held
}

// A bundle as what is held of it is named: by where it is too, as its own
// code is checked there.
const keyOf = bundle => `${bundle.managedId}\0${bundle.repoId ?? ''}\0${bundle.repoDirectory ?? ''}`
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
const STATUSES = new Set(['valid', 'invalid', 'incomplete'])
const KINDS = new Set(['differs', 'unexpected', 'unverified'])

// A server's validation as it is shown, none where it isn't one.
export function checkedValidation(told) {
  if (!told || !STATUSES.has(told.status)) return null
  const counts = Object.fromEntries(['files', 'own', 'dependencies', 'matched', 'eol', 'differs', 'unexpected', 'unverified', 'packages', 'validPackages']
    .map(name => [name, count(told.counts?.[name])]))
  const own = told.own?.checked === true && typeof told.own.repository === 'string' && /^[\da-f]{40}$/u.test(told.own.commit ?? '')
    ? { checked: true, repository: told.own.repository, commit: told.own.commit, directory: typeof told.own.directory === 'string' ? told.own.directory : '', cut: told.own.cut === true }
    : { checked: false, reason: typeof told.own?.reason === 'string' ? told.own.reason : 'unknown' }
  const problems = Array.isArray(told.problems) ? told.problems.filter(one => typeof one?.path === 'string' && KINDS.has(one.kind) && typeof one.of === 'string') : []
  const packages = Array.isArray(told.packages) ? told.packages.filter(one => typeof one?.name === 'string' && typeof one.version === 'string'
    && ['valid', 'invalid', 'unverified'].includes(one.status)) : []
  return { status: told.status, validatedAt: Number.isSafeInteger(told.validatedAt) ? told.validatedAt : null, own, counts, problems, moreProblems: count(told.moreProblems), packages }
}

// Bundle `bundle`'s validation as held, else asked: 'loading', then 'ready'
// with its `validation` (null for none yet), or 'error'; `running` while one
// is made, `runError` where that failed.
export function bundleValidation(bundle) {
  const data = sessionHeld()
  const key = keyOf(bundle)
  const entry = data.get(key)
  if (entry && (entry.running || Date.now() < entry.until)) return entry
  const loading = entry?.status === 'ready' ? { ...entry, until: Number.POSITIVE_INFINITY } : { status: 'loading', until: Number.POSITIVE_INFINITY }
  data.set(key, loading)
  fetchBundleValidation(bundle.managedId).then(told => ({ status: 'ready', until: Date.now() + KEEP_MS, validation: checkedValidation(told?.validation) }))
    .catch(err => err?.name === 'AbortError' ? null : { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'It couldn’t be read.' })
    .then(next => {
      if (data.get(key) !== loading) return false
      if (next) data.set(key, next)
      else data.delete(key)
      changed()
      return true
    })
  return loading
}

// Bundle `bundle` validated anew, held as it is made and once it is.
export async function validate(bundle) {
  const data = sessionHeld()
  const key = keyOf(bundle)
  const before = data.get(key)
  if (before?.running || !state.managedSession?.csrfToken) return
  const running = { ...before?.status === 'ready' ? before : { status: 'ready', validation: null }, until: Number.POSITIVE_INFINITY, running: true }
  data.set(key, running)
  changed()
  let next
  try {
    const told = await runBundleValidation(bundle.managedId, state.managedSession.csrfToken)
    next = { status: 'ready', until: Date.now() + KEEP_MS, validation: checkedValidation(told?.validation) }
  } catch (err) {
    next = err?.name === 'AbortError' ? null : { ...running, running: false, until: Date.now() + KEEP_MS, runError: err?.message || 'It couldn’t be validated.' }
  }
  if (data.get(key) !== running) return
  if (next) data.set(key, next)
  else data.delete(key)
  changed()
}

const plural = (value, noun) => `${value.toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`
const CHEVRON = icon(svg`<path d="m6 4 4 4-4 4"/>`)
// Why own code wasn't checked, a package wasn't, or a file is as it is.
const OWN_UNCHECKED = { 'no-repository': 'the bundle is attached to no repository', 'no-commit': 'its stamp names no commit',
  'no-access': 'you may read only part of its repository', 'commit-not-found': 'GitHub has no such commit in its repository' }
const UNVERIFIED = { git: 'installed from git, not a registry', unsupported: 'no upstream package to fetch for its ecosystem', unnamed: 'no name or version recorded', 'not-published': 'not published',
  unreadable: 'its registry refused it', 'too-large': 'too large to unpack', timeout: 'not reached in time', failed: 'couldn’t be fetched' }
const FILE_REASONS = { symlink: 'a symlink on GitHub', submodule: 'in a submodule', 'tree-cut': 'GitHub’s tree too large to list whole' }
const KIND_LABELS = { differs: 'differs', unexpected: 'unexpected', unverified: 'unverified' }
const STATUS_LABELS = { valid: 'Valid', invalid: 'Invalid', incomplete: 'Incomplete' }

const when = time => time === null ? '' : new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
// What a validation says beside its state: what fails it and what it left
// unverified, of how many files.
function said({ counts, own }) {
  const told = [counts.differs ? `${counts.differs.toLocaleString('en-US')} differ` : null, counts.unexpected ? `${counts.unexpected.toLocaleString('en-US')} unexpected` : null,
    counts.unverified ? `${counts.unverified.toLocaleString('en-US')} unverified` : null].filter(Boolean)
  return `${told.length > 0 ? `${told.join(', ')}, of ` : 'every one of '}${plural(counts.files, 'file')}${own.checked ? '' : '; own code not checked'}`
}

// A package as its row tells it: its name and version, its state, and its
// patch or why it wasn't checked.
function packageRow(pkg) {
  const patch = pkg.patch
  const how = patch?.error ? `its patch couldn’t be applied (${patch.error})` : patch?.applied === false ? 'locked patched, bundled as published' : 'patched'
  const note = pkg.status === 'unverified' ? UNVERIFIED[pkg.reason] ?? 'not checked'
    : patch ? html`${how}${patch.path ? html` by <code>${patch.path}</code>${patch.from === 'bundle' ? ' (the bundle’s)' : ''}` : nothing}` : nothing
  return html`<li class="bundle-validation-row"><span class="team-deps-name">${pkg.name}<span class="team-deps-version">@${pkg.version}</span></span>
    <span class="team-deps-review is-${pkg.status === 'valid' ? 'passed' : pkg.status === 'invalid' ? 'failed' : 'wanted'}">${pkg.status}</span>
    <span class="bundle-validation-note">${note}</span></li>`
}

function details(validation) {
  const { own, problems, moreProblems, packages, counts } = validation
  return html`<div class="bundle-review-details">
    <p class="team-deps-quiet">${own.checked ? html`Own code held to <code>${own.repository}</code> at <code>${own.commit.slice(0, 7)}</code>${own.directory
      ? html` under <code>${own.directory}</code>` : nothing}${counts.eol ? `, ${plural(counts.eol, 'file')} with a checkout’s CRLF line endings` : ''}${own.cut
      ? '; its tree was too large to list whole' : ''}.` : nothing}
    ${counts.packages ? ` ${plural(counts.validPackages, 'package')} of ${counts.packages.toLocaleString('en-US')} as published.` : ''}</p>
    ${problems.length > 0 ? html`<ul class="bundle-validation-list">${problems.map(problem => html`<li class="bundle-validation-row">
      <span class="team-deps-review is-${problem.kind === 'unverified' ? 'wanted' : 'failed'}">${KIND_LABELS[problem.kind]}</span>
      <span class="team-deps-name">${problem.path}</span>
      <span class="bundle-validation-note">${problem.of === 'own' ? 'own code' : problem.of.replace(/^[a-z-]+:/u, '')}${problem.reason ? `, ${FILE_REASONS[problem.reason] ?? problem.reason}` : ''}</span>
    </li>`)}</ul>` : nothing}
    ${moreProblems > 0 ? html`<p class="team-deps-quiet">and ${plural(moreProblems, 'file')} more, not listed</p>` : nothing}
    ${packages.length > 0 ? html`<ul class="bundle-validation-list">${packages.map(packageRow)}</ul>` : nothing}
  </div>`
}

// The Overview's line for `entry`, a managed Stasis bundle, as a fact of its
// list (`<dt>`, `<dd>`): its last validation's state and what it says, its
// Validate button, and its details; nothing for another, or while it is
// first read. `onChange` is called as what it tells changes (render.js render).
export function bundleValidationFact(entry, onChange) {
  if (!entry?.managedId || entry.kind !== 'stasis' || !state.managedSession || state.managedSession.publicShare) return nothing
  changed = onChange
  const read = bundleValidation(entry)
  if (read.status === 'loading') return nothing
  const validation = read.validation ?? null
  const id = keyOf(entry), open = opened.has(id)
  const toggle = () => {
    if (opened.has(id)) opened.delete(id)
    else opened.add(id)
    onChange()
  }
  const chip = read.running ? html`<span class="bundle-review-state" role="status">Validating…</span>`
    : validation ? html`<span class="bundle-review-state is-${validation.status === 'valid' ? 'passed' : validation.status === 'invalid' ? 'failed' : 'wanted'}">${STATUS_LABELS[validation.status]}</span>`
    : html`<span class="bundle-review-state">Not validated</span>`
  return html`<dt>Validation</dt><dd class="bundle-review bundle-validation">
    <div class="bundle-review-line">${chip}
      ${validation ? html`<span class="bundle-review-said">${said(validation)}${validation.validatedAt ? ` · ${when(validation.validatedAt)}` : ''}</span>` : nothing}
      <button type="button" class="bundles-download-btn bundle-validate-btn" ?disabled=${Boolean(read.running)} @click=${() => void validate(entry)}>${validation ? 'Validate again' : 'Validate'}</button>
      ${validation ? html`<button type="button" class="team-deps-more" aria-expanded=${String(open)} @click=${toggle}>${CHEVRON}<span>Details</span></button>` : nothing}</div>
    ${validation && !validation.own.checked ? html`<p class="bundle-validation-warning" role="alert">Own code couldn’t be verified: ${OWN_UNCHECKED[validation.own.reason] ?? validation.own.reason}.</p>` : nothing}
    ${read.status === 'error' ? html`<p class="bundle-validation-warning" role="alert">Couldn’t read its validation: ${read.error}</p>` : nothing}
    ${read.runError ? html`<p class="bundle-validation-warning" role="alert">Couldn’t validate it: ${read.runError}</p>` : nothing}
    ${validation && open ? details(validation) : nothing}
  </dd>`
}
