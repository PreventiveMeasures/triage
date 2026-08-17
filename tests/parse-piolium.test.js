// Piolium markdown findings parser — `common/parse-piolium.js`. Pure
// function; covers the format guard, the pentest-template layout
// (`## Technical Findings Detail` → `### [ID] Title`), the mode
// pipelines' `## Findings by Severity` layout (severity groups holding
// `#### ` blocks / tables / link lists), severity precedence (bullet →
// index row → group → id prefix), `Key Code Reference` file/line
// extraction, the `#### Variants` sub-table, the `## Summary of
// Findings` fallback, fenced-code-block handling, repeated sections,
// and the sections that must NOT become findings.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parsePioliumFindings } from '../common/parse-piolium.js'

// Minimal but realistic report: the H1 + prose sections piolium's
// assembler always writes, an index table, and one detail block.
function build({ title = 'example-project', index, detail } = {}) {
  const parts = [
    `# Security Audit Report: ${title}`, '=========================================', '',
    '## Executive Summary', '---------------------', 'One paragraph of prose.', '',
    '## Methodology Summary', '-----------------------',
    '- **Static Analysis:** CodeQL and Semgrep Pro', '',
  ]
  if (index) parts.push('## Summary of Findings', '----------------------', '', index, '')
  if (detail) parts.push('## Technical Findings Detail', '---------------------------', '', detail, '')
  parts.push('## Conclusion', '-------------', 'Final assessment.', '')
  return parts.join('\n')
}

const INDEX = [
  '| ID | Title | Severity | PoC Status | Parent |',
  '|----|-------|----------|------------|--------|',
  '| [C1] | Command injection in the build hook | CRITICAL | executed | -- |',
].join('\n')

const DETAIL = [
  '### [C1] Command injection in the build hook',
  '- **Severity:** CRITICAL',
  '- **Summary:** The build hook shells out with an unsanitized branch name.',
  '- **Impact:** Any user who can open a PR gains code execution on CI.',
  '- **Root Cause:** String interpolation into `exec` instead of `execFile` args.',
  '- **Key Code Reference:** src/build/hook.js:142 in runHook()',
  '- **PoC Status:** executed',
  '- **Detailed Report:** piolium/findings/C1-command-injection/report.md',
  '- **Proof of Concept:** piolium/findings/C1-command-injection/poc.py',
  '- **Evidence:** piolium/findings/C1-command-injection/evidence/',
].join('\n')

describe('parsePioliumFindings — format guard', () => {
  it('returns null for input with neither marker', () => {
    assert.equal(parsePioliumFindings(''), null)
    assert.equal(parsePioliumFindings('plain text'), null)
    assert.equal(parsePioliumFindings('# Some other report\n\n## Details\n\nbody'), null)
  })

  it('does not claim a Claude Security markdown document', () => {
    // parse-md.js owns any h1-led doc; piolium must fall through so the
    // chain reaches it.
    const md = [
      '# SQL injection in the login form',
      '',
      '## Details',
      'Unparameterized query.',
      '',
      '---',
      '**Severity:** high',
      '**Category:** security',
    ].join('\n')
    assert.equal(parsePioliumFindings(md), null)
  })

  it('accepts the H1 marker alone', () => {
    const parsed = parsePioliumFindings(build({ index: INDEX }))
    assert.equal(parsed.findings.length, 1)
  })

  it('accepts the detail-section marker alone (retitled H1)', () => {
    const md = ['# Audit of example-project', '', '## Technical Findings Detail', '', DETAIL].join('\n')
    const parsed = parsePioliumFindings(md)
    assert.equal(parsed.findings.length, 1)
    assert.equal(parsed.findings[0].severity, 'critical')
  })

  it('returns null when the markers are present but nothing parses', () => {
    assert.equal(parsePioliumFindings(build()), null)
  })

  it('normalizes \\r\\n line endings', () => {
    const parsed = parsePioliumFindings(build({ index: INDEX, detail: DETAIL }).replaceAll('\n', '\r\n'))
    assert.equal(parsed.findings.length, 1)
    assert.equal(parsed.findings[0].line, '142')
  })
})

