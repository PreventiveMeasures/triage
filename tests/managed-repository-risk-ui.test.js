import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ago, findingsOf, malwareOf, malwareSaid, putOff, riskOf, scoreOf } from '../ui/managed/repository-risk.js'
import { templateText } from './_lit.js'

test('a package’s malware is told from npm’s registry or a mirror alike, but where its integrity differs from npm’s', () => {
  const malware = new Set(['GHSA-2v46-p5h4-248w'])
  const row = (source, risk) => ({ name: 'chalk', version: '5.6.1', source, risk, malware })
  for (const source of ['registry', 'mirror']) {
    assert.equal(malwareOf(row(source, { error: 'version-not-found' })), malware, `${source}: npm deleted the version, as it does malware's`)
    assert.equal(malwareOf(row(source, { severity: null, findings: [] })), malware, `${source}: assessed`)
    assert.equal(malwareOf(row(source, undefined)), malware, `${source}: not yet assessed`)
    assert.equal(malwareOf(row(source, { error: 'integrity-mismatch' })), null, `${source}: not npm's artifact`)
  }
  assert.equal(malwareOf({ name: 'left-pad', version: '1.3.0', source: 'registry', risk: { severity: null, findings: [] } }), null, 'no advisory of malware')
})

test('a package’s Malware is told once, of npm’s advisories and of its package taken down by npm alike, each said in its tooltip', () => {
  const taken = { severity: 'critical', findings: [{ id: 'malware', severity: 'critical', takenDown: true }, { id: 'too-new', severity: 'high' }] }
  const row = (malware, risk) => ({ name: 'crossenv', version: '1.0.0', source: 'registry', malware, risk })
  const both = row(new Set(['GHSA-c2m4-w5hm-vqjw']), taken)
  assert.deepEqual(findingsOf(both).map(({ id }) => id), ['malware', 'too-new'], 'once')
  assert.deepEqual(malwareSaid(both), ['GHSA-c2m4-w5hm-vqjw', 'Taken down by npm'])
  assert.deepEqual(findingsOf(row(undefined, taken)).map(({ id }) => id), ['malware', 'too-new'], 'risk\'s alone')
  assert.deepEqual(malwareSaid(row(undefined, taken)), ['Taken down by npm'])
  assert.deepEqual(malwareSaid(row(new Set(['GHSA-2v46-p5h4-248w']), { error: 'package-not-found' })), ['GHSA-2v46-p5h4-248w'], 'the advisories\' alone')
})

test('a package is told by its risk score, in its level’s color, and its findings; lockfiles a line a repository, all in the page’s scroll pane', () => {
  const page = new (customElements.get('managed-admin-repo-risk'))()
  page._state = 'done'
  for (const line of [
    { type: 'repos', repos: [{ id: 1, fullName: 'org/one' }, { id: 2, fullName: 'org/two' }] },
    { type: 'repo', id: 1, commit: 'a'.repeat(40), lockfiles: [{ path: 'package-lock.json', format: 'npm' }, { path: 'web/pnpm-lock.yaml', format: 'pnpm' }] },
    { type: 'repo', id: 2, error: 'github-unreachable', detail: 'listing its lockfiles: TimeoutError: The operation was aborted due to timeout, after 30.0s' },
    { type: 'lockfile', repo: 1, path: 'package-lock.json', format: 'npm', packages: [{ name: 'left-pad', version: '1.3.0', source: 'registry' },
      { name: 'debug', version: '4.4.0', source: 'registry' }, { name: 'chalk', version: '5.6.1', source: 'registry' }] },
    { type: 'lockfile', repo: 1, path: 'web/pnpm-lock.yaml', format: 'pnpm', error: 'lockfile-unreadable', detail: 'not YAML' },
    { type: 'risk', name: 'chalk', version: '5.6.1', published: null, severity: 'critical', score: 62, findings: [{ id: 'held-exfiltration', severity: 'critical' }, { id: 'too-new', severity: 'high' }] },
    { type: 'risk', name: 'debug', version: '4.4.0', published: null, severity: 'high', score: 7, findings: [{ id: 'publisher', severity: 'high' }] },
    { type: 'risk', name: 'left-pad', version: '1.3.0', error: 'upstream-unavailable', detail: 'fetch failed' },
  ]) page._apply(line)
  const text = templateText(page.render())
  assert.match(text, /<div class="manage-list">[\s\S]*Lockfiles[\s\S]*<th class="risk-findings-column">Findings<\/th>/u, 'lockfiles, then the results, in one scroll pane')
  assert.match(text, />Risk<\/span><\/th><th class="risk-findings-column">Findings/u)
  assert.match(text, /<span class=risk-score risk-high>62<\/span>/u, 'orange from 50')
  assert.match(text, /<span class=risk-score risk-low>7<\/span>/u, 'plain under 25, however severe its findings')
  assert.deepEqual(page._rows().map(row => row.name), ['chalk', 'debug', 'left-pad'], 'the riskiest first, one that couldn\'t be told after')
  assert.equal(text.split('>org/one<').length - 1, 1, 'a repository named once, its lockfiles beside it')
  assert.match(text, /package-lock\.json<\/span><span class="risk-lockfile-meta">npm · 3 packages/u)
  assert.match(text, /data-tooltip=not YAML>Unreadable/u)
  assert.match(text, /data-tooltip=listing its lockfiles: TimeoutError[^>]*>GitHub unreachable/u)
  assert.match(text, />Exfiltration host<\/li>[\s\S]*>Too new<\/li>/u)
  assert.match(text, /data-tooltip=fetch failed>npm unavailable/u, 'a package risk couldn\'t be told of says why where its findings are')
})

