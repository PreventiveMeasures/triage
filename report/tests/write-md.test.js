// `report/write-md.js` — the findings document the Download button
// writes. Pure: findings in (the parsers' own objects), a document out.
//
// Pinned here: the header that says what the file is and — the part a
// reader can't otherwise know — under which view and filters it was
// made; the summary and index; that every field a finding carries
// lands on the page, in every format the report library reads; and
// the layout rules markdown needs to render it as intended (loose
// evidence lists, closed fences, escaped table cells, anchors).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { writeMarkdown } from '../index.js'
import { anchorSlug, cell, code, formatTimestamp, indentUnder, link, prose } from '../md-text.js'
import { parseCodexCsvToScans } from '../parse-codex.js'
import { parseDeepsecFindings } from '../parse-deepsec.js'
import { parseMarkdownFindings } from '../parse-md.js'
import { parsePioliumFindings } from '../parse-piolium.js'

const finding = (extra = {}) => ({
  id: 'f1', file: 'src/a.js', line: 7, severity: 'high',
  description: 'Token comparison is not constant-time.', ...extra,
})

// The smallest document with the header a caller usually supplies.
function doc(groups, extra = {}) {
  return {
    title: 'r',
    reports: [{ name: 'r.json', source: null }],
    view: { bucket: null },
    filters: [],
    counts: { included: groups.length, total: groups.length },
    groups,
    ...extra,
  }
}