describe('parsePioliumFindings — report shape', () => {
  it('reports type security and source piolium', () => {
    const parsed = parsePioliumFindings(build({ index: INDEX, detail: DETAIL }))
    assert.equal(parsed.type, 'security')
    assert.equal(parsed.source, 'piolium')
  })

  it('leaves per-finding type unset (severity is the only category)', () => {
    const f = parsePioliumFindings(build({ index: INDEX, detail: DETAIL })).findings[0]
    assert.equal(f.type, undefined)
  })

  it('does not assign ids — derivation fingerprints them at ingest', () => {
    // `C1` is report-local: two projects both have one, so using it as
    // the finding id would collide across reports.
    const f = parsePioliumFindings(build({ index: INDEX, detail: DETAIL })).findings[0]
    assert.equal(f.id, undefined)
  })
})

describe('parsePioliumFindings — detail blocks', () => {
  it('maps the documented bullet fields onto the finding', () => {
    const f = parsePioliumFindings(build({ index: INDEX, detail: DETAIL })).findings[0]
    assert.equal(f.severity, 'critical')
    assert.equal(f.file, 'src/build/hook.js')
    assert.equal(f.line, '142')
    assert.equal(f.pocStatus, 'executed')
    assert.equal(f.reportPath, 'piolium/findings/C1-command-injection/report.md')
  })

  it('builds the description from heading + summary + impact + root cause', () => {
    const f = parsePioliumFindings(build({ index: INDEX, detail: DETAIL })).findings[0]
    assert.equal(f.description, [
      'Command injection in the build hook',
      'The build hook shells out with an unsanitized branch name.',
      'Impact: Any user who can open a PR gains code execution on CI.',
      'Root Cause: String interpolation into `exec` instead of `execFile` args.',
    ].join('\n\n'))
  })

  it('omits absent narrative sections from the description', () => {
    const detail = ['### [M1] Weak JWT validation', '- **Severity:** MEDIUM'].join('\n')
    const f = parsePioliumFindings(build({ detail })).findings[0]
    assert.equal(f.description, 'Weak JWT validation')
  })

  it('strips bold markdown from the description', () => {
    const detail = ['### [H1] Title', '- **Summary:** A **very** bad bug.'].join('\n')
    const f = parsePioliumFindings(build({ detail })).findings[0]
    assert.equal(f.description, 'Title\n\nA very bad bug.')
  })

  it('keeps a wrapped bullet value across its continuation lines', () => {
    const detail = [
      '### [H1] Title',
      '- **Summary:** first line',
      '  continues here',
      '- **PoC Status:** executed',
    ].join('\n')
    const f = parsePioliumFindings(build({ detail })).findings[0]
    assert.equal(f.description, 'Title\n\nfirst line\n  continues here')
    assert.equal(f.pocStatus, 'executed')
  })

  it('parses every finding in the section', () => {
    const detail = [
      '### [C1] First', '- **Severity:** CRITICAL', '',
      '### [H1] Second', '- **Severity:** HIGH', '',
      '### [M1] Third', '- **Severity:** MEDIUM',
    ].join('\n')
    const parsed = parsePioliumFindings(build({ detail }))
    assert.deepEqual(parsed.findings.map((f) => f.severity), ['critical', 'high', 'medium'])
    assert.deepEqual(parsed.findings.map((f) => f.description), ['First', 'Second', 'Third'])
  })

  it('accepts an unbracketed heading as a bare title', () => {
    const detail = ['### Command injection', '- **Severity:** HIGH'].join('\n')
    const f = parsePioliumFindings(build({ detail })).findings[0]
    assert.equal(f.description, 'Command injection')
    assert.equal(f.severity, 'high')
  })

  it('falls back to unknown / ? when no code reference is given', () => {
    const detail = ['### [H1] Title', '- **Severity:** HIGH'].join('\n')
    const f = parsePioliumFindings(build({ detail })).findings[0]
    assert.equal(f.file, 'unknown')
    assert.equal(f.line, '?')
  })
})

