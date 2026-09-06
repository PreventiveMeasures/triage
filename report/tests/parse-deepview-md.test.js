// `report/parse-deepview-md.js` — the reader for the document
// write-md.js writes. Pinned here: the guard (the marker line, and
// nothing without it); each fact and section back into the field it
// was written from; the producer and the run settled at the report
// level or per finding; a group of cases; and — the point of the
// format — that a report of every kind the library reads survives
// export and re-import: the second export is the first, byte for
// byte, and the findings keep their ids and their facts.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { backfillFindingIds, inheritReportMeta, loadFindings, readReport, writeMarkdown } from '../index.js'
import { findingTitle } from '../finding.js'
import { parseCodexCsvToScans } from '../parse-codex.js'
import { parseDeepsecFindings } from '../parse-deepsec.js'
import { parseDeepviewMarkdown } from '../parse-deepview-md.js'
import { parseMarkdownFindings } from '../parse-md.js'
import { parsePioliumFindings } from '../parse-piolium.js'
import { DOCUMENT_MARKER } from '../write-md.js'

const finding = (extra = {}) => ({
  id: 'f1', file: 'src/a.js', line: '7', severity: 'high',
  description: 'Token comparison is not constant-time.', ...extra,
})

// The repository a document is about, as the viewer's adapter settles
// it (ui/view/markdown-export.js documentRepo): the report's own
// declaration, else the one repository every finding agrees on.
function documentRepo(data) {
  if (data.repo?.github) return data.repo.github
  const repos = new Set(flat(data).map((f) => f.repo?.github ?? null))
  return repos.size === 1 && !repos.has(null) ? [...repos][0] : null
}

// A document out of the writer for a report, the way the viewer's
// adapter assembles one: the report's source, the repository, the
// findings as one-case groups unless the report groups them.
function docOf(data, name = 'r.json', extra = {}) {
  const groups = data.groups ?? data.findings.map((f) => [f])
  return {
    title: 'r',
    reports: [{ name, source: data.source ?? null }],
    repo: documentRepo(data),
    view: { bucket: null },
    filters: [],
    counts: { included: groups.length, total: groups.length },
    groups,
    ...extra,
  }
}

const exportOf = (data, name, extra, hooks) => writeMarkdown(docOf(data, name, extra), hooks)
const flat = (data) => data.findings ?? data.groups.flat()
const without = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)))

// The viewer's read path in miniature: every finding gets an id and the
// report's run meta before anything shows or writes it.
async function ingest(data) {
  await backfillFindingIds(flat(data))
  for (const f of flat(data)) inheritReportMeta(f, data)
  return data
}

// Export, read back, export again — the document a re-imported report
// writes, beside the one it was read from.
async function roundTrip(data, name, extra, hooks) {
  await ingest(data)
  const first = exportOf(data, name, extra, hooks)
  const back = parseDeepviewMarkdown(first)
  assert.ok(back, 'the document reads back')
  await ingest(back)
  return { first, back, second: exportOf(back, name, extra, hooks) }
}

// The one finding of a one-finding document, read back.
const one = (data, extra, hooks) => parseDeepviewMarkdown(exportOf(data, 'r.json', extra, hooks)).findings[0]
const byId = (data) => new Map(flat(data).map((f) => [f.id, f]))

describe('parseDeepviewMarkdown — the guard', () => {
  it('reads what the writer writes, and nothing without the marker line', () => {
    const md = exportOf({ findings: [finding()] })
    assert.ok(md.startsWith(`${DOCUMENT_MARKER}\n`))
    assert.equal(readReport(md).format, 'deepview-md')
    assert.equal(parseDeepviewMarkdown(md.replace(`${DOCUMENT_MARKER}\n\n`, '')), null, 'the same document unmarked')
    assert.equal(parseDeepviewMarkdown('# Title\n\n- **Severity:** High\n'), null)
    assert.equal(parseDeepviewMarkdown(''), null)
  })

  it('takes a later format number as its own', () => {
    const md = exportOf({ findings: [finding()] }).replace('format 1', 'format 2')
    assert.equal(parseDeepviewMarkdown(md)?.findings.length, 1)
  })

  it('is no report when it holds no finding', () => {
    assert.equal(parseDeepviewMarkdown(writeMarkdown()), null)
    assert.equal(readReport(writeMarkdown()).format, null, 'and nothing else claims it')
  })

  it('normalises line endings', () => {
    const md = exportOf({ findings: [finding({ description: 'A\n\nB' })] }).replaceAll('\n', '\r\n')
    assert.equal(parseDeepviewMarkdown(md).findings[0].description, 'Token comparison is not constant-time.'.replace(/.*/u, 'A\n\nB'))
  })
})

