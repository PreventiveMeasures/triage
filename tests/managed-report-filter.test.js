import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterReportContent, filterReportData } from '../common/managed/report-filter.ts'

const perms = (dependencies = false, security = false) => ({ dependencies, security })
const ids = data => (data.findings ?? data.groups).map(entry => Array.isArray(entry) ? entry.map(f => f.id) : entry.id)
const npm = name => ({ npm: { name } })

test('security permission uses analyzer defaults and allows classifier downgrades in security reports', () => {
  for (const type of ['security', 'dependencies']) {
    const report = { type, findings: [
      { id: 'default', file: 'src/a.js' },
      { id: 'downgraded', security: false, severity: 'critical' },
      { id: 'correctness', type: 'correctness' },
      { id: 'flag', type: 'correctness', security: true },
    ] }
    assert.deepEqual(ids(filterReportData(report, perms(true))), ['downgraded', 'correctness'])
  }
})

test('external reports use original security severity, independently of an App stamp or corrected severity', () => {
  const report = { source: 'codex-security', type: 'security', findings: [
    { id: 'high', severity: 'high', security: false, correctedSeverity: 'bug', isApp: true },
    { id: 'bug', severity: 'bug', correctedSeverity: 'high' },
    { id: 'info', severity: 'informational' },
    { id: 'native', source: 'deepview', type: 'security', security: false, severity: 'high' },
  ] }
  assert.deepEqual(ids(filterReportData(report, perms())), ['bug', 'info', 'native'])
})

test('security removes complete original rows before dependency filtering, and shared identities propagate', () => {
  const report = { groups: [
    [{ id: 'app', isApp: true, security: false }, { id: 'hidden', file: 'node_modules/dep/a.js', security: true }],
    [{ id: 'app', security: false }, { id: 'other', file: 'src/a.js' }],
    [{ id: 'allowed-app', isApp: true, file: 'node_modules/dep/a.js' }, { id: 'denied', file: 'node_modules/dep/b.js' }],
    [{ id: 'own', file: 'src/b.js' }],
  ] }
  assert.deepEqual(ids(filterReportData(report, perms())), [['allowed-app'], ['own']])
  assert.deepEqual(ids(filterReportData(report, perms(true))), [['allowed-app', 'denied'], ['own']])
  assert.deepEqual(ids(filterReportData(report, perms(false, true))), [['app'], ['app', 'other'], ['allowed-app'], ['own']])
})

test('known positive security stamps are honored, while false stamps cannot bypass classification', () => {
  const report = { findings: [
    { id: 'linked', security: false, isSecurity: true },
    { id: 'intrinsic', type: 'security', isSecurity: false },
    { id: 'ordinary', isSecurity: false },
  ] }
  assert.deepEqual(ids(filterReportData(report, perms())), ['ordinary'])
})

test('App findings survive dependency filtering independent of their declared file', () => {
  const report = { findings: [
    { id: 'explicit', file: 'vendor/third/a.js', isApp: true },
    { id: 'pass', file: 'dependencies/third/a.js', revalidate: 'revalidation' },
    { id: 'external', file: 'node_modules/third/a.js', source: 'deepsec' },
    { id: 'explicit-source', file: 'node_modules/third/a.js', source: 'deepsec', isApp: false },
    { id: 'own', file: 'src/a.js' },
  ] }
  assert.deepEqual(ids(filterReportData(report, perms(false, true))), ['explicit', 'pass', 'external', 'own'])
})