describe('parsePioliumFindings — severity precedence', () => {
  const cases = [
    ['CRITICAL', 'critical'],
    ['HIGH', 'high'],
    ['MEDIUM', 'medium'],
    ['LOW', 'low'],
    ['INFO', 'informational'],
    ['INFORMATIONAL', 'informational'],
  ]
  for (const [src, want] of cases) {
    it(`maps ${src} to ${want}`, () => {
      const detail = [`### [X1] Title`, `- **Severity:** ${src}`].join('\n')
      assert.equal(parsePioliumFindings(build({ detail })).findings[0].severity, want)
    })
  }

  it('is case-insensitive on the bullet value', () => {
    const detail = ['### [X1] Title', '- **Severity:** High'].join('\n')
    assert.equal(parsePioliumFindings(build({ detail })).findings[0].severity, 'high')
  })

  it('falls back to the index row when the bullet is missing', () => {
    const index = [
      '| ID | Title | Severity | Status |',
      '|----|-------|----------|--------|',
      '| [Q9] | Odd id | CRITICAL | VALID |',
    ].join('\n')
    const detail = ['### [Q9] Odd id', '- **Summary:** no severity bullet here'].join('\n')
    assert.equal(parsePioliumFindings(build({ index, detail })).findings[0].severity, 'critical')
  })

  it('falls back to the id prefix when neither names a severity', () => {
    const detail = ['### [H7] Title', '- **Summary:** body'].join('\n')
    assert.equal(parsePioliumFindings(build({ detail })).findings[0].severity, 'high')
  })

  it("accepts the lite scheme's dashed ids for the prefix fallback", () => {
    const detail = ['### [H-001] Title', '- **Summary:** body'].join('\n')
    assert.equal(parsePioliumFindings(build({ detail })).findings[0].severity, 'high')
  })

  it('does not read a bare leading letter as a severity prefix', () => {
    // CVE-2024-1234 starts with C but is not a piolium id — it must not
    // grade as critical.
    const index = [
      '| ID | Title | Severity |',
      '|----|-------|----------|',
      '| CVE-2024-1234 | Something | ??? |',
    ].join('\n')
    assert.equal(parsePioliumFindings(build({ index })).findings[0].severity, 'medium')
  })

  it('reads the tier from the first token of a wrapped Severity bullet', () => {
    // parseFields keeps continuation lines on a bullet value; the tier
    // must still match when a parenthetical wraps under it.
    const detail = [
      '### [SEC-001] Cmd inj',
      '- **Severity:** CRITICAL',
      '  (raised after the PoC confirmed unauthenticated reachability)',
    ].join('\n')
    assert.equal(parsePioliumFindings(build({ detail })).findings[0].severity, 'critical')
  })

  it('defaults to medium for an unrecognized tier and id', () => {
    const detail = ['### [Q1] Title', '- **Severity:** spicy'].join('\n')
    assert.equal(parsePioliumFindings(build({ detail })).findings[0].severity, 'medium')
  })
})

describe('parsePioliumFindings — code reference', () => {
  const ref = (value) => parsePioliumFindings(
    build({ detail: ['### [H1] Title', `- **Key Code Reference:** ${value}`].join('\n') }),
  ).findings[0]

  it('splits a trailing :line off the path', () => {
    const f = ref('src/a/b.js:42')
    assert.equal(f.file, 'src/a/b.js')
    assert.equal(f.line, '42')
  })

  it('keeps the start line of a range and sheds it from the path', () => {
    const f = ref('src/api/invoices.js:88-95 in getInvoice()')
    assert.equal(f.file, 'src/api/invoices.js')
    assert.equal(f.line, '88')
  })

  it('drops the function qualifier the template appends', () => {
    const f = ref('src/a/b.js:42 in handleRequest()')
    assert.equal(f.file, 'src/a/b.js')
    assert.equal(f.line, '42')
  })

  it('strips backticks', () => {
    const f = ref('`src/a/b.js:42`')
    assert.equal(f.file, 'src/a/b.js')
    assert.equal(f.line, '42')
  })

  it('takes the line from a #L anchor and keeps the URL as location', () => {
    const f = ref('[src/a/b.js](https://github.com/o/r/blob/main/src/a/b.js#L99)')
    assert.equal(f.file, 'src/a/b.js')
    assert.equal(f.line, '99')
    assert.equal(f.location, 'https://github.com/o/r/blob/main/src/a/b.js#L99')
  })

  it('prefers the #L anchor over a :line suffix on the link text', () => {
    const f = ref('[src/a/b.js:7](https://github.com/o/r/blob/main/src/a/b.js#L99)')
    assert.equal(f.file, 'src/a/b.js')
    assert.equal(f.line, '99')
  })

  it('leaves the line unknown when the path carries none', () => {
    const f = ref('src/a/b.js')
    assert.equal(f.file, 'src/a/b.js')
    assert.equal(f.line, '?')
  })

  it('accepts Location as an alias for Key Code Reference', () => {
    const detail = ['### [H1] Title', '- **Location:** src/a/b.js:12'].join('\n')
    const f = parsePioliumFindings(build({ detail })).findings[0]
    assert.equal(f.file, 'src/a/b.js')
    assert.equal(f.line, '12')
  })
})

