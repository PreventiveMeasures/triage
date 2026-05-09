// Markdown findings parser — `common/parse-md.js`. Pure function; the
// only globals it touches are RegExp / String prototype methods, so
// every branch is testable directly.
//
// Format reminder (one finding shown):
//
//   # <Title>
//
//   ## Details
//   <Details>
//
//   ## Location
//   [<name>](<url>)
//
//   …other optional sections…
//
//   ---
//   **Severity:** <critical|high|medium|low>
//   **Status:** Open
//   **Category:** <category>
//   **Repository:** <owner/repo>
//   **Branch:** <branch>
//   **Date created:** <YYYY-MM-DD>

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseMarkdownFindings } from '../common/parse-md.js'

describe('parseMarkdownFindings — format guards', () => {
  it('returns null for empty input', () => {
    assert.equal(parseMarkdownFindings(''), null)
  })

  it('returns null for plain text without an h1', () => {
    assert.equal(parseMarkdownFindings('not a finding\nfoo bar'), null)
  })

  it('returns null for h2-only input (must start with h1)', () => {
    assert.equal(parseMarkdownFindings('## Subhead\n\ncontent'), null)
  })

  it('returns null when no parsed block produces a finding', () => {
    // Just an h1 with no title text → block returns null → findings=[].
    assert.equal(parseMarkdownFindings('# \n\n'), null)
  })

  it('normalizes \\r\\n line endings', () => {
    const parsed = parseMarkdownFindings('# Title\r\n\r\n---\r\n**Severity:** high\r\n')
    assert.equal(parsed.findings.length, 1)
    assert.equal(parsed.findings[0].severity, 'high')
  })
})

describe('parseMarkdownFindings — single finding', () => {
  it('extracts title, severity, default file/line', () => {
    const md = '# Title here\n\n---\n**Severity:** critical\n'
    const parsed = parseMarkdownFindings(md)
    assert.equal(parsed.type, 'analysis')
    assert.equal(parsed.source, 'claude-security')
    assert.equal(parsed.findings.length, 1)
    const f = parsed.findings[0]
    assert.equal(f.severity, 'critical')
    assert.equal(f.file, 'unknown')
    assert.equal(f.line, '?')
    assert.match(f.description, /Title here/u)
  })

  it('defaults severity to medium when missing', () => {
    const parsed = parseMarkdownFindings('# Title\n\n---\n**Status:** Open\n')
    assert.equal(parsed.findings[0].severity, 'medium')
  })

  it('defaults severity to medium when unrecognized', () => {
    const parsed = parseMarkdownFindings('# Title\n\n---\n**Severity:** spicy\n')
    assert.equal(parsed.findings[0].severity, 'medium')
  })

  it('accepts every documented severity tier', () => {
    for (const sev of ['critical', 'high', 'medium', 'low', 'high_bug', 'bug', 'informational']) {
      const parsed = parseMarkdownFindings(`# T\n\n---\n**Severity:** ${sev}\n`)
      assert.equal(parsed.findings[0].severity, sev, `tier ${sev}`)
    }
  })

  it('lowercases severity input', () => {
    const parsed = parseMarkdownFindings('# T\n\n---\n**Severity:** HIGH\n')
    assert.equal(parsed.findings[0].severity, 'high')
  })
})

describe('parseMarkdownFindings — sections', () => {
  it('builds description from title + Details + Impact + Reproduction', () => {
    const md = [
      '# Bad thing',
      '',
      '## Details',
      'It happened.',
      '',
      '## Impact',
      'Things broke.',
      '',
      '## Reproduction steps',
      'Step 1.',
      '',
      '---',
      '**Severity:** high',
    ].join('\n')
    const f = parseMarkdownFindings(md).findings[0]
    assert.match(f.description, /Bad thing/u)
    assert.match(f.description, /It happened\./u)
    assert.match(f.description, /Impact: Things broke\./u)
    assert.match(f.description, /Reproduction: Step 1\./u)
  })

  it('extracts recommendation from Recommended fix section', () => {
    const md = '# T\n\n## Recommended fix\nDo X then Y.\n\n---\n**Severity:** medium\n'
    const f = parseMarkdownFindings(md).findings[0]
    assert.equal(f.recommendation, 'Do X then Y.')
  })

  it('strips ** bold markers from description', () => {
    const md = '# T\n\n## Details\nThis **is bold** text.\n\n---\n**Severity:** medium\n'
    const f = parseMarkdownFindings(md).findings[0]
    assert.match(f.description, /This is bold text\./u)
    assert.doesNotMatch(f.description, /\*\*/u)
  })

  it('skips missing sections silently', () => {
    const md = '# Just a title\n\n---\n**Severity:** low\n'
    const f = parseMarkdownFindings(md).findings[0]
    assert.equal(f.description, 'Just a title')
  })
})

