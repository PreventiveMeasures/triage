import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findingsOf, malwareOf, malwareSaid } from '../ui/managed/repository-risk.js'

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
