// Markdown findings parser — `report/src/parse-md.js`. Pure function; the
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

import { findMdLink } from '../src/md-structure.js'
import { parseMarkdownFindings } from '../src/parse-md.js'

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
    assert.equal(parsed.type, 'security')
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
  it('builds description from title + Details + Impact, reproduction its own field', () => {
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
    // Reproduction is a FIELD, the slot a native dump fills and the
    // one render-finding.js gives a `<details>` — not a paragraph in
    // the description, which the card can only draw open.
    assert.equal(f.reproduction, 'Step 1.')
    assert.doesNotMatch(f.description, /Reproduction/u)
  })

  // The two narrative sections a Claude Security report names go to
  // the two slots a native dump fills, so the card draws both the same
  // way it draws a dump's — each its own collapsible section rather
  // than one disclosure and one block wedged open (render-finding.js).
  it('extracts reproduction from Reproduction steps section', () => {
    const md = '# T\n\n## Details\nD.\n\n## Reproduction steps\n1. Do X.\n2. Watch Y.\n\n---\n**Severity:** medium\n'
    const f = parseMarkdownFindings(md).findings[0]
    assert.equal(f.reproduction, '1. Do X.\n2. Watch Y.')
    assert.equal(f.description, 'T\n\nD.')
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
    assert.equal(f.category, 'vulnerability')
  })

  it('keeps the category as the report wrote it, under its own name — not as the analyzer type', () => {
    // Claude Security is one analyzer; what it filed a finding under is
    // the finding's category. The `source` marker names the analyzer,
    // so no per-finding `type` is stamped (it would read as one run per
    // category in the header and the export).
    const md = '# T\n\n---\n**Severity:** medium\n**Category:** Insufficient Verification of Data Authenticity\n'
    const f = parseMarkdownFindings(md).findings[0]
    assert.equal(f.category, 'Insufficient Verification of Data Authenticity')
    assert.equal(f.type, undefined)
  })

  it('leaves the category off a finding without one', () => {
    const f = parseMarkdownFindings('# T\n\n---\n**Severity:** medium\n').findings[0]
    assert.ok(!('category' in f))
  })

  it('reports the security category at the report level, whatever the findings are filed under', () => {
    const md = [
      '# T1\n\n---\n**Severity:** medium\n**Category:** Quality',
      '# T2\n\n---\n**Severity:** medium\n**Category:** Security',
    ].join('\n\n')
    assert.equal(parseMarkdownFindings(md).type, 'security')
    assert.equal(parseMarkdownFindings('# T\n\n---\n**Severity:** medium\n').type, 'security')
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

// Paths that carry brackets or parens of their own — a Next.js app
// router writes `app/(main)/[id]/page.ts`, and the report links it as
// `[<path>:<line>](<url>)`. Read with a label class that stops at the
// first `]`, none of these matched at all: the whole `[…](…)` text
// became the file name, the line came back `?`, and an evidence row
// lost its url with it.
describe('parseMarkdownFindings — paths with brackets and parens', () => {
  const REF = '[a/b/src/app/(main)/c/[id]/index.ts:123–124](https://github.com/org/repo/blob/master/a/b/c/app/%28main%29/c/%5Bid%5D/index.ts#L123-L124)'
  const URL = 'https://github.com/org/repo/blob/master/a/b/c/app/%28main%29/c/%5Bid%5D/index.ts#L123-L124'
  const located = (ref) => parseMarkdownFindings([
    '# T', '', '## Location', ref, '', '---', '**Severity:** medium',
  ].join('\n')).findings[0]

  it('reads the path, the line and the url out of the link', () => {
    const f = located(REF)
    assert.equal(f.file, 'a/b/src/app/(main)/c/[id]/index.ts')
    assert.equal(f.line, '123-124')
    assert.equal(f.location, URL)
  })

  it('keeps a url whose own parens were never encoded', () => {
    // Markdown ends a bare destination on the first UNBALANCED `)`, so
    // `(main)` inside it is part of the url; stopping at the first one
    // truncated it to `…/app/(main`.
    const f = located('[app/(main)/x.ts:7](https://github.com/o/r/blob/m/app/(main)/x.ts#L7)')
    assert.equal(f.file, 'app/(main)/x.ts')
    assert.equal(f.line, '7')
    assert.equal(f.location, 'https://github.com/o/r/blob/m/app/(main)/x.ts#L7')
  })

  it('takes the angle-bracket form this library\'s own writer emits', () => {
    // md-text.js `link` wraps a url holding a space, a paren or an
    // angle bracket, so an export of one of these findings comes back
    // through here on re-import.
    const f = located('[app/(main)/[id]/x.ts:7-9](<https://github.com/o/r/blob/m/app/(main)/[id]/x.ts#L7-L9>)')
    assert.equal(f.file, 'app/(main)/[id]/x.ts')
    assert.equal(f.line, '7-9')
    assert.equal(f.location, 'https://github.com/o/r/blob/m/app/(main)/[id]/x.ts#L7-L9')
  })

  it('unescapes brackets a report escaped for markdown', () => {
    const f = located('[a/b/app/\\[id\\]/index.ts:12](https://example.com/x#L12)')
    assert.equal(f.file, 'a/b/app/[id]/index.ts')
    assert.equal(f.line, '12')
  })

  it('gives every evidence row its own path, line and url', () => {
    const f = parseMarkdownFindings([
      '# T', '',
      '## Evidence',
      `1. ${REF}`,
      '   The segment is read here.',
      '2. [app/(main)/[id]/query.ts:8](https://github.com/o/r/blob/m/q.ts#L8)',
      '',
      '---', '**Severity:** medium',
    ].join('\n')).findings[0]
    assert.deepEqual(f.evidence, [
      {
        file: 'a/b/src/app/(main)/c/[id]/index.ts',
        line: '123-124',
        url: URL,
        text: 'The segment is read here.',
      },
      { file: 'app/(main)/[id]/query.ts', line: '8', url: 'https://github.com/o/r/blob/m/q.ts#L8' },
    ])
    // …and the finding's own location is the first row, as ever.
    assert.equal(f.file, 'a/b/src/app/(main)/c/[id]/index.ts')
    assert.equal(f.line, '123-124')
  })

  it('finds such a link in an Evidence section written without markers', () => {
    // The marker-less fallback looks for the first line carrying a
    // link — which a bracketed path used to hide from it, leaving the
    // section as prose in the description and the finding unlocated.
    const f = parseMarkdownFindings([
      '# T', '',
      '## Evidence',
      'See the handler:',
      REF,
      'and the loader.',
      '',
      '---', '**Severity:** medium',
    ].join('\n')).findings[0]
    assert.equal(f.evidence.length, 1)
    assert.equal(f.evidence[0].file, 'a/b/src/app/(main)/c/[id]/index.ts')
    assert.equal(f.evidence[0].url, URL)
    assert.equal(f.evidence[0].text, 'See the handler:\nand the loader.')
  })

  it('starts at the first real link, not at the first bracket', () => {
    // A bracket pair that closes with no `(` behind it is not a
    // label — `[context]` here — and the reading has to carry on past
    // it rather than swallow it into the next link's label.
    const f = located('[context] see [src/a.ts:7](https://example.com/a.ts#L7)')
    assert.equal(f.file, 'src/a.ts')
    assert.equal(f.line, '7')
    assert.equal(f.location, 'https://example.com/a.ts#L7')
  })

  it('keeps a url whose own paren never closes', () => {
    // No balanced reading of that url exists, so it is read to the
    // first `)` — how it was read before there was a scanner.
    const f = located('[src/(legacy/file.ts:7](https://example.com/src/(legacy/file.ts#L7)')
    assert.equal(f.file, 'src/(legacy/file.ts')
    assert.equal(f.line, '7')
    assert.equal(f.location, 'https://example.com/src/(legacy/file.ts#L7')
  })

  it('takes a url whose own parens nest', () => {
    const f = located('[src/a(foo(bar)).ts:7](https://example.com/a(foo(bar)).ts#L7)')
    assert.equal(f.file, 'src/a(foo(bar)).ts')
    assert.equal(f.line, '7')
    assert.equal(f.location, 'https://example.com/a(foo(bar)).ts#L7')
  })

  it('keeps a path whose bracket never closes', () => {
    // No balanced reading of these brackets exists, so the label is
    // read up to the first `]` — which is how this was read before
    // there was a scanner, and the path survives whole.
    const f = located('[src/[id.ts:7](https://example.com/x#L7)')
    assert.equal(f.file, 'src/[id.ts')
    assert.equal(f.line, '7')
    assert.equal(f.location, 'https://example.com/x#L7')
    // The same rule, applied to a label that is prose rather than a
    // path: it reads as it always did, to the first `]`, rather than
    // the scanner picking the link out of the middle of it.
    assert.equal(located('[unclosed [src/a.ts:7](https://example.com/a.ts#L7)').file, 'unclosed [src/a.ts')
  })

  it('reads past a badge to the reference behind it', () => {
    // An empty label is no label, and an empty destination no
    // destination — which is what lets the reading reach the second
    // link here rather than stopping at the image in front of it.
    const f = located('![](badge.svg) [src/a.ts:7](https://example.com/a.ts#L7)')
    assert.equal(f.file, 'src/a.ts')
    assert.equal(f.line, '7')
    assert.equal(f.location, 'https://example.com/a.ts#L7')
    assert.equal(located('[]() [src/b.ts:9](https://example.com/b.ts#L9)').file, 'src/b.ts')
  })

  it('still leaves a line with no link as the raw text it is', () => {
    const f = located('a/b/app/(main)/[id]/index.ts:12')
    assert.equal(f.file, 'a/b/app/(main)/[id]/index.ts')
    assert.equal(f.line, '12')
    assert.equal(f.location, 'a/b/app/(main)/[id]/index.ts:12')
  })
})

// The compatibility property every one of the readings above exists to
// keep: a line the expression this replaced could read still reads the
// same way. That expression is the reference below — it is the whole
// of what parse-md.js did before `findMdLink`, so wherever it matched,
// the scanner has to match at the same place with the same label.
//
// The url is compared with `startsWith` rather than for equality,
// because the one thing the scanner is allowed to do better is finish
// a url the old class cut short: `…/a(foo(bar)).ts#L7` came back as
// `…/a(foo(bar` (the class stopped at the first `)`), and now comes
// back whole. Every other shape has to be untouched.
describe('findMdLink — nothing the old expression read reads differently', () => {
  const OLD = /\[([^\]]+)\]\(([^)\s]+)\)/u

  const labels = [
    'src/a.ts:7', 'app/(main)/x.ts:7', 'app/(main)/[id]/x.ts:7', 'src/[id.ts:7', 'src/a]b.ts:7',
    'a/b/\\[id\\]/x.ts:7', '`src/[id.ts:7`', '`app/(main)/[id]/x.ts:7`', 'a/b/\\_c\\_/x.ts:10', 'x', '',
  ]
  const urls = [
    'https://e.com/a.ts#L7', 'https://e.com/app/(main)/a.ts#L7', 'https://e.com/a(foo(bar)).ts#L7',
    'https://e.com/src/(legacy/a.ts#L7', 'https://e.com/%28main%29/%5Bid%5D/a.ts#L7-L9',
    'https://e.com/a.ts', '',
  ]
  // The positions a reference turns up in: alone on the line, behind
  // prose (bracketed or not), ahead of it, as a list item — and behind
  // another LINK, which is how a badge sits at the head of a row and
  // the dimension whose absence here let an empty one through.
  const around = [
    (l) => l, (l) => `[context] see ${l}`, (l) => `${l} and more`, (l) => `see ${l} here`, (l) => `- ${l}`,
    (l) => `![](badge.svg) ${l}`, (l) => `![badge](b.svg) ${l}`, (l) => `[]() ${l}`, (l) => `[x](y) ${l}`,
  ]

  it('matches where it matched, on every shape these spell', () => {
    let read = 0
    for (const label of labels) {
      for (const url of urls) {
        for (const place of around) {
          const line = place(`[${label}](${url})`)
          const old = OLD.exec(line)
          if (!old) continue
          read++
          const now = findMdLink(line)
          assert.ok(now, `no link read in ${JSON.stringify(line)}`)
          assert.equal(now.index, old.index, line)
          assert.equal(now.label, old[1], line)
          assert.ok(now.url.startsWith(old[2]), `${JSON.stringify(now.url)} does not extend ${JSON.stringify(old[2])}`)
        }
      }
    }
    // A guard on the guard: if the shapes above stop reaching the old
    // expression, the loop asserts nothing and says so.
    assert.ok(read > 300, `only ${read} of these shapes reached the old expression`)
  })
})

