import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SEVERITIES, backfillFindingIds, correctedVariants, deriveFindingId, displayedSeverity,
  effectiveSeverity, hasSeverityCorrection, loadFindings, parseCodexCsvToScans,
  readReport, severityLabel, writeMarkdown,
} from '../index.js'

const finding = (extra = {}) => ({ severity: 'informative', description: 'Note', file: 'src/a.js', line: '7', ...extra })

test('JSON Informative aliases use the existing tier and preserve IDs through export and reload', async () => {
  for (const severity of ['informative', 'Informative', ' INFORMATIVE ']) {
    for (const source of [finding({ severity }), finding({ severity, fileHash: 'sha512-original' }), finding({ severity, location: 'https://example.com/a#L7' })]) {
      const originalId = await deriveFindingId(source)
      const loaded = await loadFindings(JSON.stringify({ findings: [source] }))
      const [f] = loaded.findings
      assert.equal(f.severity, 'informational')
      assert.equal(f.id, originalId)
      assert.equal((await loadFindings(JSON.stringify(loaded.data))).findings[0].id, originalId)
      const markdown = writeMarkdown({ title: 'Report', groups: [[f]] })
      assert.match(markdown, /Informational/u)
      assert.doesNotMatch(markdown, /Informative/iu)
      const reloaded = await loadFindings(markdown)
      assert.equal(reloaded.findings[0].id, originalId)
      assert.equal(reloaded.findings[0].severity, 'informational')
    }
  }
  assert.ok(!SEVERITIES.includes('informative'), 'no extra filter or sorting tier')
})

test('grouped JSON and already-parsed managed findings normalize original and corrected aliases', async () => {
  const source = finding({ correctedSeverity: 'Informative' })
  const originalId = await deriveFindingId(source)
  const { data } = readReport(JSON.stringify({ groups: [[source, finding({ id: 'upstream-id' })]] }))
  assert.equal(data.groups[0][0].severity, 'informational')
  assert.equal(data.groups[0][0].correctedSeverity, 'informational')
  assert.equal(data.groups[0][1].id, 'upstream-id')
  await backfillFindingIds([source])
  assert.equal(source.severity, 'informational')
  assert.equal(source.correctedSeverity, 'informational')
  assert.equal(source.id, originalId)
})

test('severity readers treat Informative as Informational in both lenses and correction comparisons', () => {
  assert.equal(displayedSeverity(finding(), 'original'), 'informational')
  assert.equal(effectiveSeverity(finding({ severity: 'high', correctedSeverity: 'Informative' })), 'informational')
  assert.equal(severityLabel('Informative'), 'Informational')
  assert.ok(!hasSeverityCorrection(finding({ correctedSeverity: 'informational' })))
  assert.ok(!hasSeverityCorrection(finding({ severity: 'informational', correctedSeverity: 'informative' })))
  assert.ok(hasSeverityCorrection(finding({ correctedSeverity: 'low' })))
  assert.equal(correctedVariants({ _correctedByReport: { a: { severity: 'informative' }, b: { severity: 'informational' } } }), null)
})

const markdownCases = [
  ['Claude Security', '# Note\n\n---\n**Severity:** Informative\n', '50d71e70-3de0-4a19-8145-4daafd83eab2'],
  ['DeepSec', '# Vulnerability Scan Report\n\n## INFORMATIVE (1)\n\n### Note\n\n- **File:** `src/a.js`\n- **Lines:** 7\n', 'd24445c9-24a2-47df-a936-a426fe88a691'],
  ['Piolium detail', '# Security Audit Report\n\n## Technical Findings Detail\n\n### [H1] Note\n- **Severity:** Informative\n', '27f935e1-aa4f-4931-b6b5-66aa786ba0a5'],
  ['Piolium index', '# Security Audit Report\n\n## Summary of Findings\n\n| ID | Title | Severity |\n|----|-------|----------|\n| H1 | Note | Informative |\n', '27f935e1-aa4f-4931-b6b5-66aa786ba0a5'],
]
// IDs captured from the previous parser, before it recognized Informative.
for (const [format, content, originalId] of markdownCases) {
  test(`${format} maps Informative without changing its previous fallback fingerprint`, async () => {
    const { findings: [f] } = await loadFindings(content)
    assert.equal(f.severity, 'informational')
    assert.equal(f.id, originalId)
  })
}

test('Piolium Informative section headings apply to their findings', async () => {
  const content = '# Security Audit Report\n\n## Informative Findings\n\n- **H1** Note\n'
  const loaded = await loadFindings(content)
  assert.equal(loaded.format, 'piolium')
  assert.equal(loaded.findings[0].severity, 'informational')
})

test('Piolium Informative details retain the index severity for their legacy identity', async () => {
  const prefix = '# Security Audit Report\n\n## Summary of Findings\n\n| ID | Title | Severity |\n|----|-------|----------|\n| H1 | Note | Low |\n\n## Technical Findings Detail\n\n### [H1] Note\n'
  const previous = await loadFindings(`${prefix}- **Severity:** Unknown\n`)
  const current = await loadFindings(`${prefix}- **Severity:** Informative\n`)
  assert.equal(current.findings[0].severity, 'informational')
  assert.equal(current.findings[0].id, previous.findings[0].id)
})

test('DeepView markdown accepts Informative original and corrected values', async () => {
  const markdown = writeMarkdown({ title: 'Report', groups: [[finding({ id: 'kept', severity: 'high', correctedSeverity: 'informational' })]] })
  const loaded = await loadFindings(markdown.replaceAll('Informational', 'Informative'))
  assert.equal(loaded.findings[0].correctedSeverity, 'informational')
  assert.equal(loaded.findings[0].id, 'kept')
})

test('Codex CSV Informative aliases retain upstream finding IDs', () => {
  const csv = 'finding_url,repository,title,description,severity,configured_scan_id,relevant_paths\nhttps://example.com/f/1,owner/repo,Note,Details,Informative,scan:1,src/a.js\n'
  const [f] = parseCodexCsvToScans(csv)[0].data.findings
  assert.equal(f.severity, 'informational')
  assert.equal(f.id, 'https://example.com/f/1')
})