describe('parsePioliumFindings — variants', () => {
  const detail = [
    '### [C1] Parent finding',
    '- **Severity:** CRITICAL',
    '- **Key Code Reference:** src/parent.js:10',
    '',
    '#### Variants',
    '',
    '| ID | Title | Severity | Location | PoC Status |',
    '|----|-------|----------|----------|------------|',
    '| [H2] | IDOR variant on invoices | HIGH | src/api/invoices.js:88 | executed |',
    '| [M3] | IDOR variant on receipts | MEDIUM | src/api/receipts.js:12 | theoretical |',
  ].join('\n')

  it('surfaces variant rows as findings of their own', () => {
    const parsed = parsePioliumFindings(build({ detail }))
    assert.equal(parsed.findings.length, 3)
    const [, h2, m3] = parsed.findings
    assert.equal(h2.description, 'IDOR variant on invoices')
    assert.equal(h2.severity, 'high')
    assert.equal(h2.file, 'src/api/invoices.js')
    assert.equal(h2.line, '88')
    assert.equal(h2.pocStatus, 'executed')
    assert.equal(m3.severity, 'medium')
    assert.equal(m3.line, '12')
  })

  it('does not fold the variant table into the parent fields', () => {
    const parent = parsePioliumFindings(build({ detail })).findings[0]
    assert.equal(parent.file, 'src/parent.js')
    assert.equal(parent.description, 'Parent finding')
  })

  it('records the parent link from the index table', () => {
    const index = [
      '| ID | Title | Severity | PoC Status | Parent |',
      '|----|-------|----------|------------|--------|',
      '| [C1] | Parent finding | CRITICAL | executed | -- |',
      '| [H2] | IDOR variant on invoices | HIGH | executed | C1 |',
    ].join('\n')
    const parsed = parsePioliumFindings(build({ index, detail }))
    assert.equal(parsed.findings[0].parent, undefined)
    assert.equal(parsed.findings[1].parent, 'C1')
  })

  it('stamps the enclosing block id as parent when the index does not name one', () => {
    // No index at all: the `#### Variants` table's position under [C1]
    // states the relationship structurally.
    const parsed = parsePioliumFindings(build({ detail }))
    assert.equal(parsed.findings[1].parent, 'C1')
    assert.equal(parsed.findings[2].parent, 'C1')
  })

  it('prefers the structural parent over nothing when the index lacks a Parent column', () => {
    const index = [
      '| ID | Title | Severity | Status |',
      '|----|-------|----------|--------|',
      '| [C1] | Parent finding | CRITICAL | VALID |',
      '| [H2] | IDOR variant on invoices | HIGH | VALID |',
    ].join('\n')
    const parsed = parsePioliumFindings(build({ index, detail }))
    assert.equal(parsed.findings[1].parent, 'C1')
  })

  it('stops the variant table at the next heading', () => {
    const md = [
      '## Technical Findings Detail',
      '',
      '### [C1] Parent',
      '',
      '#### Variants',
      '',
      '| ID | Title | Severity | Location | PoC Status |',
      '|----|-------|----------|----------|------------|',
      '| [H2] | Variant | HIGH | src/v.js:1 | executed |',
      '',
      '## Deferred Findings (triage skip)',
      '',
      '| Slug | Original Severity | Triage Reason |',
      '|------|-------------------|---------------|',
      '| noisy-log | LOW | below the PoC bar |',
    ].join('\n')
    const parsed = parsePioliumFindings(md)
    assert.equal(parsed.findings.length, 2)
    assert.deepEqual(parsed.findings.map((f) => f.description), ['Parent', 'Variant'])
  })
})

