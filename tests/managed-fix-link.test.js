import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let metadata = null
mock.module('../ui/view/managed-pull-requests.js', { namedExports: {
  managedFixes: { read: () => metadata }, subscribeFixes: () => () => {},
} })
mock.module('../ui/view/tooltip.js', { namedExports: { hideTooltip: () => {}, installShadowTooltipListener: () => {} } })
await import('../ui/view/managed-fix-link.js')
const FixLink = customElements.get('managed-fix-link')
function renderText(value) {
  if (value?.strings) return value.strings.map((text, i) => text + renderText(value.values[i])).join('')
  return value == null || ['symbol', 'function'].includes(typeof value) ? '' : String(value)
}

['pull', 'issues'].forEach(kind => {
  test(`${kind} Fix links show the right item kind, title, status and description in compact previews`, () => {
    const link = new FixLink()
    link.url = `https://github.com/org/repo/${kind}/42`
    link.compact = true
    metadata = { title: 'Resolved bug', status: 'closed', description: 'Details of the resolution' }
    const text = renderText(link.render())
    assert.ok(text.includes(`Closed ${kind === 'pull' ? 'pull request' : 'issue'}: Resolved bug`))
    assert.ok(text.includes('Details of the resolution'))
    assert.ok(text.includes('https://github.com/org/repo/'))
  })
})

test('issue reasons label and color both full links and compact previews without changing PR statuses', () => {
  const link = new FixLink()
  link.url = 'https://github.com/org/repo/issues/42'
  for (const [stateReason, label, style] of [
    ['completed', 'Completed', 'completed'], ['not_planned', 'Not planned', 'not_planned'],
    ['duplicate', 'Duplicate', 'duplicate'], ['unknown', 'Closed', 'unknown'], [null, 'Closed', 'unknown'],
  ]) {
    metadata = { title: 'A fix', status: 'closed', stateReason, description: 'Details' }
    for (const compact of [false, true]) {
      link.compact = compact
      const text = renderText(link.render())
      assert.ok(text.includes(`${label} issue: A fix`))
      assert.ok(text.includes(`class=${compact ? 'status' : 'link-icon'} ${style}`))
      assert.ok(text.includes(`class=${compact ? 'status' : 'link-status'} ${style}`))
    }
  }
  metadata = { title: 'A fix', status: 'open', stateReason: 'completed' }
  assert.ok(renderText(link.render()).includes('Open issue: A fix'))
  link.url = 'https://github.com/org/repo/pull/42'
  metadata.status = 'closed'
  assert.ok(renderText(link.render()).includes('Closed pull request: A fix'))
})

test('Fix URLs omitted by the workspace response keep the local/E2E plain-link rendering', () => {
  const link = new FixLink()
  link.url = 'https://github.com/unrelated/private/issues/42'
  metadata = null
  const full = renderText(link.render())
  assert.ok(full.includes(link.url))
  assert.doesNotMatch(full, /fix-preview|preview-title|link-icon|link-status/u)
  link.compact = true
  const compact = renderText(link.render())
  assert.ok(compact.includes(`<slot></slot>`), 'the normal Fix icon is used instead of a GitHub issue/PR icon')
  assert.ok(compact.includes(`Open fix link: ${link.url}`))
  assert.doesNotMatch(compact, /fix-preview|<svg/u)
})