const line = (md, label) => {
  const m = new RegExp(`^- \\*\\*${label}:\\*\\* (.*)$`, 'mu').exec(md)
  return m ? m[1] : null
}
const headings = (md) => [...md.matchAll(/^(#{1,6}) (.+)$/gmu)].map((m) => `${m[1]} ${m[2]}`)

describe('writeMarkdown — the whole document', () => {
  it('writes the golden two-finding document', () => {
    const md = writeMarkdown(doc([
      [finding({ confidence: 8, title: 'Token comparison is not constant-time', description: 'The token is compared with `==`.', impact: 'Timing oracle.', recommendation: 'Use `timingSafeEqual`.' })],
      [finding({ id: 'f2', file: 'src/b.js', line: '?', severity: 'low', description: 'Verbose error' })],
    ], { generatedAt: '2026-09-05T14:02:00Z' }))
    assert.equal(md, [
      '# r',
      '',
      '- **Report:** `r.json`',
      '- **Exported:** 2026-09-05 14:02 UTC',
      '- **View:** Live findings',
      '- **Filters:** none',
      '- **Included:** all 2 findings',
      '',
      '## Summary',
      '',
      '| Severity | Findings |',
      '| --- | ---: |',
      '| High | 1 |',
      '| Low | 1 |',
      '| **Total** | **2** |',
      '',
      '| # | Severity | Finding | Location | Confidence |',
      '| ---: | --- | --- | --- | --- |',
      '| 1 | High | [Token comparison is not constant-time](#1-token-comparison-is-not-constant-time) | `src/a.js:7` | 8/10 |',
      '| 2 | Low | [Verbose error](#2-verbose-error) | `src/b.js` |  |',
      '',
      '## High (1)',
      '',
      '### 1. Token comparison is not constant-time',
      '',
      '- **Location:** `src/a.js:7`',
      '- **Severity:** High',
      '- **Confidence:** 8/10',
      '',
      'The token is compared with `==`.',
      '',
      '#### Impact',
      '',
      'Timing oracle.',
      '',
      '#### Recommendation',
      '',
      'Use `timingSafeEqual`.',
      '',
      '## Low (1)',
      '',
      '### 2. Verbose error',
      '',
      '- **Location:** `src/b.js`',
      '- **Severity:** Low',
      '',
    ].join('\n'))
  })

  it('takes an empty document, and what is not a finding', () => {
    assert.match(writeMarkdown(), /^# Findings\n\n## Summary\n\nNo findings are included\.\n$/u)
    const md = writeMarkdown({ groups: [null, [], ['stray', null], finding()] })
    assert.equal(headings(md).filter((h) => h.startsWith('### ')).length, 1, 'a bare finding is a one-case group; junk is dropped')
  })
})

describe('writeMarkdown — the header', () => {
  it('names the sources, reports, workspace and repository', () => {
    const md = writeMarkdown(doc([[finding()]], {
      reports: [{ name: 'a.md', source: 'claude-security' }, { name: 'b.md', source: 'deepsec' }, { name: 'c.json', source: null }],
      workspace: 'Q3 audit',
      repo: 'acme/app',
    }))
    assert.equal(line(md, 'Source'), 'Claude Security, DeepSec')
    assert.equal(line(md, 'Reports'), '`a.md`, `b.md`, `c.json`')
    assert.equal(line(md, 'Workspace'), 'Q3 audit')
    assert.equal(line(md, 'Repository'), '[acme/app](https://github.com/acme/app)')
  })

  it('links a repository given as a URL as itself', () => {
    const md = writeMarkdown(doc([[finding()]], { repo: 'https://gitlab.example/acme/app' }))
    assert.equal(line(md, 'Repository'), '<https://gitlab.example/acme/app>')
  })

  it('lists the analyzer runs the included findings came from', () => {
    const one = writeMarkdown(doc([[finding({ type: 'security', model: 'anthropic/claude-opus-5', effort: 'max' })]]))
    assert.equal(line(one, 'Analyzer'), 'security · opus 5 · max')
    const two = writeMarkdown(doc([
      [finding({ type: 'security', model: 'claude-opus-5' })],
      [finding({ id: 'f2', type: 'correctness', model: 'gpt-5.5' })],
    ]))
    assert.equal(line(two, 'Analyzers'), 'security · opus 5; correctness · gpt 5.5')
  })

  it('says which view the selection was made in', () => {
    const view = (v) => line(writeMarkdown(doc([[finding()]], { view: v })), 'View')
    assert.equal(view({ bucket: null }), 'Live findings')
    assert.equal(view({ bucket: 'Deleted' }), 'Deleted findings')
    assert.equal(view({ bucket: null, severityMode: 'original' }), 'Live findings · original analyzer severities')
    assert.equal(view({ bucket: null, severityMode: 'corrected' }), 'Live findings · corrected severities')
    assert.equal(view({ bucket: null, revalidation: false }), 'Live findings · code view — the revalidation pass is not applied')
    assert.equal(view({ bucket: null, revalidation: true }), 'Live findings · app view — the revalidation pass is applied')
    // A caller that says nothing about the view gets no line.
    assert.equal(line(writeMarkdown({ groups: [[finding()]] }), 'View'), null)
  })

  it('puts the applied filters and the counts in the header', () => {
    const md = writeMarkdown(doc([[finding()]], {
      filters: [{ label: 'Severity', value: 'Critical, High' }, { label: 'Confidence', value: '≥ 5' }],
      counts: { included: 12, total: 40 },
    }))
    assert.equal(line(md, 'Filters'), 'Severity: Critical, High · Confidence: ≥ 5')
    assert.equal(line(md, 'Included'), '12 of 40 findings (28 filtered out)')
  })

  it('says outright when nothing is filtered, and when nothing is left', () => {
    assert.equal(line(writeMarkdown(doc([[finding()]], { counts: { included: 1, total: 1 } })), 'Filters'), 'none')
    assert.equal(line(writeMarkdown(doc([[finding()]], { counts: { included: 1, total: 1 } })), 'Included'), 'all 1 finding')
    assert.equal(line(writeMarkdown(doc([], { counts: { included: 0, total: 0 } })), 'Included'), 'no findings')
    assert.equal(line(writeMarkdown(doc([], { counts: { included: 0, total: 3 } })), 'Included'), '0 of 3 findings (3 filtered out)')
    // Without a filter list there is nothing to describe, so no line
    // rather than a misleading "none".
    assert.equal(line(writeMarkdown({ groups: [[finding()]] }), 'Filters'), null)
  })

  it('stamps the export time in UTC', () => {
    assert.equal(line(writeMarkdown(doc([], { generatedAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) })), 'Exported'), '2026-01-02 03:04 UTC')
    assert.equal(line(writeMarkdown(doc([], { generatedAt: 'not a date' })), 'Exported'), null)
  })
})

describe('writeMarkdown — summary and index', () => {
  it('orders the severity table down the ladder, unknown tiers last', () => {
    const md = writeMarkdown(doc([
      [finding({ severity: 'low' })],
      [finding({ id: 'f2', severity: 'critical' })],
      [finding({ id: 'f3', severity: 'weird' })],
      [finding({ id: 'f4', severity: 'high_bug' })],
      [finding({ id: 'f5' })],
    ]))
    assert.deepEqual(headings(md).filter((h) => h.startsWith('## ')), ['## Summary', '## Critical (1)', '## High (1)', '## Low (1)', '## High bug (1)', '## weird (1)'])
    assert.match(md, /\| Critical \| 1 \|\n\| High \| 1 \|\n\| Low \| 1 \|\n\| High bug \| 1 \|\n\| weird \| 1 \|\n\| \*\*Total\*\* \| \*\*5\*\* \|/u)
    assert.deepEqual([...md.matchAll(/^### (\d+)\. /gmu)].map((m) => m[1]), ['1', '2', '3', '4', '5'], 'numbered through the document')
  })

  it('buckets a finding with no severity as informational', () => {
    const md = writeMarkdown(doc([[finding({ severity: undefined })]]))
    assert.ok(md.includes('## Informational (1)'))
  })

  it('links every index row to its section, with the anchor GitHub gives the heading', () => {
    const md = writeMarkdown(doc([[finding({ title: 'SQL injection in `getUser()` [C1]' })]]))
    assert.ok(md.includes('| 1 | High | [SQL injection in `getUser()` \\[C1\\]](#1-sql-injection-in-getuser-c1) | `src/a.js:7` |'), md)
    assert.ok(md.includes('### 1. SQL injection in `getUser()` [C1]'))
  })

  it('keeps a title with a pipe or a line break on one table row', () => {
    const md = writeMarkdown(doc([[finding({ title: 'a | b\nc' })]]))
    assert.ok(md.includes('[a \\| b c](#1-a--b-c)'), md)
  })

  it('shows the confidence column only when something has a confidence', () => {
    assert.doesNotMatch(writeMarkdown(doc([[finding()]])), /\| Confidence \|/u)
    assert.match(writeMarkdown(doc([[finding({ confidence: 0 })]])), /\| Confidence \|\n.*\n\| 1 \| High \| .* \| 0\/10 \|/u)
  })

  it('counts the cases of a group in its index row', () => {
    const md = writeMarkdown(doc([[finding(), finding({ id: 'f2', line: 9 })]]))
    assert.match(md, /\(#1-token-comparison-is-not-constant-time\) \(2 cases\) \| `src\/a\.js:7` \|/u)
  })

  it('tallies the annotations the reader made', () => {
    const marks = { f1: { flagged: true, color: 'red', comment: 'c', fix: 'x' }, f2: { color: 'blue' } }
    const md = writeMarkdown(doc([[finding()], [finding({ id: 'f2' })], [finding({ id: 'f3' })]]), { annotation: (f) => marks[f.id] ?? null })
    assert.ok(md.includes('\nAnnotations: 1 flagged, 2 colour-marked, 1 commented, 1 with a fix link.\n'), md)
    assert.doesNotMatch(writeMarkdown(doc([[finding()]])), /Annotations:/u)
  })
})

describe('writeMarkdown — a finding\'s facts', () => {
  it('links the location through the hook, and names the export', () => {
    const md = writeMarkdown(doc([[finding({ exportName: 'Foo', methodName: 'bar' })]]), { location: () => 'https://x.test/a.js#L7' })
    assert.equal(line(md, 'Location'), '[`src/a.js:7`](https://x.test/a.js#L7) · `Foo.bar`')
  })

  it('links a location the report itself linked when no hook answers', () => {
    const md = writeMarkdown(doc([[finding({ location: 'https://x.test/a.js#L7' })]]))
    assert.equal(line(md, 'Location'), '[`src/a.js:7`](https://x.test/a.js#L7)')
    assert.equal(line(writeMarkdown(doc([[finding({ location: 'piolium:C1' })]])), 'Location'), '`src/a.js:7`')
    assert.equal(line(writeMarkdown(doc([[finding({ line: '10-20' })]])), 'Location'), '`src/a.js:10-20`')
  })

  it('writes both severities of a corrected finding, whichever lens is on', () => {
    const f = finding({ severity: 'medium', correctedSeverity: 'high', correctedSeverityReason: 'Reachable unauthenticated.' })
    const corrected = writeMarkdown(doc([[f]]))
    assert.equal(line(corrected, 'Severity'), 'High — corrected from Medium')
    assert.ok(corrected.includes('## High (1)'))
    assert.ok(corrected.includes('#### Severity correction\n\nReachable unauthenticated.'))
    const original = writeMarkdown(doc([[f]], { view: { severityMode: 'original' } }))
    assert.equal(line(original, 'Severity'), 'Medium — corrected to High')
    assert.ok(original.includes('## Medium (1)'))
  })

  it('ignores a correction that names no known tier', () => {
    const md = writeMarkdown(doc([[finding({ correctedSeverity: 'severe', correctedSeverityReason: 'x' })]]))
    assert.equal(line(md, 'Severity'), 'High')
    assert.doesNotMatch(md, /Severity correction/u)
  })

  it('notes a correction that varies across reports, and the analyzer\'s critical flag', () => {
    const md = writeMarkdown(doc([[finding({
      critical: true,
      correctedSeverity: 'critical',
      _correctedByReport: { 'a.json': { severity: 'critical' }, 'b.json': { severity: 'high' } },
    })]]))
    assert.equal(line(md, 'Severity'), 'Critical — corrected from High (varies across reports — a.json: Critical; b.json: High) · flagged critical by the analyzer')
  })

  it('names the analyzer run only where it varies', () => {
    const same = writeMarkdown(doc([[finding({ type: 'security', model: 'opus-5' })], [finding({ id: 'f2', type: 'security', model: 'opus-5' })]]))
    assert.equal(line(same, 'Analyzer'), 'security · opus 5', 'the header names it once')
    assert.doesNotMatch(same, /^- \*\*Analyzer:\*\* .*\n- \*\*Analyzer:\*\*/mu)
    assert.equal(same.match(/^- \*\*Analyzer:\*\*/gmu).length, 1)
    const varies = writeMarkdown(doc([[finding({ type: 'security', model: 'opus-5' })], [finding({ id: 'f2', type: 'correctness' })]]))
    assert.equal(line(varies, 'Analyzers'), 'security · opus 5; correctness', 'the header lists both runs')
    assert.deepEqual([...varies.matchAll(/^- \*\*Analyzer:\*\* (.*)$/gmu)].map((m) => m[1]), ['security · opus 5', 'correctness'], 'and each finding names its own')
  })

  it('stamps the revalidation outcome, and the pass\'s own row', () => {
    const md = writeMarkdown(doc([[finding({ revalidate: 'Refuted ' })], [finding({ id: 'f2', revalidate: 'revalidation' })]]))
    assert.match(md, /- \*\*Revalidation:\*\* refuted$/mu)
    assert.match(md, /- \*\*Revalidation:\*\* the revalidation pass itself$/mu)
    assert.equal(line(writeMarkdown(doc([[finding({ revalidate: 'maybe' })]])), 'Revalidation'), null, 'an unrecognised value is no stamp')
  })

  it('takes the revalidation layer off with the view', () => {
    const f = finding({ type: 'security', revalidate: 'refuted', revalidateVerdict: 'Not reachable.', revalidateRecommendation: 'Drop it.' })
    const on = writeMarkdown(doc([[f]]))
    assert.ok(on.includes('#### Revalidation verdict\n\nNot reachable.'))
    assert.ok(on.includes('#### Revalidation recommendation\n\nDrop it.'))
    const off = writeMarkdown(doc([[f], [finding({ id: 'f2', type: 'security', revalidate: 'revalidation' })]], { view: { revalidation: false } }))
    assert.doesNotMatch(off, /Revalidation/u)
    assert.doesNotMatch(off, /Not reachable|Drop it|revalidate/u)
  })

  it('writes what the reader did with the finding', () => {
    const annotation = () => ({ triage: 'inprogress', color: 'red', flagged: true, fix: 'https://github.com/o/r/pull/42', comment: 'Confirmed on staging.\n\nSee the ticket.' })
    const md = writeMarkdown(doc([[finding()]]), { annotation })
    assert.equal(line(md, 'Triage'), 'In progress · Red mark · Flagged')
    assert.equal(line(md, 'Fix'), '<https://github.com/o/r/pull/42>')
    assert.ok(md.endsWith('#### Comment\n\nConfirmed on staging.\n\nSee the ticket.\n'), md)
  })

  it('takes a per-report ignore as the triage state, and a fix that is not a URL as text', () => {
    const md = writeMarkdown(doc([[finding()]]), { annotation: () => ({ ignored: true, fix: 'internal ticket #42' }) })
    assert.equal(line(md, 'Triage'), 'Ignored')
    assert.equal(line(md, 'Fix'), 'internal ticket #42')
    assert.equal(line(writeMarkdown(doc([[finding()]]), { annotation: () => ({ flagged: false }) }), 'Triage'), null)
  })

  it('names each case\'s report only when the document spans several', () => {
    const one = writeMarkdown(doc([[finding()]]), { report: () => 'r.json' })
    assert.equal(line(one, 'Report'), '`r.json`', 'the header line')
    assert.equal(one.match(/^- \*\*Report:\*\*/gmu).length, 1)
    const two = writeMarkdown(doc([[finding()], [finding({ id: 'f2' })]], { reports: [{ name: 'a.json' }, { name: 'b.json' }] }), { report: (f) => (f.id === 'f1' ? 'a.json' : 'b.json') })
    assert.match(two, /- \*\*Report:\*\* `a.json`$/mu)
    assert.match(two, /- \*\*Report:\*\* `b.json`$/mu)
  })

  it('names a finding\'s own repository when it is not the document\'s', () => {
    const md = writeMarkdown(doc([
      [finding({ repo: { github: 'acme/app' } })],
      [finding({ id: 'f2', file: 'node_modules/left-pad/index.js', repo: { github: 'left-pad/left-pad' } })],
    ], { repo: 'acme/app' }))
    assert.equal(md.match(/^- \*\*Repository:\*\*/gmu).length, 2, 'the header and the dependency finding')
    assert.match(md, /- \*\*Repository:\*\* \[left-pad\/left-pad\]\(https:\/\/github\.com\/left-pad\/left-pad\)$/mu)
  })

  it('links the introducing commit through the hook, or prints the hash', () => {
    const f = finding({ commitHash: 'abc1234deadbeef' })
    assert.equal(line(writeMarkdown(doc([[f]]), { commit: () => 'https://github.com/o/r/commit/abc1234deadbeef' }), 'Introduced in'), '[`abc1234`](https://github.com/o/r/commit/abc1234deadbeef)')
    assert.equal(line(writeMarkdown(doc([[f]])), 'Introduced in'), '`abc1234deadbeef`')
  })

  it('writes the provenance a report attached', () => {
    const md = writeMarkdown(doc([[finding({
      discoveredIn: 'src/routes.js', package: { npm: { name: 'acme-db', version: '2.1.0' } },
      status: 'Open', branch: 'main', dateCreated: '2026-08-30', detectedAt: '2026-01-15', committedAt: '2025-12-01',
      pocStatus: 'executed', parent: 'C1', slug: 'rule-slug', priority: 7,
      reportPath: 'piolium/findings/C1/report.md', auditedCommit: 'deadbeef',
    })]]))
    for (const [label, value] of [
      ['Found while analyzing', '`src/routes.js`'], ['Package', '`acme-db@2.1.0`'],
      ['Status', 'Open'], ['Branch', 'main'], ['Created', '2026-08-30'], ['Detected', '2026-01-15'], ['Committed', '2025-12-01'],
      ['PoC', 'executed'], ['Variant of', 'C1'], ['Rule', 'rule-slug'], ['Priority', '7'],
      ['Detailed report', '`piolium/findings/C1/report.md`'], ['Audited commit', '`deadbeef`'],
    ]) assert.equal(line(md, label), value, label)
  })

  it('leaves out what a finding does not carry, or carries as something else', () => {
    const md = writeMarkdown(doc([[finding({ discoveredIn: 'src/a.js', package: { npm: {} }, status: { open: true }, priority: NaN })]]))
    for (const label of ['Found while analyzing', 'Package', 'Status', 'Priority', 'Confidence', 'Triage', 'Fix', 'Revalidation']) {
      assert.equal(line(md, label), null, label)
    }
  })
})

describe('writeMarkdown — a finding\'s narrative', () => {
  it('lifts the first line into the heading and writes the rest as the body', () => {
    const md = writeMarkdown(doc([[finding({ description: 'Shell injection\n\nThe worker pool forwards arguments to a shell.' })]]))
    assert.ok(md.includes('### 1. Shell injection\n'))
    assert.ok(md.includes('- **Severity:** High\n\nThe worker pool forwards arguments to a shell.\n'), md)
  })

  it('does not repeat a one-line description under the heading it became', () => {
    const md = writeMarkdown(doc([[finding({ description: 'One line only.' })]]))
    assert.ok(md.includes('### 1. One line only.\n\n- **Location:**'))
    assert.equal(md.split('One line only.').length, 3, 'in the index and the heading, nowhere else')
  })

  it('keeps a description whose one line was too long for the heading', () => {
    const long = `A ${'very '.repeat(40)}long single-line description.`
    const md = writeMarkdown(doc([[finding({ description: long })]]))
    assert.match(md, /^### 1\. A very .*…$/mu)
    assert.ok(md.includes(`\n\n${long}\n`), 'the body carries the whole line')
  })

  it('keeps a description that opens on a fence whole', () => {
    const description = '```ts\nconst a = 1\n```\n\nProse under it.'
    const md = writeMarkdown(doc([[finding({ description })]]))
    assert.ok(md.includes(`- **Severity:** High\n\n${description}\n`), md)
  })

  it('does not repeat a title the description opens with', () => {
    const md = writeMarkdown(doc([[finding({ title: 'A title', description: 'A title\n\nThe body.' })]]))
    assert.ok(md.includes('### 1. A title\n\n- **Location:** `src/a.js:7`\n- **Severity:** High\n\nThe body.\n'), md)
  })

  it('gives the labelled sections a report wrote their own headings, after the evidence', () => {
    const md = writeMarkdown(doc([[finding({
      title: 'A title',
      description: 'Lead.\n\nMore lead.\n\n**Impact:** Boom.\n\nA trailing note.\n\n**Root Cause:** Merge.',
      evidence: [{ file: 'src/a.js', line: 7 }],
    })]]))
    assert.ok(md.includes([
      'Lead.', '', 'More lead.', '',
      '#### Evidence', '', '1. `src/a.js:7`', '',
      '#### Impact', '', 'Boom.', '',
      'A trailing note.', '',
      '#### Root Cause', '', 'Merge.', '',
    ].join('\n')), md)
  })

  it('writes the evidence as a loose list, each note its own paragraph under its reference', () => {
    const md = writeMarkdown(doc([[finding({ evidence: [
      { file: 'src/a.js', line: '10-20', url: 'https://x.test/a.js#L10-L20', text: 'Tainted here.' },
      { file: 'src/b.js', line: '?', observation: 'Reads the file.\nTwo lines.' },
      { url: 'https://x.test/c.js' },
      { text: 'A note with no reference' },
    ] })]]), { evidence: (row, f, i) => (i === 1 ? 'https://x.test/b.js' : (row.url ?? null)) })
    assert.ok(md.includes([
      '#### Evidence', '',
      '1. [`src/a.js:10-20`](https://x.test/a.js#L10-L20)', '', '   Tainted here.', '',
      '2. [`src/b.js`](https://x.test/b.js)', '', '   Reads the file.', '   Two lines.', '',
      '3. <https://x.test/c.js>', '',
      '4. (no reference)', '', '   A note with no reference',
    ].join('\n')), md)
  })

  it('writes every narrative field as a section, in the card\'s order', () => {
    const md = writeMarkdown(doc([[finding({
      impact: 'i', reproduction: 'r', recommendation: 'rec', confidenceReason: 'cr',
      revalidate: 'confirmed', revalidateVerdict: 'rv', revalidateRecommendation: 'rr',
      correctedSeverity: 'critical', correctedSeverityReason: 'sc',
    })]]), { annotation: () => ({ comment: 'c' }) })
    assert.deepEqual(headings(md).filter((h) => h.startsWith('#### ')), [
      '#### Impact', '#### Reproduction', '#### Recommendation', '#### Confidence reasoning',
      '#### Revalidation verdict', '#### Revalidation recommendation', '#### Severity correction', '#### Comment',
    ])
  })

  it('strips the export markers the isolate pipeline injects', () => {
    const md = writeMarkdown(doc([[finding({
      exportName: 'getUser', exportsMode: 'isolate',
      description: '[export: getUser] The id is interpolated.',
      impact: '[export: getUser] Every row.',
    })]]))
    assert.ok(md.includes('### 1. The id is interpolated.'))
    assert.ok(md.includes('#### Impact\n\nEvery row.'))
  })

  it('closes a fence a report left open, and normalises line endings', () => {
    const md = writeMarkdown(doc([
      [finding({ description: 'Lead.\r\n\r\nBody line.\r\n\r\n**Impact:** Boom.\r\n\r\n```js\r\nrun()' })],
      [finding({ id: 'f2', description: 'Next.' })],
    ]))
    assert.doesNotMatch(md, /\r/u)
    assert.ok(md.includes('### 1. Lead.\n\n- **Location:** `src/a.js:7`\n- **Severity:** High\n\nBody line.\n\n#### Impact\n\nBoom.\n\n```js\nrun()\n```\n\n### 2. Next.'), md)
    assert.ok(md.includes('### 2. Next.'), 'the finding after the open fence is still a finding')
  })
})

describe('writeMarkdown — a group of cases', () => {
  it('writes one heading with a case under it per member', () => {
    const md = writeMarkdown(doc([[
      finding({ description: 'Prototype pollution\n\nFirst run.', impact: 'i1' }),
      finding({ id: 'f2', line: 9, description: 'Prototype pollution\n\nSecond run.', impact: 'i2' }),
    ]]), { report: (f) => (f.id === 'f1' ? 'a.json' : 'b.json') })
    assert.deepEqual(headings(md).filter((h) => /^#{3,}/u.test(h)), [
      '### 1. Prototype pollution',
      '#### Case 1 of 2 — `src/a.js:7`', '##### Impact',
      '#### Case 2 of 2 — `src/a.js:9`', '##### Impact',
    ])
    assert.ok(md.includes('### 1. Prototype pollution\n\n2 cases of this finding — reported in `a.json`, `b.json`.\n\n#### Case 1 of 2'), md)
    assert.ok(md.includes('#### Case 1 of 2 — `src/a.js:7`\n\n- **Location:** `src/a.js:7`\n- **Severity:** High\n- **Report:** `a.json`\n\nFirst run.\n\n##### Impact\n\ni1\n'), md)
  })

  it('notes a case named differently from its group', () => {
    const md = writeMarkdown(doc([[finding({ description: 'The name' }), finding({ id: 'f2', description: 'Another name' })]]))
    assert.ok(md.includes('2 cases of this finding.\n\n#### Case 1 of 2 — `src/a.js:7`\n\n- **Location:**'), md)
    assert.ok(md.includes('#### Case 2 of 2 — `src/a.js:7`\n\nAnother name\n\n- **Location:**'), md)
  })
})

// Every format the report library reads, written back out: the fields
// each parser preserves land on the page.
describe('writeMarkdown — every format the library reads', () => {
  it('claude-security markdown', () => {
    const md = writeMarkdown(doc([[parseMarkdownFindings([
      '# Unsafe deserialization in the config loader',
      '',
      '## Details',
      'The loader trusts input.',
      '',
      '## Evidence',
      '1. [src/config/load.ts:42](https://github.com/acme/app/blob/abc/src/config/load.ts#L42)',
      '   The tainted string reaches `yaml.load` here.',
      '',
      '## Impact',
      'Remote code execution.',
      '',
      '## Reproduction steps',
      '1. Write a YAML file.',
      '2. Run the app.',
      '',
      '## Recommended fix',
      'Use `safeLoad`.',
      '',
      '---',
      '**Severity:** critical',
      '**Status:** Open',
      '**Category:** Security',
      '**Repository:** acme/app',
      '**Branch:** main',
      '**Date created:** 2026-08-30',
    ].join('\n')).findings[0]]]))
    assert.ok(md.includes('### 1. Unsafe deserialization in the config loader'))
    assert.equal(line(md, 'Location'), '[`src/config/load.ts:42`](https://github.com/acme/app/blob/abc/src/config/load.ts#L42)')
    assert.equal(line(md, 'Severity'), 'Critical')
    assert.equal(line(md, 'Repository'), '[acme/app](https://github.com/acme/app)')
    assert.equal(line(md, 'Status'), 'Open')
    assert.equal(line(md, 'Branch'), 'main')
    assert.equal(line(md, 'Created'), '2026-08-30')
    assert.ok(md.includes('The loader trusts input.\n\n#### Evidence\n\n1. [`src/config/load.ts:42`](https://github.com/acme/app/blob/abc/src/config/load.ts#L42)\n\n   The tainted string reaches `yaml.load` here.\n\n#### Impact\n\nRemote code execution.\n\n#### Reproduction\n\n1. Write a YAML file.\n2. Run the app.\n\n#### Recommendation\n\nUse `safeLoad`.\n'), md)
  })

  it('deepsec markdown', () => {
    const md = writeMarkdown(doc([[parseDeepsecFindings([
      '# Vulnerability Scan Report', '', '## HIGH (1)', '',
      '### Unsafe regex', '',
      '- **File:** `src/x.js`', '- **Lines:** 26, 28', '- **Slug:** unsafe-regex', '- **Confidence:** high', '',
      'A **catastrophic** backtracking pattern.', '',
      '**Recommendation:** Anchor the pattern.', '',
    ].join('\n')).findings[0]]]))
    assert.ok(md.includes('### 1. Unsafe regex'))
    assert.equal(line(md, 'Location'), '`src/x.js:26`')
    assert.equal(line(md, 'Confidence'), '8/10')
    assert.equal(line(md, 'Rule'), 'unsafe-regex')
    assert.ok(md.includes('A catastrophic backtracking pattern.\n\n#### Recommendation\n\nAnchor the pattern.\n'), md)
  })

  it('piolium markdown', () => {
    const md = writeMarkdown(doc([[parsePioliumFindings([
      '# Security Audit Report: example-project', '', '**Target:** acme/app', '**Commit audited:** deadbeef', '',
      '## Summary of Findings', '',
      '| ID | Title | Severity | PoC Status | Parent |', '|----|-------|----------|------------|--------|',
      '| [C1] | Command injection in the build hook | CRITICAL | executed | -- |', '',
      '## Technical Findings Detail', '',
      '### [C1] Command injection in the build hook',
      '- **Severity:** CRITICAL',
      '- **Summary:** The build hook shells out with an unsanitized branch name.',
      '- **Impact:** Any user who can open a PR gains code execution on CI.',
      '- **Root Cause:** String interpolation into `exec`.',
      '- **Key Code Reference:** src/build/hook.js:142 in runHook()',
      '- **PoC Status:** executed',
      '- **Detailed Report:** piolium/findings/C1-command-injection/report.md', '',
    ].join('\n')).findings[0]]]))
    assert.ok(md.includes('### 1. Command injection in the build hook'))
    assert.equal(line(md, 'Location'), '`src/build/hook.js:142`')
    assert.equal(line(md, 'Severity'), 'Critical')
    assert.equal(line(md, 'PoC'), 'executed')
    assert.equal(line(md, 'Detailed report'), '`piolium/findings/C1-command-injection/report.md`')
    assert.equal(line(md, 'Audited commit'), '`deadbeef`')
    assert.equal(line(md, 'Repository'), '[acme/app](https://github.com/acme/app)')
    assert.ok(md.includes('The build hook shells out with an unsanitized branch name.\n\n#### Impact\n\nAny user who can open a PR gains code execution on CI.\n\n#### Root Cause\n\nString interpolation into `exec`.\n'), md)
  })

  it('codex csv', () => {
    const header = 'finding_url,repository,repository_url,title,description,severity,status,detected_at,committed_at,author_email,assignee_name,assignee_email,has_patch,configured_scan_id,commit_hash,relevant_paths,resolution_reason'
    const row = 'https://example.com/finding/1,alice/widget,https://github.com/alice/widget,A title,A description,high,open,2026-01-15,2025-12-01,,,,false,scan-uuid:scan-1,abc1234deadbeef,src/main.js,'
    const scan = parseCodexCsvToScans(`${header}\n${row}\n`)[0]
    const md = writeMarkdown(doc([[scan.data.findings[0]]], { reports: [{ name: `${scan.displayName}.codex`, source: scan.data.source }] }),
      { commit: (f) => `https://github.com/${f.repo.github}/commit/${f.commitHash}` })
    assert.equal(line(md, 'Source'), 'Codex Security')
    assert.ok(md.includes('### 1. A title\n\n- **Location:** `src/main.js`\n- **Severity:** High\n- **Repository:** [alice/widget](https://github.com/alice/widget)\n- **Introduced in:** [`abc1234`](https://github.com/alice/widget/commit/abc1234deadbeef)\n- **Detected:** 2026-01-15\n- **Committed:** 2025-12-01\n\nA description\n'), md)
  })
})

describe('md-text helpers', () => {
  it('escapes a table cell and quotes code', () => {
    assert.equal(cell('a | b\n  c'), 'a \\| b c')
    assert.equal(code('src/a.js'), '`src/a.js`')
    assert.equal(code('a `b` c'), '``a `b` c``')
    assert.equal(code('`tick'), '`` `tick ``')
    assert.equal(code(''), '')
  })

  it('links, putting an awkward destination in angle brackets', () => {
    assert.equal(link('x', 'https://a.test/b'), '[x](https://a.test/b)')
    assert.equal(link('x', 'https://a.test/b c)'), '[x](<https://a.test/b c)>)')
  })

  it('makes GitHub\'s anchors, numbered on a repeat', () => {
    const taken = new Set()
    assert.equal(anchorSlug('1. SQL injection in `getUser()` [C1]', taken), '1-sql-injection-in-getuser-c1')
    assert.equal(anchorSlug('Über café_ok', taken), 'über-café_ok')
    assert.equal(anchorSlug('Twice', taken), 'twice')
    assert.equal(anchorSlug('Twice', taken), 'twice-1')
    assert.equal(anchorSlug('Twice', taken), 'twice-2')
  })

  it('closes a dangling fence with its own marker, and leaves closed ones alone', () => {
    assert.equal(prose('```js\nrun()'), '```js\nrun()\n```')
    assert.equal(prose('~~~\nrun()\n```'), '~~~\nrun()\n```\n~~~')
    assert.equal(prose('text\n\n````\nrun()'), 'text\n\n````\nrun()\n````')
    assert.equal(prose('```js\nrun()\n```'), '```js\nrun()\n```')
    assert.equal(prose('  plain  '), 'plain')
    assert.equal(prose(null), '')
  })

  it('indents continuation lines to the marker, blank lines empty', () => {
    assert.equal(indentUnder('10. ', 'a\n\nb'), '    a\n\n    b')
  })

  it('formats a timestamp in UTC', () => {
    assert.equal(formatTimestamp('2026-09-05T14:02:59.999Z'), '2026-09-05 14:02 UTC')
    assert.equal(formatTimestamp('nope'), '')
  })
})
