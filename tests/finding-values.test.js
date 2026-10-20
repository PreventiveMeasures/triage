import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expandFindingValues, findingValueIndex } from '../common/managed/finding-values.js'

test('a team\'s findings\' packages and repositories are sent once each, their findings telling their index, and read back as they were', () => {
  const npm = { npm: { name: 'x' } }, repo = { github: 'own/repo', directory: 'app' }
  const plain = { id: 'plain', file: 'src/c.js' }
  const reports = [
    { source: 'deepview', findings: [{ id: 'a', package: npm, repo }, [{ id: 'b', package: { npm: { name: 'x' } } }, plain], { id: 'n', package: null }] },
    { groups: [[{ id: 'c', repo: 'own/repo', package: 7 }]] },
    { source: 'links', links: [['a', 'c']] },
  ]
  const sent = JSON.parse(JSON.stringify(reports))
  const values = findingValueIndex()
  const indexed = sent.map(data => values.index(data))
  assert.deepEqual(values.values, [npm, repo, 7, 'own/repo'], 'a value once, however many findings and reports tell it')
  assert.deepEqual(indexed[0].findings, [{ id: 'a', package: 0, repo: 1 }, [{ id: 'b', package: 0 }, plain], { id: 'n', package: null }])
  assert.deepEqual(indexed[1].groups, [[{ id: 'c', repo: 3, package: 2 }]], 'a number among them as well, so that every one sent is an index')
  assert.strictEqual(indexed[0].findings[1][1], sent[0].findings[1][1], 'a finding without either sent as it is')
  assert.strictEqual(indexed[2], sent[2])
  assert.deepEqual(sent, reports, 'the reports themselves left as they are')
  const read = JSON.parse(JSON.stringify({ reports: indexed, values: values.values }))
  assert.deepEqual(read.reports.map(data => expandFindingValues(data, read.values)), reports)
  const unindexed = { findings: [{ id: 'a', package: 0 }] }
  assert.deepEqual(expandFindingValues(unindexed, undefined), { findings: [{ id: 'a', package: 0 }] }, 'one sent without values read as it is')
})