describe('parseDeepviewMarkdown — the header, at the report level', () => {
  it('names the product a report came from as its source', () => {
    const back = parseDeepviewMarkdown(exportOf({ source: 'claude-security', findings: [finding()] }, 'a.md'))
    assert.equal(back.source, 'claude-security')
    assert.equal(back.type, 'security')
    assert.ok(!('source' in back.findings[0]), 'and not on the finding')
  })

  it('reads a run every finding shares back into the header', () => {
    const data = { type: 'security', model: 'anthropic/claude-opus-5', effort: 'max', exportsMode: 'list', findings: [finding(), finding({ id: 'f2' })] }
    for (const f of data.findings) inheritReportMeta(f, data)
    const back = parseDeepviewMarkdown(exportOf(data))
    assert.deepEqual({ type: back.type, model: back.model, effort: back.effort, exportsMode: back.exportsMode }, { type: 'security', model: 'opus 5', effort: 'max', exportsMode: 'list' })
    assert.ok(!('model' in back.findings[0]), 'the findings inherit it at ingest, as a dump\'s do')
  })

  it('tells a mode from a model when a run names only one of them', () => {
    const run = (extra) => parseDeepviewMarkdown(exportOf({ findings: [finding(extra)] }))
    assert.deepEqual(run({ type: 'correctness' }).type, 'correctness')
    const model = run({ model: 'anthropic/claude-opus-5', effort: 'max' })
    assert.equal(model.model, 'opus 5')
    assert.equal(model.effort, 'max')
    assert.equal(model.type, undefined)
  })

  it('reads the repository, a slug or a URL', () => {
    assert.deepEqual(parseDeepviewMarkdown(exportOf({ findings: [finding()] }, 'r.json', { repo: 'acme/app' })).repo, { github: 'acme/app' })
    assert.deepEqual(parseDeepviewMarkdown(exportOf({ findings: [finding()] }, 'r.json', { repo: 'https://gitlab.example/acme/app' })).repo, { github: 'https://gitlab.example/acme/app' })
    assert.equal(parseDeepviewMarkdown(exportOf({ findings: [finding()] })).repo, undefined)
  })

  it('settles the analyzers per finding when the document mixes a product with the analyzer\'s runs', () => {
    const md = writeMarkdown({
      reports: [{ name: 'a.md', source: 'claude-security' }, { name: 'b.json', source: null }],
      groups: [[finding({ id: 'c1' })], [finding({ id: 'j1', type: 'security', model: 'opus-5' })], [finding({ id: 'j2', type: 'correctness' })]],
    }, { report: (f) => (f.id === 'c1' ? 'a.md' : 'b.json') })
    const back = parseDeepviewMarkdown(md)
    assert.equal(back.source, undefined, 'no one product')
    const f = byId(back)
    assert.equal(f.get('c1').source, 'claude-security', 'the product\'s finding names it')
    assert.equal(f.get('c1').type, undefined)
    assert.deepEqual({ type: f.get('j1').type, model: f.get('j1').model }, { type: 'security', model: 'opus 5' })
    assert.equal(f.get('j2').type, 'correctness')
    assert.equal(back.type, undefined, 'no one mode either')
  })

  it('keeps one product at the report level even when each finding was told its analyzer', () => {
    const md = writeMarkdown({
      reports: [{ name: 'a.md', source: 'deepsec' }, { name: 'b.md', source: 'deepsec' }],
      groups: [[finding({ id: 'd1' })], [finding({ id: 'd2' })]],
    }, { report: (f) => (f.id === 'd1' ? 'a.md' : 'b.md') })
    const back = parseDeepviewMarkdown(md)
    assert.equal(back.source, 'deepsec')
    assert.ok(back.findings.every((f) => !('source' in f)))
  })

  it('lifts a mode every finding ran in to the report level', () => {
    // The pass's own row names its run apart from the rest, so each
    // finding carries its run; the report still says which mode.
    const data = { findings: [finding({ type: 'security', model: 'opus-5' }), finding({ id: 'f2', type: 'security', model: 'opus-5', revalidate: 'revalidation' })] }
    const back = parseDeepviewMarkdown(exportOf(data))
    assert.equal(back.type, 'security')
    assert.equal(back.model, undefined)
    assert.equal(back.findings[1].revalidate, 'revalidation')
    assert.equal(back.findings[1].model, 'opus 5')
  })
})

