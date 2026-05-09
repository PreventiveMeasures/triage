// Vercel DeepSec markdown findings parser — `common/parse-deepsec.js`.
// Pure function; covers severity tier mapping, confidence text →
// numeric mapping, recommendation extraction, and the `## SEVERITY (n)`
// + `### Title` two-level structure.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseDeepsecFindings } from '../common/parse-deepsec.js'

const HEADER = [
  '# Vulnerability Scan Report',
  '',
  '| Project | example |',
  '',
  '## Summary',
  '',
  '| Total | 1 |',
  '',
].join('\n')

function build(severityHeader, findings) {
  return `${HEADER}## ${severityHeader}\n\n${findings}\n`
}

describe('parseDeepsecFindings — format guard', () => {
  it('returns null when no `## SEVERITY (n)` header is present', () => {
    assert.equal(parseDeepsecFindings('plain text'), null)
    assert.equal(parseDeepsecFindings('# Title only'), null)
    assert.equal(parseDeepsecFindings('## Just a section\n\nbody'), null)
  })

  it('returns null when severity headers exist but no findings parse', () => {
    // Header but no `### title` blocks — findings array stays empty.
    const md = build('HIGH (0)', '')
    assert.equal(parseDeepsecFindings(md), null)
  })

  it('normalizes \\r\\n line endings', () => {
    const md = `${HEADER.replace(/\n/gu, '\r\n')}## HIGH (1)\r\n\r\n### A finding\r\n\r\n- **File:** \`src/x.js\`\r\n- **Lines:** 1\r\n`
    const parsed = parseDeepsecFindings(md)
    assert.equal(parsed.findings.length, 1)
    assert.equal(parsed.findings[0].severity, 'high')
  })
})

describe('parseDeepsecFindings — severity tier mapping', () => {
  const cases = [
    ['CRITICAL', 'critical'],
    ['HIGH',     'high'],
    ['MEDIUM',   'medium'],
    ['LOW',      'low'],
    ['HIGH_BUG', 'high_bug'],
    ['BUG',      'bug'],
    ['INFO',     'informational'],
    ['INFORMATIONAL', 'informational'],
    ['UNKNOWN',  'medium'], // fallback so an unrecognized tier still surfaces
  ]
  for (const [src, expected] of cases) {
    it(`maps ${src} → ${expected}`, () => {
      const md = build(`${src} (1)`, '### A finding\n\n- **File:** `x.js`\n- **Lines:** 1\n')
      const parsed = parseDeepsecFindings(md)
      assert.equal(parsed.findings[0].severity, expected)
    })
  }
})

describe('parseDeepsecFindings — confidence mapping', () => {
  const cases = [
    ['high',   8],
    ['medium', 5],
    ['low',    2],
  ]
  for (const [text, numeric] of cases) {
    it(`maps confidence "${text}" → ${numeric}`, () => {
      const md = build('HIGH (1)',
        `### A finding\n\n- **File:** \`x.js\`\n- **Lines:** 1\n- **Confidence:** ${text}\n`,
      )
      const parsed = parseDeepsecFindings(md)
      assert.equal(parsed.findings[0].confidence, numeric)
    })
  }

  it('omits confidence when missing', () => {
    const md = build('HIGH (1)', '### A finding\n\n- **File:** `x.js`\n- **Lines:** 1\n')
    const parsed = parseDeepsecFindings(md)
    assert.equal(parsed.findings[0].confidence, undefined)
  })

  it('omits confidence when unrecognized', () => {
    const md = build('HIGH (1)',
      '### A finding\n\n- **File:** `x.js`\n- **Lines:** 1\n- **Confidence:** uncertain\n',
    )
    const parsed = parseDeepsecFindings(md)
    assert.equal(parsed.findings[0].confidence, undefined)
  })
})

describe('parseDeepsecFindings — file/line extraction', () => {
  it('strips backticks from file paths', () => {
    const md = build('HIGH (1)', '### F\n\n- **File:** `path/to/file.js`\n- **Lines:** 5\n')
    const parsed = parseDeepsecFindings(md)
    assert.equal(parsed.findings[0].file, 'path/to/file.js')
  })

  it('uses the first line from a comma-separated Lines value', () => {
    const md = build('HIGH (1)', '### F\n\n- **File:** `x.js`\n- **Lines:** 12, 24, 36\n')
    const parsed = parseDeepsecFindings(md)
    assert.equal(parsed.findings[0].line, '12')
  })

  it('falls back to "?" when Lines is absent', () => {
    const md = build('HIGH (1)', '### F\n\n- **File:** `x.js`\n')
    const parsed = parseDeepsecFindings(md)
    assert.equal(parsed.findings[0].line, '?')
  })

  it('falls back to "unknown" when File is absent', () => {
    const md = build('HIGH (1)', '### F\n\n- **Lines:** 1\n')
    const parsed = parseDeepsecFindings(md)
    assert.equal(parsed.findings[0].file, 'unknown')
  })
})

