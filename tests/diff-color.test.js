// `ui/view/diff-color.js` — `classifyDiff`, which decides whether a
// block of terminal stdout is diff output and, if so, what each line
// is. The recognition is @preventive/diff/color.js's; what this module
// adds is the translation from its styleText-shaped style names to the
// CSS classes the terminal paints. So four things are pinned here: the
// three diff formats are each recognised and labelled, ordinary text
// that merely contains `+` or `---` is left alone, every style the
// library emits translates to a class rather than falling through to
// plain, and — the part that can drift — the labels still match what
// `@preventive/terminal` actually prints. Recognition reads structure
// rather than argv, so a change to either package's diff output would
// otherwise stop the colouring silently.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// A leaf: diff-color.js imports nothing, so it loads without the
// frontend global the rest of ui/view/ needs.
const { classifyDiff } = await import('../ui/view/diff-color.js')
const { createTerminal } = await import('@preventive/terminal')
const { diffLineStyles } = await import('@preventive/diff/color.js')

const kinds = (text) => classifyDiff(text)?.map((d) => d.kind)

describe('classifyDiff — unified', () => {
  const unified = [
    '--- a.txt', '+++ b.txt', '@@ -1,8 +1,8 @@',
    ' alpha', '-charlie', '+CHARLIE', ' delta', '\\ No newline at end of file',
  ].join('\n')

  it('labels headers, hunk, added and removed lines', () => {
    assert.deepEqual(kinds(unified), [
      'head', 'head', 'hunk', '', 'del', 'add', '', 'meta',
    ])
  })

  it('reads `---` and `+++` as headers, not as removed/added lines', () => {
    const parts = classifyDiff(unified)
    assert.equal(parts[0].kind, 'head', '--- is the from-file header')
    assert.equal(parts[1].kind, 'head', '+++ is the to-file header')
  })

  it('leaves context lines unlabelled so they render as plain text', () => {
    assert.equal(classifyDiff(unified)[3].kind, '')
  })

  it('preserves every line verbatim', () => {
    assert.equal(classifyDiff(unified).map((d) => d.text).join('\n'), unified)
  })
})

describe('classifyDiff — context', () => {
  const context = [
    '*** a.txt', '--- b.txt', '***************',
    '*** 1,8 ****', '  alpha', '! charlie', '--- 1,8 ----', '! CHARLIE',
  ].join('\n')

  it('labels the fence, range lines, headers and changed lines', () => {
    assert.deepEqual(kinds(context), [
      'head', 'head', 'hunk', 'hunk', '', 'chg', 'hunk', 'chg',
    ])
  })

  it('tells a `--- 1,8 ----` range line from a `--- b.txt` header', () => {
    const parts = classifyDiff(context)
    assert.equal(parts[1].kind, 'head', '--- b.txt is a file header')
    assert.equal(parts[6].kind, 'hunk', '--- 1,8 ---- is a range line')
  })

  it('wins over unified when both markers could match', () => {
    // A context diff's `---` headers would read as unified removals if
    // the fence were not checked first.
    assert.equal(classifyDiff(context)[0].kind, 'head')
  })
})

describe('classifyDiff — normal', () => {
  const normal = ['3c3', '< charlie', '---', '> CHARLIE', '8d7', '< hotel'].join('\n')

  it('labels the change command, both sides and the separator', () => {
    assert.deepEqual(kinds(normal), ['hunk', 'del', 'meta', 'add', 'hunk', 'del'])
  })

  it('accepts the a/c/d commands with and without ranges', () => {
    for (const command of ['3c3', '1,2d0', '0a1,4', '12,15c12,18']) {
      assert.equal(kinds(`${command}\n< x\n> y`)?.[0], 'hunk', command)
    }
  })
})

describe('classifyDiff — not a diff', () => {
  it('returns null for empty output', () => {
    assert.equal(classifyDiff(''), null)
  })

  it('returns null for a source file full of + bullets and --- rules', () => {
    const source = [
      '# Title', '', '--- a horizontal rule ---', '+ bullet one', '+ bullet two',
      '- bullet three', 'const x = 1 + 2', '### Section',
    ].join('\n')
    assert.equal(classifyDiff(source), null)
  })

  it('returns null for an `ls` listing', () => {
    assert.equal(classifyDiff('a.js\ndeep\nwide.js\n'), null)
  })

  it('needs a real marker, not just a line that looks close', () => {
    assert.equal(classifyDiff('@@ not a hunk header\n+x'), null)
    assert.equal(classifyDiff('3x3\n< a\n> b'), null, 'x is not an a/c/d command')
    assert.equal(classifyDiff('**********\n! x'), null, 'fence is exactly 15 stars')
  })
})

