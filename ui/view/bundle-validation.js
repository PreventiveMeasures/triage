// A managed Stasis bundle's validation (server-managed/bundle-validation.ts,
// Stasis's own) as a line of its Overview's facts (render-bundle.js), with its
// Validate button and its details: its last one asked once and kept a while.
import { FILE_REASONS, LOCKFILE_ERRORS, OWN_REASONS, noteOf } from '@exodus/stasis/validate-notes'
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
// `next` held for `key` in place of `was`, none for null, unless something
// else has been since; told where it is.
function settle(data, key, was, next) {
  if (data.get(key) !== was) return false
  if (next) data.set(key, next)
  else data.delete(key)
  changed()
  return true
}
const STATUSES = new Set(['valid', 'invalid', 'incomplete'])

// A server's validation as it is shown, none where it isn't one.
export const checkedValidation = told => STATUSES.has(told?.status) ? told : null

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
    .then(next => settle(data, key, loading, next))
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
  settle(data, key, running, next)
}

const plural = (value, noun) => `${value.toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`
const CHEVRON = icon(svg`<path d="m6 4 4 4-4 4"/>`)
// Why own code wasn't checked: Stasis's reasons, and the app's own where its reader may read only part of its repository.
const OWN_UNCHECKED = { ...OWN_REASONS, 'no-access': 'you may read only part of its repository' }
const STATUS_LABELS = { valid: 'Valid', invalid: 'Invalid', incomplete: 'Incomplete' }
// The tone a validation's, a package's or a file's state is shown in.
const TONE = { valid: 'passed', invalid: 'failed', incomplete: 'wanted', unverified: 'wanted', differs: 'failed', unexpected: 'failed' }
const SAID = [['differs', 'differ'], ['unexpected', 'unexpected'], ['unverified', 'unverified']]
// What fails packages apart from their files.
const PACKAGES_SAID = [['lockFailures', 'failing its lockfile', 'failing their lockfile'], ['misplaced', 'installed where another is', 'installed where others are']]

const when = time => time === null ? '' : new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
// What a validation says beside its state: what fails it and what it left
// unverified, of how many files.
function said({ counts, own }) {
  const told = SAID.filter(([kind]) => counts[kind]).map(([kind, word]) => `${counts[kind].toLocaleString('en-US')} ${word}`)
  const packages = PACKAGES_SAID.filter(([kind]) => counts[kind]).map(([kind, one, more]) => `${plural(counts[kind], 'package')} ${counts[kind] === 1 ? one : more}`)
  return `${told.length > 0 ? `${told.join(', ')}, of ` : 'every one of '}${plural(counts.files, 'file')}${packages.map(text => `; ${text}`).join('')}${own.checked ? '' : '; own code not checked'}`
}

// A package as its row tells it: its name and version, its state, and what
// Stasis notes of it, its paths as code.
function packageRow(pkg) {
  const note = noteOf(pkg).map(part => typeof part === 'string' ? part : html`<code>${part.path}</code>`)
  return html`<li class="bundle-validation-row"><span class="team-deps-name">${pkg.name}<span class="team-deps-version">@${pkg.version}</span></span>
    <span class="team-deps-review is-${TONE[pkg.status]}">${pkg.status}</span>
    <span class="bundle-validation-note">${note}</span></li>`
}

function details(validation) {
  const { own, problems, moreProblems, packages, counts, lockfiles } = validation
  const ref = own.checked && own.ref ? own.ref.tag ? html`, tag <code>${own.ref.tag}</code>` : html` of <code>${own.ref.branch}</code>` : nothing
  return html`<div class="bundle-review-details">
    <p class="team-deps-quiet">${own.checked ? html`Own code held to <code>${own.repository}</code> at <code>${own.commit.slice(0, 7)}</code>${ref}${own.directory
      ? html` under <code>${own.directory}</code>` : nothing}${counts.eol ? `, ${plural(counts.eol, 'file')} with a checkout’s CRLF line endings` : ''}${own.cut
      ? '; its tree was too large to list whole' : ''}.` : nothing}
    ${counts.packages ? ` ${plural(counts.validPackages, 'package')} of ${counts.packages.toLocaleString('en-US')} as published.` : ''}
    ${lockfiles?.length ? html` Dependencies held to ${lockfiles.map((path, at) => html`${at ? ', ' : ''}<code>${path}</code>`)}.` : nothing}</p>
    ${problems.length > 0 ? html`<ul class="bundle-validation-list">${problems.map(problem => html`<li class="bundle-validation-row">
      <span class="team-deps-review is-${TONE[problem.kind]}">${problem.kind}</span>
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
  const { validation } = read
  const id = keyOf(entry), open = opened.has(id)
  const toggle = () => {
    if (opened.has(id)) opened.delete(id)
    else opened.add(id)
    onChange()
  }
  const chip = read.running ? html`<span class="bundle-review-state" role="status">Validating…</span>`
    : validation ? html`<span class="bundle-review-state is-${TONE[validation.status]}">${STATUS_LABELS[validation.status]}</span>`
    : html`<span class="bundle-review-state">Not validated</span>`
  return html`<dt>Validation</dt><dd class="bundle-review bundle-validation">
    <div class="bundle-review-line">${chip}
      ${validation ? html`<span class="bundle-review-said">${said(validation)}${validation.validatedAt ? ` · ${when(validation.validatedAt)}` : ''}</span>` : nothing}
      <button type="button" class="bundles-download-btn bundle-validate-btn" ?disabled=${Boolean(read.running)} @click=${() => void validate(entry)}>${validation ? 'Validate again' : 'Validate'}</button>
      ${validation ? html`<button type="button" class="team-deps-more" aria-expanded=${String(open)} @click=${toggle}>${CHEVRON}<span>Details</span></button>` : nothing}</div>
    ${validation && !validation.own.checked ? html`<p class="bundle-validation-warning" role="alert">Own code couldn’t be verified: ${OWN_UNCHECKED[validation.own.reason] ?? validation.own.reason}.</p>` : nothing}
    ${validation?.lockfileError && validation.counts.packages ? html`<p class="bundle-validation-warning" role="alert">Dependencies held to no lockfile,
      each to its registry’s integrity alone: ${LOCKFILE_ERRORS[validation.lockfileError] ?? validation.lockfileError}.</p>` : nothing}
    ${read.status === 'error' ? html`<p class="bundle-validation-warning" role="alert">Couldn’t read its validation: ${read.error}</p>` : nothing}
    ${read.runError ? html`<p class="bundle-validation-warning" role="alert">Couldn’t validate it: ${read.runError}</p>` : nothing}
    ${validation && open ? details(validation) : nothing}
  </dd>`
}