describe('parseDeepsecFindings — description + recommendation', () => {
  it('preserves the title line and prose body', () => {
    const md = build('HIGH (1)', [
      '### Use after free',
      '',
      '- **File:** `src/x.js`',
      '- **Lines:** 1',
      '',
      'The buffer is freed before the next read.',
      '',
    ].join('\n'))
    const f = parseDeepsecFindings(md).findings[0]
    assert.match(f.description, /Use after free/u)
    assert.match(f.description, /buffer is freed/u)
  })

  it('extracts recommendation from inline **Recommendation:** marker', () => {
    const md = build('MEDIUM (1)', [
      '### Title',
      '',
      '- **File:** `x.js`',
      '- **Lines:** 1',
      '',
      'prose body line.',
      '',
      '**Recommendation:** swap the order of A and B.',
    ].join('\n'))
    const f = parseDeepsecFindings(md).findings[0]
    assert.equal(f.recommendation, 'swap the order of A and B.')
    assert.doesNotMatch(f.description, /Recommendation/u)
  })

  it('strips bullet metadata lines from description', () => {
    const md = build('LOW (1)', [
      '### T',
      '',
      '- **File:** `x.js`',
      '- **Lines:** 7',
      '- **Slug:** rule-foo',
      '- **Confidence:** medium',
      '',
      'narrative.',
    ].join('\n'))
    const f = parseDeepsecFindings(md).findings[0]
    assert.doesNotMatch(f.description, /\*\*File:\*\*/u)
    assert.doesNotMatch(f.description, /\*\*Slug:\*\*/u)
    assert.match(f.description, /narrative\./u)
  })

  it('strips ** bold markers from description', () => {
    const md = build('LOW (1)', [
      '### T',
      '',
      '- **File:** `x.js`',
      '- **Lines:** 1',
      '',
      'this **is bold** text',
    ].join('\n'))
    const f = parseDeepsecFindings(md).findings[0]
    assert.doesNotMatch(f.description, /\*\*/u)
    assert.match(f.description, /this is bold text/u)
  })

  it('captures the slug field', () => {
    const md = build('HIGH (1)', '### T\n\n- **File:** `x.js`\n- **Lines:** 1\n- **Slug:** sql-injection\n')
    const f = parseDeepsecFindings(md).findings[0]
    assert.equal(f.slug, 'sql-injection')
  })
})

describe('parseDeepsecFindings — multi-finding + multi-section', () => {
  it('handles multiple findings inside one severity section', () => {
    const md = build('HIGH (2)', [
      '### Finding A',
      '',
      '- **File:** `a.js`',
      '- **Lines:** 1',
      '',
      '---',
      '',
      '### Finding B',
      '',
      '- **File:** `b.js`',
      '- **Lines:** 2',
    ].join('\n'))
    const parsed = parseDeepsecFindings(md)
    assert.equal(parsed.findings.length, 2)
    assert.equal(parsed.findings[0].file, 'a.js')
    assert.equal(parsed.findings[1].file, 'b.js')
  })

  it('handles multiple severity sections', () => {
    const md = `${HEADER}${[
      '## CRITICAL (1)',
      '',
      '### Crit',
      '',
      '- **File:** `c.js`',
      '- **Lines:** 1',
      '',
      '## LOW (1)',
      '',
      '### Low',
      '',
      '- **File:** `l.js`',
      '- **Lines:** 1',
    ].join('\n')}\n`
    const parsed = parseDeepsecFindings(md)
    assert.equal(parsed.findings.length, 2)
    assert.equal(parsed.findings[0].severity, 'critical')
    assert.equal(parsed.findings[1].severity, 'low')
  })

  it('returned shape carries `type: security` and `source: deepsec`', () => {
    const md = build('HIGH (1)', '### T\n\n- **File:** `x.js`\n- **Lines:** 1\n')
    const parsed = parseDeepsecFindings(md)
    assert.equal(parsed.type, 'security')
    assert.equal(parsed.source, 'deepsec')
  })
})