describe('classifyDiff — translating the library\'s styles', () => {
  // classifyDiff maps the library's style names onto CSS classes. A name
  // it does not know renders that line plain, which would be a silent
  // hole rather than a crash — so assert every line the library styled
  // came back with a class. Fixtures below cover all six documented
  // styles between them (bold/cyan/green/red from unified, yellow from
  // context, gray from the unified no-newline marker).
  const fixtures = {
    unified: ['--- a.txt', '+++ b.txt', '@@ -1,2 +1,2 @@', ' ctx', '-old', '+new', '\\ No newline at end of file'].join('\n'),
    context: ['*** a.txt', '--- b.txt', '***************', '*** 1,3 ****', '! was', '--- 1,3 ----', '! now', '+ added', '- gone'].join('\n'),
    normal: ['3c3', '< old', '---', '> new'].join('\n'),
  }

  for (const [name, text] of Object.entries(fixtures)) {
    it(`leaves no ${name} line the library styled without a class`, () => {
      const styles = diffLineStyles(text)
      assert.notEqual(styles, null, 'the fixture is recognised as a diff')
      const labelled = classifyDiff(text)
      for (let i = 0; i < styles.length; i++) {
        if (styles[i] === null) continue
        assert.notEqual(labelled[i].kind, '', `line ${i} (${JSON.stringify(text.split('\n')[i])}) has style ${styles[i]} but no class`)
      }
    })
  }

  it('covers all six styles the library documents', () => {
    const seen = new Set()
    for (const text of Object.values(fixtures)) {
      for (const style of diffLineStyles(text)) if (style !== null) seen.add(style)
    }
    assert.deepEqual([...seen].toSorted(), ['bold', 'cyan', 'gray', 'green', 'red', 'yellow'])
  })

  it('reports no style for a line the library left unstyled', () => {
    const labelled = classifyDiff(fixtures.unified)
    assert.equal(labelled[3].kind, '', 'the context line stays plain')
  })
})

describe('classifyDiff — against the real terminal output', () => {
  const a = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf\nhotel\n'
  const b = 'alpha\nbravo\nCHARLIE\ndelta\necho\nfoxtrot\ngolf\nindia\n'

  const createTerminalWith = (files) => createTerminal(new Map(Object.entries(files)))
  const run = (line) => createTerminalWith({ '/a.txt': a, '/b.txt': b }).run(line)

  // The classifier keys off structure, so if the package ever changes
  // how it spells a hunk header or a range line, colouring would stop
  // silently. These fail instead. `present` differs per format because
  // a context diff spells a two-sided change `!` on both sides, and
  // reserves `+`/`-` for lines only one side has.
  for (const [name, line, expected, present] of [
    ['normal', 'diff a.txt b.txt', ['hunk', 'del', 'meta', 'add'], ['add', 'del']],
    ['unified', 'diff -u a.txt b.txt', ['head', 'head', 'hunk'], ['add', 'del']],
    ['context', 'diff -c a.txt b.txt', ['head', 'head', 'hunk', 'hunk'], ['chg']],
  ]) {
    it(`recognises real \`${line}\` output as ${name}`, () => {
      const { stdout } = run(line)
      assert.notEqual(stdout, '', 'the two files differ, so there is output')
      const labelled = classifyDiff(stdout)
      assert.notEqual(labelled, null, 'output is recognised as a diff')
      assert.deepEqual(labelled.slice(0, expected.length).map((d) => d.kind), expected)
      for (const kind of present) {
        assert.ok(labelled.some((d) => d.kind === kind), `a ${kind} line is labelled`)
      }
    })
  }

  // The `+ ` / `- ` context rules only fire when one side lacks the
  // line outright, which the change-only fixture above never produces.
  it('labels a context diff\'s one-sided additions and deletions', () => {
    const base = 'one\ntwo\nthree\nfour\nfive\nsix\n'
    const terminal = createTerminalWith({
      '/a.txt': base,
      '/added.txt': 'one\ntwo\nthree\nEXTRA\nfour\nfive\nsix\n',
      '/gone.txt': 'one\ntwo\nfour\nfive\nsix\n',
    })
    const added = classifyDiff(terminal.run('diff -c a.txt added.txt').stdout)
    assert.ok(added.some((d) => d.kind === 'add' && d.text === '+ EXTRA'))
    const gone = classifyDiff(terminal.run('diff -c a.txt gone.txt').stdout)
    assert.ok(gone.some((d) => d.kind === 'del' && d.text === '- three'))
  })

  it('leaves identical-file output alone (there is none)', () => {
    const terminal = createTerminalWith({ '/a.txt': a, '/same.txt': a })
    const { stdout } = terminal.run('diff a.txt same.txt')
    assert.equal(stdout, '')
    assert.equal(classifyDiff(stdout), null)
  })

  it('colours a patch file read with `cat`, not just `diff` output', () => {
    const patch = '--- a.txt\n+++ b.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n'
    const terminal = createTerminalWith({ '/fix.patch': patch })
    const { stdout } = terminal.run('cat fix.patch')
    assert.deepEqual(kinds(stdout), ['head', 'head', 'hunk', 'del', 'add', ''])
  })
})
