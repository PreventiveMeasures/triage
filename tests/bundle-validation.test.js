// A managed bundle's validation as a line of its Overview's facts
// (ui/view/bundle-validation.js): its last one read once and kept, its
// Validate button validating it anew; a warning where its own code wasn't
// checked; its details listing the files failing or unverified and the
// packages patched, failing or not checked.
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { templateText, templates } from './_lit.js'

const state = { managedSession: { id: 's', role: 'triage', csrfToken: 'token' } }
const asked = []
const ran = []
let kept = {}
let running = {}
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchBundleValidation(id) { asked.push(id); return Promise.resolve({ validation: kept[id] ?? null }) },
  runBundleValidation(id, csrf) { ran.push([id, csrf]); return Promise.resolve(running[id]).then(validation => { if (validation instanceof Error) throw validation; return { validation } }) },
} })
const { bundleValidationFact } = await import('../ui/view/bundle-validation.js')

const commit = 'f'.repeat(40)
const counts = (more = {}) => ({ files: 12, own: 4, dependencies: 7, synthetic: 1, matched: 12, eol: 0, differs: 0, unexpected: 0, unverified: 0, packages: 3, validPackages: 3, ...more })
const VALID = { validatedAt: Date.UTC(2026, 9, 31, 12), status: 'valid', own: { checked: true, repository: 'org/repo', commit, directory: 'web' }, counts: counts(),
  problems: [], moreProblems: 0, packages: [{ ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 1, status: 'valid', patch: { path: 'patches/ms@2.1.3.patch', from: 'bundle', applied: true } }] }
const INVALID = { ...VALID, status: 'invalid', counts: counts({ matched: 8, differs: 2, unexpected: 1, unverified: 1, validPackages: 1 }),
  problems: [{ path: 'node_modules/left/index.js', kind: 'differs', of: 'npm:left@1.0.0' }, { path: 'src/extra.js', kind: 'unexpected', of: 'own' },
    { path: 'src/link.js', kind: 'differs', of: 'own', reason: 'symlink' }, { path: 'x', kind: 'nonsense', of: 'own' }], moreProblems: 3,
  packages: [{ ecosystem: 'composer', name: 'org/php', version: '1.0.0', files: 1, status: 'unverified', reason: 'unsupported' },
    { ecosystem: 'npm', name: 'left', version: '1.0.0', files: 2, status: 'invalid' }] }
const UNCHECKED = { ...VALID, status: 'incomplete', own: { checked: false, reason: 'no-repository' }, counts: counts({ matched: 8, unverified: 4 }), packages: [] }
const entry = (managedId, more = {}) => ({ managedId, kind: 'stasis', repoId: 7, repoDirectory: 'web', ...more })
let renders = 0
const render = () => { renders++ }
const settle = async () => { for (let round = 0; round < 6; round++) await setImmediate() }
const shown = async bundle => {
  bundleValidationFact(bundle, render)
  await settle()
  return templateText(bundleValidationFact(bundle, render))
}
// The function the button of the line labelled `label` calls: the handler
// whose button's text, up to its end, holds the label.
const click = (bundle, label) => {
  for (const template of templates(bundleValidationFact(bundle, render))) {
    for (const [at, before] of template.strings.entries()) {
      if (!before.trimEnd().endsWith('@click=')) continue
      const rest = template.strings.slice(at + 1).map((text, k) => text + templateText(template.values[at + 1 + k])).join('')
      if (rest.slice(0, rest.indexOf('</button>')).replaceAll(/<[^>]*>/gu, '').includes(label)) return template.values[at]()
    }
  }
  throw new Error(`No button ${label}`)
}

test('nothing while first read, nor for a sourcemap or a public link; a bundle never validated says so, with its Validate button', async () => {
  assert.equal(templateText(bundleValidationFact(entry('fresh'), render)), '', 'while read')
  const fresh = await shown(entry('fresh'))
  assert.ok(renders > 0, 'drawn again once read')
  assert.match(fresh, /<dt>Validation<\/dt>[^]*Not validated[^]*>Validate<\/button>/u)
  assert.doesNotMatch(fresh, /Details/u)
  const before = asked.length
  assert.equal(await shown(entry('map', { kind: 'sourcemap' })), '')
  state.managedSession = { id: 's', role: 'view', publicShare: true }
  assert.equal(await shown(entry('shared')), '')
  state.managedSession = { id: 's', role: 'triage', csrfToken: 'token' }
  assert.equal(asked.length, before, 'neither asked')
})

test('a kept validation is told at once; Validate validates it anew with the session\'s token, the line saying so meanwhile', async () => {
  kept = { kept: VALID }
  const valid = await shown(entry('kept'))
  assert.match(valid, /is-passed">Valid<\/span>[^]*every one of 12 files · /u)
  assert.match(valid, />Validate again<\/button>/u)
  const before = asked.length
  await shown(entry('kept'))
  assert.equal(asked.length, before, 'kept for the session')
  let finish
  running = { kept: new Promise(resolve => { finish = resolve }) }
  click(entry('kept'), 'Validate again')
  assert.match(templateText(bundleValidationFact(entry('kept'), render)), /role="status">Validating…[^]*disabled/u)
  finish(INVALID)
  await settle()
  assert.deepEqual(ran, [['kept', 'token']])
  const invalid = templateText(bundleValidationFact(entry('kept'), render))
  assert.match(invalid, /is-failed">Invalid<\/span>/u)
  assert.match(invalid, /2 differ, 1 unexpected, 1 unverified, of 12 files/u)
  click(entry('kept'), 'Details')
  const details = templateText(bundleValidationFact(entry('kept'), render))
  assert.match(details, /Own code held to <code>org\/repo<\/code> at <code>fffffff<\/code> under <code>web<\/code>/u)
  assert.match(details, /is-failed">differs<\/span>[^]*node_modules\/left\/index\.js[^]*left@1\.0\.0/u)
  assert.match(details, /is-failed">unexpected<\/span>[^]*src\/extra\.js[^]*own code/u)
  assert.match(details, /src\/link\.js[^]*own code, a symlink on GitHub/u)
  assert.doesNotMatch(details, /nonsense/u, 'one of no kind left out')
  assert.match(details, /and 3 files more, not listed/u)
  assert.match(details, /org\/php[^]*unverified[^]*no upstream package to fetch for its ecosystem/u)
})

test('where its own code wasn\'t checked, the line warns why; a patched package is noted; a failed run says why, the last validation kept', async () => {
  kept = { unchecked: UNCHECKED, patched: VALID }
  const unchecked = await shown(entry('unchecked'))
  assert.match(unchecked, /is-wanted">Incomplete[^]*4 unverified, of 12 files; own code not checked/u)
  assert.match(unchecked, /role="alert">Own code couldn’t be verified: the bundle is attached to no repository\./u)
  await shown(entry('patched'))
  click(entry('patched'), 'Details')
  assert.match(templateText(bundleValidationFact(entry('patched'), render)), /ms[^]*valid[^]*patched by <code>patches\/ms@2\.1\.3\.patch<\/code> \(the bundle’s\)/u)
  running = { patched: Object.assign(new Error('Other bundles are being validated. Try again shortly.'), { status: 429 }) }
  click(entry('patched'), 'Validate again')
  await settle()
  const failed = templateText(bundleValidationFact(entry('patched'), render))
  assert.match(failed, /is-passed">Valid[^]*role="alert">Couldn’t validate it: Other bundles are being validated/u)
})