test('a package’s risk score is risk’s, malware’s 100 as npm’s advisories tell it too, and none where it isn’t told', () => {
  const row = (risk, malware) => ({ name: 'chalk', version: '5.6.1', source: 'registry', risk, ...malware ? { malware: new Set(['GHSA-2v46-p5h4-248w']) } : {} })
  assert.equal(scoreOf(row({ severity: 'high', score: 38, findings: [] })), 38)
  assert.equal(scoreOf(row({ severity: null, score: 0, findings: [] })), 0)
  assert.equal(scoreOf(row({ severity: 'high', score: 38, findings: [] }, true)), 100, 'npm\'s advisories of malware')
  assert.equal(scoreOf(row({ error: 'version-not-found' }, true)), 100, 'npm deleted the version, as it does malware\'s')
  assert.equal(scoreOf(row(null)), null, 'not yet told')
  assert.equal(scoreOf(row({ error: 'upstream-unavailable' })), null)
  assert.equal(scoreOf(row({ error: 'integrity-mismatch' }, true)), null, 'not npm\'s artifact')
})

test('a risk kept and gone stale is told, dimmed and said so, until assessed again; one that couldn\'t be keeps it, saying why', () => {
  const page = new (customElements.get('managed-admin-repo-risk'))()
  page._state = 'running'
  const assessedAt = Date.now() - 3 * 24 * 60 * 60_000
  for (const line of [
    { type: 'repos', repos: [{ id: 1, fullName: 'org/one' }] },
    { type: 'repo', id: 1, commit: 'a'.repeat(40), lockfiles: [{ path: 'package-lock.json', format: 'npm' }] },
    { type: 'lockfile', repo: 1, path: 'package-lock.json', format: 'npm', packages: [{ name: 'debug', version: '4.4.0', source: 'registry' }] },
    { type: 'risk', name: 'debug', version: '4.4.0', published: null, severity: 'high', score: 54, findings: [{ id: 'publisher', severity: 'high' }], stale: { assessedAt } },
  ]) page._apply(line)
  const text = () => templateText(page.render())
  assert.match(text(), /<tr class=is-stale>/u)
  assert.match(text(), /risk-high>54<\/span><span class="risk-stale" data-tooltip=Assessed 3 days ago; to be assessed again once the rest are>stale/u)
  assert.match(text(), /· 1 stale/u)
  page._apply({ type: 'risk', name: 'debug', version: '4.4.0', error: 'upstream-unavailable', detail: 'fetch failed' })
  assert.match(text(), /risk-high>54<[^]*couldn’t be assessed again: npm unavailable: fetch failed>stale/u, 'the stale risk kept')
  page._apply({ type: 'risk', name: 'debug', version: '4.4.0', published: null, severity: null, score: 0, findings: [] })
  assert.doesNotMatch(text(), /is-stale|risk-stale/u, 'assessed again, fresh')
})

