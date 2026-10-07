import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitMarkdownImport } from '../common/markdown-import.js'
import { loadManagedFindings, readManagedReport } from '../common/managed/report-content.ts'
import { filterReportContent } from '../common/managed/report-filter.ts'
import { genericMarkdown } from './_generic-markdown.js'

test('generic imports produce independent JSON reports with repository metadata and normalized severities', async () => {
  const reports = splitMarkdownImport(genericMarkdown, 'audit.md')
  assert.deepEqual(reports.map((report) => report.name), ['audit: Product%20A.generic-md', 'audit: Product%20B.generic-md'])
  for (const [index, report] of reports.entries()) {
    const { data } = readManagedReport(report.content, report.name)
    assert.equal(data.source, 'markdown-generic')
    assert.equal(data.repo.github, ['a/a', 'a/b'][index])
    assert.equal(data.findings.length, 1)
    assert.equal(data.findings[0].severity, ['critical', 'medium'][index])
    assert.equal(data.findings[0].security, true)
    const loaded = await loadManagedFindings(report.content, report.name)
    assert.equal(loaded.findings[0].sourceId, ['AAA-02', 'BBB-05'][index])
    assert.match(loaded.findings[0].id, /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u)
    assert.equal(loaded.findings[0].id, (await loadManagedFindings(genericMarkdown, 'audit.md')).findings[index].id)
  }
  assert.ok(JSON.parse(reports[0].content).findings[0].description.includes('Foo `code` --> something happens --> something else happens'))
})

test('derived names preserve distinct products containing filename separators and escape-like text', () => {
  const reports = splitMarkdownImport(genericMarkdown.replaceAll('Product A', 'A/B').replaceAll('Product B', 'A%2FB'), 'audit.MARKDOWN')
  assert.equal(new Set(reports.map((report) => report.name)).size, 2)
  assert.ok(reports.every((report) => !report.name.includes('/')))
  assert.deepEqual(reports.map((report) => JSON.parse(report.content).product), ['A/B', 'A%2FB'])
})

test('generic managed reads and security filtering include every product', async () => {
  const parsed = readManagedReport(genericMarkdown, 'audit.md')
  assert.equal(parsed.format, 'markdown-generic')
  assert.deepEqual(parsed.data.findings.map((finding) => finding.sourceId), ['AAA-02', 'BBB-05'])
  const visible = filterReportContent(genericMarkdown, { dependencies: false, security: true }, 'audit.md')
  assert.equal((await loadManagedFindings(visible, 'audit.md')).findings.length, 2)
  const hidden = filterReportContent(genericMarkdown, { dependencies: true, security: false }, 'audit.md')
  assert.deepEqual(readManagedReport(hidden, 'audit.md').data.findings, [])
})

test('repository and prefix errors reject the complete import, while other formats keep their existing path', () => {
  const invalidRepo = genericMarkdown.replace('a/b/blob/abcdef0/f/g/h.js', 'a/other/blob/abcdef0/f/g/h.js')
  assert.throws(() => splitMarkdownImport(invalidRepo, 'bad.md'), /exactly one repository/u)
  assert.equal(readManagedReport(invalidRepo, 'bad.md').data, null)
  const invalidPrefix = genericMarkdown.replaceAll('https://github.com/a/b/', 'https://github.com/a/a/')
  assert.throws(() => splitMarkdownImport(invalidPrefix, 'bad.md'), /unsupported repository ID prefixes/u)
  assert.equal(readManagedReport(invalidPrefix, 'bad.md').data, null)
  for (const content of ['{"findings":[]}', '# Claude report\n\n## Details\n\nText', 'finding_url,repository\na,b']) {
    assert.equal(splitMarkdownImport(content, 'existing.csv'), null)
  }
})

test('different repositories can share finding ID prefixes', () => {
  const reports = splitMarkdownImport(genericMarkdown.replaceAll('BBB-05', 'AAA-05'), 'audit.md')
  assert.deepEqual(reports.map((report) => JSON.parse(report.content).repo.github), ['a/a', 'a/b'])
  assert.deepEqual(reports.map((report) => JSON.parse(report.content).findings[0].sourceId), ['AAA-02', 'AAA-05'])
})

test('unsupported generic Markdown aborts both local and managed imports', async () => {
  const text = genericMarkdown.replace('### Attack Scenario', '### Other')
  assert.throws(() => splitMarkdownImport(text, 'bad.md'), /unsupported.*missing required headers/u)
  assert.equal(readManagedReport(text, 'bad.md').data, null)
  assert.equal(await loadManagedFindings(text, 'bad.md'), null)
})
