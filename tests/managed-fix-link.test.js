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
