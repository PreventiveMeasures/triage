// Codex Security CSV parser — `common/parse-codex.js`. Pure function;
// covers the RFC-4180-ish CSV reader (quotes, embedded commas /
// newlines, `""` escaped quotes), per-scan grouping, the
// single-repository-per-scan assertion, and the row → finding mapping.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseCodexCsvToScans } from '../common/parse-codex.js'

const HEADER = [
  'finding_url', 'repository', 'repository_url', 'title', 'description',
  'severity', 'status', 'detected_at', 'committed_at', 'author_email',
  'assignee_name', 'assignee_email', 'has_patch', 'configured_scan_id',
  'commit_hash', 'relevant_paths', 'resolution_reason',
].join(',')

function row(over = {}) {
  const defaults = {
    finding_url: 'https://example.com/finding/1',
    repository: 'alice/widget',
    repository_url: 'https://github.com/alice/widget',
    title: 'A title',
    description: 'A description',
    severity: 'high',
    status: 'open',
    detected_at: '2026-01-15',
    committed_at: '2025-12-01',
    author_email: '',
    assignee_name: '',
    assignee_email: '',
    has_patch: 'false',
    configured_scan_id: 'scan-uuid:scan-1',
    commit_hash: 'abc1234deadbeef',
    relevant_paths: 'src/main.js',
    resolution_reason: '',
  }
  const merged = { ...defaults, ...over }
  return [
    merged.finding_url, merged.repository, merged.repository_url, merged.title,
    merged.description, merged.severity, merged.status, merged.detected_at,
    merged.committed_at, merged.author_email, merged.assignee_name,
    merged.assignee_email, merged.has_patch, merged.configured_scan_id,
    merged.commit_hash, merged.relevant_paths, merged.resolution_reason,
  ].join(',')
}

function csv(...rows) {
  return [HEADER, ...rows].join('\n') + '\n'
}

describe('parseCodexCsvToScans — header validation', () => {
  it('throws on empty input', () => {
    assert.throws(() => parseCodexCsvToScans(''), /empty or missing header/u)
  })

  it('throws "empty or missing header" on a header-only file', () => {
    // `parseCsvRows` strips the trailing-newline phantom row, so a
    // header line with nothing after it parses to a single row →
    // rows.length < 2 → header-error branch.
    assert.throws(() => parseCodexCsvToScans(`${HEADER}\n`), /empty or missing header row/u)
  })

  it('throws "no rows with a configured_scan_id" when every data row lacks one', () => {
    // Need at least 2 rows so the header check passes; the next gate
    // is the per-row scan-id presence check.
    assert.throws(
      () => parseCodexCsvToScans(csv(row({ configured_scan_id: '' }))),
      /no rows with a configured_scan_id/u,
    )
  })

  it('throws when a required column is missing', () => {
    const partial = 'finding_url,repository,title\nx,y,z\n'
    assert.throws(() => parseCodexCsvToScans(partial), /missing required column/u)
  })
})

describe('parseCodexCsvToScans — basic row → finding mapping', () => {
  it('emits one scan with one finding under the correct displayName', () => {
    const scans = parseCodexCsvToScans(csv(row()))
    assert.equal(scans.length, 1)
    assert.equal(scans[0].displayName, 'alice/widget:scan-1')
    assert.equal(scans[0].data.type, 'security')
    assert.equal(scans[0].data.source, 'codex-security')
    assert.equal(scans[0].data.findings.length, 1)
  })

  it('uses finding_url as the stable id', () => {
    const url = 'https://example.com/finding/abc123'
    const scans = parseCodexCsvToScans(csv(row({ finding_url: url })))
    assert.equal(scans[0].data.findings[0].id, url)
  })

  it('captures repo, severity, commit hash, dates', () => {
    const scans = parseCodexCsvToScans(csv(row({
      severity: 'CRITICAL',
      commit_hash: 'deadbeef',
      detected_at: '2026-04-01',
      committed_at: '2025-11-30',
    })))
    const f = scans[0].data.findings[0]
    assert.deepEqual(f.repo, { github: 'alice/widget' })
    assert.equal(f.severity, 'critical') // lowercased
    assert.equal(f.commitHash, 'deadbeef')
    assert.equal(f.detectedAt, '2026-04-01')
    assert.equal(f.committedAt, '2025-11-30')
  })

  it('joins title + description with a blank line', () => {
    const scans = parseCodexCsvToScans(csv(row({
      title: 'SQL injection',
      description: 'Concatenated user input.',
    })))
    assert.equal(
      scans[0].data.findings[0].description,
      'SQL injection\n\nConcatenated user input.',
    )
  })

  it('uses just title or just description when one side is empty', () => {
    const scansT = parseCodexCsvToScans(csv(row({ title: 'Only title', description: '' })))
    assert.equal(scansT[0].data.findings[0].description, 'Only title')
    const scansD = parseCodexCsvToScans(csv(row({ title: '', description: 'Only desc' })))
    assert.equal(scansD[0].data.findings[0].description, 'Only desc')
  })

  it('defaults severity to "medium" when missing', () => {
    const scans = parseCodexCsvToScans(csv(row({ severity: '' })))
    assert.equal(scans[0].data.findings[0].severity, 'medium')
  })

  it('uses the FIRST relevant_path (drops siblings for now)', () => {
    const scans = parseCodexCsvToScans(csv(row({
      relevant_paths: 'src/a.js | src/b.js | src/c.js',
    })))
    assert.equal(scans[0].data.findings[0].file, 'src/a.js')
  })

  it('falls back to "unknown" when relevant_paths is empty', () => {
    const scans = parseCodexCsvToScans(csv(row({ relevant_paths: '' })))
    assert.equal(scans[0].data.findings[0].file, 'unknown')
  })

  it('always sets line to "?" (codex CSVs have no line numbers)', () => {
    const scans = parseCodexCsvToScans(csv(row()))
    assert.equal(scans[0].data.findings[0].line, '?')
  })
})

