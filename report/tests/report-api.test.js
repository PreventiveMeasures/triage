// `report/index.js` — the report library's public surface. The parsers
// under `report/` each have their own suite; this one pins the door in
// front of them: which format wins for a given document, what counts
// as a report at all, what each entry point hands back, and that the
// whole read path (recognise → flatten → id) works in one call.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { analyzeReport, backfillFindingIds, detectFormat, loadFindings, readReport } from '../index.js'

const JSON_REPORT = JSON.stringify({
  type: 'security',
  findings: [
    { file: 'src/a.js', line: '10', severity: 'high', description: 'One' },
    { file: 'src/b.js', line: '20', severity: 'low', description: 'Two' },
  ],
})

const CLAUDE_SECURITY = [
  '# Unsafe deserialization',
  '',
  '## Details',
  'The loader trusts input.',
  '',
  '## Location',
  '[src/load.ts:42](https://github.com/o/r/blob/abc/src/load.ts#L42)',
  '',
  '---',
  '**Severity:** critical',
  '**Category:** Security',
].join('\n')

const DEEPSEC = [
  '# Vulnerability Scan Report',
  '',
  '## HIGH (1)',
  '',
  '### A finding',
  '',
  '- **File:** `src/x.js`',
  '- **Lines:** 1',
  '',
].join('\n')

const PIOLIUM = [
  '# Security Audit Report: example-project',
  '=========================================',
  '',
  '## Technical Findings Detail',
  '---------------------------',
  '',
  '### [C1] Command injection in the build hook',
  '',
  '- **Severity:** CRITICAL',
  '- **Key Code Reference:** src/build.js:12',
  '',
  '## Conclusion',
  '-------------',
  'Final assessment.',
].join('\n')

describe('readReport — dispatch', () => {
  it('takes JSON first, with no reason to give', () => {
    const { data, format, reason } = readReport(JSON_REPORT)
    assert.equal(format, 'json')
    assert.equal(reason, null)
    assert.equal(data.findings.length, 2)
  })

  it('takes a pre-deduplicated dump off `groups`', () => {
    const { data, format } = readReport(JSON.stringify({ groups: [[{ description: 'a' }]] }))
    assert.equal(format, 'json')
    assert.equal(data.groups.length, 1)
  })

  it('recognises each markdown producer by name', () => {
    assert.equal(readReport(CLAUDE_SECURITY).format, 'claude-security')
    assert.equal(readReport(DEEPSEC).format, 'deepsec')
    assert.equal(readReport(PIOLIUM).format, 'piolium')
  })

  it('names the format the same way the parser marks its output', () => {
    for (const md of [CLAUDE_SECURITY, DEEPSEC, PIOLIUM]) {
      const { data, format } = readReport(md)
      assert.equal(format, data.source, format)
    }
  })

  it('says why when nothing recognises the text', () => {
    const { data, format, reason } = readReport('not a report at all')
    assert.equal(data, null)
    assert.equal(format, null)
    assert.match(reason, /not a recognized markdown format/u)
  })

  it('quotes the JSON error for a malformed dump', () => {
    // The common failure: a truncated analyzer dump. It is not markdown
    // either, so the reason leans on the parse error.
    const { data, reason } = readReport('{"findings": [{"file": "a.js"')
    assert.equal(data, null)
    assert.match(reason, /JSON error: /u)
  })

  // A JSON file is a report only when it carries a findings (or groups)
  // array; anything else that parses is some other JSON file, not an
  // empty report — and the reason says which of the two it hit.
  it('does not take valid JSON without a findings array as a report', () => {
    for (const text of ['{"hello": "world"}', '[]', '{"findings": "nope"}', '{"findings": {"a": 1}}']) {
      const { data, format, reason } = readReport(text)
      assert.equal(data, null, text)
      assert.equal(format, null, text)
      assert.match(reason, /not a report/u)
    }
  })
})

describe('detectFormat', () => {
  it('names the producer', () => {
    assert.equal(detectFormat(JSON_REPORT), 'json')
    assert.equal(detectFormat(CLAUDE_SECURITY), 'claude-security')
    assert.equal(detectFormat('nope'), null)
  })

  // Codex is the format the content doesn't name — its export is a
  // CSV — so the filename decides it, and only it.
  it('takes a .csv filename as codex, whatever the content', () => {
    const csv = 'finding_url,repository,title\nx,y,z\n'
    assert.equal(detectFormat(csv, 'export.csv'), 'codex')
    assert.equal(detectFormat(csv, 'EXPORT.CSV'), 'codex')
    assert.equal(detectFormat(csv, 'scans/acme (1).csv'), 'codex')
    // No filename: a CSV's content names nothing.
    assert.equal(detectFormat(csv), null)
  })

  it('lets the content name every other format', () => {
    assert.equal(detectFormat(JSON_REPORT, 'findings.md'), 'json')
    assert.equal(detectFormat(CLAUDE_SECURITY, 'report.txt'), 'claude-security')
    assert.equal(detectFormat('nope', 'report.md'), null)
  })
})