describe('parseDeepviewMarkdown — the facts', () => {
  it('reads the location, its link and the export it sits in', () => {
    const f = one({ findings: [finding({ location: 'https://x.test/a.js#L7', exportName: 'Foo', methodName: 'bar' })] })
    assert.deepEqual([f.file, f.line, f.location, f.exportName, f.methodName], ['src/a.js', '7', 'https://x.test/a.js#L7', 'Foo', 'bar'])
    const named = one({ findings: [finding({ exportName: 'getUser' })] })
    assert.deepEqual([named.exportName, named.methodName, named.location], ['getUser', undefined, undefined])
    assert.deepEqual(one({ findings: [finding({ line: '?' })] }).line, '?')
    assert.deepEqual(one({ findings: [finding({ line: '10-20' })] }).line, '10-20')
    const link = one({ findings: [finding()] }, {}, { location: () => 'https://x.test/a.js#L7' })
    assert.equal(link.location, 'https://x.test/a.js#L7', 'a link the caller made is the finding\'s location now')
  })

  it('reads the severity, its correction under either lens, and the analyzer\'s flag', () => {
    const f = finding({ severity: 'medium', correctedSeverity: 'high', correctedSeverityReason: 'Reachable.', critical: true })
    for (const severityMode of ['corrected', 'original']) {
      const back = one({ findings: [f] }, { view: { severityMode } })
      assert.deepEqual([back.severity, back.correctedSeverity, back.correctedSeverityReason, back.critical], ['medium', 'high', 'Reachable.', true], severityMode)
    }
    const varies = one({ findings: [finding({ correctedSeverity: 'critical', _correctedByReport: { a: { severity: 'critical' }, b: { severity: 'high' } } })] })
    assert.deepEqual([varies.severity, varies.correctedSeverity, varies._correctedByReport], ['high', 'critical', undefined])
    assert.equal(one({ findings: [finding({ severity: 'weird' })] }).severity, 'weird', 'a tier the ladder doesn\'t know')
    assert.equal(one({ findings: [finding({ severity: 'high_bug' })] }).severity, 'high_bug')
  })

  it('reads the confidence and the revalidation stamp', () => {
    const f = one({ findings: [finding({ confidence: 8, revalidate: 'Refuted ' })] })
    assert.equal(f.confidence, 8)
    assert.equal(f.revalidate, 'refuted')
    assert.equal(one({ findings: [finding({ confidence: 0 })] }).confidence, 0)
    assert.equal(one({ findings: [finding({ revalidate: 'revalidation' })] }).revalidate, 'revalidation', 'the pass\'s own row')
  })

  it('reads the provenance a report attached, under the names it used', () => {
    const f = one({ findings: [finding({
      repo: { github: 'left-pad/left-pad' }, commitHash: 'abc1234deadbeef', discoveredIn: 'src/routes.js',
      package: { npm: { name: 'acme-db', version: '2.1.0' } }, category: 'Insufficient Verification of Data Authenticity',
      status: 'Open', branch: 'main', dateCreated: '2026-08-30', detectedAt: '2026-01-15', committedAt: '2025-12-01',
      pocStatus: 'executed (blocked by\nthe WAF)', parent: 'C1', slug: 'rule-slug', priority: 7,
      reportPath: 'piolium/findings/C1/report.md', auditedCommit: 'deadbeef',
    })] }, { repo: 'acme/app' }, { commit: (x) => `https://github.com/${x.repo.github}/commit/${x.commitHash}` })
    assert.deepEqual(f, {
      id: 'f1', file: 'src/a.js', line: '7', severity: 'high', description: 'Token comparison is not constant-time.',
      repo: { github: 'left-pad/left-pad' }, commitHash: 'abc1234deadbeef', discoveredIn: 'src/routes.js',
      package: { npm: { name: 'acme-db', version: '2.1.0' } }, category: 'Insufficient Verification of Data Authenticity',
      status: 'Open', branch: 'main', dateCreated: '2026-08-30', detectedAt: '2026-01-15', committedAt: '2025-12-01',
      pocStatus: 'executed (blocked by the WAF)', parent: 'C1', slug: 'rule-slug', priority: 7,
      reportPath: 'piolium/findings/C1/report.md', auditedCommit: 'deadbeef',
    })
    const bare = one({ findings: [finding({ commitHash: 'abc1234deadbeef', package: { npm: { name: 'acme-db' } } })] })
    assert.equal(bare.commitHash, 'abc1234deadbeef', 'unlinked, the whole hash is on the line')
    assert.deepEqual(bare.package, { npm: { name: 'acme-db' } })
  })

  it('leaves the reader\'s annotations and the case\'s report to the viewer', () => {
    const f = one({ findings: [finding()] }, {}, {
      annotation: () => ({ triage: 'inprogress', color: 'red', flagged: true, fix: 'https://github.com/o/r/pull/42', comment: 'Confirmed.' }),
      report: () => 'r.json',
    })
    assert.deepEqual(f, finding())
  })

  it('reads a finding the writer could only head by its location as unnamed', () => {
    assert.equal(one({ findings: [finding({ description: '' })] }).description, '')
    assert.equal(one({ findings: [{ id: 'f1', severity: 'low' }] }).description, '')
  })
})

