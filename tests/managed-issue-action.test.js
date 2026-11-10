import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { templates } from './_lit.js'

// Render the actual card without the page renderer and source-preview DOM.
mock.module('../ui/view/render.js', { namedExports: { render() {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: null } })
const { getPackagesIndex } = await import('../client/bundle-finding-index.js')
const { state } = await import('../client/state.ts')
const { findingCardInnerTemplate } = await import('../ui/view/render-finding.js')
const { cardLinkFor } = await import('../ui/view/managed-issues.js')

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
  assert.equal(draft.searchParams.has('body'), false, 'the dialog drafts the body from the finding')
})

test('the prefilled issue body links each evidence row as it links File:', t => {
  const action = issueAction(t, { serverMode: 'standalone' }, { line: '3', repo: { github: 'o/r' },
    evidence: [{ file: 'src/file.js', line: '3' }, { file: 'src/sink.js', line: '9-12', text: 'The sink (line 10).' }] })
  const lines = new URL(action.values[0]).searchParams.get('body').split('\n')
  const blob = 'https://github.com/o/r/blob/HEAD/src'
  assert.ok(lines.includes(`File: [src/file.js:3](${blob}/file.js#L3)`))
  assert.ok(lines.includes(`1. [src/file.js:3](${blob}/file.js#L3)`))
  assert.ok(lines.includes(`2. [src/sink.js:9-12](${blob}/sink.js#L9-L12)`))
  assert.ok(lines.includes(`   The sink ([line 10](${blob}/sink.js#L10)).`))
})

// Outside managed mode the form is the only way in, so its body is the
// one the managed dialog creates through the API: every section, the
// alerts included, and the source pinned to the commit the report read.
test('the prefilled issue body is the managed dialog\'s, every section in', t => {
  const commit = 'a'.repeat(40)
  const finding = { line: '3', repo: undefined, _repoFallback: 'o/r', _repoCommit: commit, isSecurity: true,
    impact: 'Data leaks.', reproduction: 'Run it.', recommendation: 'Check it.', evidence: [{ file: 'src/sink.js', line: '9-12' }] }
  const body = new URL(issueAction(t, { serverMode: 'standalone' }, finding).values[0]).searchParams.get('body')
  // The source at that commit opens the issue as GitHub's snippet of it;
  // the Evidence rows stay labelled links.
  assert.equal(body, [
    `https://github.com/o/r/blob/${commit}/src/file.js#L3`,
    'Finding description',
    '> [!CAUTION]\n> **Impact:**\n> Data leaks.',
    `**Evidence:**\n1. [src/sink.js:9-12](https://github.com/o/r/blob/${commit}/src/sink.js#L9-L12)`,
    '**Reproduction:**\nRun it.',
    '> [!TIP]\n> **Recommendation:**\n> Check it.',
  ].join('\n\n'))
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
    const rendered = cardTemplates(t, { triage: new Map([['finding', { fix: manual }]]), managedIssues: new Map([['finding', { url, autoFix, duplicateOf: null }]]) })
    assert.equal(rendered.some(template => template.strings[0].includes('class="mark-issue"')), false)
    const links = rendered.filter(template => template.strings.join('').includes('<managed-fix-link'))
    assert.ok(links.some(template => template.strings.join('').includes('Issue:') && template.values.includes(url)))
    const auto = links.filter(template => template.strings.join('').includes('Fix from issue:'))
    assert.equal(auto.length, manual === autoFix ? 0 : 1, 'matching links are shown once')
    if (auto.length > 0) assert.ok(auto[0].values.includes(autoFix))
    if (manual) assert.ok(links.some(template => template.values.includes(manual)))
  })
}

test('kanban cards link the manual Fix, else the issue\'s pull request, else the issue it duplicates, else the issue', t => {
  const autoFix = 'https://github.com/o/r/pull/3', duplicateOf = 'https://github.com/o/r/issues/9', finding = { id: 'finding' }, url = 'https://github.com/o/r/issues/1'
  const previous = { serverMode: state.serverMode, localMode: state.localMode, currentManagedTeam: state.currentManagedTeam,
    managedSession: state.managedSession, managedIssues: state.managedIssues }
  t.after(() => Object.assign(state, previous))
  Object.assign(state, { serverMode: 'managed', localMode: false, currentManagedTeam: 'team',
    managedSession: { id: 'user', role: 'view', csrfToken: 'csrf' }, managedIssues: new Map([['finding', { url, autoFix: null, duplicateOf: null }]]) })
  assert.equal(cardLinkFor(finding, null), url)
  assert.equal(cardLinkFor(finding, { fix: '' }), url)
  assert.equal(cardLinkFor(finding, { fix: 'https://github.com/o/r/pull/2' }), 'https://github.com/o/r/pull/2')
  assert.equal(cardLinkFor(finding, { fix: 'patched upstream' }), 'patched upstream')
  state.managedIssues.set('finding', { url, autoFix, duplicateOf: null })
  assert.equal(cardLinkFor(finding, null), autoFix)
  assert.equal(cardLinkFor(finding, { fix: 'https://github.com/o/r/pull/2' }), 'https://github.com/o/r/pull/2')
  state.managedIssues.set('finding', { url, autoFix: null, duplicateOf })
  assert.equal(cardLinkFor(finding, null), duplicateOf)
  state.managedIssues.set('finding', { url, autoFix, duplicateOf })
  assert.equal(cardLinkFor(finding, null), autoFix, 'a pull request still wins')
  state.managedSession = { publicShare: true }
  assert.equal(cardLinkFor(finding, null), '', 'public links never show saved issues')
})

test('an issue closed as a duplicate shows the issue it duplicates beside it', t => {
  const duplicateOf = 'https://github.com/o/r/issues/9', url = 'https://github.com/o/r/issues/1'
  const rendered = cardTemplates(t, { triage: new Map(), managedIssues: new Map([['finding', { url, autoFix: null, duplicateOf }]]) })
  const links = rendered.filter(template => template.strings.join('').includes('<managed-fix-link'))
  assert.ok(links.some(template => template.strings.join('').includes('Issue:') && template.values.includes(url)), 'the saved issue is kept')
  assert.ok(links.some(template => template.strings.join('').includes('Duplicate of:') && template.values.includes(duplicateOf)))
  const plain = cardTemplates(t, { triage: new Map(), managedIssues: new Map([['finding', { url, autoFix: null, duplicateOf: null }]]) })
  assert.equal(plain.some(template => template.strings.join('').includes('Duplicate of:')), false)
})
