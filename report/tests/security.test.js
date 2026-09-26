import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inheritReportMeta, isSecurityFinding, stampSecurityGroups } from '../index.js'

test('security and dependencies default to security unless the boolean field is false', () => {
  for (const type of ['security', 'dependencies']) {
    for (const security of [undefined, null, true, 'false', 0]) {
      assert.equal(isSecurityFinding({ type, security }), true)
    }
    assert.equal(isSecurityFinding({ type, security: false, severity: 'critical' }), false)
    assert.equal(isSecurityFinding({ analyzer: type }), true)
  }
  for (const type of ['correctness', 'analysis', 'Security', 'security-extra', undefined]) {
    assert.equal(isSecurityFinding({ type, severity: 'high' }), false)
    assert.equal(isSecurityFinding({ type, security: true }), true)
    assert.equal(isSecurityFinding({ type, security: 'true' }), false)
  }
})

test('external imports use original security severities independently of security false', () => {
  for (const source of ['deepsec', 'piolium', 'claude-security', 'codex-security', 'other-import']) {
    for (const severity of ['critical', 'high', 'medium', 'low']) {
      assert.equal(isSecurityFinding({ source, severity, security: false, correctedSeverity: 'bug' }), true)
    }
    for (const severity of ['high_bug', 'bug', 'informational', undefined]) {
      assert.equal(isSecurityFinding({ source, severity, correctedSeverity: 'high' }), false)
    }
  }
  for (const source of [undefined, null, '', 'deepview']) {
    assert.equal(isSecurityFinding({ source, severity: 'high', isApp: true }), false)
  }
})

test('run metadata inheritance respects external report provenance', () => {
  for (const type of ['security', 'dependencies']) {
    const finding = {}
    inheritReportMeta(finding, { type })
    assert.equal(isSecurityFinding(finding), true)
  }
  const finding = { severity: 'bug' }
  const report = { source: 'deepsec', type: 'security' }
  inheritReportMeta(finding, report)
  stampSecurityGroups([[finding]], { source: report.source })
  assert.equal(finding.isSecurity, false)
})

test('row siblings and overlapping identities propagate regardless of visibility or load order', () => {
  for (const reverse of [false, true]) {
    const groups = [
      [{ id: 'app', type: 'correctness' }, { id: 'source', security: true, revalidate: 'refuted' }],
      [{ id: 'app', security: false }, { id: 'sibling', type: 'correctness' }],
      [{ id: 'unrelated', type: 'correctness' }],
    ]
    if (reverse) groups.reverse()
    stampSecurityGroups(groups)
    for (const f of groups.flat()) assert.equal(f.isSecurity, f.id !== 'unrelated')
    assert.equal(stampSecurityGroups(groups), false, 'idempotent')
  }
})

test('known linked rows propagate transitively through siblings and cycles without loading reports', () => {
  const groups = [[{ id: 'a' }], [{ id: 'other' }]]
  const index = [
    { members: [{ id: 'b', isSecurity: false }, { id: 'c', isSecurity: false }] },
    { members: [{ id: 'd', isSecurity: true }, { id: 'e', isSecurity: true }] },
  ]
  const links = new Map([['a', ['b', 'unknown']], ['c', ['d']], ['e', ['a']]])
  const lookups = []
  const options = {
    linkedIds: id => links.get(id) ?? [],
    knownRows: ids => { lookups.push(...ids); return index.filter(row => row.members.some(f => ids.includes(f.id))) },
  }
  stampSecurityGroups(groups, options)
  assert.equal(groups[0][0].isSecurity, true)
  assert.equal(groups[1][0].isSecurity, false)
  assert.equal(new Set(lookups).size, lookups.length, 'each known id is visited once')
  assert.ok(lookups.includes('unknown'), 'missing linked findings are harmless')
  assert.equal(index[0].members[0].isSecurity, false, 'read-only index rows are not mutated')
  links.clear()
  stampSecurityGroups(groups, options)
  assert.equal(groups[0][0].isSecurity, false, 'removed links do not leave sticky positive flags')
})

test('removing a sibling or changing evidence recomputes the stamp', () => {
  const finding = { id: 'a', isSecurity: true, security: false }
  const sibling = { security: true }
  const group = [finding, sibling]
  stampSecurityGroups([group])
  assert.equal(finding.isSecurity, true)
  group.pop()
  stampSecurityGroups([group])
  assert.equal(finding.isSecurity, false)
  assert.equal(finding.security, false, 'the original field is never overwritten')
  assert.doesNotThrow(() => stampSecurityGroups([[null, false, {}]]))
})
