// Markdown findings parser — `report/parse-md.js`. Pure function; the
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
//   ## Evidence
//   1. [<name>](<url>)
//      <Description>
//   2. [<name>](<url>)
//      <Description>
//
//   …other optional sections…
//
// Older reports carry `## Location` ([<name>](<url>)) instead; both
// paths are pinned below.
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

import { parseMarkdownFindings } from '../parse-md.js'

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
    assert.match(f.description, /\*\*Impact:\*\* Things broke\./u)
    assert.match(f.description, /\*\*Reproduction:\*\* Step 1\./u)
  })

  it('extracts recommendation from Recommended fix section', () => {
    const md = '# T\n\n## Recommended fix\nDo X then Y.\n\n---\n**Severity:** medium\n'
    const f = parseMarkdownFindings(md).findings[0]
    assert.equal(f.recommendation, 'Do X then Y.')
  })

  // The renderer turns `**bold**` into real <strong> emphasis, so the
  // report's own markers are kept rather than stripped — as are the
  // `**Label:**` prefixes this parser adds.
  it('keeps ** bold markers for the renderer to emphasize', () => {
    const md = '# T\n\n## Details\nThis **is bold** text.\n\n---\n**Severity:** medium\n'
    const f = parseMarkdownFindings(md).findings[0]
    assert.match(f.description, /This \*\*is bold\*\* text\./u)
  })

  it('keeps ** bold markers in the recommendation', () => {
    const md = '# T\n\n## Recommended fix\nUse **safeMerge()**.\n\n---\n**Severity:** medium\n'
    assert.equal(parseMarkdownFindings(md).findings[0].recommendation, 'Use **safeMerge()**.')
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

  it('unescapes a path the report escaped for markdown', () => {
    const md = [
      '# T',
      '',
      '## Location',
      '[a/b/\\_cc\\_cc/index.js:10](https://example.com/a.ts#L10)',
      '',
      '---',
      '**Severity:** medium',
    ].join('\n')
    const f = parseMarkdownFindings(md).findings[0]
    assert.equal(f.file, 'a/b/_cc_cc/index.js')
    // The URL is left exactly as written — it is the id discriminator.
    assert.equal(f.location, 'https://example.com/a.ts#L10')
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

// `## Evidence` — the newer Claude Security layout, a numbered list
// where each row cites one site and notes what it shows. The FIRST row
// is the finding's location; every row lands on `finding.evidence` as
// structured data (the card renders it as a list, and the text surfaces
// rebuild the markdown from it), so the description does NOT repeat it.
describe('parseMarkdownFindings — evidence section', () => {
  const md = (...evidence) => [
    '# T',
    '',
    '## Details',
    'Something is wrong.',
    '',
    '## Evidence',
    ...evidence,
    '',
    '## Impact',
    'Bad.',
    '',
    '---',
    '**Severity:** high',
  ].join('\n')

  const TWO_ROWS = [
    '1. [libs/libraries/a.ts:10–20](https://github.com/o/r/blob/abc123/libs/libraries/a.ts#L10-L20)',
    '   Entry point that parses the payload.',
    '2. [libs/libraries/b.ts:30](https://github.com/o/r/blob/abc123/libs/libraries/b.ts#L30)',
    '   The sink.',
  ]

  it('takes file, line and link from the first row', () => {
    const f = parseMarkdownFindings(md(...TWO_ROWS)).findings[0]
    assert.equal(f.file, 'libs/libraries/a.ts')
    assert.equal(f.line, '10-20')
    assert.equal(f.location, 'https://github.com/o/r/blob/abc123/libs/libraries/a.ts#L10-L20')
  })

  it('lands every row on `evidence`, ref + note apart', () => {
    const f = parseMarkdownFindings(md(...TWO_ROWS)).findings[0]
    assert.deepEqual(f.evidence, [
      {
        file: 'libs/libraries/a.ts',
        line: '10-20',
        url: 'https://github.com/o/r/blob/abc123/libs/libraries/a.ts#L10-L20',
        text: 'Entry point that parses the payload.',
      },
      {
        file: 'libs/libraries/b.ts',
        line: '30',
        url: 'https://github.com/o/r/blob/abc123/libs/libraries/b.ts#L30',
        text: 'The sink.',
      },
    ])
  })

  it('keeps the rows out of the description', () => {
    const f = parseMarkdownFindings(md(...TWO_ROWS)).findings[0]
    assert.doesNotMatch(f.description, /Evidence/u)
    assert.doesNotMatch(f.description, /libs\/libraries/u)
    // The neighbouring sections are untouched.
    assert.match(f.description, /Something is wrong\./u)
    assert.match(f.description, /\*\*Impact:\*\* Bad\./u)
  })

  it('left-trims a note and keeps its own line breaks', () => {
    const f = parseMarkdownFindings(md(
      '1. [src/a.ts:10](https://example.com/a.ts#L10)',
      '   First note line.',
      '      Second note line.',
    )).findings[0]
    assert.equal(f.evidence[0].text, 'First note line.\nSecond note line.')
  })

  it('normalizes an en-dashed line range to a plain hyphen', () => {
    const f = parseMarkdownFindings(md('1. [src/a.ts:10–20](https://example.com/a.ts)')).findings[0]
    assert.equal(f.evidence[0].file, 'src/a.ts')
    assert.equal(f.evidence[0].line, '10-20')
  })

  it('reads a range from a `#L10-L20` anchor', () => {
    const f = parseMarkdownFindings(md('1. [src/a.ts](https://example.com/a.ts#L10-L20)')).findings[0]
    assert.equal(f.line, '10-20')
  })

  it('keeps a single-line reference single', () => {
    const f = parseMarkdownFindings(md('1. [src/a.ts:10](https://example.com/a.ts#L10)')).findings[0]
    assert.equal(f.line, '10')
  })

  // Reports escape the markdown metacharacters in a path — an
  // underscore would otherwise open emphasis — so `\_` is the report's
  // markup, not part of the name the displays print (and not part of
  // the path a reconstructed blob URL has to address).
  it('unescapes a path the report escaped for markdown', () => {
    const f = parseMarkdownFindings(md(
      '1. [a/b/\\_cc\\_cc/index.js:10–20](https://example.com/a.ts#L10-L20)',
    )).findings[0]
    assert.equal(f.file, 'a/b/_cc_cc/index.js')
    assert.deepEqual(f.evidence, [{
      file: 'a/b/_cc_cc/index.js',
      line: '10-20',
      url: 'https://example.com/a.ts#L10-L20',
    }])
  })

  it('sheds backticks around the path', () => {
    const f = parseMarkdownFindings(md('1. [`src/a.ts:10`](https://example.com/a.ts)')).findings[0]
    assert.equal(f.file, 'src/a.ts')
    assert.equal(f.line, '10')
  })

  it('leaves `url` unset for a row that carries no link', () => {
    const f = parseMarkdownFindings(md('1. src/a.ts:10', '   A note.')).findings[0]
    assert.deepEqual(f.evidence, [{ file: 'src/a.ts', line: '10', text: 'A note.' }])
    // …while the finding-level `location` keeps its raw-text fallback,
    // which finding-id.js uses as the id discriminator.
    assert.equal(f.location, 'src/a.ts:10')
  })

  it('accepts bulleted rows', () => {
    const f = parseMarkdownFindings(md(
      '- [src/a.ts:10](https://example.com/a.ts#L10)',
      '- [src/b.ts:20](https://example.com/b.ts#L20)',
    )).findings[0]
    assert.equal(f.file, 'src/a.ts')
    assert.equal(f.evidence.length, 2)
    assert.equal(f.evidence[1].url, 'https://example.com/b.ts#L20')
  })

  it('never takes a row\'s prose as the location', () => {
    const f = parseMarkdownFindings(md(
      '1. [src/a.ts:10](https://example.com/a.ts#L10)',
      '   Prose under the row, not a reference.',
    )).findings[0]
    assert.equal(f.file, 'src/a.ts')
    assert.equal(f.evidence.length, 1)
    assert.equal(f.evidence[0].text, 'Prose under the row, not a reference.')
  })

  it('reads a lone unmarked reference line', () => {
    const f = parseMarkdownFindings(md('[src/a.ts:10](https://example.com/a.ts#L10)')).findings[0]
    assert.equal(f.file, 'src/a.ts')
    assert.equal(f.line, '10')
    assert.equal(f.evidence.length, 1)
  })

  it('picks the linked line out of an unmarked section, prose as its note', () => {
    const f = parseMarkdownFindings(md(
      'The flaw sits in the loader:',
      '[src/a.ts:10](https://example.com/a.ts#L10)',
    )).findings[0]
    assert.equal(f.file, 'src/a.ts')
    assert.equal(f.evidence[0].text, 'The flaw sits in the loader:')
  })

  it('leaves prose-only evidence in the description, file unknown', () => {
    const f = parseMarkdownFindings(md('Nothing citable here.', 'Only prose.')).findings[0]
    assert.equal(f.file, 'unknown')
    assert.equal(f.line, '?')
    assert.equal(f.location, undefined)
    assert.equal(f.evidence, undefined)
    // Nothing parses out of it, so dropping it would lose it.
    assert.match(f.description, /\*\*Evidence:\*\*\nNothing citable here\./u)
  })

  it('lets `## Location` win when a report carries both', () => {
    const mdBoth = [
      '# T',
      '',
      '## Location',
      '[src/loc.ts:5](https://example.com/loc.ts#L5)',
      '',
      '## Evidence',
      '1. [src/ev.ts:10](https://example.com/ev.ts#L10)',
      '',
      '---',
      '**Severity:** high',
    ].join('\n')
    const f = parseMarkdownFindings(mdBoth).findings[0]
    assert.equal(f.file, 'src/loc.ts')
    assert.equal(f.line, '5')
    assert.equal(f.location, 'https://example.com/loc.ts#L5')
    // The Evidence rows are still carried.
    assert.deepEqual(f.evidence, [{ file: 'src/ev.ts', line: '10', url: 'https://example.com/ev.ts#L10' }])
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