// A reference is a short line; a malformed document's need not be, and
// every reading here is a scan to the end when nothing closes it. Read
// per candidate, that was quadratic — 50k of `[` and nothing else took
// ~3s to come back null, and a run of `[x](` with no `)` in it ~10s,
// each bracket paying for the remainder of the line again. The closing
// positions are read off the text once instead.
//
// The bound is deliberately loose — 50x the linear cost on this input,
// which is ~20ms — so this fails on the shape of the work rather than
// on how busy the machine is. Quadratic would need ~50s here.
describe('findMdLink — a malformed line is read once, not per bracket', () => {
  const under = (ms, text) => {
    const started = process.hrtime.bigint()
    assert.equal(findMdLink(text), null)
    const took = Number(process.hrtime.bigint() - started) / 1e6
    assert.ok(took < ms, `${text.length} characters took ${took.toFixed(0)}ms`)
  }

  it('rejects a line of nothing but brackets', () => under(1000, '['.repeat(50_000)))
  it('rejects a line of openings that never close', () => under(1000, '[x]('.repeat(12_500)))
  it('rejects a line of nested openings', () => under(1000, '([x]('.repeat(10_000)))

  it('rejects a line of code fences that never close', () => {
    // Runs of growing length, so no run closes any other: read per
    // run, each one scanned the rest of the line for a fence of its
    // own length, which took ~5s over 20k characters.
    let text = ''
    for (let n = 1; text.length < 20_000; n++) text += `${'`'.repeat(n)}x`
    under(1000, text)
  })
})
