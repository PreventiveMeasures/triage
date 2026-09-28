import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import './_polyfills.js'
import '../ui/view/frontend-install.js'

// Render the actual card without the page renderer and source-preview DOM.
mock.module('../ui/view/render.js', { namedExports: { render() {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: null } })
const { state } = await import('../client/state.ts')
const { findingCardInnerTemplate } = await import('../ui/view/render-finding.js')

function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}

function issueAction(t, overrides = {}) {
  const next = { serverMode: 'managed', localMode: false, currentManagedTeam: 'team',
    managedSession: { id: 'user', login: 'author', role: 'view', csrfToken: 'csrf' }, ...overrides }
  const previous = Object.fromEntries(Object.keys(next).map(key => [key, state[key]]))
  Object.assign(state, next)
  t.after(() => Object.assign(state, previous))
  const finding = { id: 'finding', severity: 'high', title: 'Finding title', description: 'Finding description',
    file: 'src/file.js', repo: { github: 'https://github.com/o/r' }, _managedReportId: 'report' }
  return templates(findingCardInnerTemplate([finding])).find(template => template.strings[0].includes('class="mark-issue"'))
}

test('managed issue action has no native creation URL for modified clicks or Open Link in New Tab', t => {
  const action = issueAction(t)
  assert.ok(action)
  const markup = action.strings.join('')
  assert.match(markup, /^<button type="button"/u)
  assert.doesNotMatch(markup, /\bhref=|\btarget=/u, 'native link actions cannot skip the existing-issue lookup')
  assert.match(markup, /data-issue-form=/u)
  const draft = new URL(action.values[0])
  assert.equal(draft.pathname, '/o/r/issues/new')
  assert.equal(draft.searchParams.get('title'), 'Finding title')
  assert.match(draft.searchParams.get('body'), /Finding description/u)
})

for (const [mode, overrides] of [
  ['e2e', { serverMode: 'e2e' }],
  ['standalone', { serverMode: 'standalone' }],
  ['local', { localMode: true }],
  ['public share', { managedSession: { publicShare: true } }],
]) {
  test(`${mode} issue action retains the prefilled GitHub link`, t => {
    const action = issueAction(t, overrides)
    assert.ok(action)
    assert.match(action.strings.join(''), /^<a class="mark-issue" href= target="_blank"/u)
    assert.equal(new URL(action.values[0]).pathname, '/o/r/issues/new')
  })
}