describe('parseDeepviewMarkdown — the narrative', () => {
  const description = (text, extra = {}) => one({ findings: [finding({ description: text, ...extra })] }).description

  it('puts the heading back as the description\'s first line', () => {
    assert.equal(description('Shell injection\n\nThe pool forwards arguments.'), 'Shell injection\n\nThe pool forwards arguments.')
    assert.equal(description('One line only.'), 'One line only.')
    assert.equal(description('The body.', { title: 'A title' }), 'A title\n\nThe body.', 'a title field leads the description now — the same name, by finding.js')
    assert.equal(findingTitle(one({ findings: [finding({ title: 'A title', description: 'The body.' })] })), 'A title')
  })

  it('keeps a name too long for its heading whole, with or without a body under it', () => {
    const long = `A ${'very '.repeat(40)}long single-line description.`
    assert.equal(description(long), long)
    assert.equal(description(`${long}\n\nWith a body.`), `${long}\n\nWith a body.`)
    assert.equal(description(`${long}\n\nWith a body.\n\n**Root Cause:** Boom.`), `${long}\n\nWith a body.\n\n**Root Cause:** Boom.`)
  })

  it('keeps a description that opens on a fence, and a fence holding heading lines, whole', () => {
    const fenced = '```md\n#### not a section\n\n## nor a tier\n```\n\nProse under it.'
    assert.equal(description(fenced), fenced)
    assert.equal(description('Lead.\n\n```sh\n### 2. not a finding\n```'), 'Lead.\n\n```sh\n### 2. not a finding\n```')
  })

  it('takes the fields the writer sectioned, in the writer\'s order, off the end', () => {
    const f = one({ findings: [finding({
      description: 'Lead.', impact: 'i', reproduction: 'r', recommendation: 'rec', confidenceReason: 'cr',
      revalidate: 'confirmed', revalidateVerdict: 'rv', revalidateRecommendation: 'rr',
    })] })
    assert.deepEqual([f.impact, f.reproduction, f.recommendation, f.confidenceReason, f.revalidateVerdict, f.revalidateRecommendation], ['i', 'r', 'rec', 'cr', 'rv', 'rr'])
    assert.equal(f.description, 'Lead.')
  })

  it('gives a report\'s own labelled paragraphs back to the description, in their place', () => {
    // Impact before a label the writer has no field for stays a paragraph — the field would move it.
    assert.equal(description('Lead.\n\n**Impact:** A.\n\n**Root Cause:** B.'), 'Lead.\n\n**Impact:** A.\n\n**Root Cause:** B.')
    // Impact at the end is the field's place; it becomes the field.
    const tail = one({ findings: [finding({ description: 'Lead.\n\n**Root Cause:** B.\n\n**Impact:** A.' })] })
    assert.equal(tail.description, 'Lead.\n\n**Root Cause:** B.')
    assert.equal(tail.impact, 'A.')
    // A paragraph and a field of the same name: the field is the last one.
    const both = one({ findings: [finding({ description: 'Lead.\n\n**Impact:** From the prose.', impact: 'From the field.' })] })
    assert.equal(both.description, 'Lead.\n\n**Impact:** From the prose.')
    assert.equal(both.impact, 'From the field.')
    // A label with nothing under it, and prose after a labelled paragraph.
    assert.equal(description('Lead.\n\n**PoC:**\n\n**Note:** Trailing.\n\nMore.'), 'Lead.\n\n**PoC:**\n\n**Note:** Trailing.\n\nMore.')
  })

  it('reads the evidence rows, notes and all', () => {
    const f = one({ findings: [finding({ evidence: [
      { file: 'src/a.js', line: '10-20', url: 'https://x.test/a.js#L10-L20', text: 'Tainted here.' },
      { file: 'src/b.js', line: '?', observation: 'Reads the file.\nTwo lines.' },
      { file: 'src/c.js', line: 3, text: 'A snippet:\n\n```js\nrun()\n\ngo()\n```' },
      { url: 'https://x.test/d.js' },
      { text: 'A note with no reference' },
    ] })] })
    assert.deepEqual(f.evidence, [
      { file: 'src/a.js', line: '10-20', url: 'https://x.test/a.js#L10-L20', text: 'Tainted here.' },
      { file: 'src/b.js', line: '?', text: 'Reads the file.\nTwo lines.' },
      { file: 'src/c.js', line: '3', text: 'A snippet:\n\n```js\nrun()\n\ngo()\n```' },
      { url: 'https://x.test/d.js' },
      { text: 'A note with no reference' },
    ])
  })

  it('reads the correction\'s reason, and not the reader\'s comment', () => {
    const f = one({ findings: [finding({ severity: 'low', correctedSeverity: 'high', correctedSeverityReason: 'Unauthenticated.' })] }, {}, { annotation: () => ({ comment: 'Mine.' }) })
    assert.equal(f.correctedSeverityReason, 'Unauthenticated.')
    assert.equal(f.comment, undefined)
    assert.equal(f.description, 'Token comparison is not constant-time.')
  })
})

