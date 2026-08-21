// `ui/view/format.js` — the source-link builders: `fileUrl` /
// `isPkgRef`, `findingUrl`, `markdownLinkToken`, and the `## Evidence`
// row helpers (`evidenceUrl` / `evidenceLabel` / `evidenceMarkdown`). Pins the
// package-reference guard: a piolium `Key code` citing `name@1.2.3` (or
// `@scope/name@1.2.3`) is a dependency reference, not a repo path, and
// must not blob-link under the finding's repo — while real paths keep
// their links, including paths with an `@` inside a segment. Pins, too,
// which URL a finding's location row resolves to (the report's own link
// beats the HEAD-pinned reconstruction) and which inline `[a](b)` refs
// in a description are safe to turn into anchors.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// format.js → frontend-global.js throws at module load when the
// `@rray/frontend` slot isn't installed. Tests don't run the boot path
// that installs it, and fileUrl never touches any of these symbols, so
// a bare stub is enough to let the import chain evaluate.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const { evidenceLabel, evidenceMarkdown, evidenceUrl, fileUrl, findingUrl, isPkgRef, markdownLinkToken } = await import('../ui/view/format.js')

describe('isPkgRef', () => {
  it('matches bare and scoped package references', () => {
    assert.equal(isPkgRef('lodash@4.17.21'), true)
    assert.equal(isPkgRef('@org/name@1.2.3'), true)
  })

  it('does not match real paths', () => {
    assert.equal(isPkgRef('src/a.js'), false)
    assert.equal(isPkgRef('src/@types/x.d.ts'), false)
    assert.equal(isPkgRef('long path/sub dir/file.js'), false)
    assert.equal(isPkgRef('unknown'), false)
  })
})

describe('fileUrl — package references', () => {
  it('never blob-links a package reference, under either repo source', () => {
    assert.equal(fileUrl('lodash@4.17.21', 'acme/widgets', ''), null)
    assert.equal(fileUrl('@org/name@1.2.3', 'acme/widgets', ''), null)
    assert.equal(fileUrl('lodash@4.17.21', '', 'https://github.com/acme/widgets'), null)
  })

  it('still links real paths', () => {
    assert.equal(
      fileUrl('src/a.js', 'acme/widgets', ''),
      'https://github.com/acme/widgets/blob/HEAD/src/a.js',
    )
  })
})

// A markdown import carries the report's own link for the finding's
// location (`## Evidence` / `## Location`), pinned to the revision the
// report was produced from. It wins over the `HEAD` reconstruction —
// and is often the only link available, since those reports need not
// name a repository at all.
describe('findingUrl', () => {
  const gh = 'https://github.com/o/r/blob/abc123/src/a.ts#L10-L20'

  it('prefers the report-provided location link', () => {
    assert.equal(
      findingUrl({ file: 'src/a.ts', line: '10-20', location: gh, repo: { github: 'acme/widgets' } }, ''),
      gh,
    )
  })

  it('links a finding whose report named no repository', () => {
    assert.equal(findingUrl({ file: 'src/a.ts', line: '10', location: gh }, ''), gh)
  })

  it('falls back to the reconstruction, anchoring the line', () => {
    assert.equal(
      findingUrl({ file: 'src/a.ts', line: '42', repo: { github: 'acme/widgets' } }, ''),
      'https://github.com/acme/widgets/blob/HEAD/src/a.ts#L42',
    )
  })

  it('anchors a range at its start line', () => {
    assert.equal(
      findingUrl({ file: 'src/a.ts', line: '10-20', repo: { github: 'acme/widgets' } }, ''),
      'https://github.com/acme/widgets/blob/HEAD/src/a.ts#L10',
    )
  })

  it('drops the anchor when the line is unknown', () => {
    assert.equal(
      findingUrl({ file: 'src/a.ts', line: '?' }, 'https://github.com/acme/widgets'),
      'https://github.com/acme/widgets/blob/HEAD/src/a.ts',
    )
  })

  it('ignores a non-http location (piolium id, javascript:)', () => {
    const base = { file: 'src/a.ts', line: '7', repo: { github: 'acme/widgets' } }
    const target = 'https://github.com/acme/widgets/blob/HEAD/src/a.ts#L7'
    assert.equal(findingUrl({ ...base, location: 'piolium:C1' }, ''), target)
    assert.equal(findingUrl({ ...base, location: 'javascript:alert(1)' }, ''), target)
    assert.equal(findingUrl({ ...base, location: 'src/a.ts' }, ''), target)
  })

  it('returns null with nothing to link against', () => {
    assert.equal(findingUrl({ file: 'src/a.ts', line: '7' }, ''), null)
    assert.equal(findingUrl(null, ''), null)
  })
})