describe('parseCodexCsvToScans — multi-scan grouping', () => {
  it('emits one entry per configured_scan_id', () => {
    const csvText = csv(
      row({ configured_scan_id: 'p:scan-1', repository: 'org/a' }),
      row({ configured_scan_id: 'p:scan-2', repository: 'org/b' }),
      row({ configured_scan_id: 'p:scan-1', repository: 'org/a' }),
    )
    const scans = parseCodexCsvToScans(csvText)
    assert.equal(scans.length, 2)
    const scan1 = scans.find((s) => s.displayName.endsWith(':scan-1'))
    const scan2 = scans.find((s) => s.displayName.endsWith(':scan-2'))
    assert.equal(scan1.data.findings.length, 2)
    assert.equal(scan2.data.findings.length, 1)
  })

  it('strips the prefix-up-to-first-colon from the displayName', () => {
    const scans = parseCodexCsvToScans(csv(row({ configured_scan_id: 'long-uuid:short-id' })))
    assert.equal(scans[0].displayName, 'alice/widget:short-id')
  })

  it('keeps the full id when no `:` is present in configured_scan_id', () => {
    const scans = parseCodexCsvToScans(csv(row({ configured_scan_id: 'noprefix-id' })))
    assert.equal(scans[0].displayName, 'alice/widget:noprefix-id')
  })

  it('throws when one scan spans multiple repositories', () => {
    const csvText = csv(
      row({ configured_scan_id: 'p:scan-1', repository: 'org/a' }),
      row({ configured_scan_id: 'p:scan-1', repository: 'org/b' }),
    )
    assert.throws(() => parseCodexCsvToScans(csvText), /multiple repositories/u)
  })

  it('skips rows with no configured_scan_id', () => {
    const csvText = csv(
      row({ configured_scan_id: '' }),
      row({ configured_scan_id: 'p:keep-me' }),
    )
    const scans = parseCodexCsvToScans(csvText)
    assert.equal(scans.length, 1)
    assert.equal(scans[0].data.findings.length, 1)
  })
})

describe('parseCodexCsvToScans — CSV reader edge cases', () => {
  it('handles quoted fields containing commas', () => {
    const scans = parseCodexCsvToScans(csv(row({
      title: '"one, two, three"',
      description: '"a, b"',
    })))
    assert.match(scans[0].data.findings[0].description, /one, two, three/u)
    assert.match(scans[0].data.findings[0].description, /a, b/u)
  })

  it('handles `""` escaped quotes inside a quoted field', () => {
    const scans = parseCodexCsvToScans(csv(row({
      title: '"He said ""hello"""',
    })))
    assert.match(scans[0].data.findings[0].description, /He said "hello"/u)
  })

  it('handles embedded newlines inside quoted fields', () => {
    const scans = parseCodexCsvToScans(csv(row({
      description: '"line one\nline two"',
    })))
    assert.match(scans[0].data.findings[0].description, /line one\nline two/u)
  })

  it('tolerates a trailing newline at end of file', () => {
    // csv() already adds a trailing newline; verify a double trailing
    // newline doesn't produce a phantom empty-row finding.
    const text = `${csv(row())}\n`
    const scans = parseCodexCsvToScans(text)
    assert.equal(scans.length, 1)
    assert.equal(scans[0].data.findings.length, 1)
  })

  it('handles \\r\\n line endings', () => {
    const text = csv(row()).replace(/\n/gu, '\r\n')
    const scans = parseCodexCsvToScans(text)
    assert.equal(scans.length, 1)
    assert.equal(scans[0].data.findings.length, 1)
  })
})