describe('parseMarkdownFindings — location parsing', () => {
  it('extracts file + line from a markdown link with #L<n> anchor', () => {
    const md = [
      '# T',
      '',
      '## Location',
      '[src/foo.js](https://github.com/o/r/blob/HEAD/src/foo.js#L42)',
      '',
      '---',
      '**Severity:** medium',
    ].join('\n')
    const f = parseMarkdownFindings(md).findings[0]
    assert.equal(f.file, 'src/foo.js')
    assert.equal(f.line, '42')
    assert.equal(f.location, 'https://github.com/o/r/blob/HEAD/src/foo.js#L42')
  })

  it('extracts line from a `:42` suffix on the file path', () => {
    const md = [
      '# T',
      '',
      '## Location',
      '[src/foo.js:99](https://example.com/src/foo.js)',
      '',
      '---',
      '**Severity:** medium',
    ].join('\n')
    const f = parseMarkdownFindings(md).findings[0]
    assert.equal(f.file, 'src/foo.js')
    assert.equal(f.line, '99')
  })

  it('prefers #L<n> anchor over `:<n>` suffix when both are present', () => {
    const md = [
      '# T',
      '',
      '## Location',
      '[src/foo.js:99](https://example.com/src/foo.js#L7)',
      '',
      '---',
      '**Severity:** medium',
    ].join('\n')
    const f = parseMarkdownFindings(md).findings[0]
    assert.equal(f.file, 'src/foo.js')
    assert.equal(f.line, '7')
  })

  it('falls back to raw text when no markdown link is present', () => {
    const md = [
      '# T',
      '',
      '## Location',
      'src/foo.js',
      '',
      '---',
      '**Severity:** medium',
    ].join('\n')
    const f = parseMarkdownFindings(md).findings[0]
    assert.equal(f.file, 'src/foo.js')
    assert.equal(f.location, 'src/foo.js')
    assert.equal(f.line, '?')
  })
})

describe('parseMarkdownFindings — metadata', () => {
  it('captures repository, branch, dateCreated, status', () => {
    const md = [
      '# T',
      '',
      '---',
      '**Severity:** high',
      '**Status:** Open',
      '**Category:** vulnerability',
      '**Repository:** alice/widget',
      '**Branch:** main',
      '**Date created:** 2026-01-15',
    ].join('\n')
    const f = parseMarkdownFindings(md).findings[0]
    assert.deepEqual(f.repo, { github: 'alice/widget' })
    assert.equal(f.branch, 'main')
    assert.equal(f.dateCreated, '2026-01-15')
    assert.equal(f.status, 'Open')
    assert.equal(f.type, 'vulnerability')
  })

  it('lowercases the per-finding category to match the JSON shape', () => {
    const md = '# T\n\n---\n**Severity:** medium\n**Category:** Security\n'
    const f = parseMarkdownFindings(md).findings[0]
    assert.equal(f.type, 'security')
  })

  it('drops report-level type fallback to "analysis" when no finding has a category', () => {
    const md = '# T\n\n---\n**Severity:** medium\n'
    const parsed = parseMarkdownFindings(md)
    assert.equal(parsed.type, 'analysis')
  })

  it('uses the first finding-level category as the report-level type', () => {
    const md = [
      '# T1\n\n---\n**Severity:** medium\n**Category:** Quality',
      '# T2\n\n---\n**Severity:** medium\n**Category:** Security',
    ].join('\n\n')
    const parsed = parseMarkdownFindings(md)
    assert.equal(parsed.type, 'quality')
  })
})

describe('parseMarkdownFindings — multiple findings', () => {
  it('parses two findings separated by `---` between them', () => {
    const md = [
      '# Finding A',
      '',
      '---',
      '**Severity:** high',
      '',
      '# Finding B',
      '',
      '---',
      '**Severity:** low',
    ].join('\n')
    const parsed = parseMarkdownFindings(md)
    assert.equal(parsed.findings.length, 2)
    assert.match(parsed.findings[0].description, /Finding A/u)
    assert.equal(parsed.findings[0].severity, 'high')
    assert.match(parsed.findings[1].description, /Finding B/u)
    assert.equal(parsed.findings[1].severity, 'low')
  })

  it('skips blocks with no title (whitespace-only title)', () => {
    // First block opens with `# \n` — title is empty, parseBlock returns null.
    // The valid block follows. Use a `## ` so the empty-title block still
    // has a body that doesn't get confused for the next h1.
    const md = '# \n\n## Stub\nignored\n\n# Real title\n\n---\n**Severity:** medium\n'
    const parsed = parseMarkdownFindings(md)
    assert.ok(parsed)
    assert.equal(parsed.findings.length, 1)
    assert.match(parsed.findings[0].description, /Real title/u)
  })
})