describe('parsePioliumFindings — summary-of-findings index', () => {
  it('emits findings the detail section never describes', () => {
    // Truncated detail section: the index is authoritative, so M1 must
    // still reach triage rather than being silently lost.
    const index = [
      '| ID | Title | Severity | PoC Status | Parent |',
      '|----|-------|----------|------------|--------|',
      '| [C1] | Command injection in the build hook | CRITICAL | executed | -- |',
      '| [M1] | Weak JWT validation | MEDIUM | theoretical | -- |',
    ].join('\n')
    const parsed = parsePioliumFindings(build({ index, detail: DETAIL }))
    assert.equal(parsed.findings.length, 2)
    const m1 = parsed.findings[1]
    assert.equal(m1.description, 'Weak JWT validation')
    assert.equal(m1.severity, 'medium')
    assert.equal(m1.pocStatus, 'theoretical')
    assert.equal(m1.file, 'unknown')
    assert.equal(m1.line, '?')
  })

  it('does not duplicate a finding present in both places', () => {
    const parsed = parsePioliumFindings(build({ index: INDEX, detail: DETAIL }))
    assert.equal(parsed.findings.length, 1)
  })

  it('works as the only finding source', () => {
    const parsed = parsePioliumFindings(build({ index: INDEX }))
    assert.equal(parsed.findings.length, 1)
    assert.equal(parsed.findings[0].severity, 'critical')
    assert.equal(parsed.findings[0].description, 'Command injection in the build hook')
  })

  it('keeps the Status column from the older four-column table', () => {
    const index = [
      '| ID | Title | Severity | Status |',
      '|----|-------|----------|--------|',
      '| [H1] | A finding | HIGH | VALID |',
    ].join('\n')
    const f = parsePioliumFindings(build({ index })).findings[0]
    assert.equal(f.status, 'VALID')
    assert.equal(f.pocStatus, undefined)
  })

  it('treats -- cells as empty', () => {
    const f = parsePioliumFindings(build({ index: INDEX })).findings[0]
    assert.equal(f.parent, undefined)
  })

  it('an unbracketed heading adopts its index row instead of double-emitting', () => {
    // parseBlock returns no id for a bare-title heading; without the
    // title-match adoption the index fallback would emit the same
    // finding a second time (with different file/line, so ingest's
    // dedupe could never merge the two).
    const index = [
      '| ID | Title | Severity | PoC Status | Parent |',
      '|----|-------|----------|------------|--------|',
      '| [C1] | Command injection | CRITICAL | executed | -- |',
    ].join('\n')
    const detail = [
      '### Command injection',
      '- **Key Code Reference:** src/a.js:1',
    ].join('\n')
    const parsed = parsePioliumFindings(build({ index, detail }))
    assert.equal(parsed.findings.length, 1)
    const f = parsed.findings[0]
    assert.equal(f.file, 'src/a.js')
    assert.equal(f.severity, 'critical')
    assert.equal(f.pocStatus, 'executed')
  })

  it('gives index-only findings distinct fingerprints via a location token', () => {
    // Same title + tier + the shared unknown/? placeholders would
    // otherwise derive the SAME finding uuid, and ingest's dedupe would
    // silently swallow all but the first — the report id is the only
    // discriminator the row carries.
    const index = [
      '| ID | Title | Severity | PoC Status | Parent |',
      '|----|-------|----------|------------|--------|',
      '| [M1] | Missing authorization check | MEDIUM | executed | -- |',
      '| [M2] | Missing authorization check | MEDIUM | theoretical | -- |',
    ].join('\n')
    const parsed = parsePioliumFindings(build({ index }))
    assert.deepEqual(parsed.findings.map((f) => f.location), ['piolium:M1', 'piolium:M2'])
  })
})

describe('parsePioliumFindings — sections that are not findings', () => {
  it('ignores the methodology bullets', () => {
    // `## Methodology Summary` uses the same `- **Label:** value` shape
    // a finding body does; only `### ` blocks inside the detail section
    // are findings.
    const parsed = parsePioliumFindings(build({ index: INDEX }))
    assert.equal(parsed.findings.length, 1)
  })

  it('ignores the deferred-findings appendix', () => {
    const md = [
      build({ index: INDEX, detail: DETAIL }),
      '## Deferred Findings (triage skip)',
      '',
      '| Slug | Original Severity | Triage Reason |',
      '|------|-------------------|---------------|',
      '| verbose-errors | LOW | below the PoC investment bar |',
      '| noisy-log | LOW | not attacker-reachable |',
    ].join('\n')
    const parsed = parsePioliumFindings(md)
    assert.equal(parsed.findings.length, 1)
    assert.equal(parsed.findings[0].description.startsWith('Command injection'), true)
  })
})

