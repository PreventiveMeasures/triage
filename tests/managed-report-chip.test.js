import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { browserAt } from './_managed-browser.js'

const hash = `#public=link0001.${'A'.repeat(43)}`
globalThis.location = new URL(`https://triage.test/team/shared-team${hash}`)
// Keep the real card template, link builder and capability parser; skip the
// page renderer and DOM handles used only by source-preview interactions.
mock.module('../ui/view/render.js', { namedExports: { render() {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: null } })
const { state } = await import('../client/state.ts')
const { findingCardInnerTemplate } = await import('../ui/view/render-finding.js')
const { findingLinkFor } = await import('../ui/view/finding-link.js')
const { createManagedHistory } = await import('../ui/view/managed-history.js')
const { parsePublicShare } = await import('../client/managed/public-share.js')

function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}

const finding = { id: 'issue /?# é', severity: 'high', description: 'Shared finding', _reportName: 'report.json', _managedReportId: 'report-id' }

test('public report-chip href retains the capability for native new-tab navigation', async () => {
  state.serverMode = 'managed'
  state.localMode = false
  state.currentWorkspace = 'managed-team:team-id'
  state.currentManagedTeam = 'team-id'
  state.currentManagedReport = null
  state.managedTeams = [{ id: 'team-id', slug: 'shared-team', reports: [{ id: 'report-id', slug: 'shared-report' }] }]
  state.reports = [{ fileName: 'report.json', groups: [[finding]] }]
  const chip = templates(findingCardInnerTemplate([finding])).find(template => template.strings[0].includes('<a class="report-chip '))
  assert.ok(chip, 'managed team cards expose a native report link')
  const href = chip.values[0]
  const url = new URL(href)
  const path = `/team/shared-team/report/shared-report/finding/${encodeURIComponent(finding.id)}`
  assert.equal(url.origin, location.origin)
  assert.equal(url.pathname, path)
  assert.equal(url.hash, hash)
  assert.equal(url.search, '', 'the capability stays out of the request URL')
  assert.deepEqual(parsePublicShare(url.hash), parsePublicShare(hash))

  const { browser } = browserAt(location.href)
  const nav = createManagedHistory(browser)
  await nav.start(() => true)
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { button: 1 }, { target: '_blank' }]) {
    assert.equal(await browser.click(href, options), false, 'native link actions remain native')
  }
  // Open Link in New Tab starts solely from the rendered href. It cannot
  // depend on interception by the original tab's history handler.
  const { browser: opened } = browserAt(href)
  let restored
  await createManagedHistory(opened).start(route => { restored = route; return true })
  assert.equal(restored.teamSlug, 'shared-team')
  assert.equal(restored.reportSlug, 'shared-report')
  assert.equal(restored.finding.id, finding.id)
  assert.equal(opened.location.hash, hash)
  assert.equal(await browser.click(href), true)
  assert.equal(browser.location.href, opened.location.href, 'ordinary and native navigation reach the same destination')
  assert.equal(new URL(findingLinkFor(finding)).hash, '', 'copyable finding references remain credential-free')
})