test('dependency filtering keeps exact GitHub and npm organizations from own source and the report', () => {
  const report = { repo: { github: 'https://github.com/ReportOrg/app.git' }, package: npm('@report/app'), findings: [
    { id: 'own', file: 'src/a.js', repo: { github: 'OwnOrg/app' }, package: npm('@own/app') },
    { id: 'report-github', file: 'node_modules/lib/a.js', repo: { github: 'reportorg/lib' } },
    { id: 'own-github', file: 'vendor/lib/a.js', repo: { github: 'https://github.com/OWNORG/lib/tree/main' } },
    { id: 'report-npm', file: 'dependencies/lib/a.js', package: npm('@report/lib') },
    { id: 'own-npm', file: 'node_modules/lib/a.js', package: npm('@own/lib') },
    { id: 'path-npm', file: 'node_modules/.pnpm/x/node_modules/@own/lib/a.js' },
    { id: 'near-github', file: 'node_modules/lib/a.js', repo: { github: 'reportorg-other/lib' } },
    { id: 'near-npm', file: 'vendor/lib/a.js', package: npm('@own-other/lib') },
    { id: 'foreign', file: 'dependencies/lib/a.js', repo: { github: 'third/lib' }, package: npm('@third/lib') },
    { id: 'unscoped', file: 'node_modules/lib/a.js', package: npm('lib') },
  ] }
  assert.deepEqual(ids(filterReportData(report, perms(false, true))), ['own', 'report-github', 'own-github', 'report-npm', 'own-npm', 'path-npm'])
})

test('only own-source anchors grant organization exceptions, not App or dependency findings', () => {
  const report = { findings: [
    { id: 'app', isApp: true, file: 'src/a.js', repo: { github: 'external/app' }, package: npm('@external/app') },
    { id: 'dep', file: 'node_modules/a/index.js', repo: { github: 'third/a' }, package: npm('@third/a') },
    { id: 'sibling-dep', file: 'node_modules/b/index.js', repo: { github: 'third/b' }, package: npm('@third/b') },
    { id: 'app-org-dep', file: 'node_modules/b/index.js', repo: { github: 'external/b' }, package: npm('@external/b') },
  ] }
  assert.deepEqual(ids(filterReportData(report, perms(false, true))), ['app'])
})

test('server repository assignments override embedded report organizations, including unassigned', () => {
  const report = { repo: { github: 'old/app' }, findings: [
    { id: 'old', file: 'node_modules/lib/a.js', repo: { github: 'old/lib' } },
    { id: 'new', file: 'node_modules/lib/a.js', repo: { github: 'new/lib' } },
  ] }
  assert.deepEqual(ids(filterReportData(report, perms(false, true), { github: 'new/app' })), ['new'])
  assert.deepEqual(ids(filterReportData(report, perms(false, true), { github: null })), [])
})

test('all dependency path markers are checked without matching partial directory names', () => {
  const report = { findings: [
    { id: 'node', file: 'node_modules/dep/a.js' }, { id: 'vendor', file: 'vendor/dep/a.js' },
    { id: 'deps', file: 'dependencies/dep/a.js' }, { id: 'windows', file: 'x\\node_modules\\dep\\a.js' },
    { id: 'own', file: 'my-node_modules-src/a.js' },
  ] }
  assert.deepEqual(ids(filterReportData(report, perms(false, true))), ['own'])
})

test('filtering preserves the cached input and surviving member shapes without stamping it', () => {
  const own = Object.freeze({ id: 'own', file: 'src/a.js' })
  const dep = Object.freeze({ id: 'dep', file: 'node_modules/lib/a.js' })
  const report = Object.freeze({ type: 'correctness', groups: Object.freeze([Object.freeze([own, dep])]) })
  const filtered = filterReportData(report, perms())
  assert.deepEqual(filtered.groups, [[own]])
  assert.equal(filtered.groups[0][0], own)
  assert.deepEqual(report.groups, [[own, dep]])
  assert.equal(filterReportData(report, perms(true, true)), report)
})

test('raw Markdown responses cannot bypass security filtering', () => {
  const report = '# Security finding\n\n---\n**Severity:** high\n'
  const filtered = JSON.parse(filterReportContent(report, perms(), 'report.md'))
  assert.deepEqual(filtered.findings, [])
  assert.equal(filterReportContent(report, perms(false, true), 'report.md'), report)
})
