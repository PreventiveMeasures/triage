import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import './_polyfills.js'

// Render the actual card without the page renderer and source-preview DOM.
mock.module('../ui/view/render.js', { namedExports: { render() {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: null } })
const { getPackagesIndex } = await import('../client/bundle-finding-index.js')
const { state } = await import('../client/state.ts')
const { findingCardInnerTemplate } = await import('../ui/view/render-finding.js')

function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}

function cardTemplates(t, overrides = {}, findingOverrides = {}) {
  const next = { serverMode: 'managed', localMode: false, currentManagedTeam: 'team',
    managedSession: { id: 'user', login: 'author', role: 'view', csrfToken: 'csrf' }, ...overrides }
  const previous = Object.fromEntries(Object.keys(next).map(key => [key, state[key]]))
  Object.assign(state, next)
  t.after(() => Object.assign(state, previous))
  const finding = { id: 'finding', severity: 'high', title: 'Finding title', description: 'Finding description',
    file: 'src/file.js', repo: { github: 'https://github.com/o/r' }, _managedReportId: 'report', ...findingOverrides }
  return templates(findingCardInnerTemplate([finding]))
}

function issueAction(t, overrides, findingOverrides) {
  return cardTemplates(t, overrides, findingOverrides).find(template => template.strings[0].includes('class="mark-issue"'))
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


test('managed issue targets use finding/report metadata rather than unrelated local package inference', t => {
  const index = getPackagesIndex(), key = 'issue-target-test'
  const previous = index.get(key)
  index.set(key, { files: new Set(['node_modules/pkg/a.js']), repos: new Set(['o/local-only']) })
  t.after(() => { if (previous) index.set(key, previous); else index.delete(key) })
  const finding = { file: 'node_modules/pkg/a.js', _repoFallback: 'o/assigned' }
  const upstream = issueAction(t, {}, { ...finding, repo: { github: 'https://github.com/o/upstream.git/tree/main' } })
  assert.equal(new URL(upstream.values[0]).pathname, '/o/upstream/issues/new')
  const assigned = issueAction(t, {}, { ...finding, repo: undefined })
  assert.equal(new URL(assigned.values[0]).pathname, '/o/assigned/issues/new')
  assert.equal(issueAction(t, { repoUrl: 'o/global' }, { ...finding, repo: undefined, _repoFallback: null }), undefined)
})


for (const manual of ['', 'https://github.com/o/r/pull/2', 'https://github.com/o/r/pull/3']) {
  test(`saved issue replaces creation and renders automatic Fix alongside manual ${manual || '(empty)'}`, t => {
    const autoFix = 'https://github.com/o/r/pull/3', url = 'https://github.com/o/r/issues/1'
    const rendered = cardTemplates(t, { triage: new Map([['finding', { fix: manual }]]), managedIssues: new Map([['finding', { url, autoFix }]]) })
    assert.equal(rendered.some(template => template.strings[0].includes('class="mark-issue"')), false)
    const links = rendered.filter(template => template.strings.join('').includes('<managed-fix-link'))
    assert.ok(links.some(template => template.strings.join('').includes('Issue:') && template.values.includes(url)))
    const auto = links.filter(template => template.strings.join('').includes('Fix from issue:'))
    assert.equal(auto.length, manual === autoFix ? 0 : 1, 'matching links are shown once')
    if (auto.length > 0) assert.ok(auto[0].values.includes(autoFix))
    if (manual) assert.ok(links.some(template => template.values.includes(manual)))
  })
}
