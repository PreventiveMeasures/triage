// Block quotes and GitHub's alerts in rendered prose: a report's `>`
// passage, and an issue body's `> [!CAUTION]` Impact or `> [!TIP]`
// Recommendation, as the created-issue preview shows it. Each is drawn as
// a quote or a titled callout, what it quotes rendered inside it as any
// body is; never as its own markers.
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

class TestDialog { static styles = []; _finish() {} }
mock.module('../ui/view/code-highlight.js', { namedExports: { highlightedCode: () => null } })
mock.module('../ui/view/render.js', { namedExports: { render() {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: null } })
mock.module('../ui/view/dialogs/app-dialog.js', { namedExports: { AppDialog: TestDialog, openAppDialog() {} } })
const { renderHighlighted } = await import('../ui/view/render-finding.js')
const { flowText } = await import('../ui/view/format.js')
await import('../ui/view/dialogs/managed-issue-dialog.js')

// The rendered markup, each alert's glyph left out: what is drawn around
// the text is what these tests read, not the shape of an icon.
const shown = (text, opts) => templateText(renderHighlighted(text, opts)).replaceAll(/<svg\b[^>]*>.*?<\/svg>/gu, '')
const alert = (kind, title) => `<div class="md-alert md-alert-${kind}"><div class="md-alert-title">${title}</div>`

// An issue body as the issue draft writes one: the Impact a CAUTION alert,
// the Recommendation a TIP, each with its label inside, every line quoted
// and a bare `>` between its paragraphs.
const ISSUE_BODY = `The parser reads the config without checking its owner.

> [!CAUTION]
> **Impact:**
> Private data can be disclosed.
>
> Any local user can read it.
>
> \`\`\`js
> const config = readFileSync(path)
> // > a quote in code is code
> \`\`\`

**Reproduction:**
1. Create the file
2. Run the tool

> [!TIP]
> **Recommendation:**
> Check the owner first.`

test('a quote is drawn as a blockquote, its markers gone and what it says rendered inside', () => {
  assert.equal(shown('Before.\n\n> A quoted **line**\n> and the next.\n>\n> A second `paragraph`.\n\nAfter.'),
    '<div class="para">Before.</div><blockquote class="md-quote"><div class="para">A quoted <strong>line</strong>\nand the next.</div>'
    + '<div class="para">A second <span class="inline-code">paragraph</span>.</div></blockquote><div class="para">After.</div>')
  assert.equal(shown('> only a quote'), '<blockquote class="md-quote">only a quote</blockquote>')
  assert.equal(shown('>quoted without the space'), '<blockquote class="md-quote">quoted without the space</blockquote>')
})

test('each of GitHub\'s five alerts is a callout titled by its kind, in any case GitHub reads', () => {
  for (const [marker, kind, title] of [['NOTE', 'note', 'Note'], ['TIP', 'tip', 'Tip'], ['IMPORTANT', 'important', 'Important'],
    ['WARNING', 'warning', 'Warning'], ['CAUTION', 'caution', 'Caution'], ['note', 'note', 'Note'], ['Warning', 'warning', 'Warning']]) {
    assert.equal(shown(`> [!${marker}]\n> What it says.`), `${alert(kind, title)}What it says.</div>`, marker)
  }
  assert.match(templateText(renderHighlighted('> [!NOTE]\n> x')), /<div class="md-alert-title"><svg class="md-alert-icon" [^>]*aria-hidden="true">/u, 'its glyph is decoration')
})

test('an issue body\'s alerts keep their label, paragraphs and fenced snippet inside them', () => {
  const text = shown(ISSUE_BODY)
  assert.equal(text, '<div class="para">The parser reads the config without checking its owner.</div>'
    + `${alert('caution', 'Caution')}<div class="para"><strong>Impact:</strong>\nPrivate data can be disclosed.</div><div class="para">Any local user can read it.</div>`
    + '<div class="code-block" data-lang=js><div class="code-block-lang">js</div><pre><code>const config = readFileSync(path)\n// > a quote in code is code</code></pre></div></div>'
    + '<div class="para"><strong>Reproduction:</strong></div><ol class="md-list" start=><li>Create the file</li><li>Run the tool</li></ol>'
    + `${alert('tip', 'Tip')}<strong>Recommendation:</strong>\nCheck the owner first.</div>`)
  assert.doesNotMatch(text, /\[!|^>|\n>/u, 'no marker is left in the text')
  assert.equal(shown(flowText(ISSUE_BODY)), text, 'flowText leaves a quote\'s lines as they are')
  assert.equal(shown(ISSUE_BODY.replaceAll('\n', '\r\n')), text, 'and CRLF reads the same')
})

test('a `>` inside a fenced block is code, at the top level and inside a list item', () => {
  for (const body of ['```\n> [!CAUTION]\n> not a quote\n```', '- step\n\n  ```\n  > [!CAUTION]\n  > not a quote\n  ```']) {
    const text = shown(body)
    assert.match(text, /<pre><code>> \[!CAUTION\]\n> not a quote<\/code><\/pre>/u, body)
    assert.doesNotMatch(text, /md-quote|md-alert/u, body)
  }
})

test('what is no alert stays a plain quote, its marker the text it was', () => {
  for (const [body, quoted] of [
    ['> [!NOTE] on the marker\'s line', '[!NOTE] on the marker\'s line'],
    ['> [!NOTE]', '[!NOTE]'],
    ['> [!NOTE]\n>', '[!NOTE]'],
    ['> [!DANGER]\n> not a kind GitHub has', '[!DANGER]\nnot a kind GitHub has'],
  ]) assert.equal(shown(body), `<blockquote class="md-quote">${quoted}</blockquote>`, body)
  // GitHub draws an alert only at the top of a body: nested, it's a quote.
  assert.equal(shown('1. Step\n   > [!WARNING]\n   > careful'), '<ol class="md-list" start=><li><div class="para">Step</div><blockquote class="md-quote">[!WARNING]\ncareful</blockquote></li></ol>')
  assert.equal(shown('> outer\n> > [!TIP]\n> > inner'), '<blockquote class="md-quote"><div class="para">outer</div><blockquote class="md-quote">[!TIP]\ninner</blockquote></blockquote>')
})

test('a quote ends where markdown ends it', () => {
  assert.equal(shown('> one\n\n> two'), '<blockquote class="md-quote">one</blockquote><blockquote class="md-quote">two</blockquote>', 'a blank line between makes two')
  assert.equal(shown('> quoted\nand lazily on\n\nafter'), '<blockquote class="md-quote">quoted\nand lazily on</blockquote><div class="para">after</div>', 'a line of text goes on with its paragraph')
  assert.equal(shown('> quoted\n- item'), '<blockquote class="md-quote">quoted</blockquote><ul class="md-list"><li>item</li></ul>', 'a list item does not')
  assert.equal(shown('> quoted\n## Heading'), '<blockquote class="md-quote">quoted</blockquote><div class="md-heading" role="heading" aria-level=2>Heading</div>', 'nor a heading')
  assert.equal(shown('> ```\n> code\nafter'), '<blockquote class="md-quote"><div class="code-block" data-lang=><pre><code>code</code></pre></div></blockquote><div class="para">after</div>', 'nor a line after a fence the quote left open')
  assert.equal(shown('- item\n> quote'), '<ul class="md-list"><li>item</li></ul><blockquote class="md-quote">quote</blockquote>', 'a quote ends the list above it')
})

test('the compact surfaces get the quoted text inline, without the markers or a block', () => {
  const text = shown(ISSUE_BODY, { paragraphs: false })
  assert.doesNotMatch(text, /<blockquote|md-alert|<div class="para"|\[!|(?:^|\n)>/u)
  assert.match(text, /^The parser reads the config without checking its owner\.\n\n<strong>Impact:<\/strong>\nPrivate data can be disclosed\.\n\nAny local user can read it\.<div class="code-block"/u)
  assert.match(text, /\n\n<strong>Recommendation:<\/strong>\nCheck the owner first\.$/u)
  assert.equal(shown('Lead.\n> quoted **text**\nTail.', { paragraphs: false }), 'Lead.\nquoted <strong>text</strong>\nTail.')
  assert.equal(shown('```\n> kept\n```', { paragraphs: false }), '<div class="code-block" data-lang=><pre><code>> kept</code></pre></div>', 'a `>` in code stays')
})

test('quotes nest only so deep, and a long run of markers costs no more than a few passes', () => {
  const t = performance.now()
  const text = shown(`${'>'.repeat(100000)} x`)
  shown(`${'>'.repeat(100000)} x`, { paragraphs: false })
  shown(`> a\n${'>\n'.repeat(50000)}> b`)
  shown('> a\nb\n'.repeat(20000))
  const ms = performance.now() - t
  assert.ok(ms < 5000, `quotes took ${ms.toFixed(0)}ms`)
  assert.equal(text.match(/<blockquote/gu).length, 16)
  assert.ok(text.includes(`${'>'.repeat(100000 - 16)} x`), 'past that the markers stay text')
})

// List items count toward the same depth as quotes: each level parses
// what it holds again, so a few KB of nested markers used to recurse
// once per marker, until the stack ran out (3,000 `1. ` did). Past 16
// levels the rest is the innermost item's text.
test('lists nest only so deep too, counted with quotes, and a deep one costs a few passes', () => {
  const t = performance.now()
  const ordered = shown(`${'1. '.repeat(3000)}x`)
  const indented = shown(Array.from({ length: 300 }, (_, i) => `${' '.repeat(i * 2)}- x${i}`).join('\n'))
  const mixed = shown(`${'- > '.repeat(2000)}x`)
  const ms = performance.now() - t
  assert.ok(ms < 2000, `lists took ${ms.toFixed(0)}ms`)
  assert.equal(ordered.match(/<ol /gu).length, 16)
  assert.ok(ordered.includes(`${'1. '.repeat(3000 - 16)}x`), 'past that the markers stay text')
  assert.equal(indented.match(/<ul /gu).length, 16)
  assert.ok(indented.includes('<li>x15\n- x16\n  - x17'), 'the 17th item on is the 16th\'s text')
  assert.equal(mixed.match(/<ul |<blockquote/gu).length, 16)
  // Normal nesting is drawn as before.
  assert.equal(shown('- a\n  - b\n    > c').match(/<ul |<blockquote/gu).length, 3)
})

test('the created issue\'s preview draws its alerts', () => {
  const dialog = Object.assign(new (customElements.get('managed-issue-dialog'))(), {
    context: { repository: 'o/r' }, session: { login: 'author' }, renderBody: renderHighlighted,
    createdUrl: 'https://github.com/o/r/issues/7', createdIssue: { status: 'open', number: 7, title: 'Finding', author: 'author', labels: [], description: ISSUE_BODY },
  })
  const text = templateText(dialog.render())
  assert.match(text, /<div class="issue-description"><div class="para">The parser[^<]*<\/div><div class="md-alert md-alert-caution"><div class="md-alert-title"><svg [^]*?<\/svg>Caution<\/div>/u)
  assert.match(text, /<div class="md-alert md-alert-tip"><div class="md-alert-title"><svg [^]*?<\/svg>Tip<\/div><strong>Recommendation:<\/strong>/u)
  assert.doesNotMatch(text, /\[!CAUTION\]|\[!TIP\]/u)
})