describe('parseDeepviewMarkdown — a group of cases', () => {
  it('reads an entry of cases as one group, each case its own finding', () => {
    const data = { groups: [
      [finding({ description: 'Prototype pollution\n\nFirst run.', impact: 'i1' }), finding({ id: 'f2', line: '9', description: 'Prototype pollution\n\nSecond run.', impact: 'i2' })],
      [finding({ id: 'f3', description: 'Alone.' })],
    ] }
    const back = parseDeepviewMarkdown(writeMarkdown(docOf(data), { report: (f) => (f.id === 'f1' ? 'a.json' : 'b.json') }))
    assert.equal(back.findings, undefined)
    assert.deepEqual(back.groups.map((g) => g.map((f) => f.id)), [['f1', 'f2'], ['f3']])
    assert.deepEqual(back.groups[0].map((f) => [f.line, f.description, f.impact]), [
      ['7', 'Prototype pollution\n\nFirst run.', 'i1'], ['9', 'Prototype pollution\n\nSecond run.', 'i2'],
    ])
    assert.equal(back.groups[1][0].description, 'Alone.')
  })

  it('names a case after its own title where it had one', () => {
    const back = parseDeepviewMarkdown(exportOf({ groups: [[finding({ description: 'The name' }), finding({ id: 'f2', description: 'Another name' })]] }))
    assert.deepEqual(back.groups[0].map((f) => f.description), ['The name', 'Another name'])
  })
})

// ── Every format the library reads, out and back ──────────────────────

const CLAUDE_SECURITY = [
  '# Unsafe deserialization in the config loader', '',
  '## Details', 'The loader trusts input.', '',
  '## Evidence',
  '1. [src/config/load.ts:42](https://github.com/acme/app/blob/abc/src/config/load.ts#L42)',
  '   The tainted string reaches `yaml.load` here.', '',
  '## Impact', 'Remote code execution.', '',
  '## Reproduction steps', '1. Write a YAML file.', '2. Run the app.', '',
  '## Recommended fix', 'Use `safeLoad`.', '',
  '---', '**Severity:** critical', '**Status:** Open', '**Category:** insufficient verification of data authenticity',
  '**Repository:** acme/app', '**Branch:** main', '**Date created:** 2026-08-30', '',
  '# A second finding', '', '## Location', '[src/b.ts:7](https://github.com/acme/app/blob/abc/src/b.ts#L7)', '',
  '---', '**Severity:** low', '**Category:** Security', '**Repository:** acme/app',
].join('\n')

