import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderMarkdown } from '../ui/markdown.js'

test('advisory Markdown renders headings, lists, tables, quotes and code', () => {
  const rendered = renderMarkdown(`# Impact

**Strong** and *emphasized* with \`inline code\`.

- First
- Second

> A quote

| Version | Status |
| --- | --- |
| 1.0 | Affected |

\`\`\`js
const example = '<script>not HTML</script>'
\`\`\`
`)
  for (const snippet of ['<h1>Impact</h1>', '<strong>Strong</strong>', '<em>emphasized</em>', '<code>inline code</code>',
    '<ul>', '<li>Second</li>', '<blockquote>', '<table>', '<td>Affected</td>', '<pre><code class="language-js">', '&lt;script&gt;']) {
    assert.ok(rendered.includes(snippet), snippet)
  }
})

test('Markdown links resolve against the advisory URL and open safely without native tooltips', () => {
  const rendered = renderMarkdown('[Relative](../patch "Patch") [Absolute](https://example.com/fix) ![Example](/image.png "Image")', 'https://github.com/org/repo/security/advisories/GHSA-1234')
  assert.match(rendered, /href="https:\/\/github.com\/org\/repo\/security\/patch" target="_blank" rel="noopener noreferrer"/u)
  assert.match(rendered, /href="https:\/\/example.com\/fix"/u)
  assert.match(rendered, /href="https:\/\/github.com\/image.png" target="_blank" rel="noopener noreferrer">Example<\/a>/u)
  assert.doesNotMatch(rendered, /<img/u, 'illustrations remain accessible without loading external images')
  assert.doesNotMatch(rendered, /title=/u)
  const noBase = renderMarkdown('[Absolute](https://example.com/fix) [Relative](./patch)', null)
  assert.match(noBase, /href="https:\/\/example.com\/fix"/u)
  assert.doesNotMatch(noBase, /href="\.\/patch"/u)
})

test('advisory Markdown escapes raw HTML and blocks executable links and image sources', () => {
  const rendered = renderMarkdown(`<script>alert(1)</script>

<img src=x onerror=alert(1)>

[Bad](javascript:alert%281%29) [Encoded](jav&#x61;script:alert%281%29) [File](file:///etc/passwd)

![SVG](data:image/svg+xml;base64,AAAA) ![Mail](mailto:bad@example.com)

[Mail](mailto:security@example.com)`)
  assert.match(rendered, /&lt;script&gt;/u)
  assert.match(rendered, /&lt;img/u)
  assert.doesNotMatch(rendered, /<script|<img src="x"|(?:href|src)="(?:javascript:|data:|file:)|src="mailto:/u)
  assert.match(rendered, /href="mailto:security@example.com"/u)
})