describe('analyzeReport — entries and producer, nothing else', () => {
  it('counts JSON entries and reports no source for a native dump', () => {
    assert.deepEqual(analyzeReport(JSON_REPORT), { count: 2, source: undefined, recognized: true })
  })

  it('counts an ENTRY, not the findings a grouped entry holds', () => {
    const grouped = JSON.stringify({ findings: [[{ description: 'a' }, { description: 'b' }]] })
    assert.equal(analyzeReport(grouped).count, 1)
  })

  it('counts markdown findings and names their producer', () => {
    assert.deepEqual(analyzeReport(CLAUDE_SECURITY), { count: 1, source: 'claude-security', recognized: true })
    assert.equal(analyzeReport(DEEPSEC).source, 'deepsec')
    assert.equal(analyzeReport(PIOLIUM).source, 'piolium')
  })

  it('treats valid JSON with no findings[] as unrecognised', () => {
    assert.deepEqual(analyzeReport('{"hello": "world"}'), { count: 0, recognized: false })
    assert.deepEqual(analyzeReport('[]'), { count: 0, recognized: false })
  })

  it('counts a pre-deduplicated dump by its groups', () => {
    assert.equal(analyzeReport(JSON.stringify({ groups: [[{ description: 'a' }], { description: 'b' }] })).count, 2)
  })

  it('reports nothing recognisable as unrecognised', () => {
    assert.deepEqual(analyzeReport('plain prose'), { count: 0, recognized: false })
  })
})

describe('backfillFindingIds', () => {
  it('fills in the missing ids and leaves the existing ones alone', async () => {
    const findings = [
      { severity: 'high', description: 'One', file: 'a.js', line: '1' },
      { id: 'already-set', severity: 'low', description: 'Two', file: 'b.js', line: '2' },
    ]
    await backfillFindingIds(findings)
    assert.match(findings[0].id, /^[0-9a-f-]{36}$/u)
    assert.equal(findings[1].id, 'already-set')
  })

  it('derives the same id twice for the same finding', async () => {
    const of = async () => {
      const f = [{ severity: 'high', description: 'One', file: 'a.js', line: '1' }]
      await backfillFindingIds(f)
      return f[0].id
    }
    assert.equal(await of(), await of())
  })
})

describe('loadFindings — the whole read path', () => {
  it('recognises, flattens and ids in one call', async () => {
    const report = await loadFindings(JSON_REPORT)
    assert.equal(report.format, 'json')
    assert.equal(report.data.type, 'security')
    assert.equal(report.findings.length, 2)
    for (const f of report.findings) assert.match(f.id, /^[0-9a-f-]{36}$/u)
  })

  it('carries the markdown producer through as the format and the source', async () => {
    const report = await loadFindings(CLAUDE_SECURITY)
    assert.equal(report.format, 'claude-security')
    assert.equal(report.data.source, 'claude-security')
    assert.equal(report.findings[0].file, 'src/load.ts')
  })

  it('flattens grouped entries and drops what is not a finding', async () => {
    const report = await loadFindings(JSON.stringify({
      findings: [{ description: 'a' }, [{ description: 'b' }, { description: 'c' }], null, 'stray', [null]],
    }))
    assert.deepEqual(report.findings.map((f) => f.description), ['a', 'b', 'c'])
  })

  it('reads a pre-grouped dump off `groups`', async () => {
    const report = await loadFindings(JSON.stringify({
      groups: [[{ severity: 'high', description: 'One', file: 'a.js', line: '1' }]],
    }))
    assert.equal(report.findings.length, 1)
  })

  it('hands the findings back as the parser\'s own objects', async () => {
    const report = await loadFindings(JSON_REPORT)
    assert.equal(report.findings[0], report.data.findings[0])
  })

  it('returns null for anything that is not a report', async () => {
    assert.equal(await loadFindings('plain prose'), null)
    assert.equal(await loadFindings('{"hello": "world"}'), null)
  })
})