const DEEPSEC = [
  '# Vulnerability Scan Report', '', '## HIGH (1)', '',
  '### Unsafe regex', '',
  '- **File:** `src/x.js`', '- **Lines:** 26, 28', '- **Slug:** unsafe-regex', '- **Confidence:** high', '',
  'A **catastrophic** backtracking pattern.', '',
  '**Recommendation:** Anchor the pattern.', '',
  '## BUG (1)', '', '### A plain bug', '', '- **File:** `src/y.js`', '',
].join('\n')

const PIOLIUM = [
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
].join('\n')

const CODEX = [
  'finding_url,repository,repository_url,title,description,severity,status,detected_at,committed_at,author_email,assignee_name,assignee_email,has_patch,configured_scan_id,commit_hash,relevant_paths,resolution_reason',
  'https://example.com/finding/1,alice/widget,https://github.com/alice/widget,A title,"A description, with a comma.",high,open,2026-01-15,2025-12-01,,,,false,scan-uuid:scan-1,abc1234deadbeef,src/main.js,',
  'https://example.com/finding/2,alice/widget,https://github.com/alice/widget,Another,"Line one.\n\nLine two.",low,open,2026-01-16,,,,,false,scan-uuid:scan-1,,src/other.js | src/more.js,',
].join('\n')

const NATIVE = () => ({
  type: 'security', model: 'anthropic/claude-opus-5', effort: 'max', exportsMode: 'list',
  repo: { github: 'acme/app' },
  findings: [
    {
      id: 'f1', file: 'src/a.js', line: 7, severity: 'medium', correctedSeverity: 'high', correctedSeverityReason: 'Reachable unauthenticated.',
      confidence: 8, confidenceReason: 'Traced end to end.', title: 'Token comparison is not constant-time',
      description: 'The token is compared with `==`.\n\nA second paragraph.', impact: 'Timing oracle.', reproduction: 'Run it.',
      recommendation: 'Use `timingSafeEqual`.', revalidate: 'confirmed', revalidateVerdict: 'Still there.',
      evidence: [{ file: 'src/a.js', line: 7, observation: 'The compare.' }, { file: 'src/b.js', line: '?' }],
      exportName: 'check', methodName: 'compare', critical: true, priority: 7, commitHash: 'abc1234deadbeef', discoveredIn: 'src/routes.js',
    },
    {
      id: 'f2', file: 'node_modules/left-pad/index.js', line: 3, severity: 'low', description: 'Verbose error',
      repo: { github: 'left-pad/left-pad' }, package: { npm: { name: 'left-pad', version: '1.3.0' } },
    },
    { id: 'f3', file: 'src/c.js', line: 1, severity: 'high', description: 'The revalidation pass row', revalidate: 'revalidation' },
  ],
})

// The facts a re-imported finding must carry exactly as its original
// did — everything but the shape of its prose (a title field becomes
// the description's first line, a `**Impact:**` paragraph at the end
// becomes the field, a note is `text` whatever a dump called it) and
// the line number's type (a string, as every markdown import's is).
function facts(f) {
  return { ...without(f, 'description', 'title', 'line', 'evidence', '_idBasis'), line: String(f.line), title: findingTitle(f) }
}