// Inline `[label](url)` refs inside a description — the `## Evidence`
// list parse-md.js carries into the body. Only well-formed http(s)
// links become anchors.
describe('markdownLinkToken', () => {
  it('splits a well-formed link into label + url', () => {
    assert.deepEqual(
      markdownLinkToken('[src/a.ts:10-20](https://github.com/o/r/blob/abc123/src/a.ts#L10-L20)'),
      { label: 'src/a.ts:10-20', url: 'https://github.com/o/r/blob/abc123/src/a.ts#L10-L20' },
    )
  })

  it('rejects non-http targets', () => {
    assert.equal(markdownLinkToken('[click](javascript:alert(1))'), null)
    assert.equal(markdownLinkToken('[doc](data:text/html,<b>hi</b>)'), null)
    assert.equal(markdownLinkToken('[local](./src/a.ts)'), null)
    assert.equal(markdownLinkToken('[file](file:///etc/passwd)'), null)
  })

  it('rejects anything that is not exactly one link', () => {
    assert.equal(markdownLinkToken('see [a](https://example.com/a) and more'), null)
    assert.equal(markdownLinkToken('[a](https://example.com/a'), null)
    assert.equal(markdownLinkToken('[](https://example.com/a)'), null)
    assert.equal(markdownLinkToken('plain text'), null)
  })

  it('falls back to the url as the label when the label is blank', () => {
    assert.deepEqual(
      markdownLinkToken('[ ](https://example.com/a)'),
      { label: 'https://example.com/a', url: 'https://example.com/a' },
    )
  })
})

// `## Evidence` rows (common/parse-md.js) — the card renders them as a
// list, and every text surface (markdown export, GitHub issue body,
// clipboard / Claude handoff, search haystack) rebuilds the markdown
// from `evidenceMarkdown`, so its shape is what those all emit.
describe('evidence rows', () => {
  const f = {
    file: 'a.ts',
    line: '10-20',
    repo: { github: 'acme/widgets' },
    evidence: [
      { file: 'libs/a.ts', line: '10-20', url: 'https://github.com/o/r/blob/abc/libs/a.ts#L10-L20', text: 'The merge loop.' },
      { file: 'libs/b.ts', line: '30', text: 'The sink.' },
      { file: 'libs/c.ts', line: '?' },
    ],
  }

  it('labels a row as file:line, dropping an unknown line', () => {
    assert.equal(evidenceLabel(f.evidence[0]), 'libs/a.ts:10-20')
    assert.equal(evidenceLabel(f.evidence[2]), 'libs/c.ts')
  })

  it('links a row by its own URL when the report gave one', () => {
    assert.equal(evidenceUrl(f.evidence[0], f, ''), 'https://github.com/o/r/blob/abc/libs/a.ts#L10-L20')
  })

  it('reconstructs a link for a row that carried none', () => {
    assert.equal(evidenceUrl(f.evidence[1], f, ''), 'https://github.com/acme/widgets/blob/HEAD/libs/b.ts#L30')
    assert.equal(evidenceUrl(f.evidence[2], f, ''), 'https://github.com/acme/widgets/blob/HEAD/libs/c.ts')
  })

  it('gives no link when the finding has no repo to resolve against', () => {
    assert.equal(evidenceUrl(f.evidence[1], { file: 'a.ts' }, ''), null)
  })

  it('rebuilds the list as markdown, notes indented under their row', () => {
    assert.equal(evidenceMarkdown(f), [
      '**Evidence:**',
      '1. [libs/a.ts:10-20](https://github.com/o/r/blob/abc/libs/a.ts#L10-L20)',
      '   The merge loop.',
      '2. libs/b.ts:30',
      '   The sink.',
      '3. libs/c.ts',
    ].join('\n'))
  })

  it('keeps a multi-line note inside its own row', () => {
    const md = evidenceMarkdown({ evidence: [{ file: 'a.ts', line: '1', text: 'First.\nSecond.' }] })
    assert.equal(md, '**Evidence:**\n1. a.ts:1\n   First.\n   Second.')
  })

  it('is empty for a finding with no rows', () => {
    assert.equal(evidenceMarkdown({ file: 'a.ts' }), '')
    assert.equal(evidenceMarkdown({ file: 'a.ts', evidence: [] }), '')
    assert.equal(evidenceMarkdown(null), '')
  })
})