test('a risk line told as kept is stale where it says so, an error of one stale its own', () => {
  const stale = { assessedAt: 1 }
  assert.equal(riskOf({ severity: null, score: 0, findings: [], published: null }, null).stale, null)
  assert.deepEqual(riskOf({ error: 'integrity-mismatch', stale }, null), { error: 'integrity-mismatch', detail: null, stale })
  assert.deepEqual(riskOf({ error: 'npm-busy' }, { error: 'integrity-mismatch', detail: null, stale }), { error: 'npm-busy', detail: null, stale: null }, 'a stale failure is replaced')
  const now = Date.parse('2026-10-14T12:00:00Z')
  assert.deepEqual([5 * 60_000, 3 * 60 * 60_000, 3 * 24 * 60 * 60_000].map(before => ago(now - before, now)), ['5 minutes ago', '3 hours ago', '3 days ago'])
})

test('packages only devDependencies need, in every lockfile that locks them, are tagged dev and listed after the rest, but malware; their advisories after the rest too', () => {
  const page = new (customElements.get('managed-admin-repo-risk'))()
  page._state = 'done'
  const advisory = (id, name, severity, versions, malware = false) => ({ id, name, title: id, severity, url: null, range: null, versions, malware })
  for (const line of [
    { type: 'repos', repos: [{ id: 1, fullName: 'org/one' }] },
    { type: 'repo', id: 1, commit: 'a'.repeat(40), lockfiles: [{ path: 'package-lock.json', format: 'npm' }, { path: 'web/pnpm-lock.yaml', format: 'pnpm' }] },
    { type: 'lockfile', repo: 1, path: 'package-lock.json', format: 'npm', packages: [{ name: 'left-pad', version: '1.3.0', source: 'registry' },
      { name: 'mocha', version: '10.0.0', source: 'registry', dev: true }, { name: 'eslint', version: '9.0.0', source: 'registry', dev: true },
      { name: 'crossenv', version: '1.0.0', source: 'registry', dev: true }] },
    { type: 'lockfile', repo: 1, path: 'web/pnpm-lock.yaml', format: 'pnpm', packages: [{ name: 'mocha', version: '10.0.0', source: 'registry' },
      { name: 'eslint', version: '9.0.0', source: 'registry', dev: true }] },
    { type: 'risk', name: 'left-pad', version: '1.3.0', published: null, severity: 'moderate', score: 5, findings: [{ id: 'deprecated', severity: 'moderate' }] },
    { type: 'risk', name: 'mocha', version: '10.0.0', published: null, severity: null, score: 0, findings: [] },
    { type: 'risk', name: 'eslint', version: '9.0.0', published: null, severity: 'high', score: 60, findings: [{ id: 'too-new', severity: 'high' }] },
    { type: 'risk', name: 'crossenv', version: '1.0.0', published: null, severity: 'critical', score: 100, findings: [{ id: 'malware', severity: 'critical', takenDown: true }] },
    { type: 'advisories', repo: 1, path: 'package-lock.json', advisories: [advisory('GHSA-eslint', 'eslint', 'critical', ['9.0.0']),
      advisory('GHSA-left-pad', 'left-pad', 'low', ['1.3.0']), advisory('GHSA-crossenv', 'crossenv', 'critical', ['1.0.0'], true)] },
  ]) page._apply(line)
  assert.deepEqual([...page._packages.values()].map(row => [row.name, row.dev]), [['left-pad', false], ['mocha', false], ['eslint', true], ['crossenv', true]],
    'dev only where every lockfile locks it so')
  assert.deepEqual(page._rows().map(row => [row.name, putOff(row)]), [['crossenv', false], ['left-pad', false], ['mocha', false], ['eslint', true]],
    'the riskiest first of those needed, malware among them, those of devDependencies alone after')
  const text = templateText(page.render())
  assert.match(text, />eslint<\/a><span class="risk-dev" data-tooltip=Only devDependencies need it[^>]*>dev<\/span>/u)
  assert.doesNotMatch(text, />mocha<\/a><span class="risk-dev"/u)
  assert.deepEqual(page._advisoryRows().map(row => [row.id, row.dev]), [['GHSA-crossenv', true], ['GHSA-left-pad', false], ['GHSA-eslint', true]],
    'malware first, then those of versions needed, however less severe')
  page._tab = 'advisories'
  assert.match(templateText(page.render()), />eslint<\/a><span class="risk-dev" data-tooltip=Only devDependencies need the versions it affects[^>]*>dev</u)
})