describe('parseDeepviewMarkdown — every format the library reads, out and back', () => {
  it('claude-security markdown', async () => {
    const data = parseMarkdownFindings(CLAUDE_SECURITY)
    const { first, back, second } = await roundTrip(data, 'a.md')
    assert.equal(second, first)
    assert.equal(readReport(first).format, 'deepview-md')
    assert.deepEqual([back.source, back.type, back.repo], ['claude-security', 'security', { github: 'acme/app' }])
    assert.deepEqual([...byId(back).keys()], [...byId(data).keys()], 'the ids, derived from the source, survive')
    const [orig, again] = [data.findings[0], back.findings[0]]
    assert.deepEqual(without(facts(again), 'impact', 'reproduction'), without(facts(orig), 'repo'), 'the repository every finding shared went to the report; the two sections became fields')
    assert.deepEqual(again.evidence, orig.evidence)
    assert.equal(again.description, 'Unsafe deserialization in the config loader\n\nThe loader trusts input.')
    assert.equal(again.impact, 'Remote code execution.')
    assert.equal(again.reproduction, '1. Write a YAML file.\n2. Run the app.')
    assert.equal(again.category, 'insufficient verification of data authenticity')
    assert.equal(back.findings[1].location, 'https://github.com/acme/app/blob/abc/src/b.ts#L7')
  })

  it('deepsec markdown', async () => {
    const data = parseDeepsecFindings(DEEPSEC)
    const { first, back, second } = await roundTrip(data, 'd.md')
    assert.equal(second, first)
    assert.deepEqual([back.source, back.type], ['deepsec', 'security'])
    for (const [i, orig] of data.findings.entries()) {
      const again = byId(back).get(orig.id)
      assert.deepEqual(facts(again), facts(orig), `finding ${i}`)
      assert.equal(again.description, orig.description, `finding ${i}`)
    }
  })

  it('piolium markdown', async () => {
    const data = parsePioliumFindings(PIOLIUM)
    const { first, back, second } = await roundTrip(data, 'p.md')
    assert.equal(second, first)
    assert.deepEqual([back.source, back.type, back.repo], ['piolium', 'security', { github: 'acme/app' }])
    const [orig, again] = [data.findings[0], back.findings[0]]
    assert.deepEqual(facts(again), without(facts(orig), 'repo'))
    assert.equal(again.description, orig.description, 'the audit\'s own labels stay paragraphs, in their order')
  })

  it('codex csv', async () => {
    const scan = parseCodexCsvToScans(CODEX)[0]
    const { first, back, second } = await roundTrip(scan.data, `${scan.displayName}.codex`)
    assert.equal(second, first)
    assert.deepEqual([back.source, back.type, back.repo], ['codex-security', 'security', { github: 'alice/widget' }])
    for (const orig of scan.data.findings) {
      const again = byId(back).get(orig.id)
      assert.deepEqual(facts(again), without(facts(orig), 'repo'), orig.id)
      assert.equal(again.description, orig.description, orig.id)
    }
  })

  it('the analyzer\'s own dump', async () => {
    const data = NATIVE()
    const { first, back, second } = await roundTrip(data, 'r.json')
    assert.equal(second, first)
    assert.deepEqual([back.source, back.type, back.repo], [undefined, 'security', { github: 'acme/app' }])
    const again = byId(back)
    for (const orig of data.findings) {
      assert.deepEqual(facts(again.get(orig.id)), { ...without(facts(orig), 'model'), model: 'opus 5' }, orig.id)
    }
    assert.equal(again.get('f1').description, 'Token comparison is not constant-time\n\nThe token is compared with `==`.\n\nA second paragraph.')
    assert.deepEqual(again.get('f1').evidence, [{ file: 'src/a.js', line: '7', text: 'The compare.' }, { file: 'src/b.js', line: '?' }])
  })

  it('a dump of groups, under the viewer\'s links', async () => {
    const data = { type: 'security', groups: [[finding({ description: 'Pollution\n\nFirst.' }), finding({ id: 'f2', line: '9', description: 'Pollution\n\nSecond.' })], [finding({ id: 'f3' })]] }
    const hooks = {
      location: (f) => `https://github.com/acme/app/blob/HEAD/${f.file}#L${f.line}`,
      report: (f) => (f.id === 'f2' ? 'b.json' : 'a.json'),
    }
    const { first, back, second } = await roundTrip(data, 'r.json', { reports: [{ name: 'a.json' }, { name: 'b.json' }] }, hooks)
    assert.equal(second, first)
    assert.deepEqual(back.groups.map((g) => g.map((f) => f.id)), [['f1', 'f2'], ['f3']])
    assert.equal(back.groups[0][1].location, 'https://github.com/acme/app/blob/HEAD/src/a.js#L9')
  })

  it('reads back through the library\'s door with its ids, and derives them for a document written without', async () => {
    const data = await ingest(parseMarkdownFindings(CLAUDE_SECURITY))
    const report = await loadFindings(exportOf(data, 'a.md'))
    assert.equal(report.format, 'deepview-md')
    assert.deepEqual(report.findings.map((f) => f.id), data.findings.map((f) => f.id))
    const unmarked = await loadFindings(exportOf(data, 'a.md').replaceAll(/^- \*\*ID:\*\* .*\n/gmu, ''))
    assert.ok(unmarked.findings.every((f) => typeof f.id === 'string' && f.id.length > 0), 'ids derived at load')
  })
})