describe('parsePioliumFindings — fenced code blocks', () => {
  it('a ## line inside a fence does not end the findings section', () => {
    // Piolium inlines PoC snippets; a shell comment at column 0 used to
    // truncate `## Technical Findings Detail` and silently drop every
    // finding after the fence.
    const detail = [
      '### [C1] First',
      '- **Severity:** CRITICAL',
      '- **Summary:** x',
      '',
      '```sh',
      '## reproduce',
      'curl x',
      '```',
      '',
      '### [H1] Second',
      '- **Severity:** HIGH',
      '',
      '### [M1] Third',
      '- **Severity:** MEDIUM',
    ].join('\n')
    const parsed = parsePioliumFindings(build({ detail }))
    assert.deepEqual(parsed.findings.map((f) => f.severity), ['critical', 'high', 'medium'])
  })

  it('keeps the fenced PoC inside the bullet value it belongs to', () => {
    const detail = [
      '### [C1] First',
      '- **Severity:** CRITICAL',
      '- **Summary:** x',
      '',
      '```sh',
      '## reproduce',
      'curl x',
      '```',
    ].join('\n')
    const f = parsePioliumFindings(build({ detail })).findings[0]
    assert.equal(f.description.includes('## reproduce'), true)
    assert.equal(f.description.includes('curl x'), true)
  })

  it('a ### line inside a fence does not fabricate a finding', () => {
    const detail = [
      '### [C1] Only finding',
      '- **Severity:** CRITICAL',
      '- **Summary:** body',
      '',
      '```',
      '### not a finding',
      '```',
    ].join('\n')
    assert.equal(parsePioliumFindings(build({ detail })).findings.length, 1)
  })

  it('an unterminated fence runs to the end of the input', () => {
    const detail = [
      '### [C1] Only finding',
      '- **Severity:** CRITICAL',
      '',
      '```',
      '### swallowed',
    ].join('\n')
    assert.equal(parsePioliumFindings(build({ detail })).findings.length, 1)
  })

  it('a ~~~ line inside a backtick fence stays content', () => {
    const detail = [
      '### [C1] First',
      '- **Severity:** CRITICAL',
      '',
      '```',
      '~~~',
      '### still fenced',
      '```',
      '',
      '### [H1] Second',
      '- **Severity:** HIGH',
    ].join('\n')
    const parsed = parsePioliumFindings(build({ detail }))
    assert.deepEqual(parsed.findings.map((f) => f.severity), ['critical', 'high'])
  })
})

describe('parsePioliumFindings — repeated sections', () => {
  it('concatenated audit runs keep the findings of both', () => {
    // `cat a.md b.md > all.md` used to be last-write-wins on the
    // repeated `## Technical Findings Detail` header, silently losing
    // the first run's findings.
    const md = [
      '# Security Audit Report: alpha',
      '',
      '## Technical Findings Detail',
      '',
      '### [C1] alpha finding',
      '- **Severity:** CRITICAL',
      '- **Key Code Reference:** alpha/hook.js:1',
      '',
      '# Security Audit Report: beta',
      '',
      '## Technical Findings Detail',
      '',
      '### [H1] beta finding',
      '- **Severity:** HIGH',
      '- **Key Code Reference:** beta/fetch.js:2',
    ].join('\n')
    const parsed = parsePioliumFindings(md)
    assert.deepEqual(
      parsed.findings.map((f) => [f.severity, f.file]),
      [['critical', 'alpha/hook.js'], ['high', 'beta/fetch.js']],
    )
  })

  it('reads every table of a repeated index, skipping re-stated header rows', () => {
    const md = [
      '# Security Audit Report: x',
      '',
      '## Summary of Findings',
      '',
      '| ID | Title | Severity | PoC Status | Parent |',
      '|----|-------|----------|------------|--------|',
      '| [C1] | First | CRITICAL | executed | -- |',
      '',
      '## Summary of Findings',
      '',
      '| ID | Title | Severity | PoC Status | Parent |',
      '|----|-------|----------|------------|--------|',
      '| [H1] | Second | HIGH | executed | -- |',
    ].join('\n')
    const parsed = parsePioliumFindings(md)
    assert.deepEqual(parsed.findings.map((f) => f.description), ['First', 'Second'])
  })
})

