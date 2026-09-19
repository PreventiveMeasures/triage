import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { autorun, store } from '@rray/frontend/state-management'
import './_polyfills.js'

globalThis[Symbol.for('@rray/frontend')] ??= { html: () => null }

const { saveFile, deleteFile } = await import('../client/storage.js')
const { state, saveRepoUrlFor } = await import('../client/state.ts')
const { knownLinkHint } = await import('../client/finding-link.js')
const { activeTabFor, findGroupById, sortTabs } = await import('../ui/view/group.js')
const { closeLinksPreview, getLinksPreview, openLinksPreview } = await import('../ui/view/links-preview.js')

let sequence = 0
async function fixture(data) {
  const name = `links-preview-test-${++sequence}.json`
  await saveFile(name, JSON.stringify(data))
  state.currentView = 'links'
  state.currentLinks = { name: 'links.json', groups: [['A', 'B']], skipped: 0 }
  state.currentFile = 'links.json'
  return name
}

afterEach(closeLinksPreview)

describe('Links finding preview', () => {
  it('stays active after the first reactive card render and can still close', async () => {
    const name = await fixture({ findings: [[{ id: 'A' }, { id: 'B' }]] })
    await openLinksPreview('B', name)
    const preview = getLinksPreview()
    let renderedPreview
    // FindingCard reads the preview from its StateElement reaction. This
    // lazily wraps currentLinks, which must not look like file navigation.
    const dispose = autorun(() => { renderedPreview = getLinksPreview() })
    dispose()
    assert.equal(renderedPreview, preview)
    assert.equal(getLinksPreview(), preview, 'later source-loading renders keep the preview')
    closeLinksPreview()
    assert.equal(getLinksPreview(), null)
  })

  it('loads the exact report copy without navigating or changing the report set', async () => {
    const name = await fixture({
      type: 'security', model: 'report-model', repo: { github: 'owner/project' }, bundleHashes: ['bundle-hash'],
      findings: [[{ id: 'A', title: 'First' }, { id: 'B', title: 'Chosen', source: 'codex-security', correctedSeverity: 'low' }]],
    })
    const reports = state.reports
    const owner = store(state.currentLinks)
    await openLinksPreview('B', name)
    const preview = getLinksPreview()
    assert.equal(preview.error, '')
    assert.deepEqual(preview.group.map((f) => f.id), ['A', 'B'])
    const chosen = activeTabFor(preview.group)
    assert.equal(chosen.id, 'B')
    assert.equal(chosen.title, 'Chosen')
    assert.equal(chosen._reportName, name)
    assert.equal(chosen._source, 'codex-security')
    assert.equal(chosen._repoFallback, 'owner/project')
    assert.deepEqual(chosen._bundleHashes, ['bundle-hash'])
    assert.equal(chosen.correctedSeverity, 'low')
    assert.equal(chosen.model, 'report-model')
    assert.equal(findGroupById('A'), preview.group, 'the normal card actions resolve the preview row')
    assert.ok(knownLinkHint('report', name), 'copy-link report hint is ready')
    assert.equal(state.currentLinks, owner)
    assert.equal(state.currentView, 'links')
    assert.equal(state.currentFile, 'links.json')
    assert.equal(state.reports, reports)
  })

  it('opens the indicated original row with every tab even when the App lens folds originals', async () => {
    const name = await fixture({ groups: [
      [{ id: 'A' }, { id: 'other-row' }],
      [{ id: 'A', title: 'This row' }, { id: 'B' }, { id: 'pass', revalidate: 'revalidation' }],
    ] })
    state.showRevalidation = true
    state.revalidationDetailed = false
    await openLinksPreview('A', name, 1)
    const group = getLinksPreview().group
    assert.deepEqual(sortTabs(group).map((f) => f.id).toSorted(), ['A', 'B', 'pass'])
    assert.equal(activeTabFor(group).title, 'This row')
    state.activeTabByGroup.set('A', 'B')
    assert.equal(activeTabFor(group).id, 'B', 'existing tab controls can select another member')
    closeLinksPreview()
    assert.deepEqual(sortTabs(group).map((f) => f.id), ['pass'], 'normal cards retain the existing lens')
  })

  it('uses the report source and saved repository fallback', async () => {
    const name = await fixture({ source: 'claude-security', findings: [{ id: 'A', revalidate: 'revalidation' }] })
    saveRepoUrlFor(name, 'owner/fallback')
    await openLinksPreview('A', name)
    const finding = getLinksPreview().group[0]
    assert.equal(finding._source, 'claude-security')
    assert.equal(finding._analyzer, 'claude-security')
    assert.equal(finding._repoFallback, 'owner/fallback')
    assert.equal(finding.revalidate, 'revalidation')
  })

  it('does not reopen a preview dismissed while its report loads', async () => {
    const name = await fixture({ findings: [{ id: 'A' }] })
    const pending = openLinksPreview('A', name)
    assert.equal(getLinksPreview().group, null)
    closeLinksPreview()
    await pending
    assert.equal(getLinksPreview(), null)
  })

  it('discards a pending preview after navigation to another Links file', async () => {
    const name = await fixture({ findings: [{ id: 'A' }] })
    const pending = openLinksPreview('A', name)
    state.currentLinks = { name: 'different.json', groups: [['C', 'D']], skipped: 0 }
    await pending
    assert.equal(getLinksPreview(), null)
  })

  it('discards a pending preview when the same Links file is reloaded', async () => {
    const name = await fixture({ findings: [{ id: 'A' }] })
    const pending = openLinksPreview('A', name)
    state.currentLinks = { ...state.currentLinks }
    await pending
    assert.equal(getLinksPreview(), null)
  })

  it('keeps the latest clicked finding when requests overlap', async () => {
    const name = await fixture({ findings: [{ id: 'A' }, { id: 'B' }] })
    await Promise.all([openLinksPreview('A', name), openLinksPreview('B', name)])
    assert.equal(getLinksPreview().group[0].id, 'B')
  })

  it('reports missing findings and deleted reports without leaving Links', async () => {
    const name = await fixture({ findings: [{ id: 'A' }] })
    await openLinksPreview('unknown', name)
    assert.match(getLinksPreview().error, /no longer/u)
    assert.equal(getLinksPreview().group, null)
    await deleteFile(name)
    await openLinksPreview('A', name)
    assert.ok(getLinksPreview().error)
    assert.equal(state.currentView, 'links')
  })
})
