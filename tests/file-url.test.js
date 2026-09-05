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

// `## Evidence` rows (report/parse-md.js) — the card renders them as a
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