describe('parsePioliumFindings — Findings by Severity layout', () => {
  // The mode pipelines (balanced L6c, deep P15) task the assembler with
  // "Findings by Severity (with links to per-finding report.md)",
  // referencing findings "by their <id>-<slug> directory name" — a
  // different layout from the pentest template above. The exact
  // rendering inside each severity group is the composing agent's
  // choice, so all three observed forms are covered: #### blocks,
  // link/bullet lists, and tables.

  it('parses the balanced-mode shape: groups with #### blocks and link lists', () => {
    const md = [
      '# Security Audit Report: my-repo',
      '',
      '## Executive Summary',
      'The audit found one critical and two high issues.',
      '',
      '## Findings by Severity',
      '',
      '### Critical',
      '',
      '#### [C1-command-injection](findings/C1-command-injection/report.md)',
      '',
      'The build hook shells out with an unsanitized branch name.',
      '',
      '**Impact:** RCE on the CI runner.',
      '',
      '### High',
      '',
      '- [H1-idor-invoices](findings/H1-idor-invoices/report.md): IDOR on the invoices endpoint.',
      '- [H2-path-traversal](findings/H2-path-traversal/report.md) — Path traversal in the extractor.',
      '',
      '### Low',
      '',
      'None identified.',
      '',
      '## Attack Surface Summary',
      '',
      '- [recon](piolium/attack-surface/lite-recon.md)',
      '',
      '## Coverage Gaps',
      '',
      '- Payment flows were not exercised.',
      '',
      '## Methodology Notes',
      '',
      'Static analysis plus manual probing.',
    ].join('\n')
    const parsed = parsePioliumFindings(md)
    assert.equal(parsed.source, 'piolium')
    assert.deepEqual(parsed.findings.map((f) => f.severity), ['critical', 'high', 'high'])
    const [c1, h1, h2] = parsed.findings
    // Title recovered from the <id>-<slug> directory name; prose body
    // and the Impact label folded into the description.
    assert.equal(c1.description, [
      'command injection',
      'The build hook shells out with an unsanitized branch name.',
      'Impact: RCE on the CI runner.',
    ].join('\n\n'))
    assert.equal(c1.location, 'piolium:C1')
    assert.equal(c1.reportPath, 'findings/C1-command-injection/report.md')
    assert.equal(h1.description, 'idor invoices\n\nIDOR on the invoices endpoint.')
    assert.equal(h1.location, 'piolium:H1')
    assert.equal(h2.description, 'path traversal\n\nPath traversal in the extractor.')
    // "None identified." placeholder and the Attack Surface / Coverage
    // Gaps link lists must not become findings.
    assert.equal(parsed.findings.length, 3)
  })

  it('reads counted groups and id-prefixed #### headings', () => {
    const md = [
      '# Security Audit Report: x',
      '',
      '## Findings by Severity',
      '',
      '### HIGH (2)',
      '',
      '#### H1: Weak session tokens',
      '- **Severity:** High',
      '- **Key Code Reference:** src/auth/session.js:33',
      '',
      '#### H-002-jwt-audience',
      'Tokens are accepted for any audience.',
      '',
      '### MEDIUM (1)',
      '',
      '#### [M1] Verbose errors',
      '**File:** src/http/errors.js:9',
    ].join('\n')
    const parsed = parsePioliumFindings(md)
    const [h1, h2, m1] = parsed.findings
    assert.equal(h1.severity, 'high')
    assert.equal(h1.file, 'src/auth/session.js')
    assert.equal(h1.line, '33')
    assert.equal(h1.description, 'Weak session tokens')
    // Group severity carries when the block names none; slug title +
    // prose body.
    assert.equal(h2.severity, 'high')
    assert.equal(h2.description, 'jwt audience\n\nTokens are accepted for any audience.')
    assert.equal(h2.location, 'piolium:H-002')
    // Un-bulleted `**File:**` label still resolves the code reference.
    assert.equal(m1.severity, 'medium')
    assert.equal(m1.file, 'src/http/errors.js')
    assert.equal(m1.line, '9')
  })

  it('reads a table inside a group, inheriting the group severity', () => {
    const md = [
      '# Security Audit Report: x',
      '',
      '## Findings by Severity',
      '',
      '### Medium',
      '',
      '| ID | Title | Location |',
      '|----|-------|----------|',
      '| [M1] | Verbose error responses | src/http/errors.js:9 |',
    ].join('\n')
    const f = parsePioliumFindings(md).findings[0]
    assert.equal(f.severity, 'medium')
    assert.equal(f.description, 'Verbose error responses')
    assert.equal(f.file, 'src/http/errors.js')
    assert.equal(f.line, '9')
  })

  it('accepts a severity group promoted to the section level', () => {
    const md = [
      '# Security Audit Report: x',
      '',
      '## Critical Findings',
      '',
      '#### [C1] Hook injection',
      '- **Key Code Reference:** src/h.js:2',
    ].join('\n')
    const f = parsePioliumFindings(md).findings[0]
    assert.equal(f.severity, 'critical')
    assert.equal(f.file, 'src/h.js')
  })

  it('accepts #### findings directly under a findings section', () => {
    const md = [
      '# Security Audit Report: x',
      '',
      '## Findings',
      '',
      '#### [C1] Hook injection',
      '- **Key Code Reference:** src/h.js:2',
    ].join('\n')
    const parsed = parsePioliumFindings(md)
    assert.equal(parsed.findings.length, 1)
    assert.equal(parsed.findings[0].severity, 'critical')
  })

  it('the Findings by Severity marker alone passes the format guard', () => {
    const md = [
      '# Audit of my-repo',
      '',
      '## Findings by Severity',
      '',
      '### High',
      '- [H1-idor](findings/H1-idor/report.md): IDOR.',
    ].join('\n')
    const parsed = parsePioliumFindings(md)
    assert.equal(parsed.source, 'piolium')
    assert.equal(parsed.findings[0].severity, 'high')
  })

  it('does not mistake a finding title starting with a tier word for a group', () => {
    const md = [
      '# Security Audit Report: x',
      '',
      '## Technical Findings Detail',
      '',
      '### High memory usage in the parser',
      '- **Severity:** LOW',
    ].join('\n')
    const f = parsePioliumFindings(md).findings[0]
    assert.equal(f.severity, 'low')
    assert.equal(f.description, 'High memory usage in the parser')
  })

  it('index rows still fill gaps for grouped findings', () => {
    const md = [
      '# Security Audit Report: x',
      '',
      '## Summary of Findings',
      '',
      '| ID | Title | Severity | PoC Status | Parent |',
      '|----|-------|----------|------------|--------|',
      '| [C1] | Command injection | CRITICAL | executed | -- |',
      '| [M9] | Index-only finding | MEDIUM | theoretical | -- |',
      '',
      '## Findings by Severity',
      '',
      '### Critical',
      '',
      '- [C1-command-injection](findings/C1-command-injection/report.md): Command injection.',
    ].join('\n')
    const parsed = parsePioliumFindings(md)
    assert.equal(parsed.findings.length, 2)
    // The grouped list entry adopts its index row's PoC status; the
    // index-only row still lands via the fallback.
    assert.equal(parsed.findings[0].pocStatus, 'executed')
    assert.equal(parsed.findings[1].description, 'Index-only finding')
    assert.equal(parsed.findings[1].pocStatus, 'theoretical')
  })
})

describe('parsePioliumFindings — no repo derivation', () => {
  it('never invents a repo from the H1 project name', () => {
    // Deliberate: "Security Audit Report: <project>" holds a monorepo
    // path (`packages/core`) or free-text label as easily as an
    // owner/repo slug, the two are syntactically indistinguishable, and
    // a wrong repo.github beats the user-editable repo chip in fileUrl —
    // dead source links the user could not correct. The repo chip is
    // the supported way to attach one.
    for (const title of ['PreventiveMeasures/triage', 'packages/core', 'Acme Payments API']) {
      const parsed = parsePioliumFindings(build({ title, detail: DETAIL }))
      assert.equal(parsed.findings[0].repo, undefined)
    }
  })
})
