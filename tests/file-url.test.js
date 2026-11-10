// `ui/view/format.js` — the source-link builders: `fileUrl` /
// `isPkgRef`, `findingUrl`, `markdownLinkToken`, and the `## Evidence`
// row helpers (`evidenceUrl` / `locationLabel` / `evidenceMarkdown`). Pins the
// package-reference guard: a piolium `Key code` citing `name@1.2.3` (or
// `@scope/name@1.2.3`) is a dependency reference, not a repo path, and
// must not blob-link under the finding's repo — while real paths keep
// their links, including paths with an `@` inside a segment. Pins, too,
// which URL a finding's location row resolves to (the report's own link
// beats the HEAD-pinned reconstruction) and which inline `[a](b)` refs
// in a description are safe to turn into anchors.

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

const { configureDepsDir, evidenceMarkdown, evidenceUrl, fileUrl, findingUrl, githubRefLabel, isPkgRef, locationLabel, markdownLinkToken } = await import('../ui/view/format.js')

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

// `repo.directory` — where inside the repository the tree a report
// describes sits, the npm `repository.directory` field's meaning
// (`{ github: 'babel/babel', directory: 'packages/babel-core' }`). It
// is declared in both the places `repo` is, the report header (which
// reaches the builders as the resolved fallback, group.js
// findingRepoTarget) and a finding's own, and each one's directory
// travels with its own repo: the two are never mixed, or a monorepo
// path would be spliced onto a dependency's upstream.
describe('fileUrl — repository directory', () => {
  const monorepo = { github: 'babel/babel', directory: 'packages/babel-core' }

  it('prefixes the path with the finding repo directory', () => {
    assert.equal(
      fileUrl('src/index.js', monorepo, ''),
      'https://github.com/babel/babel/blob/HEAD/packages/babel-core/src/index.js',
    )
  })

  it('prefixes the path with the report repo directory', () => {
    assert.equal(
      fileUrl('src/index.js', null, monorepo),
      'https://github.com/babel/babel/blob/HEAD/packages/babel-core/src/index.js',
    )
  })

  it('prefixes under a typed repo URL too', () => {
    assert.equal(
      fileUrl('src/index.js', '', { github: 'https://github.com/babel/babel', directory: 'packages/babel-core' }),
      'https://github.com/babel/babel/blob/HEAD/packages/babel-core/src/index.js',
    )
  })

  it('sits between the repo and the package-relative path of a dependency', () => {
    // The `node_modules/<pkg>/` prefix comes off first — the path is
    // rooted at the package's own repo — and the directory says where
    // in that repo the package lives.
    assert.equal(
      fileUrl('node_modules/@babel/core/lib/index.js', { github: 'babel/babel', directory: 'packages/babel-core' }, ''),
      'https://github.com/babel/babel/blob/HEAD/packages/babel-core/lib/index.js',
    )
  })

  it('keeps each directory with the repo it was declared beside', () => {
    // The finding names its own upstream, so the report's directory —
    // a path in the PROJECT's repo — has no business on that link.
    assert.equal(
      fileUrl('src/a.js', { github: 'acme/widgets' }, monorepo),
      'https://github.com/acme/widgets/blob/HEAD/src/a.js',
    )
    // And the report's answers only while the finding names none.
    assert.equal(
      fileUrl('src/a.js', { directory: 'packages/babel-core' }, { github: 'acme/widgets' }),
      'https://github.com/acme/widgets/blob/HEAD/src/a.js',
    )
  })

  // A finding's repo written as a URL, as some imports do, is the same
  // slug: never `github.com/https://github.com/…`.
  it('reads a finding repo written as a GitHub URL down to its slug', () => {
    for (const github of ['https://github.com/o/r', 'https://github.com/o/r.git', 'github.com/o/r/tree/main', 'https://www.github.com/o/r/']) {
      assert.equal(fileUrl('src/a.js', { github }, ''), 'https://github.com/o/r/blob/HEAD/src/a.js', github)
    }
    assert.equal(fileUrl('src/a.js', { github: 'https://gitlab.com/o/r' }, ''), 'https://gitlab.com/o/r/blob/HEAD/src/a.js')
  })

  it('links exactly as before without one', () => {
    for (const repo of ['acme/widgets', { github: 'acme/widgets' }, { github: 'acme/widgets', directory: '' }]) {
      assert.equal(fileUrl('src/a.js', repo, ''), 'https://github.com/acme/widgets/blob/HEAD/src/a.js')
    }
    for (const fallback of ['acme/widgets', { github: 'acme/widgets' }, { github: 'acme/widgets', directory: './' }]) {
      assert.equal(fileUrl('src/a.js', '', fallback), 'https://github.com/acme/widgets/blob/HEAD/src/a.js')
    }
  })

  it('links nothing a directory alone can hang off', () => {
    assert.equal(fileUrl('src/a.js', { directory: 'packages/babel-core' }, ''), null)
    assert.equal(fileUrl('@babel/core@7.0.0', monorepo, ''), null, 'still not a path')
  })

  it('anchors the line on the directory-qualified link', () => {
    assert.equal(
      findingUrl({ file: 'src/index.js', line: '42', repo: monorepo }, ''),
      'https://github.com/babel/babel/blob/HEAD/packages/babel-core/src/index.js#L42',
    )
    assert.equal(
      findingUrl({ file: 'src/index.js', line: '42' }, monorepo),
      'https://github.com/babel/babel/blob/HEAD/packages/babel-core/src/index.js#L42',
    )
  })

  it('carries the directory onto the evidence rows', () => {
    const f = { file: 'src/index.js', line: '10', repo: monorepo, evidence: [{ file: 'src/index.js', line: '10' }, { file: 'src/parse.js', line: '3' }] }
    assert.equal(
      evidenceUrl(f.evidence[0], f, '', 0),
      'https://github.com/babel/babel/blob/HEAD/packages/babel-core/src/index.js#L10',
    )
    assert.equal(
      evidenceUrl(f.evidence[1], f, '', 1),
      'https://github.com/babel/babel/blob/HEAD/packages/babel-core/src/parse.js#L3',
      'own source under the finding repo, directory and all',
    )
    assert.equal(
      evidenceUrl({ file: 'src/other.ts', line: '5' }, { file: 'src/index.js' }, monorepo, 1),
      'https://github.com/babel/babel/blob/HEAD/packages/babel-core/src/other.ts#L5',
      'and the report repo answers the same way',
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

  // GitHub highlights a `#L10-L20` anchor whole; a backwards range reads
  // as the span it meant, and a shape `lineRange` doesn't take keeps
  // its leading number, as every line did before.
  it('anchors a range as the range', () => {
    const at = (line) => findingUrl({ file: 'src/a.ts', line, repo: { github: 'acme/widgets' } }, '')
    assert.equal(at('10-20'), 'https://github.com/acme/widgets/blob/HEAD/src/a.ts#L10-L20')
    assert.equal(at('20 - 10'), 'https://github.com/acme/widgets/blob/HEAD/src/a.ts#L10-L20')
    assert.equal(at('10-10'), 'https://github.com/acme/widgets/blob/HEAD/src/a.ts#L10')
    assert.equal(at(12), 'https://github.com/acme/widgets/blob/HEAD/src/a.ts#L12')
    assert.equal(at('12:5'), 'https://github.com/acme/widgets/blob/HEAD/src/a.ts#L12')
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

  it('unescapes a label the report escaped for markdown', () => {
    assert.deepEqual(
      markdownLinkToken('[a/b/\\_cc\\_cc/index.js:10-20](https://example.com/a.ts#L10-L20)'),
      { label: 'a/b/_cc_cc/index.js:10-20', url: 'https://example.com/a.ts#L10-L20' },
    )
  })

  it('leaves a backslash that escapes nothing markdown escapes', () => {
    assert.deepEqual(
      markdownLinkToken('[C:\\path\\to](https://example.com/a.ts)'),
      { label: 'C:\\path\\to', url: 'https://example.com/a.ts' },
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

// `## Evidence` rows (@preventive/report/src/parse-md.js) — the card renders them as a
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
    assert.equal(locationLabel(f.evidence[0]), 'libs/a.ts:10-20')
    assert.equal(locationLabel(f.evidence[2]), 'libs/c.ts')
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

  // Reconstructing a row's link is a guess, and resolving every row
  // against the finding's repo was a bad one — evidence wanders, and a
  // row citing another package's file got a link into a repository that
  // has never held it. What is pinned here is which rows earn a repo.
  describe('which repo a reconstructed row resolves against', () => {
    const REPORT = 'https://github.com/acme/monorepo'
    const row = (file, line) => ({ file, line })
    // The deps dir is picked per report (configureDepsDir), and the
    // Composer case below is only itself with `vendor` active — that is
    // what makes `vendor/<org>/<pkg>/` the prefix to strip. Restored
    // after each, since it is module-wide.
    const asProject = (file) => configureDepsDir([{ groups: [[{ file }]] }])
    afterEach(() => { asProject('node_modules/a/b.js') })

    it('takes the finding repo for the first row, restating the location', () => {
      asProject('vendor/acme/lib/Client.php')
      const dep = { file: 'vendor/acme/lib/Client.php', repo: { github: 'acme/lib' } }
      assert.equal(
        evidenceUrl(row('vendor/acme/lib/Client.php', '12'), dep, REPORT, 0),
        'https://github.com/acme/lib/blob/HEAD/lib/Client.php#L12',
      )
      // …only the first, and only when it IS the finding's location.
      assert.equal(evidenceUrl(row('vendor/acme/lib/Client.php', '12'), dep, REPORT, 1), null)
      assert.equal(evidenceUrl(row('vendor/acme/lib/Other.php', '12'), dep, REPORT, 0), null)
    })

    it('takes the finding repo for a row in the same installed package', () => {
      const dep = { file: 'node_modules/lodash/index.js', repo: { github: 'lodash/lodash' } }
      assert.equal(
        evidenceUrl(row('node_modules/lodash/lib/merge.js', '40'), dep, REPORT, 3),
        'https://github.com/lodash/lodash/blob/HEAD/lib/merge.js#L40',
      )
      // The whole prefix is the identity — a different install of the
      // same name is a different copy of the file.
      assert.equal(evidenceUrl(row('app/node_modules/lodash/lib/merge.js', '40'), dep, REPORT, 3), null)
    })

    it('reads the innermost package under a nested or pnpm layout', () => {
      const dep = {
        file: 'node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/index.js',
        repo: { github: 'lodash/lodash' },
      }
      assert.equal(
        evidenceUrl(row('node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/merge.js', '7'), dep, REPORT, 2),
        'https://github.com/lodash/lodash/blob/HEAD/merge.js#L7',
      )
    })

    // The point of the whole exercise: a finding in the app citing a
    // sink somewhere in its dependencies. We know the file belongs to
    // SOME package; we do not know that package's repo.
    it('gives no link for a row in another dependency', () => {
      const own = { file: 'src/proxy.ts', repo: { github: 'acme/app' } }
      assert.equal(evidenceUrl(row('node_modules/axios/lib/http.js', '90'), own, REPORT, 1), null)
      assert.equal(evidenceUrl(row('vendor/guzzle/src/Client.php', '90'), own, REPORT, 1), null)
    })

    it('takes the finding repo for own source when the finding is own source', () => {
      const own = { file: 'src/proxy.ts', repo: { github: 'acme/app' } }
      assert.equal(
        evidenceUrl(row('src/router.ts', '8'), own, REPORT, 1),
        'https://github.com/acme/app/blob/HEAD/src/router.ts#L8',
      )
    })

    // The finding's repo is the DEPENDENCY's upstream here, so it is the
    // wrong answer for a file in the project — that one belongs to the
    // report's repo.
    it('takes the report repo for own source when the finding is in a dependency', () => {
      const dep = { file: 'node_modules/lodash/index.js', repo: { github: 'lodash/lodash' } }
      assert.equal(
        evidenceUrl(row('src/proxy.ts', '8'), dep, REPORT, 1),
        'https://github.com/acme/monorepo/blob/HEAD/src/proxy.ts#L8',
      )
      assert.equal(evidenceUrl(row('src/proxy.ts', '8'), dep, '', 1), null)
    })

    it('still takes the row URL the report gave, over any of it', () => {
      const own = { file: 'src/proxy.ts', repo: { github: 'acme/app' } }
      const pinned = { file: 'node_modules/axios/lib/http.js', url: 'https://github.com/axios/axios/blob/v1.6.0/lib/http.js#L90' }
      assert.equal(evidenceUrl(pinned, own, REPORT, 1), pinned.url)
    })
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

  // The issue body's form: each row linked where the card's is, the
  // report's own URL first, a row that resolves nowhere left as text.
  it('links every row the card links, given the repo target', () => {
    const dep = { ...f, file: 'node_modules/lodash/index.js', evidence: [...f.evidence, { file: 'node_modules/qs/lib/parse.js', line: '7' }] }
    assert.equal(evidenceMarkdown(dep, { repoFallback: { github: 'acme/monorepo', directory: '' } }), [
      '**Evidence:**',
      '1. [libs/a.ts:10-20](https://github.com/o/r/blob/abc/libs/a.ts#L10-L20)',
      '   The merge loop.',
      '2. [libs/b.ts:30](https://github.com/acme/monorepo/blob/HEAD/libs/b.ts#L30)',
      '   The sink.',
      '3. [libs/c.ts](https://github.com/acme/monorepo/blob/HEAD/libs/c.ts)',
      '4. node_modules/qs/lib/parse.js:7',
    ].join('\n'))
    assert.equal(evidenceMarkdown(f, { repoFallback: null }).split('\n')[3], '2. [libs/b.ts:30](https://github.com/acme/widgets/blob/HEAD/libs/b.ts#L30)')
  })

  // The issue body's form links a note's line references too, each to
  // those lines in the file its row links to. Other surfaces keep the
  // note as written.
  it('links the line references in a row\'s note to the row\'s file', () => {
    const blob = 'https://github.com/acme/widgets/blob/HEAD/src'
    const text = 'Read (line 40), then (lines 40-50), (L7), (L8-L9) and (Lines 3 – 1).\n'
      + 'Kept: `(line 4)`, [see (line 5)](https://example.com), (line 40, 52), (L0), (lines).'
    const row = { file: 'src/a.ts', line: '12', text }
    const md = evidenceMarkdown({ repo: { github: 'acme/widgets' }, evidence: [row] }, { repoFallback: null })
    assert.equal(md, [
      '**Evidence:**',
      `1. [src/a.ts:12](${blob}/a.ts#L12)`,
      `   Read ([line 40](${blob}/a.ts#L40)), then ([lines 40-50](${blob}/a.ts#L40-L50)), ([L7](${blob}/a.ts#L7)),`
        + ` ([L8-L9](${blob}/a.ts#L8-L9)) and ([Lines 3 – 1](${blob}/a.ts#L1-L3)).`,
      '   Kept: `(line 4)`, [see (line 5)](https://example.com), (line 40, 52), (L0), (lines).',
    ].join('\n'))
    // Markdown that already means something stays as written: a fence
    // (a ``` inside a ```` block is the block's), a code span of any
    // backtick run, link text with a title or a reference, an autolink
    // and a bare URL. A lone backtick opens nothing.
    const note = (written) => evidenceMarkdown({ repo: { github: 'acme/widgets' }, evidence: [{ file: 'src/a.ts', text: written }] }, { repoFallback: null })
      .split('\n').slice(2).map((line) => line.slice(3)).join('\n')
    for (const kept of ['```\nf() // (line 3)\n```', '````\n```\n(line 3)\n```\n(line 4)\n````', '``(line 4)``', '`` a ` (line 4) ``',
      '[sink (line 4)](https://example.com "title (line 5)")', '[sink (line 4)][ref]', '<https://example.com/(L4)>', 'https://example.com/(L4)']) {
      assert.equal(note(kept), kept, kept)
    }
    assert.equal(note('a ` b (line 9)'), `a \` b ([line 9](${blob}/a.ts#L9))`)
    // Notes are untrusted: what would make the matching rescan the rest of
    // a line at every character (unclosed `[` or `<`, backtick runs that
    // never close) costs one pass. A quadratic pass took seconds on these.
    for (const [lead, n] of [['[', 80_000], ['<', 80_000], ['`` `', 20_000], ['( ', 80_000]]) {
      const started = performance.now()
      assert.ok(note(`${lead.repeat(n)} (line 4)`).endsWith(`([line 4](${blob}/a.ts#L4))`), lead)
      assert.ok(performance.now() - started < 500, `${lead} x${n}`)
    }
    const runs = Array.from({ length: 400 }, (_, i) => '`'.repeat(i + 1)).join(' ')
    const started = performance.now()
    assert.ok(note(`${runs} (line 4)`).endsWith(`([line 4](${blob}/a.ts#L4))`))
    assert.ok(performance.now() - started < 500, 'backtick runs')
    assert.equal(note('```\n(line 3)\n```\nThen (line 4).'), `\`\`\`\n(line 3)\n\`\`\`\nThen ([line 4](${blob}/a.ts#L4)).`)
    // The report's own pinned link: its anchor swapped for the note's.
    const pinned = { file: 'libs/a.ts', line: '10-20', url: 'https://github.com/o/r/blob/abc/libs/a.ts#L10-L20', text: 'The loop (line 14).' }
    assert.ok(evidenceMarkdown({ evidence: [pinned] }, { repoFallback: null })
      .includes('The loop ([line 14](https://github.com/o/r/blob/abc/libs/a.ts#L14)).'))
    // No link for the row, or a link off GitHub: the note as written.
    assert.ok(evidenceMarkdown({ evidence: [{ file: 'src/a.ts', text: 'At (line 4).' }] }, { repoFallback: null }).includes('   At (line 4).'))
    assert.ok(evidenceMarkdown({ evidence: [{ ...pinned, url: 'https://gitlab.com/o/r/-/blob/abc/libs/a.ts#L10' }] }, { repoFallback: null })
      .includes('   The loop (line 14).'))
    // The search haystack and the other surfaces: unchanged.
    assert.ok(evidenceMarkdown({ evidence: [pinned] }).includes('   The loop (line 14).'))
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

// A GitHub blob URL as the reference it stands for. The location text
// on a card is the same `src/proxy.ts:42` whichever repo it came from,
// and a card can carry rows from several — so the mark beside it says
// where it goes, and this is what the mark's tooltip reads.
describe('githubRefLabel', () => {
  it('strips the origin, the blob ref, and spells the anchor as lines', () => {
    assert.equal(
      githubRefLabel('https://github.com/acme/app/blob/HEAD/src/proxy.ts#L42'),
      'acme/app/src/proxy.ts:42',
    )
    assert.equal(
      githubRefLabel('https://github.com/acme/app/blob/HEAD/src/proxy.ts#L20-L30'),
      'acme/app/src/proxy.ts:20-30',
    )
    // GitHub also writes a range without the second `L`.
    assert.equal(
      githubRefLabel('https://github.com/acme/app/blob/HEAD/a.ts#L20-30'),
      'acme/app/a.ts:20-30',
    )
  })

  // A report's own link is usually pinned to the commit it was
  // produced from. The sha goes with the rest of the chrome: forty
  // characters in the middle of a path tell the reader nothing they
  // are looking for, and the link still carries it.
  it('drops a pinned ref the same as HEAD', () => {
    assert.equal(
      githubRefLabel('https://github.com/acme/app/blob/9f2c1ab/src/a/b.ts#L7'),
      'acme/app/src/a/b.ts:7',
    )
    assert.equal(
      githubRefLabel('https://github.com/acme/app/blob/release%2Fv2/src/a.ts'),
      'acme/app/src/a.ts',
    )
  })

  it('takes tree and blame URLs, and www', () => {
    assert.equal(githubRefLabel('https://github.com/a/b/tree/HEAD/src'), 'a/b/src')
    assert.equal(githubRefLabel('https://github.com/a/b/blame/HEAD/src/x.ts#L3'), 'a/b/src/x.ts:3')
    assert.equal(githubRefLabel('https://www.github.com/a/b/blob/HEAD/x.ts'), 'a/b/x.ts')
  })

  // Empty means "no mark" — the location link stands as it always did.
  it('answers empty for anything that is not a GitHub blob URL', () => {
    for (const bad of [
      'https://gitlab.com/acme/app/blob/HEAD/x.ts',
      'https://github.com/acme/app',
      'https://github.com/acme/app/issues/12',
      'https://github.com/acme/app/blob/HEAD/',
      'piolium:abc', 'not a url', '', undefined, null, 42, {},
    ]) {
      assert.equal(githubRefLabel(bad), '', String(bad))
    }
  })
})

// The revision a link points at: the one the report read, so a line
// number still lands on the code it describes after the branch moves
// on; HEAD wherever that isn't known. A report's header names it as
// `repo.commit` (ingest stamps it `_repoCommit`, group.js
// findingRepoTarget passes it as `commit`), a finding's own `repo` can
// name its own, and older reports may carry `auditedCommit` instead,
// or nothing at all.
describe('findingUrl — revision', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567'
  const DEP_SHA = 'fedcba9876543210fedcba9876543210fedcba98'
  const report = { github: 'acme/app', directory: '', commit: SHA }

  it('pins own source to the commit the report read', () => {
    assert.equal(findingUrl({ file: 'src/a.ts', line: '3' }, report), `https://github.com/acme/app/blob/${SHA}/src/a.ts#L3`)
    assert.equal(findingUrl({ file: 'src/a.ts', line: '3' }, { ...report, directory: 'app/src' }),
      `https://github.com/acme/app/blob/${SHA}/app/src/src/a.ts#L3`)
  })

  it('stays on HEAD for a report that names no commit, or no repo', () => {
    for (const fallback of [{ github: 'acme/app', directory: '' }, { github: 'acme/app', directory: '', commit: '' }, 'acme/app', { github: 'acme/app', commit: 'main' }]) {
      assert.equal(findingUrl({ file: 'src/a.ts', line: '3' }, fallback), 'https://github.com/acme/app/blob/HEAD/src/a.ts#L3')
    }
    assert.equal(findingUrl({ file: 'src/a.ts', line: '3' }, { github: '', commit: SHA }), null)
  })

  // A finding names a repo only where its own differs from the report's:
  // that repo's revision is its own `commit`, never the report's.
  it('links a finding\'s own repo at its own commit, else HEAD', () => {
    const dep = { file: 'node_modules/lodash/index.js', line: '9' }
    assert.equal(findingUrl({ ...dep, repo: { github: 'lodash/lodash' } }, report), 'https://github.com/lodash/lodash/blob/HEAD/index.js#L9')
    assert.equal(findingUrl({ ...dep, repo: { github: 'lodash/lodash', commit: DEP_SHA } }, report),
      `https://github.com/lodash/lodash/blob/${DEP_SHA}/index.js#L9`)
    // A bare commit, with no repo beside it, says nothing.
    assert.equal(findingUrl({ file: 'src/a.ts', repo: { commit: DEP_SHA } }, report), `https://github.com/acme/app/blob/${SHA}/src/a.ts`)
  })

  it('takes the report\'s commit for a finding naming the report\'s repo again, in any spelling', () => {
    assert.equal(findingUrl({ file: 'src/a.ts', repo: { github: 'https://github.com/Acme/App' } }, report),
      `https://github.com/Acme/App/blob/${SHA}/src/a.ts`)
  })

  // `auditedCommit` (piolium's "Commit audited", a markdown report's one
  // cited commit) is the project's revision too, so it answers where the
  // report's does: own source, never a dependency's upstream. It is not
  // `commitHash`, the commit that introduced the bug.
  it('falls back to the audited commit for own source, behind the report\'s', () => {
    const own = { file: 'src/a.ts', auditedCommit: DEP_SHA }
    assert.equal(findingUrl(own, { github: 'acme/app' }), `https://github.com/acme/app/blob/${DEP_SHA}/src/a.ts`)
    assert.equal(findingUrl({ ...own, repo: { github: 'acme/app' } }, ''), `https://github.com/acme/app/blob/${DEP_SHA}/src/a.ts`)
    assert.equal(findingUrl(own, report), `https://github.com/acme/app/blob/${SHA}/src/a.ts`)
    assert.equal(findingUrl({ file: 'node_modules/lodash/index.js', repo: { github: 'lodash/lodash' }, auditedCommit: DEP_SHA }, report),
      'https://github.com/lodash/lodash/blob/HEAD/index.js')
    assert.equal(findingUrl({ file: 'src/a.ts', commitHash: DEP_SHA }, { github: 'acme/app' }), 'https://github.com/acme/app/blob/HEAD/src/a.ts')
  })

  it('pins evidence rows as it pins the finding', () => {
    const f = { file: 'node_modules/lodash/index.js', repo: { github: 'lodash/lodash' }, auditedCommit: DEP_SHA }
    assert.equal(evidenceUrl({ file: 'node_modules/lodash/merge.js', line: '4' }, f, report, 1), 'https://github.com/lodash/lodash/blob/HEAD/merge.js#L4')
    assert.equal(evidenceUrl({ file: 'src/proxy.ts', line: '8' }, f, report, 1), `https://github.com/acme/app/blob/${SHA}/src/proxy.ts#L8`)
    assert.equal(evidenceUrl({ file: 'src/proxy.ts', line: '8' }, { file: 'src/a.ts', auditedCommit: DEP_SHA }, { github: 'acme/app' }, 1),
      `https://github.com/acme/app/blob/${DEP_SHA}/src/proxy.ts#L8`)
    // A finding naming the report's repo again: its rows take the
    // report's commit as its own link does.
    const same = { file: 'src/a.ts', repo: { github: 'acme/app' } }
    assert.equal(findingUrl(same, report), `https://github.com/acme/app/blob/${SHA}/src/a.ts`)
    for (const i of [0, 1]) {
      assert.equal(evidenceUrl({ file: i === 0 ? 'src/a.ts' : 'src/b.ts', line: '2' }, same, report, i),
        `https://github.com/acme/app/blob/${SHA}/src/${i === 0 ? 'a' : 'b'}.ts#L2`)
    }
  })
})
